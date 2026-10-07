import "server-only";
// The off-site backup job (later-round-1-design.md 1.2 to 1.4): the company's pictures sent once each, then the company file
// (the move file as a backup: src/lib/move/export.ts purpose "backup"), both encrypted on this side for the owner's public
// key, then the old files pruned. A store only ever holds ciphertext. The restore is src/lib/offsite/restore.ts.
import crypto from "node:crypto";
import { PassThrough, Readable, Transform, pipeline } from "node:stream";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { isDesktop } from "@/lib/modules";
import { withLease } from "@/lib/lease";
import { inBackground } from "@/lib/hub";
import { exportCompany, type Mover } from "@/lib/move/export";
import { MOVE_TABLES, shopFilterSql } from "@/lib/move/format";
import { encryptBuffer, encryptStream, sha256Hex } from "@/lib/offsite/crypto";
import { keepNames, PHOTO_GRACE_DAYS } from "@/lib/offsite/retention";
import { folderStore, type OffsiteStore } from "@/lib/offsite/store";
import { hubStoreFor } from "@/lib/offsite/hub-store";
import { bucketStoreFor } from "@/lib/offsite/bucket-store";

/** What a run did, in numbers (the run's row and the Settings page say the same). */
export type RunResult = { runId: string; dataName: string; bytes: number; photos: number; pruned: number };

/** The off-site store the company's settings name. */
export async function storeFor(shopId: string): Promise<OffsiteStore> {
  const s = await db.offsiteSettings.findUnique({ where: { shopId } });
  if (!s) throw new UserError("Off-site backup isn't set up.");
  if (s.target === "folder") {
    if (!isDesktop()) throw new UserError("A folder is for the Windows program. Pick StitchHub or your own bucket (Settings, Off-site backup).");
    if (!s.folderPath.trim()) throw new UserError("Choose the folder the backups go to.");
    return folderStore(s.folderPath.trim());
  }
  if (s.target === "bucket") return bucketStoreFor(shopId, s.bucket);
  return hubStoreFor(shopId);
}

/** The internal caller the export wants: a backup runs as the company's owner, never as a person. */
const systemMover = (shopId: string): Mover => ({ id: "system", shopId, role: "OWNER", email: "", name: "Off-site backup" });

export const photoObjectName = (table: string, id: string, sha: string) => `photo/${table}/${id}-${sha.slice(0, 16)}`;

/** `data/2026-10-06-020000.sbob`: UTC, so the names sort in the order they were made. */
export const dataObjectName = (at: Date) => `data/${at.toISOString().slice(0, 19).replace("T", "-").replace(/:/g, "")}.sbob`;
export const dataObjectTime = (name: string): Date | null => {
  const m = name.match(/^data\/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.sbob$/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
};

/** A pass-through that counts the bytes and hashes them, for the object's row. */
function measure() {
  const hash = crypto.createHash("sha256");
  const m = { bytes: 0, hex: () => hash.digest("hex") };
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      m.bytes += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  return { t, m };
}

type PhotoRef = { id: string; sha: string; size: number };

async function photoRefs(shopId: string, table: (typeof MOVE_TABLES)[number]): Promise<PhotoRef[]> {
  const col = table.bytes![0];
  const rows = await db.$queryRawUnsafe<{ id: string; sha: string; size: number }[]>(
    `SELECT "id", encode(sha256("${col}"), 'hex') AS sha, length("${col}")::int AS size FROM "${table.t}" WHERE ${shopFilterSql(table)}`,
    shopId,
  );
  return rows;
}

/** Sends the pictures that have no object yet; marks the objects of pictures that left the database; returns how many went. */
async function sendPhotos(shopId: string, store: OffsiteStore, publicKey: Buffer, now: Date): Promise<number> {
  let sent = 0;
  const live = new Set<string>();
  const have = new Set((await db.offsiteObject.findMany({ where: { shopId, kind: "photo", goneAt: null }, select: { name: true } })).map((o) => o.name));
  for (const t of MOVE_TABLES.filter((x) => x.bytes?.length)) {
    for (const p of await photoRefs(shopId, t)) {
      const name = photoObjectName(t.t, p.id, p.sha);
      live.add(name);
      if (have.has(name)) continue;
      const row = await db.$queryRawUnsafe<{ d: Uint8Array }[]>(`SELECT "${t.bytes![0]}" AS d FROM "${t.t}" WHERE "id" = $1`, p.id);
      if (!row[0]) continue; // deleted since the list was read
      const clear = Buffer.from(row[0].d);
      if (sha256Hex(clear) !== p.sha) continue; // changed since the list was read: the next run sends the new one
      const sealed = await encryptBuffer(clear, publicKey);
      await store.put(name, Readable.from([sealed]), sealed.length);
      await db.offsiteObject.upsert({
        where: { shopId_name: { shopId, name } },
        create: { shopId, name, kind: "photo", photoTable: t.t, photoId: p.id, size: sealed.length, sha256: sha256Hex(sealed) },
        update: { size: sealed.length, sha256: sha256Hex(sealed), uploadedAt: now, goneAt: null },
      });
      sent++;
    }
  }
  // A picture whose row is gone keeps its object for the grace period (a restore of an older backup may still want it).
  await db.offsiteObject.updateMany({ where: { shopId, kind: "photo", goneAt: null, name: { notIn: [...live] } }, data: { goneAt: now } });
  return sent;
}

/** Deletes data files past the retention rule and photo objects past their grace period, from the store and the index. */
async function prune(shopId: string, store: OffsiteStore, now: Date): Promise<number> {
  let n = 0;
  const data = await db.offsiteObject.findMany({ where: { shopId, kind: "data" }, select: { name: true, uploadedAt: true } });
  const keep = keepNames(data.map((d) => ({ name: d.name, at: dataObjectTime(d.name) ?? d.uploadedAt })));
  for (const d of data) {
    if (keep.has(d.name)) continue;
    await store.delete(d.name);
    await db.offsiteObject.deleteMany({ where: { shopId, name: d.name } });
    n++;
  }
  const cutoff = new Date(now.getTime() - PHOTO_GRACE_DAYS * 86_400_000);
  for (const p of await db.offsiteObject.findMany({ where: { shopId, kind: "photo", goneAt: { lt: cutoff } }, select: { name: true } })) {
    await store.delete(p.name);
    await db.offsiteObject.deleteMany({ where: { shopId, name: p.name } });
    n++;
  }
  return n;
}

export type RunOpts = {
  /** A store to use instead of the one the settings name (the checks). */
  store?: OffsiteStore;
  now?: Date;
  /** Run although backups are switched off (the checks, and "Back up now" before the sheet was confirmed is still refused by the action). */
  force?: boolean;
};

/**
 * One backup of one company: pictures first (each sent once), then the company file, then pruning after a good run. A
 * failure is recorded on the run and thrown; nothing half-written is ever mistaken for a backup (the file is only named
 * and indexed once the store has all of it).
 */
export async function runOffsiteBackup(shopId: string, opts: RunOpts = {}): Promise<RunResult> {
  const s = await db.offsiteSettings.findUnique({ where: { shopId } });
  if (!s || !s.publicKey) throw new UserError("Off-site backup isn't set up: make the recovery key first.");
  if (!s.on && !opts.force) throw new UserError("Off-site backup is switched off.");
  const publicKey = Buffer.from(s.publicKey, "base64");
  const now = opts.now ?? new Date();
  const store = opts.store ?? (await storeFor(shopId));
  const run = await db.offsiteRun.create({ data: { shopId, startedAt: now } });
  try {
    const photos = await sendPhotos(shopId, store, publicKey, now);
    const ex = await exportCompany(systemMover(shopId), shopId, { purpose: "backup" });
    const name = dataObjectName(now);
    const { t, m } = measure();
    // measure() sits after the encryption: the index holds the size and hash of what the store holds. A failure anywhere
    // along the way destroys the stream the store is reading, so a cut-off file is never kept.
    const out = new PassThrough();
    pipeline(Readable.fromWeb(ex.stream as import("node:stream/web").ReadableStream<Uint8Array>), encryptStream(publicKey), t, out, () => {});
    await store.put(name, out);
    const sha = m.hex(); // a digest can be read once
    await db.offsiteObject.upsert({
      where: { shopId_name: { shopId, name } },
      create: { shopId, name, kind: "data", size: m.bytes, sha256: sha },
      update: { size: m.bytes, sha256: sha, uploadedAt: now, goneAt: null },
    });
    const pruned = await prune(shopId, store, now);
    await db.offsiteRun.update({ where: { id: run.id }, data: { status: "ok", finishedAt: new Date(), bytes: BigInt(m.bytes), photos } });
    return { runId: run.id, dataName: name, bytes: m.bytes, photos, pruned };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.offsiteRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: new Date(), error: msg.slice(0, 500) } }).catch(() => {});
    throw e;
  }
}

/** Hours after a good run before the nightly job takes another (the design's 26: a PC that was off catches up at start). */
export const STALE_HOURS = 26;

/**
 * The scheduled pass: every company with backups on whose last good run is over a day old, one at a time under the
 * "offsite" lease. Called by the server's timer after 2 am shop time and at start. Errors are on each run's row.
 */
export async function runDueOffsiteBackups(now: Date = new Date()): Promise<number> {
  // Background work: nobody is waiting on the hub, so no quick check first (and no acting company: each call names its own).
  const out = await inBackground(() => withLease("offsite", 6 * 3600_000, async (renew) => {
    const shops = await db.offsiteSettings.findMany({ where: { on: true, publicKey: { not: null } }, select: { shopId: true, shop: { select: { timeZone: true } } } });
    let done = 0;
    for (const s of shops) {
      if (!(await renew())) break;
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: s.shop.timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
      const last = await db.offsiteRun.findFirst({ where: { shopId: s.shopId, status: "ok" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
      const age = last ? (now.getTime() - last.startedAt.getTime()) / 3600_000 : Infinity;
      // At night when a day has passed; any time of day when it is long overdue (the PC was off) or never ran.
      if (!(age >= STALE_HOURS || (age >= 20 && hour >= 2 && hour < 6))) continue;
      try {
        await runOffsiteBackup(s.shopId, { now });
        done++;
      } catch (e) {
        console.error(`off-site backup (${s.shopId}):`, e instanceof Error ? e.message : e);
      }
    }
    return done;
  }));
  return out ?? 0;
}
