import "server-only";
// The hosted Companies page's "Import a company" (company-move-design.md section 8 and decision 8): the StitchBench
// administrator's browser sends the move file in 8 MB parts (UPLOAD_CHUNK, under the 16 MB request limit), each part
// appended to a spool file in the server's temp folder; a dropped connection or a reload carries on from the last whole
// part (choose the same file again: the same name and size find the same upload). Then the same importCompany as every
// door, in the background (import-jobs.ts). The upload is a CompanyMove row (direction "import") on the administrator's
// own company: it survives a reload, and only that company's administrator sees it. The spool file is deleted once the
// company is in, kept after a refusal so it can be tried again, and swept after 24 hours either way.
import fs from "node:fs";
import path from "node:path";
import type { CompanyMove } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { isPlatformAdmin } from "@/lib/shops";
import type { CurrentUser } from "@/lib/session";
import { MAX_UPLOAD, UPLOAD_CHUNK } from "./format";
import { ONLY_ADMIN, spoolDir, type ImportSummary } from "./import";
import { BUSY, importJob, removeFile, runningImport, startImportJob } from "./import-jobs";

export const IMPORT_NOT_FOUND = "Import not found.";
const STOPPED = "The import stopped part way when the server restarted. Nothing was imported; import it again.";
const DAY = 24 * 3600_000;

export type UploadStatus = "uploading" | "checking" | "importing" | "done" | "failed" | "cancelled" | "expired";

/** An upload as the Companies page sees it (dates as ISO text: it goes to the browser as JSON). */
export type UploadView = {
  id: string;
  name: string;
  size: number;
  received: number;
  status: UploadStatus;
  table: string | null;
  rowsDone: number;
  rowsTotal: number;
  bytesRead: number;
  bytesTotal: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** The file is still here after a refusal: "Import again" without uploading again. */
  canRetry: boolean;
  /** What came in and what to enter again (while this server remembers the job). */
  summary: ImportSummary | null;
};

type Side = { name: string; size: number };

const spoolFile = (id: string) => path.join(spoolDir(), `${id}.upload`);
const sideFile = (id: string) => path.join(spoolDir(), `${id}.json`);

function readSide(id: string): Side | null {
  try {
    const j = JSON.parse(fs.readFileSync(sideFile(id), "utf8")) as Partial<Side>;
    if (typeof j.name === "string" && Number.isSafeInteger(j.size)) return { name: j.name, size: j.size as number };
  } catch {
    /* gone: swept, or the server's temp folder was emptied */
  }
  return null;
}

function sizeOf(file: string | null): number {
  if (!file) return 0;
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

function admin(user: CurrentUser) {
  if (!isPlatformAdmin(user.email)) throw new UserError(ONLY_ADMIN);
}

/** The administrator's own upload by id; anyone else's (another company's, or not an upload) is "Import not found." */
async function own(user: CurrentUser, id: unknown): Promise<CompanyMove> {
  admin(user);
  const row = typeof id === "string" && id ? await db.companyMove.findFirst({ where: { id, shopId: user.shopId, direction: "import", byUserId: user.id } }) : null;
  if (!row) throw new UserError(IMPORT_NOT_FOUND);
  return row;
}

async function view(row: CompanyMove): Promise<UploadView> {
  const running = row.status === "checking" || row.status === "importing";
  const job = running || row.status === "done" || row.status === "failed" ? importJob(row.id) : null;
  if (running && !job) {
    // The row says running, but this server has no such job: it restarted part way (one transaction, nothing written).
    row = await db.companyMove.update({ where: { id: row.id }, data: { status: "failed", error: STOPPED, finishedAt: new Date() } });
  }
  const side = readSide(row.id);
  const status = (job ? job.status : row.status) as UploadStatus;
  return {
    id: row.id,
    name: side?.name ?? "move file",
    size: side?.size ?? Number(row.bytes),
    received: Number(row.bytes),
    status,
    table: job ? job.table : row.table,
    rowsDone: job ? job.rowsDone : row.rowsDone,
    rowsTotal: job ? job.rowsTotal : row.rowsTotal,
    bytesRead: job?.bytesRead ?? 0,
    bytesTotal: job?.bytesTotal ?? 0,
    error: job ? job.error : row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: (job?.finishedAt ?? row.finishedAt)?.toISOString() ?? null,
    canRetry: status === "failed" && !!side && !!row.filePath && sizeOf(row.filePath) === side.size,
    summary: job?.summary ?? null,
  };
}

/**
 * The administrator chooses a file: a new upload, or the one already part way for the same file (name and size), so
 * a reload or a dropped connection carries on where it stopped.
 */
export async function startUpload(user: CurrentUser, input: { name?: unknown; size?: unknown }): Promise<UploadView> {
  admin(user);
  await sweepUploads();
  const name =
    path
      .basename(String(input.name ?? ""))
      .replace(/[\u0000-\u001f]/g, "")
      .slice(0, 200) || "move file";
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new UserError("Choose the move file.");
  if (size > MAX_UPLOAD) throw new UserError(`That file is bigger than a move file can be (${MAX_UPLOAD / 1024 ** 3} GB).`);
  const open = await db.companyMove.findMany({ where: { shopId: user.shopId, direction: "import", status: "uploading", byUserId: user.id }, orderBy: { startedAt: "desc" } });
  for (const row of open) {
    const side = readSide(row.id);
    if (side && side.name === name && side.size === size && row.filePath && fs.existsSync(row.filePath)) return view(row);
  }
  fs.mkdirSync(spoolDir(), { recursive: true });
  const row = await db.companyMove.create({ data: { shopId: user.shopId, direction: "import", status: "uploading", byUserId: user.id } });
  const file = spoolFile(row.id);
  fs.writeFileSync(sideFile(row.id), JSON.stringify({ name, size } satisfies Side));
  fs.writeFileSync(file, "");
  return view(await db.companyMove.update({ where: { id: row.id }, data: { filePath: file } }));
}

function locks(): Set<string> {
  const g = globalThis as unknown as { __moveUploadLocks?: Set<string> };
  return (g.__moveUploadLocks ??= new Set());
}

/**
 * Part n of the file (n * UPLOAD_CHUNK bytes in). Parts go on in order: one already here is accepted again (a retry
 * after a lost answer), one ahead of what is here answers ok: false with what the server has, so the browser goes back.
 */
export async function putChunk(user: CurrentUser, id: unknown, n: number, data: Uint8Array): Promise<{ ok: boolean; received: number }> {
  const row = await own(user, id);
  if (row.status !== "uploading" || !row.filePath) throw new UserError("This upload is finished. Choose the file again to start another.");
  const side = readSide(row.id);
  if (!side) throw new UserError(IMPORT_NOT_FOUND);
  if (!Number.isSafeInteger(n) || n < 0) throw new UserError("That part number is wrong.");
  const offset = n * UPLOAD_CHUNK;
  const end = offset + data.length;
  if (data.length === 0 || data.length > UPLOAD_CHUNK || end > side.size || (end < side.size && data.length !== UPLOAD_CHUNK)) throw new UserError(`Part ${n} isn't the right size.`);
  const file = row.filePath;
  if (locks().has(row.id)) return { ok: false, received: Number(row.bytes) };
  locks().add(row.id);
  try {
    let have = sizeOf(file);
    // A part cut off half way (the server stopped while writing it): back to the last whole part.
    if (have < side.size && have % UPLOAD_CHUNK !== 0) {
      have -= have % UPLOAD_CHUNK;
      fs.truncateSync(file, have);
    }
    if (end <= have) return { ok: true, received: have };
    if (offset !== have) return { ok: false, received: have };
    await fs.promises.appendFile(file, data);
    const received = have + data.length;
    await db.companyMove.update({ where: { id: row.id }, data: { bytes: BigInt(received) } });
    return { ok: true, received };
  } finally {
    locks().delete(row.id);
  }
}

/** The whole file is here: import it (in the background). Also "Import again" after a refusal, from the same file. */
export async function finishUpload(user: CurrentUser, id: unknown): Promise<UploadView> {
  const row = await own(user, id);
  if (row.status === "checking" || row.status === "importing") return view(row);
  if (row.status !== "uploading" && row.status !== "failed") throw new UserError("This import is finished. Choose the file again to start another.");
  const side = readSide(row.id);
  const have = sizeOf(row.filePath);
  if (!side || !row.filePath || have !== side.size) {
    throw new UserError(side ? `The file isn't all here (${mb(have)} of ${mb(side.size)} MB). Choose it again to carry on.` : "The uploaded file isn't on the server any more. Choose it again.");
  }
  if (runningImport()) throw new UserError(BUSY);
  const started = await db.companyMove.update({ where: { id: row.id }, data: { status: "checking", error: null, finishedAt: null, table: null, rowsDone: 0, rowsTotal: 0 } });
  try {
    startImportJob({ id: row.id, file: row.filePath, by: user, door: "hosted", rowId: row.id, deleteWhenDone: true });
  } catch (e) {
    await db.companyMove.update({ where: { id: row.id }, data: { status: row.status, error: row.error } });
    throw e;
  }
  return view(started);
}

export async function uploadView(user: CurrentUser, id: unknown): Promise<UploadView> {
  return view(await own(user, id));
}

/** Discard an upload (its file goes); not while it is being imported. */
export async function discardUpload(user: CurrentUser, id: unknown): Promise<void> {
  const row = await own(user, id);
  const job = importJob(row.id);
  if (job && !job.finishedAt) throw new UserError("The import is running. Wait for it to finish.");
  if (row.filePath) removeFile(row.filePath);
  removeFile(sideFile(row.id));
  await db.companyMove.update({ where: { id: row.id }, data: { status: row.status === "done" ? "done" : "cancelled", filePath: null, finishedAt: row.finishedAt ?? new Date() } });
}

/** The administrator's uploads of the last day (part way, running, refused or done), newest first, for the Companies page. */
export async function recentImports(user: CurrentUser): Promise<UploadView[]> {
  if (!isPlatformAdmin(user.email)) return [];
  await sweepUploads();
  const rows = await db.companyMove.findMany({
    where: { shopId: user.shopId, direction: "import", byUserId: user.id, status: { notIn: ["cancelled", "expired"] }, startedAt: { gt: new Date(Date.now() - DAY) } },
    orderBy: { startedAt: "desc" },
    take: 10,
  });
  return Promise.all(rows.map(view));
}

/**
 * Spool files more than a day old are deleted (an upload left part way, a refused one never tried again), and their
 * uploads marked expired. Run by the Companies page, each new upload and an hourly timer (instrumentation.ts).
 */
export async function sweepUploads(now = Date.now()): Promise<void> {
  const dir = spoolDir();
  const busy = runningImport()?.file;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const n of names) {
    const f = path.join(dir, n);
    if (f === busy) continue;
    try {
      if (now - fs.statSync(f).mtimeMs > DAY) removeFile(f);
    } catch {
      /* gone meanwhile */
    }
  }
  await db.companyMove
    .updateMany({ where: { direction: "import", status: { in: ["uploading", "failed"] }, startedAt: { lt: new Date(now - DAY) } }, data: { status: "expired", filePath: null } })
    .catch(() => {});
}
