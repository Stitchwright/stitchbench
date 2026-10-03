// Manual downloads into the library (HANDOFF item 12, package manual-downloads): the library's naming; a model's
// coverage by kind of manual; "download all" for a model queues its working links and skips dead ones; the worker
// files a link with category, brand, model and kind straight to Category\Brand\Brand_Model_DocType.pdf with a
// LibraryDoc row and a sidecar, one without to _inbox; a web page, a 404 and a redirect off the web fail with plain
// words; redirects on the web are followed; the size cap; what's already here isn't fetched again (until the file is
// gone); "every link not in the library"; rows left DOWNLOADING by a closed program are taken up again; progress,
// stop and clear; the switches; the tenant section. A tiny web server in this process stands in for the maker's site.
//   npm run check scripts/checks/manual-downloads.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { fetchPublic, TooLarge } from "@/lib/safe-fetch";
import {
  alreadyHave,
  cancelJob,
  canFile,
  clearDownloadKick,
  clearJob,
  coverage,
  downloadJobs,
  downloadRun,
  downloadsActive,
  haveIndex,
  libraryDocId,
  linkStem,
  queueDownloads,
} from "@/lib/manual-downloads";
import { checkShop, cleanup } from "./lib";
import { assertUnchanged, RUN, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

async function expectError(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

const PDF = Buffer.from("%PDF-1.4\n% a stand-in manual for the check\n%%EOF\n");

/** The maker's site: a PDF, a web page, a missing file, a move on the web, and a move off it. */
function startSite(): Promise<{ base: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const u = req.url ?? "/";
    if (u === "/good.pdf") return res.writeHead(200, { "Content-Type": "application/pdf" }).end(PDF);
    if (u === "/page.html") return res.writeHead(200, { "Content-Type": "text/html" }).end("<html><body>Download our manual</body></html>");
    if (u === "/moved.pdf") return res.writeHead(302, { Location: "/good.pdf" }).end();
    if (u === "/ftp.pdf") return res.writeHead(302, { Location: "ftp://example.test/manual.pdf" }).end();
    res.writeHead(404).end("not here");
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const id = (n: number) => `chk${RUN}l${n}`;
const read = (lib: string, rel: string) => path.join(lib, ...rel.split("\\"));

async function main() {
  const site = await startSite();
  const lib = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stitchbench-lib-"));
  process.env.FETCH_ALLOW_HOSTS = new URL(site.base).host;
  process.env.LIBRARY_DIR = lib;
  delete process.env.MANUAL_DOWNLOADS;
  const a = await checkShop({ repair: true });
  const b = await checkShop({ repair: true });
  const linkIds = [1, 2, 3, 4, 5, 6, 7].map(id);
  const steer = `chk${RUN}doc`;
  try {
    // A library that already files Baby Lock under "Baby-Lock" (so the check doesn't depend on what else the DB holds).
    await db.libraryDoc.create({ data: { id: steer, path: `Sewing\\Baby-Lock\\${steer}.pdf`, category: "Sewing", brand: "Baby-Lock", file: `${steer}.pdf`, docType: "ServiceManual", modelKeys: [] } });
    const now = new Date();
    const base = { category: "Sewing", brand: "Babylock", models: "BLQ2-CHK", modelKeys: ["BLQ2CHK"], docType: "ServiceManual", source: "127.0.0.1", status: "ok", updatedAt: now };
    await db.manualLink.createMany({
      data: [
        { id: id(1), ...base, title: "BLQ2 service manual", url: `${site.base}/good.pdf` },
        {
          id: id(2),
          category: null,
          brand: `Chk${RUN}`,
          models: "MC-CHK",
          modelKeys: ["MCCHK"],
          docType: "PartsList",
          title: "Janome parts (no category)",
          fileName: "Janome_MC-CHK_PartsList.pdf",
          url: `${site.base}/good.pdf`,
          status: "unchecked",
          updatedAt: now,
        },
        { id: id(3), ...base, docType: "OperatorManual", title: "BLQ2 operator manual (dead)", url: `${site.base}/gone.pdf`, status: "dead", httpStatus: 404, checkedAt: now },
        { id: id(4), ...base, docType: "ErrorCodes", title: "BLQ2 error codes (a web page)", url: `${site.base}/page.html` },
        { id: id(5), ...base, docType: "WiringDiagram", title: "BLQ2 wiring (404)", url: `${site.base}/missing.pdf` },
        { id: id(6), ...base, docType: "Bulletin", title: "BLQ2 bulletin (moved off the web)", url: `${site.base}/ftp.pdf` },
        { id: id(7), ...base, models: "BLQ2-CHK, BLQ3-CHK", modelKeys: ["BLQ2CHK", "BLQ3CHK"], docType: "PartsList", title: "BLQ2 / BLQ3 parts list (moved)", url: `${site.base}/moved.pdf` },
      ],
    });
    const links = await db.manualLink.findMany({ where: { id: { in: linkIds } } });
    const link = (n: number) => links.find((l) => l.id === id(n))!;

    // 1. Naming and what can be filed.
    assert.equal(linkStem(link(1)), "Babylock_BLQ2-CHK_ServiceManual");
    assert.equal(linkStem(link(7)), "Babylock_BLQ2-CHK+BLQ3-CHK_PartsList");
    assert.equal(linkStem(link(2)), "Janome_MC-CHK_PartsList", "the hub's file name wins when it says one");
    assert.equal(linkStem({ ...link(1), fileName: null, docType: null, models: "A/1" }), "Babylock_A_1_Manual");
    // File names the hub sends (round-3 I7): separators, drive letters and wildcards never survive into a stem.
    const named = (fileName: string) => linkStem({ ...link(1), fileName });
    assert.equal(named("../x.pdf"), ".._x");
    assert.equal(named("..\\..\\x.pdf"), ".._.._x", "backslashes");
    assert.equal(named("C:\\Windows\\win.ini"), "C_Windows_win.ini");
    assert.equal(named("a:b*c?.pdf"), "a_b_c_");
    assert.equal(named("x\u0000y.pdf"), "x_y", "a null byte");
    assert.equal(named(".pdf"), "Babylock_BLQ2-CHK_ServiceManual", "an empty stem falls back to the built name");
    for (const hostile of ["../x.pdf", "..\\..\\x.pdf", "C:\\x", "a/b\\c", "con.pdf"]) assert.ok(!/[\\/:*?"<>|\0]/.test(named(hostile)), `no path character in the stem for ${JSON.stringify(hostile)}`);
    assert.ok(named("x".repeat(400)).length <= 150, "cut to 150");
    // Windows treats CON.pdf, NUL.pdf and the like as devices. The stem keeps the name as the hub sent it: a known gap, pinned here
    // so a fix (prefixing such names) shows up as this line failing.
    assert.equal(named("CON"), "CON", "reserved device names pass through today");
    assert.ok(canFile(link(1)) && canFile(link(7)));
    assert.ok(!canFile(link(2)), "no category: can't be filed by model");
    assert.ok(!canFile({ ...link(1), modelKeys: [] }) && !canFile({ ...link(1), docType: null }));
    assert.equal(libraryDocId("Sewing\\Baby-Lock\\X.pdf").length, 20);
    ok("linkStem builds Brand_Model+Model_DocType (the hub's file name first); canFile wants category, brand, a model and the kind");

    // Coverage by kind of manual.
    const cov = coverage(
      [{ docType: "ServiceManual" }, { docType: "ServiceManual" }, { docType: "Firmware" }],
      [
        { docType: "PartsList", status: "ok" },
        { docType: "ErrorCodes", status: "dead" },
        { docType: "PartsList", status: "unchecked" },
      ],
    );
    assert.deepEqual(
      cov.map((c) => [c.docType, c.state, c.have, c.links, c.dead]),
      [
        ["ServiceManual", "have", 2, 0, 0],
        ["PartsList", "link", 0, 2, 0],
        ["OperatorManual", "missing", 0, 0, 0],
        ["ErrorCodes", "missing", 0, 0, 1],
        ["WiringDiagram", "missing", 0, 0, 0],
        ["Firmware", "have", 1, 0, 0],
      ],
    );
    ok("coverage: the five wanted kinds in order (in hand, link only, missing; dead links counted), then any other kind seen");

    // 2. "Download all" for the model: the working links queue, the dead one is counted and skipped.
    const q1 = await queueDownloads(a.user, { kind: "model", brand: "Babylock", model: "BLQ2-CHK" });
    clearDownloadKick();
    assert.equal(q1.label, "Babylock BLQ2-CHK");
    assert.deepEqual([q1.queued, q1.dead, q1.have, q1.busy], [5, 1, 0, 0]);
    assert.equal(await downloadsActive(a.shopId), true);
    assert.equal(await downloadsActive(b.shopId), false);
    // Queueing the same model again while the first job waits: nothing new.
    await expectError(
      "queued twice",
      () => queueDownloads(a.user, { kind: "model", brand: "Babylock", model: "BLQ2-CHK" }),
      /Nothing to download for Babylock BLQ2-CHK: 5 already waiting to download, 1 dead/,
    );
    clearDownloadKick();
    ok("download all for a model queues its 5 working links, skips the dead one, and won't queue a waiting link again");

    // 3. The worker: filed by model, a redirect on the web followed, a web page / a 404 / a move off the web fail with plain words.
    const r1 = await downloadRun({ pauseMs: 0, shopIds: [a.shopId] });
    assert.deepEqual(r1, { done: 2, failed: 3, skipped: 0, left: 0 });
    const rows = await db.manualDownload.findMany({ where: { shopId: a.shopId, jobId: q1.jobId } });
    const row = (n: number) => rows.find((r) => r.linkId === id(n))!;
    assert.equal(row(1).status, "DONE");
    assert.equal(row(1).path, "Sewing\\Baby-Lock\\Babylock_BLQ2-CHK_ServiceManual.pdf", "filed under the library's own brand folder");
    assert.equal(row(1).filed, true);
    assert.deepEqual(await fs.promises.readFile(read(lib, row(1).path!)), PDF);
    const side = JSON.parse(await fs.promises.readFile(read(lib, row(1).path!) + ".json", "utf8")) as { linkId: string; url: string };
    assert.equal(side.linkId, id(1));
    assert.equal(side.url, `${site.base}/good.pdf`);
    const doc = await db.libraryDoc.findUniqueOrThrow({ where: { id: libraryDocId(row(1).path!) } });
    assert.deepEqual(
      [doc.category, doc.brand, doc.file, doc.docType, doc.modelKeys, doc.linkId, doc.sourceUrl, doc.sizeBytes, doc.title],
      ["Sewing", "Baby-Lock", "Babylock_BLQ2-CHK_ServiceManual.pdf", "ServiceManual", ["BLQ2CHK"], id(1), `${site.base}/good.pdf`, PDF.length, "BLQ2 service manual"],
    );
    assert.ok(doc.downloadedAt);
    assert.equal(row(7).status, "DONE");
    assert.equal(row(7).path, "Sewing\\Baby-Lock\\Babylock_BLQ2-CHK+BLQ3-CHK_PartsList.pdf", "a redirect on the web is followed");
    assert.equal(row(4).status, "FAILED");
    assert.match(row(4).error!, /opens a web page, not the PDF itself/);
    assert.ok(!fs.existsSync(path.join(lib, "_inbox")), "a web page is not saved anywhere");
    assert.equal(row(5).status, "FAILED");
    assert.match(row(5).error!, /answered 404/);
    assert.equal(row(6).status, "FAILED");
    assert.match(row(6).error!, /Only web \(http\/https\) links.*can't be downloaded here/);
    assert.ok(rows.every((r) => r.tries === 1 && r.startedAt && r.finishedAt));
    ok(
      "the worker files a full link to Category\\Brand\\Brand_Model_DocType.pdf with its sidecar and LibraryDoc row, follows a web redirect, and fails a web page, a 404 and a move off the web with plain words",
    );

    // The size cap cuts the body off as it streams (the worker's cap is 300 MB; the same code with a small one).
    await assert.rejects(fetchPublic(`${site.base}/good.pdf`, { timeoutMs: 5000, maxBytes: 10 }), TooLarge);
    ok("a file over the size cap is cut off while downloading");

    // 4. No category: _inbox, with the hub's file name and a sidecar, no LibraryDoc row.
    const q2 = await queueDownloads(a.user, { kind: "brand", brand: `chk${RUN}` });
    clearDownloadKick();
    assert.deepEqual([q2.label, q2.queued], [`chk${RUN}`, 1]);
    const r2 = await downloadRun({ pauseMs: 0, shopIds: [a.shopId] });
    assert.deepEqual(r2, { done: 1, failed: 0, skipped: 0, left: 0 });
    const inboxRow = await db.manualDownload.findFirstOrThrow({ where: { shopId: a.shopId, jobId: q2.jobId } });
    assert.deepEqual([inboxRow.status, inboxRow.path, inboxRow.filed], ["DONE", "_inbox\\Janome_MC-CHK_PartsList.pdf", false]);
    assert.deepEqual(await fs.promises.readFile(read(lib, inboxRow.path!)), PDF);
    assert.ok(fs.existsSync(read(lib, inboxRow.path!) + ".json"));
    assert.equal(await db.libraryDoc.count({ where: { linkId: id(2) } }), 0);
    ok("a link without a category lands in _inbox under the hub's file name, with a sidecar and no LibraryDoc row");

    // 5. Already here: by LibraryDoc row, by the hub's file name, by an earlier download; gone from disk means fetch again.
    let idx = await haveIndex();
    assert.equal(await alreadyHave(link(1), lib, idx), "Sewing\\Baby-Lock\\Babylock_BLQ2-CHK_ServiceManual.pdf");
    assert.equal(await alreadyHave(link(2), lib, idx), "_inbox\\Janome_MC-CHK_PartsList.pdf", "an earlier download in _inbox counts");
    assert.equal(await alreadyHave(link(4), lib, idx), null);
    // The hub says what another shop filed it as, and this library has that file: no download.
    assert.equal(await alreadyHave({ ...link(4), id: "someother", fileName: "babylock_blq2-chk_servicemanual.PDF" }, lib, idx), "Sewing\\Baby-Lock\\Babylock_BLQ2-CHK_ServiceManual.pdf");
    // Filed by hand where the link would go: no download either.
    const byHand = path.join(lib, "Sewing", "Baby-Lock", "Babylock_BLQ2-CHK_ErrorCodes.pdf");
    await fs.promises.writeFile(byHand, PDF);
    assert.equal(await alreadyHave(link(4), lib, idx), "Sewing\\Baby-Lock\\Babylock_BLQ2-CHK_ErrorCodes.pdf");
    await fs.promises.unlink(byHand);
    await expectError("brand already here", () => queueDownloads(a.user, { kind: "brand", brand: `Chk${RUN}` }), /Nothing to download for Chk\w+: 1 already in the library/);
    clearDownloadKick();
    await fs.promises.unlink(read(lib, inboxRow.path!));
    idx = await haveIndex();
    assert.equal(await alreadyHave(link(2), lib, idx), null, "the file is gone: it can be downloaded again");
    const q3 = await queueDownloads(a.user, { kind: "brand", brand: `Chk${RUN}` });
    clearDownloadKick();
    assert.equal(q3.queued, 1);
    assert.equal(await cancelJob(a.shopId, q3.jobId), 1);
    ok("what's already in the library (by row, by the hub's file name, by an earlier download, or filed by hand) isn't fetched again; a deleted file is");

    // 6. "Every link not in the library": the two here and the dead one are left out, the failed ones are tried again.
    const q4 = await queueDownloads(a.user, { kind: "all" });
    clearDownloadKick();
    const q4rows = await db.manualDownload.findMany({ where: { shopId: a.shopId, jobId: q4.jobId }, select: { linkId: true } });
    const q4ids = new Set(q4rows.map((r) => r.linkId));
    assert.equal(q4.label, "every link not in the library");
    assert.ok(q4.queued >= 4 && q4.queued === q4rows.length);
    assert.ok(
      [2, 4, 5, 6].every((n) => q4ids.has(id(n))),
      "failed-before and gone-from-disk links are queued again",
    );
    assert.ok(![1, 3, 7].some((n) => q4ids.has(id(n))), "in the library or dead: left out");
    assert.ok(q4.dead >= 1 && q4.have >= 2);
    assert.equal(await cancelJob(a.shopId, q4.jobId), q4.queued);
    assert.equal(await db.manualDownload.count({ where: { jobId: q4.jobId } }), 0);
    ok("'every link not in the library' leaves out what's here and what's dead; Stop takes the waiting rows off the queue");

    // 7. Resume: rows a closed program left DOWNLOADING go once more, a second interruption gives up.
    const old = new Date(Date.now() - 20 * 60_000);
    const job = `chk${RUN}resume`;
    const [again, gaveUp] = await Promise.all([
      db.manualDownload.create({ data: { shopId: a.shopId, jobId: job, jobLabel: "resume", linkId: id(4), status: "DOWNLOADING", startedAt: old, tries: 1 } }),
      db.manualDownload.create({ data: { shopId: a.shopId, jobId: job, jobLabel: "resume", linkId: id(5), status: "DOWNLOADING", startedAt: old, tries: 2 } }),
    ]);
    const r3 = await downloadRun({ pauseMs: 0, shopIds: [a.shopId] });
    assert.deepEqual(r3, { done: 0, failed: 1, skipped: 0, left: 0 });
    const again2 = await db.manualDownload.findUniqueOrThrow({ where: { id: again.id } });
    assert.deepEqual([again2.status, again2.tries], ["FAILED", 2]);
    assert.match(again2.error!, /web page/);
    const gaveUp2 = await db.manualDownload.findUniqueOrThrow({ where: { id: gaveUp.id } });
    assert.deepEqual([gaveUp2.status, gaveUp2.error], ["FAILED", "Interrupted twice"]);
    // A link that went dead, or was downloaded, after it was queued is skipped when its turn comes.
    const late = await db.manualDownload.create({ data: { shopId: a.shopId, jobId: job, jobLabel: "resume", linkId: id(3) } });
    const late2 = await db.manualDownload.create({ data: { shopId: a.shopId, jobId: job, jobLabel: "resume", linkId: id(1) } });
    const r4 = await downloadRun({ pauseMs: 0, shopIds: [a.shopId] });
    assert.deepEqual(r4, { done: 0, failed: 0, skipped: 2, left: 0 });
    assert.deepEqual((await db.manualDownload.findUniqueOrThrow({ where: { id: late.id } })).error, "Dead link");
    assert.deepEqual((await db.manualDownload.findUniqueOrThrow({ where: { id: late2.id } })).error, "Already in the library");
    // maxFiles caps a run; the rest stays queued for the next.
    await db.manualDownload.createMany({ data: [id(4), id(5)].map((linkId) => ({ shopId: a.shopId, jobId: `${job}2`, jobLabel: "cap", linkId })) });
    const r5 = await downloadRun({ pauseMs: 0, shopIds: [a.shopId], maxFiles: 1 });
    assert.deepEqual(r5, { done: 0, failed: 1, skipped: 0, left: 1 });
    ok("a row left DOWNLOADING by a closed program is taken up once more, then given up; a link gone dead or already here since it was queued is skipped; a capped run leaves the rest queued");

    // 8. Progress: the job's counts, its problems with the link's words, what was saved and where; clear.
    const jobs = await downloadJobs(a.shopId);
    const j1 = jobs.find((j) => j.jobId === q1.jobId)!;
    assert.deepEqual([j1.label, j1.total, j1.queued, j1.downloading, j1.done, j1.skipped, j1.failed], ["Babylock BLQ2-CHK", 5, 0, 0, 2, 0, 3]);
    assert.equal(j1.current, null);
    assert.deepEqual(j1.problems.map((p) => p.title).sort(), ["BLQ2 bulletin (moved off the web)", "BLQ2 error codes (a web page)", "BLQ2 wiring (404)"]);
    assert.deepEqual(j1.saved.map((s) => s.path).sort(), ["Sewing\\Baby-Lock\\Babylock_BLQ2-CHK+BLQ3-CHK_PartsList.pdf", "Sewing\\Baby-Lock\\Babylock_BLQ2-CHK_ServiceManual.pdf"]);
    const cap = jobs.find((j) => j.jobId === `${job}2`)!;
    assert.deepEqual([cap.queued, cap.failed], [1, 1]);
    assert.equal(await downloadsActive(a.shopId), true);
    await clearJob(a.shopId, `${job}2`);
    assert.equal(await db.manualDownload.count({ where: { jobId: `${job}2` } }), 0);
    assert.equal(await downloadsActive(a.shopId), false);
    ok("downloadJobs gives each job's counts, its problems and what was saved where; clear removes a job");

    // 9. Switches: no library here; MANUAL_DOWNLOADS=off.
    const keep = process.env.LIBRARY_DIR;
    delete process.env.LIBRARY_DIR;
    await expectError("no library", () => queueDownloads(a.user, { kind: "all" }), /works in the StitchBench program on the shop PC/);
    assert.deepEqual(await downloadRun({ pauseMs: 0, shopIds: [a.shopId] }), { off: true });
    process.env.LIBRARY_DIR = keep;
    process.env.MANUAL_DOWNLOADS = "off";
    assert.deepEqual(await downloadRun({ pauseMs: 0, shopIds: [a.shopId] }), { off: true });
    delete process.env.MANUAL_DOWNLOADS;
    ok("without a library folder nothing can be queued or run; MANUAL_DOWNLOADS=off stops the worker");

    // 10. Tenant: B sees none of A's jobs and can't stop or clear them.
    const before = await snapshot(a.shopId, ["ManualDownload"]);
    assert.deepEqual(await downloadJobs(b.shopId), []);
    assert.equal(await cancelJob(b.shopId, q1.jobId), 0);
    await clearJob(b.shopId, q1.jobId);
    assertUnchanged("tenant", before, await snapshot(a.shopId, ["ManualDownload"]));
    ok("tenant: B's calls with A's job ids change nothing of A's");
  } finally {
    clearDownloadKick();
    await db.libraryDoc.deleteMany({ where: { OR: [{ linkId: { in: linkIds } }, { id: steer }] } }).catch(() => {});
    await db.manualLink.deleteMany({ where: { id: { in: linkIds } } }).catch(() => {});
    await cleanup();
    await site.close();
    await fs.promises.rm(lib, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`manual-downloads.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
