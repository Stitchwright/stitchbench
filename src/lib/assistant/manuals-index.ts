import "server-only";
// The manual indexer (ai-assistant-scope.md 1.4): pdf.js reads a library PDF on this PC, page by page, and keeps each
// page's text in this company's own database (ManualPage). It runs only after a person pressed "Index these manuals" (or
// the whole library), in the background, a few pages at a time with a breath between, one file after another, and
// carries on where it stopped: ManualIndexDoc.donePages is the resume point, so a restart or a Stop loses nothing (the
// button then says Continue; nothing restarts by itself). A page with no text (a scan) is counted and skipped: "scanned
// pages can't be searched yet". Nothing here goes to the internet and nothing is read outside the library folder
// (private folders are refused by resolveInLibrary).
import fs from "node:fs";
import { db } from "@/lib/db";
import { libraryDir, resolveInLibrary } from "@/lib/library-dir";
import { libraryFor } from "@/lib/model-info";
import { requireOn } from "@/lib/module-gate";
import type { CurrentUser } from "@/lib/session";
import { UserError } from "@/lib/user-error";
import { cleanPageText, hasText } from "./manuals-prompt";

/** Pages read before the progress is saved and the server gets a breath. */
export const PAGE_CHUNK = 8;
const MAX_FILE_BYTES = 400 * 1024 * 1024;
const pause = () => new Promise<void>((r) => setImmediate(r));

type Runner = { p: Promise<void> | null; again: boolean };
const runner: Runner = ((globalThis as unknown as { __manualIndexer?: Runner }).__manualIndexer ??= { p: null, again: false });

/** Starts the background loop if it isn't running (and says "look again" if it is). The returned promise ends when no file is waiting. */
export function kickIndexer(): Promise<void> {
  if (runner.p) {
    runner.again = true;
    return runner.p;
  }
  runner.p = (async () => {
    try {
      do {
        runner.again = false;
        await drain();
      } while (runner.again);
    } finally {
      runner.p = null;
    }
  })();
  return runner.p;
}

/** True while this server is working through files (a page opened after a restart sees queued rows and false: "Continue"). */
export const indexerActive = () => runner.p !== null;

async function drain() {
  const root = libraryDir();
  if (!root) return;
  for (;;) {
    const next = await db.manualIndexDoc.findFirst({ where: { status: { in: ["running", "queued"] } }, orderBy: [{ status: "desc" }, { updatedAt: "asc" }] });
    if (!next) return;
    try {
      await indexDoc(root, next);
    } catch (e) {
      await db.manualIndexDoc
        .updateMany({ where: { shopId: next.shopId, docId: next.docId }, data: { status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) } })
        .catch(() => {});
    }
  }
}

type Row = { shopId: string; docId: string; donePages: number; blankPages: number; totalPages: number };

async function indexDoc(root: string, row: Row) {
  const where = { shopId_docId: { shopId: row.shopId, docId: row.docId } };
  const fail = (error: string) => db.manualIndexDoc.update({ where, data: { status: "failed", error } });
  const lib = await db.libraryDoc.findUnique({ where: { id: row.docId }, select: { path: true } });
  if (!lib) return void (await fail("That manual isn't in the library list any more."));
  const full = resolveInLibrary(root, lib.path);
  if (!full) return void (await fail("That file can't be read from the library."));
  let size: number;
  try {
    size = (await fs.promises.stat(full)).size;
  } catch {
    return void (await fail("The file isn't in the library folder any more."));
  }
  if (size > MAX_FILE_BYTES) return void (await fail("The file is too large to index."));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(await fs.promises.readFile(full)), useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const total = doc.numPages;
    let done = Math.min(row.donePages, total);
    let blank = row.blankPages;
    await db.manualIndexDoc.update({ where, data: { status: "running", totalPages: total, error: null } });
    while (done < total) {
      const current = await db.manualIndexDoc.findUnique({ where, select: { status: true } });
      if (current?.status !== "running") return; // Stop was pressed (or the rows were cleared)
      const rows: { shopId: string; docId: string; page: number; text: string }[] = [];
      const last = Math.min(total, done + PAGE_CHUNK);
      for (let n = done + 1; n <= last; n++) {
        const page = await doc.getPage(n);
        try {
          const text = cleanPageText((await page.getTextContent()).items as { str?: string; hasEOL?: boolean }[]);
          if (hasText(text)) rows.push({ shopId: row.shopId, docId: row.docId, page: n, text });
          else blank += 1;
        } catch {
          blank += 1; // a page pdf.js can't read is skipped, like a scan; the rest of the file goes on
        } finally {
          page.cleanup();
        }
      }
      if (rows.length) await db.manualPage.createMany({ data: rows, skipDuplicates: true });
      done = last;
      await db.manualIndexDoc.updateMany({ where: { shopId: row.shopId, docId: row.docId, status: "running" }, data: { donePages: done, blankPages: blank } });
      await pause();
    }
    await db.manualIndexDoc.updateMany({ where: { shopId: row.shopId, docId: row.docId, status: "running" }, data: { status: "done" } });
  } finally {
    await task.destroy().catch(() => {});
  }
}

export type IndexScope = { brand: string; model: string } | { all: true };

/** The library files a scope covers. */
async function docsFor(scope: IndexScope): Promise<{ id: string }[]> {
  if ("all" in scope) return db.libraryDoc.findMany({ select: { id: true } });
  return (await libraryFor(scope.brand, scope.model)).map((d) => ({ id: d.id }));
}

/**
 * "Index these manuals" (a model's) or "Index my whole library": queues every file of the scope this company hasn't
 * finished (a paused or failed one is tried again, from where it stopped) and starts the loop. Returns how many files
 * were queued. Only this company's rows are written.
 */
export async function startIndexing(user: CurrentUser, scope: IndexScope): Promise<number> {
  await requireOn(user, "assistant");
  if (!libraryDir()) throw new UserError("Searching manuals needs the manual library on this PC (the Windows program). Hosted shops can't index a library yet.");
  if (!(await manualsSwitchOn(user.shopId))) throw new UserError("Ask the manuals is switched off in Settings → Assistant.");
  const docs = await docsFor(scope);
  if (!docs.length) throw new UserError("There are no manuals for this in your library.");
  const have = new Map((await db.manualIndexDoc.findMany({ where: { shopId: user.shopId, docId: { in: docs.map((d) => d.id) } }, select: { docId: true, status: true } })).map((r) => [r.docId, r.status]));
  const fresh = docs.filter((d) => !have.has(d.id));
  const again = docs.filter((d) => ["paused", "failed"].includes(have.get(d.id) ?? ""));
  if (fresh.length) await db.manualIndexDoc.createMany({ data: fresh.map((d) => ({ shopId: user.shopId, docId: d.id })), skipDuplicates: true });
  if (again.length) await db.manualIndexDoc.updateMany({ where: { shopId: user.shopId, docId: { in: again.map((d) => d.id) } }, data: { status: "queued", error: null } });
  const waiting = await db.manualIndexDoc.count({ where: { shopId: user.shopId, docId: { in: docs.map((d) => d.id) }, status: { in: ["queued", "running"] } } });
  if (!waiting) throw new UserError("These manuals are already indexed.");
  void kickIndexer().catch((e) => console.error("manual indexer:", e instanceof Error ? e.message : e));
  return waiting;
}

/** Stop: what is queued or running is paused; the pages already read stay and Continue picks up from them. */
export async function stopIndexing(user: Pick<CurrentUser, "shopId">): Promise<void> {
  await db.manualIndexDoc.updateMany({ where: { shopId: user.shopId, status: { in: ["queued", "running"] } }, data: { status: "paused" } });
}

/** Delete this company's search index (all of it, or a model's files); the library files are not touched. */
export async function clearIndex(user: Pick<CurrentUser, "shopId">, scope: IndexScope = { all: true }): Promise<void> {
  const ids = "all" in scope ? null : (await docsFor(scope)).map((d) => d.id);
  const docFilter = ids ? { docId: { in: ids } } : {};
  await db.manualIndexDoc.updateMany({ where: { shopId: user.shopId, status: { in: ["queued", "running"] }, ...docFilter }, data: { status: "paused" } });
  await db.manualPage.deleteMany({ where: { shopId: user.shopId, ...docFilter } });
  await db.manualIndexDoc.deleteMany({ where: { shopId: user.shopId, ...docFilter } });
}

export type IndexProgress = {
  /** Files in the scope, and how many are finished, being read or waiting, failed, or stopped. */
  files: number;
  done: number;
  waiting: number;
  failed: number;
  paused: number;
  pages: number;
  pagesDone: number;
  /** Pages with no text (scans) among the files read so far. */
  blankPages: number;
  /** Searchable pages stored. */
  searchable: number;
  /** The server is working through files right now. */
  active: boolean;
  error: string | null;
};

/** Where indexing stands for this company, for a scope (or the whole library). */
export async function indexProgress(shopId: string, scope: IndexScope): Promise<IndexProgress> {
  const ids = "all" in scope ? null : (await docsFor(scope)).map((d) => d.id);
  const rows = await db.manualIndexDoc.findMany({ where: { shopId, ...(ids ? { docId: { in: ids } } : {}) }, select: { status: true, totalPages: true, donePages: true, blankPages: true, error: true } });
  const files = ids ? ids.length : await db.libraryDoc.count();
  const count = (s: string[]) => rows.filter((r) => s.includes(r.status)).length;
  const waiting = count(["queued", "running"]);
  return {
    files,
    done: count(["done"]),
    waiting,
    failed: count(["failed"]),
    paused: count(["paused"]),
    pages: rows.reduce((s, r) => s + r.totalPages, 0),
    pagesDone: rows.reduce((s, r) => s + r.donePages, 0),
    blankPages: rows.reduce((s, r) => s + r.blankPages, 0),
    searchable: rows.reduce((s, r) => s + (r.donePages - r.blankPages), 0),
    active: waiting > 0 && indexerActive(),
    error: rows.find((r) => r.status === "failed")?.error ?? null,
  };
}

async function manualsSwitchOn(shopId: string): Promise<boolean> {
  return (await db.assistantSettings.findUnique({ where: { shopId }, select: { manualsOn: true } }))?.manualsOn ?? true;
}
