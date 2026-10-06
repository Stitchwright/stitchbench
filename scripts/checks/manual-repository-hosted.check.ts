// The manual repository on a hosted install (docs/plans/manual-repository-design.md 5.4; package repo-hosted): there is no
// library on the server (no LIBRARY_DIR), so the BROWSER reads, checks and hashes the file and PUTs it to R2 itself.
// The server side of that, against a stand-in for the hub and R2 (scripts/checks/repo-mock.ts):
//   - the server's queue and offer-from-library paths say there is no library here
//   - hostedOfferStart: the statement, the hash's shape, the size, the TECH switch, uploads off, the hub's duplicate and
//     blocked answers, a PUT address that isn't R2's host (refused, no row); a slot gives the browser a PUT address and
//     headers and never the install key
//   - the browser's PUT (done here with fetch, as the page does), then hostedOfferFinish: the hub checks the stored file
//     (waiting for review, or refused for a changed file); hostedOfferFail marks a PUT that failed
//   - the repository's download URL by manual id for the browser: R2's host, the feed's sha256, the bytes match; a removed
//     manual is a 404
//   - the four hand-rolled actions gate themselves (they are on BY_HAND)
//   - the quick checks the browser runs (PDF, encrypted, size) are the same ones the server uses
//   - tenant: company B can't finish, fail or see A's offers; A's rows are unchanged
//   npm run check scripts/checks/manual-repository-hosted.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isUserError } from "@/lib/action";
import { db } from "@/lib/db";
import { hubState, hubStatus } from "@/lib/hub";
import { BY_HAND } from "@/lib/lapse-allow";
import { libraryDir } from "@/lib/library-dir";
import { NO_LIBRARY, queueDownloads } from "@/lib/manual-downloads";
import { checkPdfParts, hostedOfferFail, hostedOfferFinish, hostedOfferStart, offersFor, pullRepository, repositoryUrl, STATEMENT_VERSION } from "@/lib/manual-repository";
import { storageUrlOk } from "@/lib/safe-fetch";
import { checkShop, cleanup } from "./lib";
import { pdfBytes, sha256, startRepoMock } from "./repo-mock";
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

async function main() {
  const mock = await startRepoMock();
  delete process.env.LIBRARY_DIR;
  process.env.FETCH_ALLOW_HOSTS = new URL(mock.base).host;
  const savedHub = await hubState();
  const a = await checkShop({ repair: true });
  const b = await checkShop({ repair: true });
  const installId = `chk${RUN}`;
  const key = "chk-hosted-install-key";
  const fields = (extra: Record<string, unknown> = {}) => ({ category: "Sewing", brand, models: "H1", docType: "ServiceManual", year: 2018, language: "English", title: "", ...extra });
  const file = (label: string) => {
    const bytes = pdfBytes(`${label} ${RUN}`);
    return { bytes, sha256: sha256(bytes), sizeBytes: bytes.length, fileName: `${brand}_H1_ServiceManual_2018.pdf`, path: `Manuals/${brand}/${label}.pdf` };
  };
  const posts = () => mock.log.filter((l) => l.method === "POST" && l.path === "/v1/repository/uploads");
  try {
    await db.hubState.upsert({
      where: { id: 1 },
      create: { id: 1, url: mock.base, hubName: "Check hub", installId, installKey: key, scope: "member", joinedAt: new Date() },
      update: { url: mock.base, hubName: "Check hub", installId, installKey: key, scope: "member", repoCursor: null, repoUploads: "open", repoProbeAt: new Date() },
    });

    // 1. No library here.
    assert.equal(libraryDir(), null);
    await expectError("queue without a library", () => queueDownloads(a.user, { kind: "all" }), new RegExp(NO_LIBRARY.slice(0, 30)));
    ok("hosted: no library on the server, so the queue says so (the browser carries downloads and offers)");

    // 2. The quick checks the browser runs.
    const f1 = file("one");
    const head = f1.bytes.subarray(0, 65536);
    checkPdfParts(head, f1.bytes.subarray(-65536), f1.sizeBytes);
    assert.throws(() => checkPdfParts(Buffer.from("not a pdf at all"), Buffer.alloc(0), 16), /isn't a PDF/);
    assert.throws(() => checkPdfParts(Buffer.from("%PDF-1.7\ntrailer\n<< /Encrypt 3 0 R >>\n"), Buffer.alloc(0), 40), /encrypted/);
    assert.throws(() => checkPdfParts(head, Buffer.alloc(0), 151 * 1024 * 1024), /150 MB/);
    ok("the browser's quick checks: a PDF, not encrypted, at most 150 MB");

    // 3. What the server refuses before the hub is asked.
    await expectError("statement", () => hostedOfferStart(a.user, fields(), false, f1), /Tick the statement/);
    await expectError("hash", () => hostedOfferStart(a.user, fields(), true, { ...f1, sha256: "abc" }), /checksum/);
    await expectError("size", () => hostedOfferStart(a.user, fields(), true, { ...f1, sizeBytes: 0 }), /size/);
    await expectError("too big", () => hostedOfferStart(a.user, fields(), true, { ...f1, sizeBytes: 151 * 1024 * 1024 }), /150 MB/);
    await expectError("fields", () => hostedOfferStart(a.user, fields({ brand: "" }), true, f1), /brand/);
    const tech = { ...a.user, role: "TECH" as const };
    await expectError("tech without the switch", () => hostedOfferStart(tech, fields(), true, f1), /owner or an admin/);
    assert.equal(posts().length, 0, "none of that reached the hub");
    mock.uploadsOn = false;
    await db.hubState.update({ where: { id: 1 }, data: { repoUploads: null } });
    await expectError("opens soon", () => hostedOfferStart(a.user, fields(), true, f1), /The manual repository opens soon\./);
    assert.equal((await hubState())?.repoUploads, "soon");
    await expectError("opens soon, remembered", () => hostedOfferStart(a.user, fields(), true, f1), /opens soon/);
    assert.equal(posts().length, 1, "after the hub said so, nothing more is sent");
    assert.equal(await db.manualOffer.count({ where: { shopId: a.shopId } }), 0);
    mock.uploadsOn = true;
    await db.hubState.update({ where: { id: 1 }, data: { repoUploads: "open" } });
    ok('refusals before the hub: the statement, the checksum, the size, the 150 MB limit, a tech without the switch; uploads off says "The manual repository opens soon." and offers nothing');

    // 4. A slot: the browser PUTs, the server says sent, the hub checks the file.
    const s1 = await hostedOfferStart(a.user, fields(), true, f1);
    assert.equal(s1.state, "SENDING");
    assert.ok(s1.put, "a slot gives the browser a PUT address");
    assert.ok(storageUrlOk(s1.put!.url));
    assert.ok(!JSON.stringify(s1).includes(key), "the install key never reaches the browser");
    assert.ok(!s1.put!.url.includes(key));
    assert.equal(posts()[1].shopRef, a.shopId, "the company is named");
    assert.equal(JSON.parse(posts()[1].body).statement.version, STATEMENT_VERSION);
    let row = await db.manualOffer.findUniqueOrThrow({ where: { id: s1.id } });
    assert.equal(row.state, "SENDING");
    assert.equal(row.path, f1.path, "the browser's own path is only a label");
    const headers = Object.fromEntries(Object.entries(s1.put!.headers).filter(([k]) => k.toLowerCase() !== "content-length"));
    const r = await fetch(s1.put!.url, { method: "PUT", headers, body: new Uint8Array(f1.bytes) });
    assert.ok(r.ok, "the browser's PUT");
    const done = await hostedOfferFinish(a.user, s1.id);
    assert.equal(done.state, "WAITING");
    assert.match(done.message, /review/);
    row = await db.manualOffer.findUniqueOrThrow({ where: { id: s1.id } });
    assert.equal(row.state, "WAITING");
    assert.deepEqual(mock.objects.get(`incoming/${row.hubUploadId}.pdf`), f1.bytes);
    assert.equal((await hostedOfferFinish(a.user, s1.id)).state, "WAITING", "finishing again changes nothing");
    await expectError("the same file again", () => hostedOfferStart(a.user, fields(), true, f1), /already offered/);
    ok("a slot: the browser gets a PUT address and headers (never the install key); after its PUT the hub checks the file and the offer waits for review");

    // 5. A changed file is refused by the hub, a failed PUT is marked, the hub's own answers come back in words, a bad PUT address is refused.
    const f2 = file("two");
    const s2 = await hostedOfferStart(a.user, fields(), true, f2);
    await fetch(s2.put!.url, { method: "PUT", headers: Object.fromEntries(Object.entries(s2.put!.headers).filter(([k]) => k.toLowerCase() !== "content-length")), body: new Uint8Array(pdfBytes(`other bytes ${RUN}`)) });
    const bad = await hostedOfferFinish(a.user, s2.id);
    assert.equal(bad.state, "NOT_ACCEPTED");
    assert.match(bad.message, /don't match its sha256/);
    const f3 = file("three");
    const s3 = await hostedOfferStart(a.user, fields(), true, f3);
    await hostedOfferFail(a.user, s3.id, "the browser couldn't reach storage");
    row = await db.manualOffer.findUniqueOrThrow({ where: { id: s3.id } });
    assert.equal(row.state, "FAILED");
    assert.match(row.reason ?? "", /couldn't reach storage/);
    const f4 = file("four");
    const f5 = file("five");
    mock.duplicates.set(f4.sha256, `chk${RUN}dup`);
    mock.blocked.add(f5.sha256);
    const d4 = await hostedOfferStart(a.user, fields(), true, f4);
    assert.equal(d4.state, "DUPLICATE");
    assert.equal(d4.put, undefined);
    assert.match(d4.message, /already in the repository/);
    const d5 = await hostedOfferStart(a.user, fields(), true, f5);
    assert.equal(d5.state, "BLOCKED");
    assert.match(d5.message, /can't be offered again/);
    // A hub that hands out a PUT address that isn't R2's: refused, nothing stored.
    const f6 = file("six");
    const real = mock.base;
    const evil = mock.log.length;
    void evil;
    const origBase = mock.base;
    mock.base = "http://169.254.169.254:9";
    await expectError("a PUT address that isn't storage", () => hostedOfferStart(a.user, fields(), true, f6), /isn't one this program will send a file to/);
    mock.base = origBase;
    assert.equal(real, origBase);
    assert.equal(await db.manualOffer.count({ where: { shopId: a.shopId, sha256: f6.sha256 } }), 0, "no row for it");
    ok("a changed file is refused by the hub in words; a failed PUT is marked; duplicate and blocked answers come back with no PUT address; a PUT address off R2's host is refused");

    // 6. Download: the hub's URL by manual id, for the browser to fetch.
    const run = { installId };
    const P = pdfBytes(`hosted download ${RUN}`);
    mock.publish(`chk${RUN}hd1`, { category: "Sewing", brand, models: ["D1"], modelKeys: ["D1"], docType: "ServiceManual", year: 2019, title: "t", fileName: `${brand}_D1_ServiceManual_2019.pdf` }, P);
    await pullRepository(run, null);
    const link = await db.manualLink.findUniqueOrThrow({ where: { id: `repo_chk${RUN}hd1` } });
    assert.equal(link.origin, "repository");
    const u = await repositoryUrl(link.id);
    assert.ok(storageUrlOk(u.url));
    assert.equal(u.sha256, sha256(P));
    const got = Buffer.from(await (await fetch(u.url)).arrayBuffer());
    assert.equal(sha256(got), link.sha256, "the browser's fetch checks against the feed's sha256");
    assert.ok(!u.url.includes(key));
    mock.remove(`chk${RUN}hd1`, "copyright");
    await expectError("hub 404 (an expected UserError)", () => repositoryUrl(link.id), /isn't in the repository/);
    try {
      await repositoryUrl(link.id);
    } catch (e) {
      assert.equal(hubStatus(e), 404);
    }
    ok("download: the hub's URL by manual id points at R2's host, carries the sha256 the browser checks; a removed manual is a 404");

    // 7. The actions gate themselves.
    for (const n of ["startHostedOffer", "finishHostedOffer", "failHostedOffer", "repositoryDownloadInfo"]) assert.ok((BY_HAND as readonly string[]).includes(n), `${n} is on BY_HAND`);
    const src = fs.readFileSync(path.join(process.cwd(), "src", "actions", "manual-repository.ts"), "utf8");
    assert.ok(/async function gated[\s\S]*lapseGuard\(user\)/.test(src), "the hosted actions go through lapseGuard");
    for (const n of ["startHostedOffer", "finishHostedOffer", "failHostedOffer", "repositoryDownloadInfo"]) assert.match(src, new RegExp(`export async function ${n}\\(`));
    assert.ok(!/export async function offerManual/.test(src), "offerManual is a safe() action (read-only while lapsed)");
    ok("the hosted actions gate themselves with lapseGuard and are on the by-hand list; the offer and switch actions are safe() actions");

    // 8. Tenant.
    const before = await snapshot(a.shopId, ["ManualOffer"]);
    await expectError("B finishing A's offer", () => hostedOfferFinish(b.user, s1.id), /not found/i);
    await hostedOfferFail(b.user, s1.id, "B tries to mark A's offer failed");
    assert.deepEqual(await offersFor(b.shopId), []);
    assertUnchanged("A's offers after B's calls", before, await snapshot(a.shopId, ["ManualOffer"]));
    const fb = file("b-own");
    const sb = await hostedOfferStart(b.user, fields(), true, fb);
    assert.equal((await db.manualOffer.findUniqueOrThrow({ where: { id: sb.id } })).shopId, b.shopId);
    await expectError("A finishing B's offer", () => hostedOfferFinish(a.user, sb.id), /not found/i);
    assert.ok(!(await offersFor(a.shopId)).some((o) => o.id === sb.id));
    assert.equal(posts().at(-1)?.shopRef, b.shopId, "B's offer went out under B's name");
    ok("tenant: B can't finish, fail or see A's offers (and the reverse); A's rows are unchanged; each offer goes out under its own company");
  } finally {
    await db.manualLink.deleteMany({ where: { id: { startsWith: `repo_chk${RUN}` } } }).catch(() => undefined);
    await cleanup().catch(() => undefined);
    if (savedHub) await db.hubState.update({ where: { id: 1 }, data: { url: savedHub.url, installId: savedHub.installId, installKey: savedHub.installKey, scope: savedHub.scope, repoCursor: savedHub.repoCursor, repoUploads: savedHub.repoUploads, repoProbeAt: savedHub.repoProbeAt } }).catch(() => undefined);
    else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => undefined);
    await mock.close();
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
