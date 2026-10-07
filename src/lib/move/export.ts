import "server-only";
// Moving a company out (company-move-design.md sections 3, 7 and 8, package move-export): the freeze, the move record and
// the file. The file is streamed straight from the database while the owner's browser (or the CLI) reads it: nothing is
// spooled to disk, so there is no file to delete after the download or 24 hours later, no size limit beyond the
// browser's, and flat memory (a page of rows at a time; a photo is one line). One REPEATABLE READ, READ ONLY
// transaction holds the snapshot for the length of the download; a row written meanwhile can't end up in the file
// without its parent, and the freeze (Shop.movingAt, set when the owner confirms) means nothing is written anyway.
import zlib from "node:zlib";
import { Readable, Transform, pipeline } from "node:stream";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { appName, isPlatformAdmin, programVersion, shopKindOf } from "@/lib/shops";
import { loadModules } from "@/lib/modules";
import { PAID_MODULE_IDS } from "@/lib/module-info";
import { encodeRow, LEFT_OUT, MOVE_FORMAT, MOVE_TABLES, MOVE_VERSION, moveFileName, PAGE, shopFilterSql, type MoveEnd, type MoveMeta, type MoveTable } from "./format";
import { dropMoveToken, hubMoveView, hubPart, hubWarning, moveTokenFor, type HubMoveView } from "./hub-step";

/** Who is moving: the signed-in user, or the CLI's operator (scripts/move/export.ts). */
export type Mover = { id: string; shopId: string; role: "OWNER" | "ADMIN" | "TECH"; email: string; name: string };

type MoveShop = { id: string; name: string; doesRepair: boolean; sellsRetail: boolean; timeZone: string; movingAt: Date | null; movedTo: string | null; movedOutAt: Date | null };

const NOT_FOUND = "Company not found.";

/**
 * The company, for its owner or the StitchBench administrator (hosted: Companies). Anyone else, including another
 * company's owner, gets "Company not found." (the same answer as for an id that doesn't exist, so nothing is leaked).
 */
async function moveShop(user: Mover, shopId: string): Promise<MoveShop> {
  const allowed = (user.shopId === shopId && user.role === "OWNER") || isPlatformAdmin(user.email);
  const shop = allowed
    ? await db.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true, doesRepair: true, sellsRetail: true, timeZone: true, movingAt: true, movedTo: true, movedOutAt: true } })
    : null;
  if (!shop) throw new UserError(NOT_FOUND);
  return shop;
}

/** The destination in the owner's words ("the shop PC", "the hosted StitchShop"), trimmed to a line, or null. */
export function destinationText(v: unknown): string | null {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return s || null;
}

/**
 * The owner confirms the move (design section 7): the company is frozen (Shop.movingAt), the move record made, and the
 * file is ready to download. Refused while a move is already on, and after the hub has said the company moved.
 */
export async function startMove(user: Mover, shopId: string, opts: { to?: unknown; agreed?: boolean } = {}): Promise<string> {
  const shop = await moveShop(user, shopId);
  if (shop.movedOutAt) throw new UserError("This company has already moved to another install. This copy stays read-only.");
  if (shop.movingAt) throw new UserError("This company is already being moved. Download the move file, or cancel the move to carry on here.");
  if (opts.agreed === false) throw new UserError("Tick the box to say you understand what the move file holds.");
  const now = new Date();
  const [move] = await db.$transaction([
    db.companyMove.create({ data: { shopId, direction: "export", status: "ready", byUserId: user.id, startedAt: now }, select: { id: true } }),
    db.shop.update({ where: { id: shopId }, data: { movingAt: now, movedTo: destinationText(opts.to) } }),
  ]);
  // The hub's move token (package move-hub), when this install is on one: in every download of this move. The hub not
  // answering doesn't stop the move; the download asks again, and the Settings card says so.
  await moveTokenFor(shopId, move.id).catch((e) => console.error("company move: the move token:", e instanceof Error ? e.message : e));
  return move.id;
}

/** Cancel (owner): the freeze lifted, the move record closed. The file already downloaded, if any, is the owner's to delete. */
export async function cancelMove(user: Mover, shopId: string): Promise<void> {
  const shop = await moveShop(user, shopId);
  if (shop.movedOutAt) throw new UserError("This company has moved to another install; the move can't be cancelled from here.");
  if (!shop.movingAt) throw new UserError("This company isn't being moved.");
  await db.$transaction([
    db.shop.update({ where: { id: shopId }, data: { movingAt: null, movedTo: null } }),
    db.companyMove.updateMany({ where: { shopId, direction: "export", status: { not: "cancelled" } }, data: { status: "cancelled", finishedAt: new Date() } }),
  ]);
  // No move file made before works on the hub any more (DELETE /v1/shops/{ref}/move-token; best effort).
  await dropMoveToken(shopId).catch((e) => console.error("company move: dropping the move token:", e instanceof Error ? e.message : e));
}

/**
 * "The move is done" (design section 7): for a company whose hub can't say so (this install is on no hub, or the
 * token was never redeemed), the owner confirms the import on the new side worked. This copy then shows the moved
 * notice and may be deleted after 30 days, as when the hub says it.
 */
export async function confirmMovedOut(user: Mover, shopId: string): Promise<void> {
  const shop = await moveShop(user, shopId);
  if (shop.movedOutAt) throw new UserError("This company has already moved; this copy says so.");
  if (!shop.movingAt) throw new UserError("This company isn't being moved. Prepare the move file first.");
  const done = await db.companyMove.count({ where: { shopId, direction: "export", status: "done" } });
  if (!done) throw new UserError("The move file hasn't been downloaded yet. Download it and import it on the new install first.");
  await db.$transaction([
    db.shop.update({ where: { id: shopId }, data: { movedOutAt: new Date() } }),
    db.companyMove.updateMany({ where: { shopId, direction: "export", hubTokenSealed: { not: null } }, data: { hubTokenSealed: null } }),
  ]);
  console.info(`[move] ${JSON.stringify({ company: shopId, movedOut: "confirmed by hand", by: user.email || user.id })}`);
}

export type MoveView = {
  shop: { id: string; name: string; movingAt: Date | null; movedTo: string | null; movedOutAt: Date | null };
  /** The current export record (the newest not cancelled), or null. */
  move: {
    id: string;
    status: string;
    table: string | null;
    rowsDone: number;
    rowsTotal: number;
    bytes: number;
    error: string | null;
    startedAt: Date;
    finishedAt: Date | null;
    downloadedAt: Date | null;
  } | null;
  /** Paid modules switched on by the hosted administrator: they need a key on the new side (design section 2, notes). */
  needKeys: string[];
  fileName: string;
  /** The move's StitchHub token (package move-hub): whether this install is on a hub, whether the file carries a token, and why not. */
  hub: { onHub: boolean; hasToken: boolean; error: string | null };
  /** The company came here from a move file: how its hub step stands (Re-point the hub). */
  movedIn: HubMoveView;
};

/** Settings → Company's "Move this company" card. Another company's owner: "Company not found." */
export async function moveView(user: Mover, shopId: string): Promise<MoveView> {
  const shop = await moveShop(user, shopId);
  const [row, needKeys, hs, movedIn] = await Promise.all([
    shop.movingAt ? db.companyMove.findFirst({ where: { shopId, direction: "export", status: { not: "cancelled" } }, orderBy: { startedAt: "desc" } }) : null,
    adminModules(shopId),
    db.hubState.findUnique({ where: { id: 1 }, select: { url: true, installKey: true } }),
    hubMoveView(shopId),
  ]);
  return {
    shop: { id: shop.id, name: shop.name, movingAt: shop.movingAt, movedTo: shop.movedTo, movedOutAt: shop.movedOutAt },
    move: row
      ? {
          id: row.id,
          status: row.status,
          table: row.table,
          rowsDone: row.rowsDone,
          rowsTotal: row.rowsTotal,
          bytes: Number(row.bytes),
          error: row.error,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          downloadedAt: row.downloadedAt,
        }
      : null,
    needKeys,
    fileName: moveFileName(shop.name),
    hub: { onHub: !!(hs?.url && hs.installKey), hasToken: !!row?.hubTokenSealed, error: row?.hubError ?? null },
    movedIn,
  };
}

/** Labels of the paid modules that are on here only by the hosted administrator's switch. */
async function adminModules(shopId: string): Promise<string[]> {
  const m = await loadModules(shopId);
  return PAID_MODULE_IDS.filter((id) => m.states[id].active && m.states[id].source === "admin").map((id) => m.states[id].label);
}

// ---------- the file ----------

/**
 * Lines made by the database transaction, read by the download: a bounded queue, so the transaction waits while the
 * browser catches up (a slow connection and a big photo table must not pile the file up in memory), and a download that
 * stops part way stops the transaction too (push() throws, the transaction rolls back, the connection goes back).
 */
class Lines {
  private buf: string[] = [];
  private wake: (() => void) | null = null;
  private room: (() => void) | null = null;
  private ended = false;
  private err: unknown = null;
  closed = false;

  async push(line: string): Promise<void> {
    if (this.closed) throw new Error("the download stopped");
    this.buf.push(line);
    this.wake?.();
    this.wake = null;
    while (this.buf.length >= 64 && !this.closed) await new Promise<void>((r) => (this.room = r));
    if (this.closed) throw new Error("the download stopped");
  }

  end(err?: unknown) {
    this.err = err ?? null;
    this.ended = true;
    this.wake?.();
    this.wake = null;
  }

  async *read(): AsyncGenerator<string> {
    try {
      for (;;) {
        if (this.buf.length) {
          const l = this.buf.shift()!;
          this.room?.();
          this.room = null;
          yield l;
          continue;
        }
        if (this.ended) {
          if (this.err) throw this.err;
          return;
        }
        await new Promise<void>((r) => (this.wake = r));
      }
    } finally {
      this.closed = true;
      this.room?.();
      this.room = null;
    }
  }
}

type Row = Record<string, unknown>;
type Tx = Prisma.TransactionClient;

async function countRows(tx: Tx, t: MoveTable, shopId: string): Promise<number> {
  const r = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t.t}" WHERE ${shopFilterSql(t)}`, shopId);
  return r[0]?.n ?? 0;
}

async function countOther(tx: Tx, table: string, shopId: string): Promise<number> {
  const r = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE "shopId" = $1`, shopId);
  return r[0]?.n ?? 0;
}

/**
 * The columns a page reads: all of them, or (a backup, whose pictures are sent on their own) every column but the Bytes
 * ones, which come out as null with the picture's SHA-256 in `_ref` for the restore to fetch the right object by.
 */
async function selectList(tx: Tx, t: MoveTable, noBytes: boolean): Promise<string> {
  if (!noBytes || !t.bytes?.length) return "*";
  const cols = await tx.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
    t.t,
  );
  return cols.map((c) => (t.bytes!.includes(c.column_name) ? `NULL::bytea AS "${c.column_name}", encode(sha256("${c.column_name}"), 'hex') AS "_ref"` : `"${c.column_name}"`)).join(", ");
}

/** The rows of one table in key order, a page at a time (design 3: 200 a page, 20 for pictures). */
async function* pages(tx: Tx, t: MoveTable, shopId: string, noBytes = false): AsyncGenerator<Row[]> {
  const page = t.page ?? PAGE;
  let after = "";
  const list = await selectList(tx, t, noBytes);
  for (;;) {
    const rows = await tx.$queryRawUnsafe<(Row & { _k: string })[]>(
      `SELECT ${list}, (${t.key}) AS _k FROM "${t.t}" WHERE ${shopFilterSql(t)} AND (${t.key}) > $2 ORDER BY (${t.key}) LIMIT ${page}`,
      shopId,
      after,
    );
    if (!rows.length) return;
    after = rows[rows.length - 1]._k;
    yield rows.map(({ _k, ...r }) => {
      void _k;
      return r;
    });
  }
}

/** What the owner is told at export (design section 2's notes and section 6). */
async function warningsFor(tx: Tx, shop: MoveShop, needKeys: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const label of needKeys) out.push(`${label} is switched on here by the hosted administrator. On the new install it needs a license key.`);
  const [downloads, listings, orders] = await Promise.all([countOther(tx, "ManualDownload", shop.id), countOther(tx, "Listing", shop.id), countOther(tx, "MarketOrder", shop.id)]);
  if (downloads) out.push(`${downloads} manual download record${downloads === 1 ? "" : "s"} stay${downloads === 1 ? "s" : ""} here: they describe this install's manual library.`);
  if (listings || orders)
    out.push(
      `${listings} marketplace listing${listings === 1 ? "" : "s"} and ${orders} order${orders === 1 ? "" : "s"} are the hub's copies and aren't in the file; the hub sends them again after the move.`,
    );
  out.push("The manual library is the PC's folder, not in the file: copy the folder to the new PC, or connect one, and the index is rebuilt at start.");
  out.push("Secrets are left out (the mail password, the Twilio secret, the Stripe keys): enter them again on the new side. Everyone signs in again there.");
  return out;
}

export type ExportProgress = { table: string | null; rowsDone: number; rowsTotal: number; bytes: number };

export type ExportOpts = {
  /** Set Shop.movingAt first if it isn't (the owner's confirm does this already; the CLI may ask for it). */
  freeze?: boolean;
  /** The move record to write progress to (the Settings card reads it). Made when freezing without one. */
  moveId?: string | null;
  /** Called after each page and at the end. */
  onProgress?: (p: ExportProgress) => void;
  /**
   * "backup": an off-site backup (later-round-1-design.md 1.2): the same file with no freeze, no move record and no hub
   * move token, and the picture tables carrying `_ref` (the SHA-256) in place of the bytes. A restore puts the pictures
   * back from their own objects (src/lib/offsite/restore.ts) before the importer sees the file.
   */
  purpose?: "move" | "backup";
};

export type Export = { stream: ReadableStream<Uint8Array>; fileName: string; moveId: string | null };

/**
 * The move file as a gzipped web stream (design section 3): the meta header, every table of MOVE_TABLES in order, the
 * end trailer. Owner or platform administrator only. The transaction runs for as long as the download does; progress
 * (table, rows, gzipped bytes) goes to the CompanyMove row every page, and the row is marked done or failed at the end.
 */
export async function exportCompany(user: Mover, shopId: string, opts: ExportOpts = {}): Promise<Export> {
  const backup = opts.purpose === "backup";
  let shop = await moveShop(user, shopId);
  let moveId = backup ? null : (opts.moveId ?? null);
  if (moveId) {
    const row = await db.companyMove.findFirst({ where: { id: moveId, shopId, direction: "export" }, select: { id: true } });
    if (!row) throw new UserError("That move isn't one of this company's.");
  }
  if (backup) {
    // A backup is a read: it never freezes, and it works while the company is being moved or has moved.
  } else if (opts.freeze && !shop.movingAt) {
    moveId = await startMove(user, shopId);
    shop = await moveShop(user, shopId);
  } else if (!moveId && shop.movingAt) {
    moveId = (await db.companyMove.findFirst({ where: { shopId, direction: "export", status: { not: "cancelled" } }, orderBy: { startedAt: "desc" }, select: { id: true } }))?.id ?? null;
  }
  const needKeys = await adminModules(shopId);
  // A move (frozen, with its record) carries the hub's move token; a copy made without the freeze doesn't (it isn't a
  // move: a token in it would let any copy take the company on the hub).
  const isMove = !backup && !!moveId && !!shop.movingAt && !shop.movedOutAt;
  const tok = isMove ? await moveTokenFor(shopId, moveId!) : { token: null, error: null };
  const lines = new Lines();
  let sent = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sent += chunk.length;
      cb(null, chunk);
    },
  });
  const progress: ExportProgress = { table: null, rowsDone: 0, rowsTotal: 0, bytes: 0 };
  let lastWrite = 0;
  const report = async (force = false) => {
    progress.bytes = sent;
    opts.onProgress?.({ ...progress });
    if (!moveId) return;
    const now = Date.now();
    if (!force && now - lastWrite < 1000) return;
    lastWrite = now;
    await db.companyMove
      .update({ where: { id: moveId }, data: { status: "downloading", table: progress.table, rowsDone: progress.rowsDone, rowsTotal: progress.rowsTotal, bytes: BigInt(sent) } })
      .catch(() => {});
  };

  const produce = async () => {
    await db.$transaction(
      async (tx) => {
        // Prisma can't ask for READ ONLY; set before the first query of the transaction, as Postgres allows.
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        const mig = await tx.$queryRawUnsafe<{ m: string | null }[]>(`SELECT max(migration_name) AS m FROM "_prisma_migrations"`);
        // The install's places in the hub's feeds, from the same snapshot as the company's PartnerSeen rows.
        const hub = hubPart(await tx.hubState.findUnique({ where: { id: 1 } }), tok.token);
        const hubNote = hub && !hub.moveToken && !backup ? hubWarning(true, isMove, tok.error) : null;
        const counts: Record<string, number> = {};
        for (const t of MOVE_TABLES) counts[t.t] = await countRows(tx, t, shop.id);
        progress.rowsTotal = Object.values(counts).reduce((a, b) => a + b, 0);
        const meta: MoveMeta = {
          t: "meta",
          format: MOVE_FORMAT,
          version: MOVE_VERSION,
          program: appName(),
          appVersion: programVersion(),
          lastMigration: mig[0]?.m ?? null,
          exportedAt: new Date().toISOString(),
          shop: { id: shop.id, name: shop.name, kind: shopKindOf(shop) },
          hub,
          leftOut: [...LEFT_OUT],
          warnings: [...(await warningsFor(tx, shop, needKeys)), ...(hubNote ? [hubNote] : [])],
        };
        await lines.push(JSON.stringify(meta) + "\n");
        const tables: Record<string, number> = {};
        let rows = 0;
        for (const t of MOVE_TABLES) {
          progress.table = t.t;
          tables[t.t] = 0;
          for await (const page of pages(tx, t, shop.id, backup)) {
            for (const r of page) await lines.push(JSON.stringify(encodeRow(t, r)) + "\n");
            tables[t.t] += page.length;
            rows += page.length;
            progress.rowsDone = rows;
            await report();
          }
          if (tables[t.t] !== counts[t.t]) throw new Error(`${t.t}: counted ${counts[t.t]} rows, read ${tables[t.t]} (the key "${t.key}" isn't paging every row)`);
        }
        const end: MoveEnd = { t: "end", rows, tables };
        await lines.push(JSON.stringify(end) + "\n");
        progress.table = null;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 20_000, timeout: 24 * 3600_000 },
    );
  };
  produce().then(
    () => lines.end(),
    (e) => lines.end(e),
  );

  const node = pipeline(Readable.from(lines.read()), zlib.createGzip(), counter, (e) => {
    void report(true).then(() => {
      if (!moveId) return;
      const data = e
        ? { status: "failed", error: `The download stopped before the end: ${e.message}`.slice(0, 500), finishedAt: new Date(), bytes: BigInt(sent) }
        : { status: "done", error: null, table: null, finishedAt: new Date(), downloadedAt: new Date(), bytes: BigInt(sent), rowsDone: progress.rowsDone, rowsTotal: progress.rowsTotal };
      db.companyMove.update({ where: { id: moveId }, data }).catch(() => {});
    });
    if (e) console.error("company export stopped:", e.message);
  });
  return { stream: Readable.toWeb(node) as ReadableStream<Uint8Array>, fileName: moveFileName(shop.name), moveId };
}
