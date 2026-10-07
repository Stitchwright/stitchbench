// The manual repository, program side (docs/plans/manual-repository-design.md sections 3, 5 and 6.2; package repo-program).
// Against a stand-in for the hub's repository routes and R2 (scripts/checks/repo-mock.ts), in this process:
//   - an offer refuses a non-PDF, a private folder, a path out of the library, over 150 MB, an encrypted file, and an
//     unticked statement; a TECH can't offer until the owner's switch; nothing reaches the hub unless the offer action
//     runs (a sync sends only an empty probe); uploads off ("The manual repository opens soon.") offer nothing and are
//     remembered; the hub's duplicate and blocked answers come back in words; an interrupted send is retried with a new
//     slot; a file changed after it was chosen is not sent; offers move to waiting, in the repository, removed
//   - the feed becomes repository ManualLink rows (its own cursor); a download lands at
//     Category\Brand\Brand_Model_DocType_Year.pdf with its sidecar and hashes; a wrong sha256 saves nothing; a hostile
//     address is refused; the hub's 429 puts the row back for an hour; the disk guard stops the queue; a file held under
//     another name (sha256 or sha1) is not fetched; coverage counts the repository; a removal marks the LibraryDoc (copyright
//     and withdrawn, not replaced), a restore clears it, "Delete my copy" deletes only a marked copy
//   - a hub without a repository (404) leaves everything alone; the tenant section: company B can't see or act on A's offers
//   npm run check scripts/checks/manual-repository.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { hubState } from "@/lib/hub";
import { MOVE_TABLES, PER_INSTALL } from "@/lib/move/format";
import { clearDownloadKick, coverage, downloadJobs, downloadRun, haveIndex, alreadyHave, queueDownloads, libraryDocId } from "@/lib/manual-downloads";
import {
  canOfferNow,
  cleanFields,
  deleteWithdrawnCopyAt,
  guessFields,
  hostedOfferFinish,
  mayOffer,
  offerLibraryFile,
  offersFor,
  pullRepository,
  refreshOffers,
  REPO_MAX_BYTES,
  repositoryTotals,
  sendLibraryOffer,
  STATEMENT_VERSION,
} from "@/lib/manual-repository";
import { storageUrlOk } from "@/lib/safe-fetch";
import { checkShop, cleanup } from "./lib";
import { pdfBytes, sha1, sha256, startRepoMock } from "./repo-mock";
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

const brand = `Chk${RUN}`;
const read = (lib: string, rel: string) => path.join(lib, ...rel.split("\\"));

async function main() {
  const mock = await startRepoMock();
  const lib = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stitchbench-repo-"));
  process.env.FETCH_ALLOW_HOSTS = new URL(mock.base).host;
  process.env.LIBRARY_DIR = lib;
  process.env.REPO_MIN_FREE_BYTES = "0";
  delete process.env.MANUAL_DOWNLOADS;
  const savedHub = await hubState();
  const a = await checkShop({ repair: true });
  const b = await checkShop({ repair: true });
  const installId = `chk${RUN}`;
  const run = { installId };
  const put = async (rel: string, data: Buffer | string) => {
    const full = read(lib, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, data);
    return full;
  };
  const fields = (extra: Record<string, unknown> = {}) => ({ category: "Sewing", brand, models: "Q9, Q8", docType: "ServiceManual", year: "2019", language: "English", title: "", ...extra });
  const uploadPosts = () => mock.log.filter((l) => l.method === "POST" && l.path === "/v1/repository/uploads");
  const offers = () => uploadPosts().filter((l) => l.body !== "{}");
  let offerCalls = 0;
  const offer = (user: typeof a.user, rel: string, o: { accepted?: boolean; f?: Record<string, unknown> } = {}) => {
    offerCalls += 1;
    return offerLibraryFile(user, lib, rel, fields(o.f), o.accepted ?? true, { background: false });
  };
  try {
    await db.libraryDoc.deleteMany({ where: { brand: "_inbox", file: "dup.pdf" } });
    await db.hubState.upsert({
      where: { id: 1 },
      create: { id: 1, url: mock.base, hubName: "Check hub", installId, installKey: "chk-key", scope: "member", joinedAt: new Date() },
      update: { url: mock.base, hubName: "Check hub", installId, installKey: "chk-key", scope: "member", repoCursor: null, repoUploads: null, repoProbeAt: null },
    });

    // 1. The dialog's fields.
    assert.deepEqual(cleanFields(fields()), { category: "Sewing", brand, models: "Q9, Q8", docType: "ServiceManual", year: 2019, language: "English", title: null });
    assert.throws(() => cleanFields(fields({ brand: "" })), /brand/);
    assert.throws(() => cleanFields(fields({ models: " , " })), /model/i);
    assert.throws(() => cleanFields(fields({ docType: "Cookbook" })), /kind of manual/);
    assert.throws(() => cleanFields(fields({ category: "" })), /category/i);
    assert.throws(() => cleanFields(fields({ year: "1850" })), /year/);
    assert.equal(cleanFields(fields({ year: "" })).year, null);
    assert.deepEqual(guessFields("Brother_NV1+NV2_ServiceManual_2016.pdf"), { brand: "Brother", models: "NV1, NV2", docType: "ServiceManual", year: "2016" });
    assert.deepEqual(guessFields("scan0001.pdf"), {}, "an _inbox name says nothing");
    assert.equal(guessFields("x.pdf", { category: "Sewing", brand: "Juki", docType: "PartsList", title: "T" }).brand, "Juki", "the library row wins");
    ok("the dialog's fields are checked in the hub's rules; the first guess comes from the library row or the file name");

    // 2. What an offer refuses, before anything reaches the hub.
    const good = pdfBytes(`manual A ${RUN}`);
    await put(`Sewing\\${brand}\\${brand}_Q9_ServiceManual_2019.pdf`, good);
    await db.libraryDoc.create({ data: { id: libraryDocId(`Sewing\\${brand}\\${brand}_Q9_ServiceManual_2019.pdf`), path: `Sewing\\${brand}\\${brand}_Q9_ServiceManual_2019.pdf`, category: "Sewing", brand, file: `${brand}_Q9_ServiceManual_2019.pdf`, docType: "ServiceManual", modelKeys: ["Q9", "Q8"] } });
    await put("_inbox\\notpdf.pdf", "This is a text file, not a PDF");
    await put("_business-notes\\prices.pdf", pdfBytes(`private prices ${RUN}`));
    await put("_own-notes\\notes.pdf", pdfBytes(`own notes ${RUN}`));
    await put("_inbox\\enc.pdf", `%PDF-1.7\n1 0 obj\n<< >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF\n`);
    const big = read(lib, "_inbox\\big.pdf");
    await fs.promises.writeFile(big, "%PDF-1.4\n");
    await fs.promises.truncate(big, REPO_MAX_BYTES + 1);
    await put("_inbox\\just-under.txt", "x");
    await expectError("not a PDF", () => offer(a.user, "_inbox\\notpdf.pdf"), /isn't a PDF/);
    await expectError("private folder", () => offer(a.user, "_business-notes\\prices.pdf"), /isn't in the manual library/);
    await expectError("own notes", () => offer(a.user, "_own-notes\\notes.pdf"), /isn't in the manual library/);
    await expectError("out of the library", () => offer(a.user, "..\\..\\Windows\\win.pdf"), /isn't in the manual library/);
    await expectError("not a pdf name", () => offer(a.user, "_inbox\\just-under.txt"), /isn't in the manual library/);
    await expectError("over 150 MB", () => offer(a.user, "_inbox\\big.pdf"), /150 MB/);
    await expectError("encrypted", () => offer(a.user, "_inbox\\enc.pdf"), /encrypted/);
    await expectError("missing", () => offer(a.user, "_inbox\\nothing-here.pdf"), /isn't in the library any more/);
    await expectError("statement not ticked", () => offer(a.user, `Sewing\\${brand}\\${brand}_Q9_ServiceManual_2019.pdf`, { accepted: false }), /Tick the statement/);
    await expectError("no brand", () => offer(a.user, `Sewing\\${brand}\\${brand}_Q9_ServiceManual_2019.pdf`, { f: { brand: "" } }), /brand/);
    assert.equal(uploadPosts().length, 0, "none of that reached the hub");
    assert.equal(mock.log.filter((l) => l.method === "PUT").length, 0);
    assert.equal(await db.manualOffer.count({ where: { shopId: a.shopId } }), 0, "and left no offer row");
    offerCalls = 0;
    ok("an offer refuses a non-PDF, private folders, a path out of the library, over 150 MB, an encrypted file and an unticked statement; nothing reaches the hub");

    // 3. Who may offer: a TECH only when the owner's switch is on; a company whose hub writes are off can't.
    const tech = { ...a.user, role: "TECH" as const };
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { techsOfferManuals: true } })).techsOfferManuals, false, "the switch is off by default");
    await expectError("tech without the switch", () => mayOffer(tech), /owner or an admin/);
    await expectError("tech offering", () => offer(tech, `Sewing\\${brand}\\${brand}_Q9_ServiceManual_2019.pdf`), /owner or an admin/);
    await db.shop.update({ where: { id: a.shopId }, data: { techsOfferManuals: true } });
    await mayOffer(tech);
    await db.shop.update({ where: { id: a.shopId }, data: { techsOfferManuals: false } });
    await db.shop.update({ where: { id: a.shopId }, data: { hubWritesOff: true } });
    await expectError("hub writes off", () => mayOffer(a.user), /switched off/);
    await db.shop.update({ where: { id: a.shopId }, data: { hubWritesOff: false } });
    await db.shop.update({ where: { id: a.shopId }, data: { movingAt: new Date() } });
    await expectError("being moved", () => mayOffer(a.user), /being moved/);
    await db.shop.update({ where: { id: a.shopId }, data: { movingAt: null } });
    assert.equal(await canOfferNow(tech), false, "no button for a tech until the switch");
    assert.equal(await canOfferNow(a.user), true);
    assert.equal(uploadPosts().length, 0);
    ok("a TECH can't offer until the owner's switch; hub writes off and a move in progress refuse; nothing sent");

    // 4. Uploads off: the hub's answer is remembered, nothing is offered; a sync sends only an empty probe.
    mock.uploadsOn = false;
    assert.equal((await hubState())?.repoUploads, null);
    await pullRepository(run, lib);
    assert.equal((await hubState())?.repoUploads, "soon", "the probe learns it without offering anything");
    assert.ok(uploadPosts().every((l) => l.body === "{}") && uploadPosts().length === 1, "the probe carries no file, hash or name");
    assert.equal(await canOfferNow(a.user), false);
    await expectError("opens soon", () => offer(a.user, `Sewing\\${brand}\\${brand}_Q9_ServiceManual_2019.pdf`), /The manual repository opens soon\./);
    assert.equal(uploadPosts().length, 1, "refused before anything was sent");
    // A hub that answers "soon" to an offer (the state not learned yet) is told nothing more: no row, no PUT.
    await db.hubState.update({ where: { id: 1 }, data: { repoUploads: null } });
    await expectError("opens soon (the hub's answer)", () => offer(a.user, `Sewing\\${brand}\\${brand}_Q9_ServiceManual_2019.pdf`), /The manual repository opens soon\./);
    assert.equal((await hubState())?.repoUploads, "soon");
    assert.equal(await db.manualOffer.count({ where: { shopId: a.shopId } }), 0);
    assert.equal(mock.log.filter((l) => l.method === "PUT").length, 0);
    mock.uploadsOn = true;
    await db.hubState.update({ where: { id: 1 }, data: { repoProbeAt: null } });
    await pullRepository(run, lib);
    assert.equal((await hubState())?.repoUploads, "open", "and learns it opened");
    assert.equal(await canOfferNow(a.user), true);
    offerCalls = 0;
    ok('uploads off: "The manual repository opens soon." and nothing offered; a sync sends only an empty probe and notices when it opens');

    // 5. An offer: statement, X-Shop-Ref, the PUT, the hub told, then its states.
    const rel = `Sewing\\${brand}\\${brand}_Q9_ServiceManual_2019.pdf`;
    const r1 = await offer(a.user, rel);
    assert.equal(r1.state, "SENDING");
    let row = await db.manualOffer.findUniqueOrThrow({ where: { id: r1.id } });
    assert.equal(row.state, "WAITING", "PUT, sent, and the hub says pending");
    assert.equal(row.sha256, sha256(good));
    assert.equal(row.statementVersion, STATEMENT_VERSION);
    assert.match(row.byName, new RegExp(`^${a.user.name}`));
    const post = offers()[0];
    assert.equal(post.shopRef, a.shopId, "the company is named (X-Shop-Ref)");
    const sent = JSON.parse(post.body);
    assert.deepEqual(sent.statement, { version: STATEMENT_VERSION, accepted: true });
    assert.deepEqual(sent.offered.models, ["Q9", "Q8"]);
    assert.equal(sent.offered.year, 2019);
    assert.equal(sent.sha256, sha256(good));
    assert.deepEqual(mock.objects.get(`incoming/${row.hubUploadId}.pdf`), good, "the bytes in storage are the file");
    assert.ok(mock.log.some((l) => l.method === "POST" && l.path === `/v1/repository/uploads/${row.hubUploadId}/sent` && l.shopRef === a.shopId));
    await expectError("the same file again", () => offer(a.user, rel), /already offered/);
    // Approved on the hub, then removed after a notice.
    const up = mock.uploads.get(row.hubUploadId!)!;
    up.state = "approved";
    up.manualId = `chk${RUN}off1`;
    await refreshOffers(lib);
    row = await db.manualOffer.findUniqueOrThrow({ where: { id: r1.id } });
    assert.equal(row.state, "PUBLISHED");
    assert.equal(row.hubManualId, `chk${RUN}off1`);
    up.state = "removed";
    await refreshOffers(lib);
    row = await db.manualOffer.findUniqueOrThrow({ where: { id: r1.id } });
    assert.equal(row.state, "REMOVED");
    assert.match(row.reason ?? "", /copyright notice/);
    ok("an offer carries the statement and the company, PUTs the file, tells the hub; the list follows waiting, in the repository, removed");

    // 6. Duplicate and blocked, in words, with nothing sent.
    const dupBytes = pdfBytes(`manual dup ${RUN}`);
    const blkBytes = pdfBytes(`manual blocked ${RUN}`);
    await put("_inbox\\dup.pdf", dupBytes);
    await put("_inbox\\blk.pdf", blkBytes);
    mock.duplicates.set(sha256(dupBytes), `chk${RUN}dupman`);
    mock.blocked.add(sha256(blkBytes));
    const puts = mock.log.filter((l) => l.method === "PUT").length;
    const d = await offer(a.user, "_inbox\\dup.pdf");
    assert.equal(d.state, "DUPLICATE");
    assert.match(d.message, /already in the repository/);
    const bl = await offer(a.user, "_inbox\\blk.pdf");
    assert.equal(bl.state, "BLOCKED");
    assert.match(bl.message, /can't be offered again/);
    assert.equal(mock.log.filter((l) => l.method === "PUT").length, puts, "no bytes sent for either");
    // The library's copy knows the repository's id and hash, so the queue never downloads it back.
    await db.libraryDoc.create({ data: { id: libraryDocId("_inbox\\dup.pdf"), path: "_inbox\\dup.pdf", category: "_inbox", brand: "_inbox", file: "dup.pdf", modelKeys: [] } });
    await db.manualOffer.deleteMany({ where: { shopId: a.shopId, sha256: sha256(dupBytes) } });
    const d2 = await offer(a.user, "_inbox\\dup.pdf");
    assert.equal(d2.state, "DUPLICATE");
    const dupDoc = await db.libraryDoc.findUniqueOrThrow({ where: { path: "_inbox\\dup.pdf" } });
    assert.equal(dupDoc.sha256, sha256(dupBytes));
    assert.equal(dupDoc.linkId, `repo_chk${RUN}dupman`);
    ok("the hub's duplicate and blocked answers come back in words with no bytes sent; a duplicate marks the library copy with the repository's id and hash");

    // 7. An interrupted send is retried with a new slot; a changed file is not sent.
    await put("_inbox\\flaky.pdf", pdfBytes(`manual flaky ${RUN}`));
    mock.putFail = 1;
    const f1 = await offer(a.user, "_inbox\\flaky.pdf");
    row = await db.manualOffer.findUniqueOrThrow({ where: { id: f1.id } });
    assert.equal(row.state, "SENDING");
    assert.match(row.reason ?? "", /Will try again/);
    const firstSlot = row.hubUploadId;
    assert.equal(await sendLibraryOffer(row.id, lib), "WAITING");
    row = await db.manualOffer.findUniqueOrThrow({ where: { id: f1.id } });
    assert.notEqual(row.hubUploadId, firstSlot, "a new slot");
    assert.equal(row.tries, 2);
    await put("_inbox\\changed.pdf", pdfBytes(`manual before ${RUN}`));
    mock.putFail = 1;
    const c1 = await offer(a.user, "_inbox\\changed.pdf");
    await put("_inbox\\changed.pdf", pdfBytes(`manual after the offer was made ${RUN}`));
    assert.equal(await sendLibraryOffer(c1.id, lib), "FAILED");
    row = await db.manualOffer.findUniqueOrThrow({ where: { id: c1.id } });
    assert.match(row.reason ?? "", /changed after it was chosen/);
    ok("an interrupted send stays SENDING and is retried with a new slot; a file changed after it was chosen is never sent");

    // 8. A hub without a repository (404) is left alone.
    const old = http.createServer((req, res) => (req.url === "/health" ? res.writeHead(200).end("{}") : res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "No such route." }))));
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", () => r()));
    await db.hubState.update({ where: { id: 1 }, data: { url: `http://127.0.0.1:${(old.address() as { port: number }).port}`, repoUploads: null, repoProbeAt: null, repoCursor: "5" } });
    assert.deepEqual(await pullRepository(run, lib), { none: true });
    assert.equal((await hubState())?.repoCursor, "5", "the cursor stays");
    assert.equal((await hubState())?.repoUploads, "none");
    assert.equal(await canOfferNow(a.user), false);
    await expectError("no repository", () => mayOffer(a.user), /doesn't have a manual repository/);
    await new Promise<void>((r) => old.close(() => r()));
    await db.hubState.update({ where: { id: 1 }, data: { url: mock.base, repoUploads: null, repoProbeAt: null, repoCursor: null } });
    ok("a hub without a repository (404): nothing changes, no offering");

    // 9. The feed becomes repository links.
    const P1 = pdfBytes(`repo one ${RUN}`);
    const P2 = pdfBytes(`repo two ${RUN}`);
    const P3 = pdfBytes(`repo three: the hub describes another file ${RUN}`);
    const P4 = pdfBytes(`repo four, held here under another name ${RUN}`);
    const P5 = pdfBytes(`repo five, held here, known by sha1 only ${RUN}`);
    const base = (n: string, models: string[], docType: string, year: number | null) => ({
      category: "Sewing",
      brand,
      models,
      modelKeys: models.map((m) => m.toUpperCase()),
      docType,
      year,
      title: `${brand} ${models[0]} ${docType}`,
      fileName: `${brand}_${models[0]}_${docType}${year ? `_${year}` : ""}.pdf`,
      n,
    });
    const id = (n: number) => `chk${RUN}m${n}`;
    mock.publish(id(1), base("1", ["X1", "X2"], "ServiceManual", 2020), P1);
    mock.publish(id(2), base("2", ["X1"], "PartsList", null), P2);
    mock.publish(id(3), base("3", ["W3"], "ErrorCodes", 2018), pdfBytes(`what the storage really holds ${RUN}`));
    mock.feed.find((x) => x.id === id(3))!.sha256 = sha256(P3); // the hub's description, not the bytes
    mock.publish(id(4), base("4", ["V4"], "ServiceManual", 2015), P4);
    mock.publish(id(5), base("5", ["V5"], "ServiceManual", 2014), P5);
    const r = await pullRepository(run, lib);
    assert.deepEqual(r, { items: 5 });
    const links = await db.manualLink.findMany({ where: { id: { startsWith: `repo_chk${RUN}` } }, orderBy: { id: "asc" } });
    assert.equal(links.length, 5);
    const l1 = links.find((l) => l.id === `repo_${id(1)}`)!;
    assert.equal(l1.origin, "repository");
    assert.equal(l1.url, `stitchhub:repository/${id(1)}`);
    assert.equal(l1.status, "ok");
    assert.deepEqual(l1.modelKeys, ["X1", "X2"]);
    assert.equal(l1.models, "X1, X2");
    assert.equal(l1.fileName, `${brand}_X1_ServiceManual_2020.pdf`);
    assert.equal(l1.sha256, sha256(P1));
    assert.equal(l1.sha1, sha1(P1));
    assert.equal(l1.sizeBytes, P1.length);
    assert.equal(l1.year, 2020);
    assert.equal(l1.pages, 3);
    assert.equal((await hubState())?.repoCursor, String(mock.seq), "its own cursor moved");
    const feedAsks = mock.log.filter((l) => l.path === "/v1/repository/changes").length;
    assert.deepEqual(await pullRepository(run, lib), { items: 0 }, "the next sync asks from the cursor and gets nothing");
    assert.ok(mock.log.filter((l) => l.path === "/v1/repository/changes").length > feedAsks);
    // A hostile id in the feed never becomes a row.
    mock.feed.push({ id: "../x", seq: ++mock.seq, brand: "Evil", models: ["E"], docType: "ServiceManual" });
    await pullRepository(run, lib);
    assert.equal(await db.manualLink.count({ where: { brand: "Evil" } }), 0);
    ok("the feed becomes repository ManualLink rows (repo_<id>, stitchhub:repository/<id>, status ok) from its own cursor; a bad id is skipped");

    // 10. Coverage counts the repository as available.
    const cov = coverage([], links);
    assert.equal(cov.find((c) => c.docType === "ServiceManual")!.state, "repo");
    assert.equal(cov.find((c) => c.docType === "ServiceManual")!.repo, 3);
    assert.equal(cov.find((c) => c.docType === "OperatorManual")!.state, "missing");
    assert.equal(coverage([{ docType: "ServiceManual" }], links).find((c) => c.docType === "ServiceManual")!.state, "have");
    assert.equal(coverage([], [{ docType: "PartsList", status: "ok" }]).find((c) => c.docType === "PartsList")!.state, "link", "a web link is still a link");
    assert.equal(coverage([], [{ docType: "PartsList", status: "dead" }]).find((c) => c.docType === "PartsList")!.state, "missing");
    const tot = await repositoryTotals(links);
    assert.equal(tot.files, 5);
    assert.equal(tot.bytes, links.reduce((s, l) => s + (l.sizeBytes ?? 0), 0));
    ok("coverage: in the repository counts as available (state repo), a link is a link, dead is missing; the totals for the confirm text");

    // 11. Downloads: filed under Category\Brand\Brand_Model_DocType_Year.pdf, hash checked, held-under-another-name skipped.
    const heldRel = `Sewing\\${brand}\\Some old name.pdf`;
    await put(heldRel, P4);
    await db.libraryDoc.create({ data: { id: libraryDocId(heldRel), path: heldRel, category: "Sewing", brand, file: "Some old name.pdf", docType: "ServiceManual", modelKeys: [], sha256: sha256(P4) } });
    const heldRel5 = `Sewing\\${brand}\\Another old name.pdf`;
    await put(heldRel5, P5);
    await db.libraryDoc.create({ data: { id: libraryDocId(heldRel5), path: heldRel5, category: "Sewing", brand, file: "Another old name.pdf", docType: "ServiceManual", modelKeys: [], sha1: sha1(P5) } });
    let idx = await haveIndex();
    const l4 = links.find((l) => l.id === `repo_${id(4)}`)!;
    const l5 = links.find((l) => l.id === `repo_${id(5)}`)!;
    assert.equal(await alreadyHave(l4, lib, idx), heldRel, "held under another name: matched by sha256");
    assert.equal(await alreadyHave(l5, lib, idx), heldRel5, "held under another name: matched by sha1");
    assert.equal(await alreadyHave(l1, lib, idx), null);
    const q = await queueDownloads(a.user, { kind: "brand", brand });
    clearDownloadKick();
    assert.equal(q.queued, 3, "m1, m2 and m3; m4 and m5 are already here");
    assert.equal(q.have, 2);
    assert.equal(q.repoFiles, 3);
    const res = await downloadRun({ pauseMs: 0, shopIds: [a.shopId] });
    clearDownloadKick();
    assert.deepEqual(res, { done: 2, failed: 1, skipped: 0, left: 0 });
    const filed1 = `Sewing\\${brand}\\${brand}_X1_ServiceManual_2020.pdf`;
    assert.deepEqual(await fs.promises.readFile(read(lib, filed1)), P1, "m1 landed at Category\\Brand\\Brand_Model_DocType_Year.pdf");
    assert.ok(fs.existsSync(read(lib, `Sewing\\${brand}\\${brand}_X1_PartsList.pdf`)), "no year: Brand_Model_DocType.pdf");
    const doc1 = await db.libraryDoc.findUniqueOrThrow({ where: { path: filed1 } });
    assert.equal(doc1.sha256, sha256(P1));
    assert.equal(doc1.sha1, sha1(P1));
    assert.equal(doc1.linkId, `repo_${id(1)}`);
    assert.equal(doc1.docType, "ServiceManual");
    assert.deepEqual(doc1.modelKeys, ["X1", "X2"]);
    const side = JSON.parse(await fs.promises.readFile(`${read(lib, filed1)}.json`, "utf8"));
    assert.equal(side.origin, "repository");
    assert.equal(side.sha256, sha256(P1));
    assert.equal(side.linkId, `repo_${id(1)}`);
    // A wrong sha256 saves nothing.
    const jobs = (await downloadJobs(a.shopId, { jobIds: [q.jobId] }))[0];
    assert.equal(jobs.failed, 1);
    assert.match(jobs.problems[0].error ?? "", /checksum differs/);
    assert.ok(!fs.existsSync(read(lib, `Sewing\\${brand}\\${brand}_W3_ErrorCodes_2018.pdf`)), "nothing saved for the wrong hash");
    assert.equal(await db.libraryDoc.count({ where: { linkId: `repo_${id(3)}` } }), 0);
    assert.ok(!mock.log.some((l) => l.path === `/v1/repository/files/${id(4)}/url`), "the file held under another name was never fetched");
    // Held under the same name another time: not fetched again.
    idx = await haveIndex();
    assert.equal(await alreadyHave(l1, lib, idx), filed1);
    ok("a download lands at Category\\Brand\\Brand_Model_DocType_Year.pdf with the sidecar and hashes; a wrong sha256 saves nothing; a file held under another name (sha256 or sha1) is not fetched");

    // 12. A hostile address, the hub's 429, the disk guard.
    mock.urlOverride = "http://169.254.169.254/latest/x.pdf";
    mock.publish(id(8), base("8", ["H8"], "ServiceManual", 2001), pdfBytes(`hostile ${RUN}`));
    await pullRepository(run, lib);
    await queueDownloads(a.user, { kind: "model", brand, model: "H8" });
    clearDownloadKick();
    await downloadRun({ pauseMs: 0, shopIds: [a.shopId] });
    clearDownloadKick();
    const h8 = await db.manualDownload.findFirstOrThrow({ where: { linkId: `repo_${id(8)}` } });
    assert.equal(h8.status, "FAILED");
    assert.match(h8.error ?? "", /won't use/);
    mock.urlOverride = null;
    assert.ok(storageUrlOk("https://acct.r2.cloudflarestorage.com/bucket/files/x.pdf?X-Amz-Signature=1"));
    assert.ok(!storageUrlOk("http://acct.r2.cloudflarestorage.com/bucket/x"), "plain http to R2");
    assert.ok(!storageUrlOk("https://evil.example.com/bucket/x"));
    assert.ok(!storageUrlOk("https://acct.r2.cloudflarestorage.com.evil.example/x"));
    assert.ok(!storageUrlOk("https://user:pw@acct.r2.cloudflarestorage.com/x"));
    assert.ok(!storageUrlOk("http://169.254.169.254/x"));
    assert.ok(!storageUrlOk("not a url"));
    ok("a download address that isn't R2's host is refused; only https on r2.cloudflarestorage.com (or the test allow-list) passes");

    mock.publish(id(6), base("6", ["U6"], "ServiceManual", 2012), pdfBytes(`repo six ${RUN}`));
    await pullRepository(run, lib);
    await queueDownloads(a.user, { kind: "model", brand, model: "U6" });
    clearDownloadKick();
    mock.slow = 1;
    const slow = await downloadRun({ pauseMs: 0, shopIds: [a.shopId] });
    clearDownloadKick();
    assert.deepEqual(slow, { done: 0, failed: 0, skipped: 0, left: 1 });
    let r6 = await db.manualDownload.findFirstOrThrow({ where: { linkId: `repo_${id(6)}` } });
    assert.equal(r6.status, "QUEUED", "the 429 puts the row back");
    assert.equal(r6.tries, 0);
    assert.ok(r6.retryAfter && r6.retryAfter.getTime() - Date.now() > 50 * 60_000, "for the next hour");
    assert.match(r6.error ?? "", /slow down/);
    assert.deepEqual(await downloadRun({ pauseMs: 0, shopIds: [a.shopId] }), { done: 0, failed: 0, skipped: 0, left: 1 }, "not taken before then");
    clearDownloadKick();
    await db.manualDownload.update({ where: { id: r6.id }, data: { retryAfter: new Date(Date.now() - 1000) } });
    assert.equal((await downloadRun({ pauseMs: 0, shopIds: [a.shopId] }) as { done: number }).done, 1);
    clearDownloadKick();
    r6 = await db.manualDownload.findFirstOrThrow({ where: { linkId: `repo_${id(6)}` } });
    assert.equal(r6.status, "DONE");

    mock.publish(id(7), base("7", ["T7"], "ServiceManual", 2011), pdfBytes(`repo seven ${RUN}`));
    await pullRepository(run, lib);
    process.env.REPO_MIN_FREE_BYTES = String(1e15);
    await expectError("disk guard at queueing", () => queueDownloads(a.user, { kind: "model", brand, model: "T7" }), /Not enough room/);
    process.env.REPO_MIN_FREE_BYTES = "0";
    await queueDownloads(a.user, { kind: "model", brand, model: "T7" });
    clearDownloadKick();
    clearDownloadKick();
    process.env.REPO_MIN_FREE_BYTES = String(1e15);
    const low = await downloadRun({ pauseMs: 0, shopIds: [a.shopId] });
    clearDownloadKick();
    assert.deepEqual(low, { done: 0, failed: 0, skipped: 0, left: 1 });
    const r7 = await db.manualDownload.findFirstOrThrow({ where: { linkId: `repo_${id(7)}` } });
    assert.equal(r7.status, "QUEUED");
    assert.match(r7.error ?? "", /Stopped: less than/);
    assert.ok(!mock.log.some((l) => l.path === `/v1/repository/files/${id(7)}/url`), "no URL asked for with no room");
    process.env.REPO_MIN_FREE_BYTES = "0";
    await db.manualDownload.update({ where: { id: r7.id }, data: { retryAfter: null } });
    assert.equal((await downloadRun({ pauseMs: 0, shopIds: [a.shopId] }) as { done: number }).done, 1);
    clearDownloadKick();
    ok("the hub's 429 puts the row back for an hour (not retried sooner); the disk guard refuses a queue that can't fit and stops a run with the row still queued, in words");

    // 13. Removals: copyright and withdrawn mark the copy, replaced doesn't; a restore clears it; Delete my copy only for a marked one.
    mock.remove(id(1), "copyright");
    mock.remove(id(2), "replaced");
    mock.remove(id(6), "withdrawn");
    await pullRepository(run, lib);
    assert.equal(await db.manualLink.count({ where: { id: { in: [`repo_${id(1)}`, `repo_${id(2)}`, `repo_${id(6)}`] } } }), 0, "the rows are gone");
    const w1 = await db.libraryDoc.findUniqueOrThrow({ where: { path: filed1 } });
    assert.ok(w1.withdrawnAt);
    assert.equal(w1.withdrawnWhy, "copyright");
    assert.ok(fs.existsSync(read(lib, filed1)), "the program never deletes the file itself");
    const w2 = await db.libraryDoc.findFirstOrThrow({ where: { linkId: `repo_${id(2)}` } });
    assert.equal(w2.withdrawnAt, null, "replaced: the copy here is as good as it was");
    const w6 = await db.libraryDoc.findFirstOrThrow({ where: { linkId: `repo_${id(6)}` } });
    assert.equal(w6.withdrawnWhy, "withdrawn");
    mock.publish(id(1), base("1", ["X1", "X2"], "ServiceManual", 2020), P1);
    await pullRepository(run, lib);
    assert.equal((await db.libraryDoc.findUniqueOrThrow({ where: { path: filed1 } })).withdrawnAt, null, "restored after a counter-notice: no longer marked");
    mock.remove(id(1), "copyright");
    await pullRepository(run, lib);
    await expectError("an unmarked copy", () => deleteWithdrawnCopyAt(lib, `Sewing\\${brand}\\${brand}_X1_PartsList.pdf`), /isn't marked/);
    assert.ok(fs.existsSync(read(lib, `Sewing\\${brand}\\${brand}_X1_PartsList.pdf`)));
    await deleteWithdrawnCopyAt(lib, filed1);
    assert.ok(!fs.existsSync(read(lib, filed1)) && !fs.existsSync(`${read(lib, filed1)}.json`), "the file and its sidecar are gone");
    assert.equal(await db.libraryDoc.count({ where: { path: filed1 } }), 0);
    ok("copyright and withdrawn mark the library copy (replaced doesn't), a restore clears it, Delete my copy removes only a marked copy and its sidecar");

    // 14. Tenant: company B can't see or act on A's offers.
    const before = await snapshot(a.shopId, ["ManualOffer", "Shop"]);
    assert.ok((await offersFor(a.shopId)).length >= 5);
    assert.deepEqual(await offersFor(b.shopId), [], "B sees none of A's offers");
    await expectError("B finishing A's offer", () => hostedOfferFinish(b.user, r1.id), /not found/i);
    await expectError("B finishing a made-up offer", () => hostedOfferFinish(b.user, "nope"), /not found/i);
    await refreshOffers(lib);
    assertUnchanged("A's offers after B's calls", before, await snapshot(a.shopId, ["ManualOffer", "Shop"]));
    // B's own offer is B's: A sees nothing of it.
    await put("_inbox\\bs.pdf", pdfBytes(`B's own ${RUN}`));
    const bOffer = await offer(b.user, "_inbox\\bs.pdf");
    assert.equal((await db.manualOffer.findUniqueOrThrow({ where: { id: bOffer.id } })).shopId, b.shopId);
    assert.ok(!(await offersFor(a.shopId)).some((o) => o.id === bOffer.id));
    assert.equal(mock.log.filter((l) => l.method === "GET" && l.path === "/v1/repository/uploads" && l.shopRef === b.shopId).length >= 0, true);
    ok("tenant: B sees none of A's offers and can't finish or change them; A's rows are unchanged; B's offer is B's");

    // 15. Nothing but the offer action sent a file: every non-empty POST to /uploads was an offer that passed its checks.
    const chosen = new Set(
      await Promise.all(
        [rel, "_inbox\\dup.pdf", "_inbox\\blk.pdf", "_inbox\\flaky.pdf", "_inbox\\changed.pdf", "_inbox\\bs.pdf"].map(async (f) => sha256(await fs.promises.readFile(read(lib, f)).catch(() => Buffer.alloc(0)))),
      ),
    );
    const sentShas = offers().map((o) => JSON.parse(o.body).sha256 as string);
    assert.ok(sentShas.length >= 8 && sentShas.every((x) => chosen.has(x) || x === sha256(pdfBytes(`manual before ${RUN}`))), "every hub offer names a file a person chose: " + JSON.stringify(sentShas.filter((x) => !chosen.has(x))));
    assert.ok(!sentShas.includes(sha256(pdfBytes(`private prices ${RUN}`))) && !sentShas.includes(sha256(pdfBytes(`own notes ${RUN}`))), "nothing from the private folders was ever named to the hub");
    void offerCalls;
    assert.ok(uploadPosts().filter((l) => l.body === "{}").every((l) => l.shopRef === null), "the probe names no company");
    assert.ok(PER_INSTALL.ManualOffer, "the company move lists ManualOffer (stays with the install)");
    assert.ok(!MOVE_TABLES.some((t) => t.t === "ManualOffer"));
    ok("only the offer action sent a file; every other call was an empty probe; the move format lists ManualOffer");
  } finally {
    await db.manualLink.deleteMany({ where: { id: { startsWith: `repo_chk${RUN}` } } }).catch(() => undefined);
    await db.manualDownload.deleteMany({ where: { linkId: { startsWith: `repo_chk${RUN}` } } }).catch(() => undefined);
    await db.libraryDoc.deleteMany({ where: { OR: [{ brand }, { brand: "_inbox", file: "dup.pdf" }] } }).catch(() => undefined);
    await cleanup().catch(() => undefined);
    if (savedHub) await db.hubState.update({ where: { id: 1 }, data: { url: savedHub.url, installId: savedHub.installId, installKey: savedHub.installKey, scope: savedHub.scope, repoCursor: savedHub.repoCursor, repoUploads: savedHub.repoUploads, repoProbeAt: savedHub.repoProbeAt } }).catch(() => undefined);
    else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => undefined);
    await mock.close();
    await fs.promises.rm(lib, { recursive: true, force: true }).catch(() => undefined);
  }
  console.log(`\n${steps} sections passed`);
}

main()
  .then(() => db.$disconnect().then(() => process.exit(0)))
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
