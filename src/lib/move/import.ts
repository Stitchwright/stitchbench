import "server-only";
// Moving a company in (company-move-design.md sections 4 and 8, package move-import): one move file, made by
// src/lib/move/export.ts on another install, becomes a company here with every id it had. Two passes over the file:
// the first checks everything and writes nothing (the refusals of section 4, each in the owner's words), the second
// inserts every row in file order (parents first) in one transaction, so a file that is wrong anywhere leaves this
// install exactly as it was. The doors: the hosted Companies page (src/lib/move/upload.ts, chunked upload to a spool
// file), the Windows program's tray (src/lib/move/local.ts, the server reads the file from disk) and the CLI
// (scripts/move/import.ts). Once the transaction has committed, the hub is told the company is here now (package
// move-hub, src/lib/move/hub-step.ts); a hub that can't be reached never undoes the import.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { under } from "@/lib/opaque-path";
import zlib from "node:zlib";
import { Readable, Transform, pipeline } from "node:stream";
import { pipeline as pipelineAsync } from "node:stream/promises";
import type { ReadableStream as WebReadable } from "node:stream/web";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isUserError, UserError } from "@/lib/user-error";
import { isPlatformAdmin } from "@/lib/shops";
import { isDesktop } from "@/lib/modules";
import type { CurrentUser } from "@/lib/session";
import {
  checkMeta,
  decodeRow,
  MAX_INFLATED,
  MAX_LINE,
  MOVE_FORMAT,
  MOVE_SUFFIX,
  MOVE_TABLES,
  MOVE_VERSION,
  PAGE,
  parseLine,
  type MoveEnd,
  type MoveMeta,
  type MoveRow,
  type MoveTable,
} from "./format";
import { hubStepAfterImport, type HubStep } from "./hub-step";

/** Who imports: the StitchBench administrator (hosted, signed in), or whoever runs the PC or the server ("operator"). */
export type Importer = CurrentUser | "operator";

export type ImportProgress = {
  /** checking: the first pass (nothing written); importing: the second, in one transaction. */
  phase: "checking" | "importing";
  table: string | null;
  rowsDone: number;
  rowsTotal: number;
  /** Packed bytes read in this pass, of bytesTotal. */
  bytesRead: number;
  bytesTotal: number;
};

export type ImportSummary = {
  shopId: string;
  shopName: string;
  kind: string;
  /** "StitchBench 1.6.1, exported 2026-10-02": Shop.movedFrom. */
  from: string;
  exportedAt: string;
  rows: number;
  tables: Record<string, number>;
  /** The owners' logins, to say who signs in first. */
  owners: string[];
  /** What the owner enters again here (design section 3: secrets left out). */
  reenter: string[];
  /** What the import changed or what changes with the host. */
  notes: string[];
  /** The export's own warnings, from the file's header (modules that need a key, the library, the hub's copies). */
  warnings: string[];
  /** The public booking / shop address the file had, cleared because another company here has it. */
  bookingSlugCleared: string | null;
  /** The hub step (package move-hub): StitchHub told the company is here now, or why not and what to do. */
  hub: HubStep;
};

export const ONLY_ADMIN = "Only the StitchBench administrator can import a company.";
export const ONE_COMPANY =
  "This program already has a company. A move file brings a company to a PC that has none yet. To keep several companies on one PC, set platformAdminEmails in the settings file first (see INSTALL.md).";
const NOT_MOVE_FILE = `This isn't a StitchBench move file. Choose the file the other install made (its name ends with ${MOVE_SUFFIX}).`;
const AGAIN = "Download the move file again from the other install.";

/** Where uploads and stream sources are spooled before an import (the OS temp folder; swept after 24 hours). */
export function spoolDir(): string {
  return under(os.tmpdir(), "stitchbench-move");
}

/** The install is set up to host several companies (PLATFORM_ADMIN_EMAILS set; design decision 13). */
export function hostsMany(): boolean {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").some((s) => s.trim());
}

/** Refusal 7: the Windows program takes a company from a move file only while it has none, or when set up to host several. */
async function pcRule(count: () => Promise<number>): Promise<void> {
  if (isDesktop() && !hostsMany() && (await count()) > 0) throw new UserError(ONE_COMPANY);
}

// ---------- reading the file ----------

type Tap = { hash: crypto.Hash; bytes: number };

function unpackError(e: unknown): UserError {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") return new UserError("The move file isn't there any more. Choose it again.");
  if (err?.code === "Z_DATA_ERROR" && /header/i.test(err.message)) return new UserError(NOT_MOVE_FILE);
  return new UserError(`The move file is damaged or cut short: it doesn't unpack (${err?.message ?? String(e)}). ${AGAIN}`);
}

/**
 * The file's lines, unpacked, one at a time: flat memory (a line, one row or one photo, is at most MAX_LINE), the whole
 * file held to MAX_INFLATED. The tap sees the packed bytes (the hash that tells the second pass it reads the same file).
 */
async function* fileLines(file: string, tap: Tap): AsyncGenerator<string> {
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      tap.hash.update(chunk);
      tap.bytes += chunk.length;
      cb(null, chunk);
    },
  });
  const out = pipeline(fs.createReadStream(file), counter, zlib.createGunzip(), () => {});
  let parts: Buffer[] = [];
  let len = 0;
  let inflated = 0;
  let no = 0;
  const iterator = (out as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  try {
    for (;;) {
      let next: IteratorResult<Buffer>;
      try {
        next = await iterator.next();
      } catch (e) {
        throw unpackError(e);
      }
      if (next.done) break;
      const chunk = next.value;
      inflated += chunk.length;
      if (inflated > MAX_INFLATED) throw new UserError(`The move file unpacks to more than ${MAX_INFLATED / 1024 ** 3} GB, more than a move file can hold: it is damaged. ${AGAIN}`);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start);
        const end = nl < 0 ? chunk.length : nl;
        len += end - start;
        if (len > MAX_LINE) throw new UserError(`Line ${no + 1} of the move file is longer than ${MAX_LINE / 1024 / 1024} MB: the file is damaged. ${AGAIN}`);
        if (end > start) parts.push(chunk.subarray(start, end));
        if (nl < 0) break;
        no += 1;
        const text = Buffer.concat(parts, len).toString("utf8");
        parts = [];
        len = 0;
        start = nl + 1;
        yield text;
      }
    }
    // A last line without its newline: the export always ends with one, so this is a file cut short (parsing says so).
    if (len > 0) yield Buffer.concat(parts, len).toString("utf8");
  } finally {
    // Stopped early (a refusal) or not: the file is let go, so it can be deleted (Windows keeps an open file).
    await iterator.return?.().catch(() => {});
  }
}

function parse(text: string, no: number) {
  try {
    return parseLine(text, no);
  } catch (e) {
    throw new UserError(no === 1 ? NOT_MOVE_FILE : `The move file is damaged: ${(e as Error).message}. ${AGAIN}`);
  }
}

// ---------- what this install knows ----------

/** The columns this program knows for a model (what createMany takes): Prisma's own list. */
function knownColumns(model: string): Set<string> {
  const e = (Prisma as unknown as Record<string, Record<string, string> | undefined>)[`${model}ScalarFieldEnum`];
  if (!e) throw new Error(`no field list for ${model}`);
  return new Set(Object.values(e));
}

type Schema = {
  known: Map<string, Set<string>>;
  /** Json columns per table: a null there goes in as the database's NULL (Prisma.DbNull). */
  json: Map<string, Set<string>>;
  /** List columns per table: Prisma takes no null for one, so a null is left out of the insert (the database's NULL). */
  lists: Map<string, Set<string>>;
  /** Foreign keys other than shopId, per table: column → "Table.column" it names (all within the moved tables). */
  fks: Map<string, { column: string; ref: string }[]>;
  /** "Table.column" that some foreign key names: the first pass keeps these values to check children against. */
  refs: Set<string>;
  /** Tables with a shopId but no foreign key to Shop (PartnerSeen, PartnerFailure): deleting a company leaves their rows. */
  loose: string[];
};

async function schemaHere(): Promise<Schema> {
  const moved = new Set(MOVE_TABLES.map((t) => t.t));
  const known = new Map(MOVE_TABLES.map((t) => [t.t, knownColumns(t.t)]));
  const typed = await db.$queryRawUnsafe<{ t: string; c: string; k: string }[]>(
    `SELECT table_name AS t, column_name AS c, data_type AS k FROM information_schema.columns WHERE table_schema = current_schema() AND data_type IN ('json', 'jsonb', 'ARRAY')`,
  );
  const json = new Map<string, Set<string>>();
  const lists = new Map<string, Set<string>>();
  for (const r of typed) {
    if (!moved.has(r.t)) continue;
    const into = r.k === "ARRAY" ? lists : json;
    into.set(r.t, (into.get(r.t) ?? new Set()).add(r.c));
  }
  const fkRows = await db.$queryRawUnsafe<{ t: string; c: string; rt: string; rc: string }[]>(
    `SELECT kcu.table_name AS t, kcu.column_name AS c, ccu.table_name AS rt, ccu.column_name AS rc
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()`,
  );
  const fks = new Map<string, { column: string; ref: string }[]>();
  const refs = new Set<string>();
  const tied = new Set(fkRows.filter((r) => r.c === "shopId" && r.rt === "Shop").map((r) => r.t));
  const loose = MOVE_TABLES.filter((t) => !t.via && t.t !== "Shop" && known.get(t.t)!.has("shopId") && !tied.has(t.t)).map((t) => t.t);
  for (const r of fkRows) {
    // shopId is checked against the header; a key into a table that isn't moved (none today) isn't the file's to keep.
    if (!moved.has(r.t) || !moved.has(r.rt) || r.c === "shopId") continue;
    const ref = `${r.rt}.${r.rc}`;
    fks.set(r.t, [...(fks.get(r.t) ?? []), { column: r.c, ref }]);
    refs.add(ref);
  }
  return { known, json, lists, fks, refs, loose };
}

async function migrationsHere(): Promise<{ have: Set<string>; newest: string | null }> {
  const rows = await db.$queryRawUnsafe<{ m: string }[]>(`SELECT migration_name AS m FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
  const have = new Set(rows.map((r) => r.m));
  return { have, newest: [...have].sort().at(-1) ?? null };
}

// ---------- the first pass: check everything, write nothing ----------

type Plan = {
  meta: MoveMeta;
  tables: Record<string, number>;
  rows: number;
  bytes: number;
  hash: string;
  shop: MoveRow;
  messaging: MoveRow | null;
  owners: string[];
  openEstimates: number;
  slugTaken: boolean;
  json: Map<string, Set<string>>;
  lists: Map<string, Set<string>>;
  loose: string[];
};

const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function checkFile(file: string, now: Date, onProgress?: (p: ImportProgress) => void): Promise<Plan> {
  const bytesTotal = fs.statSync(file).size;
  const schema = await schemaHere();
  const order = new Map(MOVE_TABLES.map((t, i) => [t.t, i]));
  const byName = new Map(MOVE_TABLES.map((t) => [t.t, t]));
  const seen = new Map<string, Set<string>>([...schema.refs].map((r) => [r, new Set<string>()]));
  const keep = new Map<string, string[]>(); // table → the referenced columns its rows' values are kept for
  for (const r of schema.refs) {
    const [t, c] = r.split(".");
    keep.set(t, [...(keep.get(t) ?? []), c]);
  }
  const tap: Tap = { hash: crypto.createHash("sha256"), bytes: 0 };
  const counts: Record<string, number> = {};
  const unknown = new Set<string>();
  const emails: string[] = [];
  const owners: string[] = [];
  let meta: MoveMeta | null = null;
  let end: MoveEnd | null = null;
  let shop: MoveRow | null = null;
  let messaging: MoveRow | null = null;
  let openEstimates = 0;
  let current = -1;
  let rows = 0;
  let no = 0;
  let lastReport = 0;
  const report = (table: string | null) => onProgress?.({ phase: "checking", table, rowsDone: rows, rowsTotal: 0, bytesRead: tap.bytes, bytesTotal });

  for await (const text of fileLines(file, tap)) {
    no += 1;
    const line = parse(text, no);
    if (no === 1) {
      if (line.t !== "meta" || (line as MoveMeta).format !== MOVE_FORMAT) throw new UserError(NOT_MOVE_FILE);
      const m = line as MoveMeta;
      if (Number.isInteger(m.version) && m.version > MOVE_VERSION) {
        throw new UserError(`This move file was made by a newer program (move file version ${m.version}; this one reads version ${MOVE_VERSION}). Update this program first, then import.`);
      }
      if (!checkMeta(m)) throw new UserError(NOT_MOVE_FILE);
      if (typeof m.lastMigration !== "string" || !m.lastMigration) throw new UserError(`The move file doesn't say which database version it was taken at, so it isn't a whole move file. ${AGAIN}`);
      // Refusal 2, by name: the file's last migration must be one this database has (a newer one here is fine).
      const mig = await migrationsHere();
      if (!mig.have.has(m.lastMigration)) {
        throw new UserError(
          `This move file was taken at database version ${m.lastMigration}, which this program doesn't have (it is at ${mig.newest ?? "none"}). Update this program first, then import.`,
        );
      }
      // Refusal 3: a move is never a merge.
      const there = await db.shop.findUnique({ where: { id: m.shop.id }, select: { name: true } });
      if (there) {
        throw new UserError(`The company "${there.name}" (${m.shop.id}) is already on this install. A move never merges: if the company is coming back here, delete the copy here first, then import.`);
      }
      meta = m;
      report(null);
      continue;
    }
    if (!meta) throw new UserError(NOT_MOVE_FILE);
    if (end) throw new UserError(`The move file has lines after its end line: it has been changed. ${AGAIN}`);
    if (line.t === "end") {
      end = line as MoveEnd;
      continue;
    }
    if (line.t === "meta") throw new UserError(`The move file has a second header at line ${no}: it has been changed. ${AGAIN}`);
    const row = line as MoveRow;
    const t = byName.get(row.t);
    if (!t) throw new UserError(`Line ${no} of the move file is a ${row.t} row, which isn't part of a company this program knows. Update this program first, then import.`);
    // Parents first: a table's rows come together and in the export's order.
    const at = order.get(t.t)!;
    if (at < current) throw new UserError(`The move file's rows are out of order at line ${no} (${t.t}): it has been changed. ${AGAIN}`);
    current = at;
    // Refusal 5: every row is the header's company's.
    if (t.t === "Shop") {
      if (shop || rows > 0) throw new UserError(`The move file holds more than one company (line ${no}): it has been changed. ${AGAIN}`);
      if (row.id !== meta.shop.id) throw new UserError(`The move file's company row doesn't match its header (line ${no}): it has been changed. ${AGAIN}`);
      shop = row;
    } else {
      if (!shop) throw new UserError(`The move file has no company row before line ${no}: it has been changed. ${AGAIN}`);
      if (!t.via && row.shopId !== meta.shop.id) throw new UserError(`Line ${no} of the move file (${t.t}) belongs to another company: the file has been changed. ${AGAIN}`);
    }
    const known = schema.known.get(t.t)!;
    for (const k of Object.keys(row)) if (k !== "t" && !known.has(k)) unknown.add(`${t.t}.${k}`);
    for (const fk of schema.fks.get(t.t) ?? []) {
      const v = row[fk.column];
      if (v == null) continue;
      if (!seen.get(fk.ref)!.has(String(v))) {
        const parent = fk.ref.split(".")[0];
        throw new UserError(`Line ${no} of the move file (${t.t}) names a ${parent} that isn't in the file (${fk.column} ${String(v)}): the file has been changed. ${AGAIN}`);
      }
    }
    for (const c of keep.get(t.t) ?? []) if (row[c] != null) seen.get(`${t.t}.${c}`)!.add(String(row[c]));
    if (t.t === "User" && typeof row.email === "string") {
      emails.push(row.email);
      if (row.role === "OWNER") owners.push(row.email);
    }
    if (t.t === "MessagingSettings") messaging = row;
    if (t.t === "EstimateLink" && row.answer == null && row.revokedAt == null && typeof row.expiresAt === "string" && Date.parse(row.expiresAt) > now.getTime()) openEstimates += 1;
    counts[t.t] = (counts[t.t] ?? 0) + 1;
    rows += 1;
    if (tap.bytes - lastReport > 1024 * 1024) {
      lastReport = tap.bytes;
      report(t.t);
    }
  }

  if (!meta) throw new UserError(NOT_MOVE_FILE);
  // Refusal 6: the end line says the file is whole, and its counts are the rows'.
  if (!end) throw new UserError(`The move file is cut short: its last line is missing. ${AGAIN}`);
  if (!shop) throw new UserError(`The move file has no company in it. ${AGAIN}`);
  const said = end.tables && typeof end.tables === "object" ? end.tables : {};
  const wrong: string[] = [];
  for (const k of Object.keys(said)) if (!byName.has(k)) wrong.push(`${k}: says ${said[k]}, not a table of a company`);
  for (const t of MOVE_TABLES) {
    const want = Number(said[t.t] ?? 0);
    const have = counts[t.t] ?? 0;
    if (want !== have) wrong.push(`${t.t}: says ${want}, has ${have}`);
  }
  if (end.rows !== rows) wrong.push(`rows in all: says ${end.rows}, has ${rows}`);
  if (wrong.length) throw new UserError(`The move file's counts don't match its rows (${wrong.slice(0, 5).join("; ")}): it has been cut or changed. ${AGAIN}`);
  // Columns this program doesn't know, by name (as restoring a backup refuses them).
  if (unknown.size) {
    throw new UserError(`The move file has ${unknown.size === 1 ? "a column" : "columns"} this version doesn't know: ${[...unknown].slice(0, 10).join(", ")}. Update this program first, then import.`);
  }
  // A login with a reserved (StitchBench administrator) address would make a platform administrator: refused, as sign-up is.
  const reserved = [...new Set(emails.filter((e) => isPlatformAdmin(e)).map((e) => e.toLowerCase()))];
  if (reserved.length) {
    throw new UserError(`The move file has a login whose email address is reserved on this StitchBench (${reserved.join(", ")}). Change it on the other install (Settings → People), make the move file again, then import.`);
  }
  // Refusal 4: login emails are unique on an install (HANDOFF 2c L7/L31 not built).
  if (emails.length) {
    const taken = await db.$queryRawUnsafe<{ email: string }[]>(`SELECT email FROM "User" WHERE lower(email) = ANY($1::text[]) ORDER BY email`, [...new Set(emails.map((e) => e.toLowerCase()))]);
    if (taken.length) {
      throw new UserError(
        `${taken.length === 1 ? "This login's email address is" : "These logins' email addresses are"} already used on this install: ${taken.map((r) => r.email).join(", ")}. Change ${taken.length === 1 ? "it" : "them"} on the other install (Settings → People), make the move file again, then import.`,
      );
    }
  }
  const slug = typeof shop.bookingSlug === "string" ? shop.bookingSlug : null;
  const slugTaken = !!slug && !!(await db.shop.findFirst({ where: { bookingSlug: slug }, select: { id: true } }));
  report(null);
  return { meta, tables: counts, rows, bytes: tap.bytes, hash: tap.hash.digest("hex"), shop, messaging, owners, openEstimates, slugTaken, json: schema.json, lists: schema.lists, loose: schema.loose };
}

// ---------- the second pass: one transaction of plain inserts ----------

type Tx = Prisma.TransactionClient;
type Creatable = { createMany(args: { data: Record<string, unknown>[] }): Promise<{ count: number }> };

function delegate(tx: Tx, model: string): Creatable {
  const d = (tx as unknown as Record<string, Creatable | undefined>)[model[0].toLowerCase() + model.slice(1)];
  if (!d) throw new Error(`no model ${model}`);
  return d;
}

/** A failed insert in the owner's words: an id or code already used here (refused, design 4: no ON CONFLICT), or a missing parent. */
function insertError(table: string, e: unknown): unknown {
  const err = e as { code?: string; meta?: Record<string, unknown> };
  const meta = err?.meta ?? {};
  const cause = (meta.driverAdapterError as { cause?: { constraint?: { fields?: string[]; index?: string } } } | undefined)?.cause?.constraint;
  const fields = cause?.fields ?? (Array.isArray(meta.target) ? (meta.target as string[]) : typeof meta.target === "string" ? [meta.target] : []);
  const what = fields.length ? ` (${fields.join(", ")})` : cause?.index ? ` (${cause.index})` : "";
  if (err?.code === "P2002") return new UserError(`A ${table} row in the move file has an id or code that is already used on this install${what}. Nothing was imported.`);
  if (err?.code === "P2003") return new UserError(`A ${table} row in the move file names a row that isn't there${what}. Nothing was imported.`);
  return e;
}

function fromText(meta: MoveMeta): string {
  return `${meta.program}${meta.appVersion ? ` ${meta.appVersion}` : ""}, exported ${String(meta.exportedAt).slice(0, 10)}`.slice(0, 200);
}

/** A row as it goes in: Bytes decoded, a Json or list null as the database's NULL, and the import's own changes (design 3 and 4). */
function prepare(t: MoveTable, line: MoveRow, plan: Plan, now: Date): Record<string, unknown> {
  const row = decodeRow(t, line);
  for (const c of plan.json.get(t.t) ?? []) if (c in row && row[c] === null) row[c] = Prisma.DbNull;
  for (const c of plan.lists.get(t.t) ?? []) if (c in row && row[c] === null) delete row[c];
  if (t.t === "Shop") {
    // The secrets are null in the file already; the online shop waits for its Stripe keys; this copy came in by a move.
    Object.assign(row, { shopOn: false, movingAt: null, movedOutAt: null, movedTo: null, movedInAt: now, movedFrom: fromText(plan.meta) });
    if (plan.slugTaken) row.bookingSlug = null;
  }
  if (t.t === "MessagingSettings") {
    // Off until the mail password / Twilio token are entered again; marketing held and text replies re-read, as a restore does.
    Object.assign(row, { emailOn: false, smsOn: false, marketingHoldAt: now, inboundAt: null, inboundIncomplete: 0 });
  }
  return row;
}

/** Answers the id of the company's own move record (the hub step writes to it). */
async function insertFile(file: string, plan: Plan, by: Importer, now: Date, onProgress?: (p: ImportProgress) => void): Promise<string> {
  const shopId = plan.meta.shop.id;
  const byName = new Map(MOVE_TABLES.map((t) => [t.t, t]));
  return db.$transaction(
    async (tx) => {
      // A copy of this company deleted here earlier (it is coming back) leaves the rows of the tables without a foreign
      // key to Shop (the partner messages it had applied, the ones that failed): the file's are the company's now.
      for (const t of plan.loose) await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "shopId" = $1`, shopId);
      const tap: Tap = { hash: crypto.createHash("sha256"), bytes: 0 };
      let batch: Record<string, unknown>[] = [];
      let table: MoveTable | null = null;
      let done = 0;
      const flush = async () => {
        if (!table || !batch.length) return;
        try {
          await delegate(tx, table.t).createMany({ data: batch });
        } catch (e) {
          throw insertError(table.t, e);
        }
        done += batch.length;
        batch = [];
        onProgress?.({ phase: "importing", table: table.t, rowsDone: done, rowsTotal: plan.rows, bytesRead: tap.bytes, bytesTotal: plan.bytes });
      };
      let no = 0;
      for await (const text of fileLines(file, tap)) {
        no += 1;
        if (no === 1) continue; // the header, checked
        const line = parse(text, no);
        if (line.t === "end") continue;
        const t = byName.get(line.t);
        if (!t) throw new UserError(`The move file changed while it was being imported. Nothing was imported; import it again.`);
        if (table && table.t !== t.t) await flush();
        table = t;
        batch.push(prepare(t, line as MoveRow, plan, now));
        if (batch.length >= (t.page ?? PAGE)) await flush();
      }
      await flush();
      // The same file as the first pass checked, byte for byte; otherwise none of it goes in.
      if (tap.hash.digest("hex") !== plan.hash || done !== plan.rows) throw new UserError("The move file changed while it was being imported. Nothing was imported; import it again.");
      // A message claimed for sending on the old install may have gone: marketing is never sent twice, a notice is
      // queued again and the worker's own check drops it if it no longer applies (as a restore does).
      await tx.outMessage.updateMany({
        where: { shopId, status: "SENDING", purpose: "marketing" },
        data: { status: "CANCELLED", error: "Not sent: the company moved while it was being sent (it may have gone out already)" },
      });
      await tx.outMessage.updateMany({ where: { shopId, status: "SENDING", purpose: "notice" }, data: { status: "QUEUED", claimedAt: null, nextTryAt: null } });
      const row = await tx.companyMove.create({
        data: {
          shopId,
          direction: "import",
          status: "done",
          rowsDone: plan.rows,
          rowsTotal: plan.rows,
          bytes: BigInt(plan.bytes),
          startedAt: now,
          finishedAt: new Date(),
          byUserId: by === "operator" ? null : by.id,
        },
        select: { id: true },
      });
      // One company at a time, decided under the same lock as sign-up (createShopWithOwner), held only to the commit.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(7710001)`);
      await pcRule(async () => tx.shop.count({ where: { id: { not: shopId } } }));
      return row.id;
    },
    { maxWait: 20_000, timeout: 24 * 3600_000 },
  );
}

// ---------- the summary ----------

function summarize(plan: Plan, hub: HubStep): ImportSummary {
  const { meta, shop, messaging: ms } = plan;
  const reenter: string[] = [];
  const notes: string[] = [];
  if (ms && (ms.smtpHost || ms.emailOn)) reenter.push("The mail password: Settings → Messages → Email, then switch email on again.");
  if (ms && (ms.twilioSid || ms.smsOn)) reenter.push("The Twilio auth token: Settings → Messages → Texts, then switch texting on again.");
  if (shop.shopOn) {
    reenter.push(
      shop.shopPayVia === "platform"
        ? "Switch the online shop on again: Settings → Online shop."
        : "The Stripe secret key and webhook secret: Settings → Online shop (the webhook address is this install's now), then switch the online shop on again.",
    );
  }
  if (plan.openEstimates) {
    reenter.push(
      `${s(plan.openEstimates, "estimate link")} still waiting for the customer's answer: send ${plan.openEstimates === 1 ? "it" : "them"} again from the ticket (links already sent open only on the old install).`,
    );
  }
  reenter.push("Everyone signs in again here, with the same email and password.");
  if (ms) notes.push("Email and texting are switched off until their secrets are entered, and marketing is on hold until an owner or admin checks Messages → Opt-outs and presses Resume.");
  const slug = typeof shop.bookingSlug === "string" ? shop.bookingSlug : null;
  if (plan.slugTaken && slug) notes.push(`The online booking and shop address "${slug}" is taken by another company here, so it was cleared: choose a new one in Settings → Online booking.`);
  else if (slug) notes.push(`Online booking and the online shop answer at this install's address now (/book/${slug}): give customers the new link.`);
  // The hub step's outcome in the owner's words (it always names StitchHub); nothing to say for a company that was on no
  // hub and has nothing of a hub's.
  if (hub.status !== "none" || (plan.tables.PartnerLink ?? 0) > 0 || (plan.tables.SharedPost ?? 0) > 0) notes.push(hub.message);
  return {
    shopId: meta.shop.id,
    shopName: typeof shop.name === "string" ? shop.name : meta.shop.name,
    kind: meta.shop.kind,
    from: fromText(meta),
    exportedAt: meta.exportedAt,
    rows: plan.rows,
    tables: Object.fromEntries(MOVE_TABLES.map((t) => [t.t, plan.tables[t.t] ?? 0])),
    owners: plan.owners,
    reenter,
    notes,
    warnings: Array.isArray(meta.warnings) ? meta.warnings.filter((w) => typeof w === "string") : [],
    bookingSlugCleared: plan.slugTaken ? slug : null,
    hub,
  };
}

// ---------- the import ----------

export type ImportOpts = { by: Importer; now?: Date; onProgress?: (p: ImportProgress) => void };

/**
 * A company from a move file: the file on disk (a path), or a stream (spooled to the temp folder first, since the file
 * is read twice). Refused before any write, with the reason (design section 4): not a move file or a newer version; this
 * database behind the file's migration; the company already here; a login email already used here; a row of another
 * company, a child without its parent, a column this version doesn't know; no end line or counts that don't match;
 * on the Windows program, a company already here without platformAdminEmails; and anyone but the StitchBench
 * administrator (or the operator). Then one transaction in file order with every id kept.
 */
export async function importCompany(source: string | Readable | ReadableStream<Uint8Array>, opts: ImportOpts): Promise<ImportSummary> {
  const { by } = opts;
  const now = opts.now ?? new Date();
  if (by !== "operator" && !isPlatformAdmin(by.email)) throw new UserError(ONLY_ADMIN);
  await pcRule(() => db.shop.count());
  if (typeof source !== "string") {
    fs.mkdirSync(spoolDir(), { recursive: true });
    const tmp = under(spoolDir(), `stream-${crypto.randomBytes(9).toString("hex")}${MOVE_SUFFIX}`);
    const node = typeof (source as ReadableStream<Uint8Array>).getReader === "function" ? Readable.fromWeb(source as unknown as WebReadable<Uint8Array>) : (source as Readable);
    try {
      await pipelineAsync(node, fs.createWriteStream(tmp));
      return await importFile(tmp, by, now, opts.onProgress);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return importFile(source, by, now, opts.onProgress);
}

async function importFile(file: string, by: Importer, now: Date, onProgress?: (p: ImportProgress) => void): Promise<ImportSummary> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new UserError("The move file isn't there any more. Choose it again.");
  }
  if (!stat.isFile() || stat.size === 0) throw new UserError(NOT_MOVE_FILE);
  const plan = await checkFile(file, now, onProgress);
  let moveId: string;
  try {
    moveId = await insertFile(file, plan, by, now, onProgress);
  } catch (e) {
    if (isUserError(e)) throw e;
    // The transaction rolled back: nothing of the company is here. The reason goes to the log as it came.
    console.error("company import failed:", e);
    throw new UserError(`The import stopped and nothing was imported: ${e instanceof Error ? e.message.split("\n").filter(Boolean).at(-1) : String(e)}`);
  }
  // The company is in. The hub is told (it never throws: a hub that can't be reached is said, and retried by hand).
  const hub = await hubStepAfterImport(plan.meta.shop.id, moveId, plan.meta);
  return summarize(plan, hub);
}
