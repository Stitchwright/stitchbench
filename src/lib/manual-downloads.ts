import "server-only";
// Downloading hub links into this install's manual library (HANDOFF item 12). The hub is the community's catalog of
// links and never hosts a manual: each shop downloads into its own library folder (LIBRARY_DIR on the shop PC).
//   - downloadLink: fetch one link and file it. With category, brand, model and doc type it goes straight to
//     Category\Brand\Brand_Model_DocType.pdf with a LibraryDoc row (the model page shows it at once); otherwise to
//     _inbox. A sidecar <file>.pdf.json keeps the source URL and the link id with the file.
//   - queueDownloads / downloadRun: "Download everything" for a model, a brand, or every link not yet here, as
//     ManualDownload rows the server's timer works through one at a time with a pause between; rows survive a restart.
//   - coverage: which kinds of manual a model has, has links for, or lacks.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Joins library paths without the bundler seeing a pattern. Turbopack traces `path.join(root, a, b)` with a literal
 * fallback ("Unsorted") as a file glob and packed the whole repository into the standalone build (807 MB instead of
 * 147). Going through a spread the bundler can't follow keeps the trace to the code itself.
 */
const under = (...parts: string[]): string => path.join(...parts.map(String));
import type { ManualLink } from "@/generated/prisma/client";
import { UserError } from "@/lib/user-error";
import { db } from "@/lib/db";
import { brandKey, modelKey } from "@/lib/format";
import { hubFetch, hubId, hubJoined, hubStatus } from "@/lib/hub";
import { withLease } from "@/lib/lease";
import { libraryDir, writeUnusedPdf } from "@/lib/library-dir";
import { brandMatches } from "@/lib/model-info";
import { fetchPublic, storageUrlOk, TooLarge } from "@/lib/safe-fetch";
import { freeBytes, isRepoLink, minFreeBytes, repositoryUrl, sizeWords } from "@/lib/manual-repository";

const UA = "StitchBench (manual download for a repair shop's own library)";
export const MAX_PDF = 300 * 1024 * 1024;
const FETCH_MS = 180_000;

const MIN = 60_000;
const LEASE = "manual-downloads";
const LEASE_TTL = 5 * MIN;
const RUN_MS = 10 * MIN; // one run stops claiming after this; the timer starts the next
const STALE_MS = 15 * MIN; // a row left DOWNLOADING this long was interrupted (the program was closed)
const MAX_TRIES = 2;

/** Seconds to wait between files, so a maker's site sees one request at a time (MANUAL_DOWNLOAD_PAUSE_SECONDS, default 5). */
export function pauseMs(): number {
  const s = Number(process.env.MANUAL_DOWNLOAD_PAUSE_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : 5) * 1000;
}

/** The timer is off with MANUAL_DOWNLOADS=off, and does nothing where there is no library (hosted installs). */
export const downloadsOff = () => process.env.MANUAL_DOWNLOADS === "off";

export const NO_LIBRARY = "Downloading into the manual library works in the StitchBench program on the shop PC.";

/** A download that didn't work, in the user's words; `report` says the hub should hear the link failed. */
export class DownloadFailed extends UserError {
  readonly report: boolean;
  constructor(message: string, report = false) {
    super(message);
    this.report = report;
  }
}

// ---------- naming (the library's: Category\Brand\Brand_Model_DocType.pdf) ----------

// origin, sha256, sha1 and sizeBytes are the repository's (manual-repository-design.md 5.2): a repository row is filed by its
// hub-composed name Brand_Model_DocType_Year.pdf, checked against its sha256 and matched by hash against what the library holds.
type LinkLike = Pick<ManualLink, "id" | "category" | "brand" | "models" | "modelKeys" | "docType" | "title" | "fileName" | "url"> & Partial<Pick<ManualLink, "origin" | "sha256" | "sha1" | "sizeBytes">>;

const fileSafe = (s: string) => s.replace(/[^\w\-+.() ]+/g, "_").trim();
const folderSafe = (s: string) => s.replace(/[^\w\- ]+/g, "").trim();

/** The file name's stem: what the hub filed it as when it says, else Brand_Model+Model_DocType the way the library names them. */
export function linkStem(l: LinkLike): string {
  const given = l.fileName?.replace(/\.pdf$/i, "").trim();
  const stem =
    given ||
    `${l.brand.replace(/[^A-Za-z0-9]/g, "")}_${l.models
      .trim()
      .replace(/\s*,\s*/g, "+")
      .replace(/\s+/g, "-")}_${l.docType ?? "Manual"}`;
  return fileSafe(stem).slice(0, 150) || "manual";
}

/** A link can be filed by model when it carries a category, a brand, at least one model and the kind of manual. */
export function canFile(l: LinkLike): boolean {
  return Boolean(l.category?.trim() && l.brand.trim() && l.modelKeys.length && l.docType?.trim());
}

/** The folders a link files into: the library's own spelling where it has one (Babylock -> Baby-Lock), else the link's. */
export async function filingFolders(l: LinkLike): Promise<{ category: string; brand: string }> {
  const cats = await db.libraryDoc.findMany({ distinct: ["category"], select: { category: true } });
  const category = cats.find((c) => c.category.toLowerCase() === (l.category ?? "").trim().toLowerCase())?.category ?? (folderSafe(l.category ?? "") || "Unsorted");
  const brands = await db.libraryDoc.findMany({ where: { category }, distinct: ["brand"], select: { brand: true } });
  const brand = brands.find((b) => brandKey(b.brand) === brandKey(l.brand))?.brand ?? (folderSafe(l.brand) || "Unsorted");
  return { category, brand };
}

/** The LibraryDoc id for a path, as scripts/library/build_library_docs.py makes it (sha1 of the backslash path). */
export function libraryDocId(relPath: string): string {
  return crypto.createHash("sha1").update(relPath, "utf8").digest("hex").slice(0, 20);
}

const toRel = (...parts: string[]) => parts.join("\\");
const toFull = (root: string, rel: string) => under(root, ...rel.split("\\"));

// ---------- is it here already? ----------

export type HaveIndex = { byLink: Map<string, string>; byFile: Map<string, string>; bySha: Map<string, string>; done: Map<string, string>; folders: Map<string, Promise<{ category: string; brand: string }>> };

/** One read of what the library already holds, for checking many links. Paths are relative, backslashes. */
export async function haveIndex(): Promise<HaveIndex> {
  const docs = await db.libraryDoc.findMany({ select: { path: true, file: true, linkId: true, sha256: true, sha1: true } });
  const byLink = new Map<string, string>();
  const byFile = new Map<string, string>();
  const bySha = new Map<string, string>();
  for (const d of docs) {
    if (d.linkId) byLink.set(d.linkId, d.path);
    byFile.set(d.file.toLowerCase(), d.path);
    if (d.sha256) bySha.set(d.sha256, d.path);
    if (d.sha1) bySha.set(d.sha1, d.path);
  }
  const done = new Map<string, string>();
  for (const r of await db.manualDownload.findMany({ where: { status: "DONE", path: { not: null } }, select: { linkId: true, path: true } })) done.set(r.linkId, r.path!);
  return { byLink, byFile, bySha, done, folders: new Map() };
}

/** filingFolders, remembered per category + brand while one index is in use (thousands of links share a few folders). */
function foldersFor(l: LinkLike, idx: HaveIndex) {
  const k = `${(l.category ?? "").trim().toLowerCase()}|${brandKey(l.brand)}`;
  let p = idx.folders.get(k);
  if (!p) {
    p = filingFolders(l);
    idx.folders.set(k, p);
  }
  return p;
}

/**
 * The library path this link is already at, or null. Checked in turn: a LibraryDoc row from this link, a row whose
 * file is the name the hub filed it as, an earlier download of it, and the file sitting where it would be filed
 * (filed by hand). The file must still be on disk: a deleted manual can be downloaded again.
 */
export async function alreadyHave(l: LinkLike, root: string, idx: HaveIndex): Promise<string | null> {
  const onDisk = (rel: string | undefined) => (rel && fs.existsSync(toFull(root, rel)) ? rel : null);
  // A file held under another name (a sha256 or sha1 the library knows) counts too: it is not fetched again.
  const byHash = onDisk((l.sha256 ? idx.bySha.get(l.sha256) : undefined) ?? (l.sha1 ? idx.bySha.get(l.sha1) : undefined));
  const hit = onDisk(idx.byLink.get(l.id)) ?? byHash ?? onDisk(l.fileName ? idx.byFile.get(l.fileName.toLowerCase()) : undefined) ?? onDisk(idx.done.get(l.id));
  if (hit) return hit;
  if (!canFile(l)) return null;
  const f = await foldersFor(l, idx);
  return onDisk(toRel(f.category, f.brand, `${linkStem(l)}.pdf`));
}

// ---------- one download ----------

export type Saved = { path: string; filed: boolean };

/** Fetch the link (public web only, redirects re-checked, cut off at MAX_PDF) and file the PDF. Throws DownloadFailed. */
export async function downloadLink(l: LinkLike, root: string): Promise<Saved> {
  if (isRepoLink(l)) return downloadRepositoryLink(l, root);
  let got: Awaited<ReturnType<typeof fetchPublic>>;
  try {
    got = await fetchPublic(l.url, { headers: { "User-Agent": UA, Accept: "application/pdf,*/*" }, timeoutMs: FETCH_MS, maxBytes: MAX_PDF });
  } catch (e) {
    if (e instanceof TooLarge) throw new DownloadFailed("That file is too large to download here.");
    if (e instanceof Error && /private network|login in it|Only web|Too many redirects/.test(e.message)) throw new DownloadFailed(`${e.message} It can't be downloaded here.`);
    throw new DownloadFailed("The site didn't answer. Open the link in a browser instead; if it's dead, fix the link for everyone.", true);
  }
  if (!got.response.ok || !got.body) throw new DownloadFailed(`The site answered ${got.response.status}. Try the link in a browser; if it's dead, fix it for everyone.`, true);
  const data = got.body;
  // The first bytes say what it is, whatever the address ends in.
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new DownloadFailed("That link opens a web page, not the PDF itself. Open it in a browser and save the manual from there.");
  return fileDownload(l, root, data);
}

/** Said when a run should stop and leave the row queued: no room on the disk, or the hub said "later". */
export class HoldQueue extends DownloadFailed {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/**
 * One repository file (design 5.3): the hub's short-lived URL (by manual id), fetched from R2's own host with the SSRF
 * guard, checked as a PDF and against the feed's sha256 (a mismatch saves nothing), then filed like any download:
 * Category\Brand\Brand_Model_DocType_Year.pdf with the sidecar and the LibraryDoc row. Below the free-space floor nothing is
 * fetched. The hub's 429 puts the row back for the next hour; a 404 means it was removed meanwhile.
 */
export async function downloadRepositoryLink(l: LinkLike, root: string): Promise<Saved> {
  const free = await freeBytes(root);
  const need = (l.sizeBytes ?? 0) + minFreeBytes();
  if (free != null && free < need) throw new HoldQueue(`Stopped: less than ${sizeWords(minFreeBytes())} free on the library's disk (${sizeWords(free)} left). Free some space; the queue carries on by itself.`, 60 * MIN);
  let target: Awaited<ReturnType<typeof repositoryUrl>>;
  try {
    target = await repositoryUrl(l.id);
  } catch (e) {
    const st = hubStatus(e);
    if (st === 429) throw new HoldQueue("The hub asked this program to slow down. It carries on in an hour.", 60 * MIN);
    if (st === 404) throw new DownloadFailed("That manual isn't in the repository any more (it may have been removed).");
    if (e instanceof UserError) throw new DownloadFailed(e.message);
    throw new DownloadFailed("The hub didn't answer. It will be tried again later.");
  }
  if (!storageUrlOk(target.url)) throw new DownloadFailed("The hub gave a download address this program won't use.");
  let got: Awaited<ReturnType<typeof fetchPublic>>;
  try {
    got = await fetchPublic(target.url, { headers: { "User-Agent": UA, Accept: "application/pdf" }, timeoutMs: FETCH_MS, maxBytes: MAX_PDF });
  } catch (e) {
    if (e instanceof TooLarge) throw new DownloadFailed("That file is too large to download here.");
    throw new DownloadFailed("The repository's storage didn't answer. It will be tried again later.");
  }
  if (!got.response.ok || !got.body) throw new DownloadFailed(`The repository's storage answered ${got.response.status}. Try again later.`);
  const data = got.body;
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new DownloadFailed("What came back isn't a PDF; nothing was saved.");
  const want = l.sha256 ?? target.sha256;
  const have = crypto.createHash("sha256").update(data).digest("hex");
  if (want && have !== want) throw new DownloadFailed("The file that came back isn't the one the hub described (its checksum differs); nothing was saved.");
  return fileDownload(l, root, data, { sha256: have });
}

/** Write the PDF where it belongs, with its sidecar, and the LibraryDoc row when filed by model. */
export async function fileDownload(l: LinkLike, root: string, data: Buffer, hash?: { sha256: string }): Promise<Saved> {
  const stem = linkStem(l);
  const sha256 = hash?.sha256 ?? crypto.createHash("sha256").update(data).digest("hex");
  const sidecar = { linkId: l.id, url: l.url, title: l.title, brand: l.brand, models: l.models, docType: l.docType, sha256, ...(isRepoLink(l) ? { origin: "repository", sha1: l.sha1 ?? null } : {}), downloadedAt: new Date().toISOString() };
  if (!canFile(l)) {
    const inbox = under(root, "_inbox");
    await fs.promises.mkdir(inbox, { recursive: true });
    const name = await writeUnusedPdf(inbox, stem, data);
    await fs.promises.writeFile(under(inbox, `${name}.json`), JSON.stringify(sidecar, null, 2));
    return { path: toRel("_inbox", name), filed: false };
  }
  const f = await filingFolders(l);
  const dir = under(root, f.category, f.brand);
  await fs.promises.mkdir(dir, { recursive: true });
  const name = await writeUnusedPdf(dir, stem, data);
  await fs.promises.writeFile(under(dir, `${name}.json`), JSON.stringify(sidecar, null, 2));
  const rel = toRel(f.category, f.brand, name);
  const row = {
    path: rel,
    category: f.category,
    brand: f.brand,
    file: name,
    docType: l.docType,
    // The link's title, unless it is just the file name again
    title: l.title && l.title.replace(/\.pdf$/i, "") !== stem ? l.title.slice(0, 200) : null,
    pages: null,
    sizeBytes: data.length,
    modelKeys: l.modelKeys,
    linkId: l.id,
    sourceUrl: l.url,
    downloadedAt: new Date(),
    sha256,
    sha1: l.sha1 ?? crypto.createHash("sha1").update(data).digest("hex"),
    withdrawnAt: null,
    withdrawnWhy: null,
  };
  await db.libraryDoc.upsert({ where: { id: libraryDocId(rel) }, create: { id: libraryDocId(rel), ...row }, update: row });
  return { path: rel, filed: true };
}

/** Tell the hub a link didn't work (its checker counts reports); nothing if this install isn't on the hub. */
export async function reportLink(linkId: string): Promise<void> {
  if (!(await hubJoined().catch(() => false))) return;
  await hubFetch(`/v1/links/${hubId(linkId)}/report`, { method: "POST", json: { ok: false } }).catch(() => {});
}

// ---------- the queue ----------

export type Scope = { kind: "model"; brand: string; model: string } | { kind: "brand"; brand: string } | { kind: "all" };

export function scopeLabel(s: Scope): string {
  if (s.kind === "model") return `${s.brand} ${s.model}`;
  if (s.kind === "brand") return s.brand;
  return "every link not in the library";
}

/** The hub links a scope covers (dead ones included; the queue counts and skips them). */
export async function linksInScope(s: Scope): Promise<ManualLink[]> {
  if (s.kind === "model") {
    const key = modelKey(s.model);
    if (!key) return [];
    const rows = await db.manualLink.findMany({ where: { modelKeys: { has: key } }, orderBy: [{ docType: "asc" }, { title: "asc" }] });
    return rows.filter((l) => brandMatches(l.brand, s.brand));
  }
  const rows = await db.manualLink.findMany({ orderBy: [{ brand: "asc" }, { models: "asc" }, { docType: "asc" }] });
  return s.kind === "brand" ? rows.filter((l) => brandMatches(l.brand, s.brand)) : rows;
}

export type Queued = { jobId: string; label: string; queued: number; dead: number; have: number; busy: number; repoFiles: number; repoBytes: number };

/**
 * Queue every link in the scope that isn't dead, isn't in the library and isn't already waiting. Throws a UserError
 * when there is no library here or nothing to queue (saying why: all here already, all dead...).
 */
export async function queueDownloads(user: { shopId: string }, s: Scope): Promise<Queued> {
  const root = libraryDir();
  if (!root) throw new UserError(NO_LIBRARY);
  const label = scopeLabel(s);
  const links = await linksInScope(s);
  if (!links.length) throw new UserError(s.kind === "all" ? "No links yet. Sync with the hub first." : `No links for ${label} yet.`);
  const idx = await haveIndex();
  const waiting = new Set((await db.manualDownload.findMany({ where: { status: { in: ["QUEUED", "DOWNLOADING"] } }, select: { linkId: true } })).map((r) => r.linkId));
  const out: Queued = { jobId: crypto.randomUUID(), label, queued: 0, dead: 0, have: 0, busy: 0, repoFiles: 0, repoBytes: 0 };
  const rows: { shopId: string; jobId: string; jobLabel: string; linkId: string }[] = [];
  for (const l of links) {
    if (l.status === "dead") out.dead += 1;
    else if (await alreadyHave(l, root, idx)) out.have += 1;
    else if (waiting.has(l.id)) out.busy += 1;
    else {
      rows.push({ shopId: user.shopId, jobId: out.jobId, jobLabel: label, linkId: l.id });
      if (isRepoLink(l)) {
        out.repoFiles += 1;
        out.repoBytes += l.sizeBytes ?? 0;
      }
    }
  }
  if (!rows.length) {
    const why = [out.have && `${out.have} already in the library`, out.busy && `${out.busy} already waiting to download`, out.dead && `${out.dead} dead`].filter(Boolean).join(", ");
    throw new UserError(`Nothing to download for ${label}: ${why}.`);
  }
  // The volume guard (design 5.3): repository files are big and many; refuse when the disk couldn't hold them and the floor.
  if (out.repoFiles) {
    const free = await freeBytes(root);
    if (free != null && free < out.repoBytes + minFreeBytes()) {
      throw new UserError(
        `Not enough room: ${out.repoFiles} repository files, about ${sizeWords(out.repoBytes)}, and the library's disk has ${sizeWords(free)} free (${sizeWords(minFreeBytes())} is always kept free). Free some space, or download one model or brand at a time.`,
      );
    }
  }
  await db.manualDownload.createMany({ data: rows });
  out.queued = rows.length;
  kickDownloads();
  return out;
}

/** Take a job's waiting rows off the queue (what is downloading finishes; what is done stays listed). */
export async function cancelJob(shopId: string, jobId: string): Promise<number> {
  const r = await db.manualDownload.deleteMany({ where: { shopId, jobId, status: "QUEUED" } });
  return r.count;
}

/** Remove a finished job from the list (and anything of it still waiting). */
export async function clearJob(shopId: string, jobId: string): Promise<void> {
  await db.manualDownload.deleteMany({ where: { shopId, jobId, status: { not: "DOWNLOADING" } } });
}

// ---------- the worker ----------

export type RunResult = { done: number; failed: number; skipped: number; left: number } | { busy: true } | { off: true };

type G = { __manualRun?: Promise<RunResult> | null; __manualKick?: NodeJS.Timeout | null };
const g = globalThis as unknown as G;

/** The timer's entry: one run per process at a time, under the install-wide lease. */
export function runManualDownloads(): Promise<RunResult> {
  if (downloadsOff() || !libraryDir()) return Promise.resolve({ off: true });
  if (g.__manualRun) return g.__manualRun;
  const p = downloadRun().finally(() => {
    g.__manualRun = null;
  });
  g.__manualRun = p;
  return p;
}

/** Starts the worker a moment after something was queued, so the first file doesn't wait for the timer. */
export function kickDownloads(): void {
  if (downloadsOff() || g.__manualKick) return;
  g.__manualKick = setTimeout(() => {
    g.__manualKick = null;
    runManualDownloads().catch((e) => console.error("manual downloads:", e instanceof Error ? e.message : e));
  }, 1_500);
}

/** Checks stop the kick timer so a queued row waits for their own downloadRun. */
export function clearDownloadKick(): void {
  if (g.__manualKick) clearTimeout(g.__manualKick);
  g.__manualKick = null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One run under the lease ({ busy } when another server copy holds it): the oldest waiting row first, one file at a
 * time with a pause between, until the queue is empty or the run has gone on for RUN_MS. Checks pass `now`, a pause
 * of their own and a cap on how many files to take.
 */
export async function downloadRun(o: { now?: Date; pauseMs?: number; maxFiles?: number; shopIds?: string[] } = {}): Promise<RunResult> {
  if (downloadsOff()) return { off: true };
  const root = libraryDir();
  if (!root) return { off: true };
  const r = await withLease(LEASE, LEASE_TTL, (renew) => run(root, o, renew));
  return r ?? { busy: true };
}

async function run(root: string, o: { now?: Date; pauseMs?: number; maxFiles?: number; shopIds?: string[] }, renew: () => Promise<boolean>): Promise<RunResult> {
  const now = o.now ?? new Date();
  const scope = o.shopIds ? { shopId: { in: o.shopIds } } : {};
  const counts = { done: 0, failed: 0, skipped: 0, left: 0 };
  // Rows the closed program left DOWNLOADING: once more, then given up.
  const stale = await db.manualDownload.findMany({ where: { ...scope, status: "DOWNLOADING", startedAt: { lt: new Date(now.getTime() - STALE_MS) } }, select: { id: true, tries: true } });
  for (const s of stale) {
    const where = { id: s.id, status: "DOWNLOADING" };
    if (s.tries < MAX_TRIES) await db.manualDownload.updateMany({ where, data: { status: "QUEUED", startedAt: null, error: "Interrupted; trying once more" } });
    else await db.manualDownload.updateMany({ where, data: { status: "FAILED", finishedAt: now, error: "Interrupted twice" } });
  }
  const until = Date.now() + RUN_MS;
  const pause = o.pauseMs ?? pauseMs();
  let idx = await haveIndex();
  let taken = 0;
  while (Date.now() < until && (o.maxFiles == null || taken < o.maxFiles)) {
    const next = await db.manualDownload.findFirst({
      where: { ...scope, status: "QUEUED", OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }] },
      orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
    });
    if (!next) break;
    // The hub's own storage takes one request a second (design 5.3); a maker's site keeps the longer pause.
    if (taken > 0) await sleep(next.linkId.startsWith("repo_") ? Math.min(pause, 1000) : pause);
    if (!(await renew())) break;
    // Claim it (another copy may have taken it between the read and now).
    const claimed = await db.manualDownload.updateMany({ where: { id: next.id, status: "QUEUED" }, data: { status: "DOWNLOADING", startedAt: new Date(), tries: { increment: 1 } } });
    if (!claimed.count) continue;
    taken += 1;
    const outcome = await downloadOne(next.linkId, root, idx);
    if (outcome.status === "QUEUED") {
      // No room, or the hub said "later": the row goes back, the run stops, the timer carries on after the pause.
      await db.manualDownload.updateMany({
        where: { id: next.id, status: "DOWNLOADING" },
        data: { status: "QUEUED", startedAt: null, tries: { decrement: 1 }, error: outcome.error, retryAfter: new Date(Date.now() + (outcome.holdMs ?? 60 * MIN)) },
      });
      break;
    }
    const { holdMs: _hold, ...result } = outcome;
    void _hold;
    await db.manualDownload.updateMany({ where: { id: next.id, status: "DOWNLOADING" }, data: { ...result, finishedAt: new Date() } });
    if (outcome.status === "DONE") {
      counts.done += 1;
      idx = await haveIndex();
    } else if (outcome.status === "SKIPPED") counts.skipped += 1;
    else counts.failed += 1;
  }
  counts.left = await db.manualDownload.count({ where: { ...scope, status: "QUEUED" } });
  return counts;
}

type Outcome = { status: "DONE" | "SKIPPED" | "FAILED" | "QUEUED"; path?: string | null; filed?: boolean; error?: string | null; holdMs?: number };

async function downloadOne(linkId: string, root: string, idx: HaveIndex): Promise<Outcome> {
  const l = await db.manualLink.findUnique({ where: { id: linkId } });
  if (!l) return { status: "FAILED", error: "The link is gone from the hub." };
  // The checker may have found it dead, or someone may have downloaded it, since it was queued.
  if (l.status === "dead") return { status: "SKIPPED", error: "Dead link" };
  const have = await alreadyHave(l, root, idx);
  if (have) return { status: "SKIPPED", path: have, error: "Already in the library" };
  try {
    const saved = await downloadLink(l, root);
    return { status: "DONE", path: saved.path, filed: saved.filed, error: null };
  } catch (e) {
    if (e instanceof HoldQueue) return { status: "QUEUED", error: e.message, holdMs: e.retryAfterMs };
    if (e instanceof DownloadFailed) {
      if (e.report) await reportLink(l.id);
      return { status: "FAILED", error: e.message };
    }
    return { status: "FAILED", error: `Could not save it: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------- progress ----------

export type JobRow = { id: string; linkId: string; status: string; path: string | null; filed: boolean; error: string | null; title: string; brand: string; models: string };
export type JobProgress = {
  jobId: string;
  label: string;
  queuedAt: Date;
  total: number;
  queued: number;
  downloading: number;
  done: number;
  skipped: number;
  failed: number;
  /** The row being downloaded now, with its link's words. */
  current: JobRow | null;
  /** What failed or was skipped, newest first, so the tech can see what to look for by hand. */
  problems: JobRow[];
  /** What was saved, newest first. */
  saved: JobRow[];
};

/** This company's download jobs, newest first: the counts the progress line shows, and the rows worth reading. */
export async function downloadJobs(shopId: string, o: { jobIds?: string[]; limit?: number } = {}): Promise<JobProgress[]> {
  const rows = await db.manualDownload.findMany({ where: { shopId, ...(o.jobIds ? { jobId: { in: o.jobIds } } : {}) }, orderBy: [{ queuedAt: "desc" }, { id: "desc" }], take: 2000 });
  if (!rows.length) return [];
  const links = new Map(
    (await db.manualLink.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.linkId))] } }, select: { id: true, title: true, brand: true, models: true } })).map((l) => [l.id, l]),
  );
  const jobs = new Map<string, JobProgress>();
  for (const r of rows) {
    let j = jobs.get(r.jobId);
    if (!j) {
      if (jobs.size >= (o.limit ?? 10)) continue;
      j = { jobId: r.jobId, label: r.jobLabel, queuedAt: r.queuedAt, total: 0, queued: 0, downloading: 0, done: 0, skipped: 0, failed: 0, current: null, problems: [], saved: [] };
      jobs.set(r.jobId, j);
    }
    j.total += 1;
    if (r.queuedAt < j.queuedAt) j.queuedAt = r.queuedAt;
    const l = links.get(r.linkId);
    const row: JobRow = {
      id: r.id,
      linkId: r.linkId,
      status: r.status,
      path: r.path,
      filed: r.filed,
      error: r.error,
      title: l?.title ?? "(link gone)",
      brand: l?.brand ?? "",
      models: l?.models ?? "",
    };
    if (r.status === "QUEUED") {
      j.queued += 1;
      if (r.error) j.problems.push(row); // why it is waiting (no room on the disk, the hub said later)
    } else if (r.status === "DOWNLOADING") {
      j.downloading += 1;
      j.current = row;
    } else if (r.status === "DONE") {
      j.done += 1;
      j.saved.push(row);
    } else if (r.status === "SKIPPED") {
      j.skipped += 1;
      j.problems.push(row);
    } else {
      j.failed += 1;
      j.problems.push(row);
    }
  }
  return [...jobs.values()];
}

/** Is anything waiting or downloading for this company (the page refreshes itself while there is)? */
export async function downloadsActive(shopId: string): Promise<boolean> {
  return (await db.manualDownload.count({ where: { shopId, status: { in: ["QUEUED", "DOWNLOADING"] } } })) > 0;
}

// ---------- what a model has and lacks (item 12c) ----------

/** The kinds of manual a bench wants for every model, in the order the model page lists them. */
export const WANTED_DOC_TYPES = ["ServiceManual", "PartsList", "OperatorManual", "ErrorCodes", "WiringDiagram"] as const;

export type Coverage = { docType: string; have: number; links: number; repo: number; dead: number; state: "have" | "repo" | "link" | "missing" };

/**
 * For one model: each wanted kind of manual (and any other kind seen), with how many files the library has, how many
 * working links the hub has, and whether it's in hand, only a link away, or missing (nothing to download; look for it).
 */
export function coverage(docs: { docType: string | null }[], links: { docType: string | null; status: string; origin?: string | null }[]): Coverage[] {
  const types = [
    ...WANTED_DOC_TYPES,
    ...new Set([...docs.map((d) => d.docType), ...links.map((l) => l.docType)].filter((t): t is string => !!t && !(WANTED_DOC_TYPES as readonly string[]).includes(t))),
  ];
  return types.map((docType) => {
    const have = docs.filter((d) => d.docType === docType).length;
    const all = links.filter((l) => l.docType === docType);
    const dead = all.filter((l) => l.status === "dead").length;
    const repo = all.filter((l) => l.origin === "repository").length;
    const live = all.length - dead - repo;
    // In the repository counts as available (design 5.3): a file is there to download, with nothing to look for by hand.
    return { docType, have, links: live, repo, dead, state: have ? "have" : repo ? "repo" : live ? "link" : "missing" };
  });
}
