import "server-only";
// Reading an off-site backup back (later-round-1-design.md 1.5): the encrypted company file is decrypted and unpacked, each
// picture is fetched from its own object (checked against the SHA-256 the file carries) and put back as the importer expects
// it, and the result is an ordinary move file: importCompany takes it from there, with every one of its refusals.
import fs from "node:fs";
import readline from "node:readline";
import zlib from "node:zlib";
import { Readable, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { MOVE_TABLES, shopFilterSql, tableByName } from "@/lib/move/format";
import { decryptBuffer, decryptStream, OffsiteCryptoError, sha256Hex } from "@/lib/offsite/crypto";
import { dataObjectTime, photoObjectName } from "@/lib/offsite/backup";
import { readAll, type OffsiteStore } from "@/lib/offsite/store";

export type BackupInfo = { name: string; at: Date | null; size: number };

/** The data backups in a store, newest first. */
export async function listBackups(store: OffsiteStore): Promise<BackupInfo[]> {
  return (await store.list())
    .filter((o) => o.name.startsWith("data/"))
    .map((o) => ({ name: o.name, at: dataObjectTime(o.name), size: o.size }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** A cryptography failure in the person's words, anything else as it came. */
function plain(e: unknown): never {
  if (e instanceof OffsiteCryptoError) throw new UserError(e.message);
  throw e;
}

/** The lines of a backup, decrypted and unpacked, one string at a time. */
async function* backupLines(store: OffsiteStore, name: string, privateKey: Buffer): AsyncGenerator<string> {
  const src = await store.get(name);
  const out = new PassThrough();
  pipeline(src, decryptStream(privateKey), zlib.createGunzip(), out).catch((e) => out.destroy(e));
  try {
    for await (const line of readline.createInterface({ input: out, crlfDelay: Infinity })) if (line) yield line;
  } catch (e) {
    if ((e as { code?: string }).code === "Z_DATA_ERROR" || (e as { code?: string }).code === "Z_BUF_ERROR") throw new UserError("The backup is damaged: it doesn't unpack.");
    plain(e);
  }
}

export type Restored = { file: string; rows: number; photos: number; tables: Record<string, number>; shopId: string; shopName: string; exportedAt: string };

/**
 * Writes the backup `name` out as a move file at `file` (gzipped lines, the importer's format): the pictures fetched from
 * their objects, the `_ref` marks gone. `moveToken`: a restore code from the hub account, put in the file's hub part. Throws a UserError that says what is wrong for a wrong key, a damaged or
 * cut-off backup, a missing or changed picture.
 */
export async function restoreToFile(store: OffsiteStore, privateKey: Buffer, name: string, file: string, opts: { moveToken?: string } = {}): Promise<Restored> {
  const result: Restored = { file, rows: 0, photos: 0, tables: {}, shopId: "", shopName: "", exportedAt: "" };
  let sawEnd = false;
  async function* lines() {
    for await (const text of backupLines(store, name, privateKey)) {
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(text);
      } catch {
        throw new UserError("The backup is damaged: a line of it isn't readable.");
      }
      if (j.t === "meta") {
        const shop = j.shop as { id?: string; name?: string } | undefined;
        result.shopId = shop?.id ?? "";
        result.shopName = shop?.name ?? "";
        result.exportedAt = String(j.exportedAt ?? "");
        // A restore code from the StitchHub account is a move token: with it in the file the importer's hub step takes the
        // company over on the hub (the backup carries no token of its own).
        const hub = j.hub as { moveToken?: string | null } | null | undefined;
        if (opts.moveToken && hub) hub.moveToken = opts.moveToken;
      } else if (j.t === "end") {
        sawEnd = true;
        result.rows = Number(j.rows) || 0;
        result.tables = (j.tables as Record<string, number>) ?? {};
      } else if (typeof j._ref === "string" && typeof j.t === "string") {
        const table = tableByName(j.t);
        const col = table?.bytes?.[0];
        if (!table || !col) throw new UserError("The backup is damaged: a picture row of an unknown table.");
        let clear: Buffer;
        try {
          clear = await decryptBuffer(await readAll(await store.get(photoObjectName(j.t, String(j.id), j._ref))), privateKey);
        } catch (e) {
          if (e instanceof UserError) throw new UserError(`A picture of the backup is missing (${j.t} ${String(j.id)}): ${e.message}`);
          plain(e);
        }
        if (sha256Hex(clear) !== j._ref) throw new UserError(`A picture of the backup doesn't match what was saved (${j.t} ${String(j.id)}).`);
        j[col] = clear.toString("base64");
        delete j._ref;
        result.photos++;
      }
      yield JSON.stringify(j) + "\n";
    }
    if (!sawEnd) throw new UserError("The backup is damaged: it ends before it should.");
  }
  try {
    await pipeline(Readable.from(lines()), zlib.createGzip(), fs.createWriteStream(file));
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  return result;
}

export type KeyTest = { name: string; at: Date | null; rows: number; tables: Record<string, number>; today: Record<string, number> };

/** The company's rows today by table, for "Test my recovery key" to show beside the backup's. */
async function todayCounts(shopId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of MOVE_TABLES) {
    const r = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t.t}" WHERE ${shopFilterSql(t)}`, shopId);
    out[t.t] = r[0]?.n ?? 0;
  }
  return out;
}

/**
 * Opens the newest backup with the typed key (every chunk, so the whole file is checked) and returns its row counts beside
 * today's. It does not fetch the pictures. A wrong key or a damaged file is a UserError that says so.
 */
export async function testRecoveryKey(shopId: string, store: OffsiteStore, privateKey: Buffer): Promise<KeyTest> {
  const newest = await db.offsiteObject.findFirst({ where: { shopId, kind: "data" }, orderBy: { name: "desc" }, select: { name: true } });
  if (!newest) throw new UserError("There is no backup to test yet. Press Back up now first.");
  let end: { rows: number; tables: Record<string, number> } | null = null;
  for await (const text of backupLines(store, newest.name, privateKey)) {
    if (!text.startsWith('{"t":"end"')) continue;
    const j = JSON.parse(text);
    end = { rows: Number(j.rows) || 0, tables: j.tables ?? {} };
  }
  if (!end) throw new UserError("The backup is damaged: it ends before it should.");
  return { name: newest.name, at: dataObjectTime(newest.name), rows: end.rows, tables: end.tables, today: await todayCounts(shopId) };
}
