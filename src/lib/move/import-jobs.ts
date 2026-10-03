import "server-only";
// A company import running in the background of the server (company-move-design.md section 8): the hosted Companies
// page and the Windows program's tray start one and come back for its progress and, at the end, its summary. One at a
// time on a server. The state lives on globalThis: a production build loads separate copies of this module for the
// pages, the route handlers and the timers (as src/lib/db.ts explains), and they must all see the same jobs. A hosted
// import also mirrors its progress to its CompanyMove row (on the administrator's own company), so the Companies page
// shows it after a reload and says so if the server restarted part way (nothing is written then: one transaction).
import crypto from "node:crypto";
import fs from "node:fs";
import { db } from "@/lib/db";
import { isUserError, UserError } from "@/lib/user-error";
import { importCompany, type Importer, type ImportSummary } from "./import";

export type ImportJob = {
  id: string;
  /** pc: the Windows program's tray (progress at /move-in/<id>); hosted: the Companies page's upload. */
  door: "pc" | "hosted";
  file: string;
  status: "checking" | "importing" | "done" | "failed";
  table: string | null;
  rowsDone: number;
  rowsTotal: number;
  bytesRead: number;
  bytesTotal: number;
  error: string | null;
  summary: ImportSummary | null;
  startedAt: Date;
  finishedAt: Date | null;
  /** The hosted upload's CompanyMove row, which mirrors the progress. */
  rowId: string | null;
};

type Store = { jobs: Map<string, ImportJob>; running: string | null };

function store(): Store {
  const g = globalThis as unknown as { __companyImports?: Store };
  return (g.__companyImports ??= { jobs: new Map(), running: null });
}

const DAY = 24 * 3600_000;

/** A job by its id (a long random one: it is the only key to its progress page), or null. */
export function importJob(id: string): ImportJob | null {
  return store().jobs.get(id) ?? null;
}

/** The job running now, if any. */
export function runningImport(): ImportJob | null {
  const s = store();
  return s.running ? (s.jobs.get(s.running) ?? null) : null;
}

/** Deletes a spooled file, once more a little later if Windows still holds it open; never throws. */
export function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    setTimeout(() => fs.rm(file, { force: true }, () => {}), 2000).unref?.();
  }
}

export const BUSY = "Another company is being imported on this server. Wait for it to finish, then try again.";

/**
 * Starts importing `file` in the background and returns the job's id (the given one, for a hosted upload, which is its
 * CompanyMove row's). `deleteWhenDone`: the spooled upload goes once the company is in; a failed import keeps it, so
 * the administrator can try again without uploading again (the 24-hour sweep removes it).
 */
export function startImportJob(o: { file: string; by: Importer; door: ImportJob["door"]; id?: string; rowId?: string | null; deleteWhenDone?: boolean }): string {
  const s = store();
  const now = Date.now();
  for (const [id, j] of s.jobs) if (j.finishedAt && now - j.finishedAt.getTime() > DAY) s.jobs.delete(id);
  if (s.running) throw new UserError(BUSY);
  const id = o.id ?? crypto.randomBytes(24).toString("base64url");
  const job: ImportJob = {
    id,
    door: o.door,
    file: o.file,
    status: "checking",
    table: null,
    rowsDone: 0,
    rowsTotal: 0,
    bytesRead: 0,
    bytesTotal: 0,
    error: null,
    summary: null,
    startedAt: new Date(),
    finishedAt: null,
    rowId: o.rowId ?? null,
  };
  s.jobs.set(id, job);
  s.running = id;
  void run(job, o.by, !!o.deleteWhenDone);
  return id;
}

async function run(job: ImportJob, by: Importer, deleteWhenDone: boolean) {
  // Row writes one after another (an early progress write can't land after the last one), at most one a second.
  let chain: Promise<unknown> = Promise.resolve();
  let last = 0;
  const mirror = (force = false) => {
    if (!job.rowId) return chain;
    const now = Date.now();
    if (!force && now - last < 1000) return chain;
    last = now;
    const data = {
      status: job.status,
      table: job.table,
      rowsDone: job.rowsDone,
      rowsTotal: job.rowsTotal,
      error: job.error,
      finishedAt: job.finishedAt,
      ...(job.status === "done" && deleteWhenDone ? { filePath: null } : {}),
    };
    const rowId = job.rowId;
    chain = chain.then(() => db.companyMove.update({ where: { id: rowId }, data })).catch(() => {});
    return chain;
  };
  try {
    job.summary = await importCompany(job.file, {
      by,
      onProgress: (p) => {
        job.status = p.phase;
        job.table = p.table;
        job.rowsDone = p.rowsDone;
        job.rowsTotal = p.rowsTotal;
        job.bytesRead = p.bytesRead;
        job.bytesTotal = p.bytesTotal;
        void mirror();
      },
    });
    job.status = "done";
    job.table = null;
    job.rowsDone = job.summary.rows;
    job.rowsTotal = job.summary.rows;
    if (deleteWhenDone) removeFile(job.file);
  } catch (e) {
    job.status = "failed";
    job.error = isUserError(e) ? e.message : `The import stopped and nothing was imported: ${e instanceof Error ? e.message : String(e)}`;
    if (!isUserError(e)) console.error("company import:", e);
  } finally {
    job.finishedAt = new Date();
    store().running = null;
    await mirror(true);
  }
}
