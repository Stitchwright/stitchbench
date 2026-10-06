// Ask the manuals (docs/plans/ai-assistant-scope.md 1.4), package assistant:
//   1. the pure half: the search words from a question, page text from pdf.js items, the page link, and an answer read
//      against the pages that were offered (an unknown reference is dropped, an answer with no page behind it is "not found")
//   2. module gating and the switch: off = every body refused, no entry; on = indexing and asking work
//   3. the indexer on a small fixture manual made with pdf-lib: pages stored, a page with no text counted as a scan and
//      skipped, resume from the saved page without re-reading, Stop and Continue, a file in a private folder refused,
//      a scan-only file says it can't be searched, Delete the search index
//   4. search ranking (the page with all the words beats the page that repeats one), only this model's files
//   5. asking: the request the hub receives holds the question and the matching pages only (never the whole manual, never
//      another model's pages, no customer name), the answer's links open the library file at that page, an invented
//      reference is dropped, "not found" when nothing matches (no call is made, nothing counted) or the pages don't answer
//   6. offline: asking says "The Assistant needs the internet." while indexing and searching still work
//   7. tenant: company B sees none of A's pages, can't ask with A's ticket, and A's rows are unchanged
//   npm run check scripts/checks/assistant-manuals.check.ts
// Shares the dev database: throwaway companies "Check <run>" and library rows "chk<run>*" (removed at the end); the HubState
// row is put back; the library is a temporary folder (LIBRARY_DIR is set for this process only).
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/user-error";
import { hubState } from "@/lib/hub";
import { entryFor } from "@/lib/assistant/ui";
import { saveSettings } from "@/lib/assistant/bodies";
import { askManuals, modelIndexState, searchManualText, searchPages } from "@/lib/assistant/manuals";
import { clearIndex, indexProgress, kickIndexer, startIndexing, stopIndexing } from "@/lib/assistant/manuals-index";
import { buildAskManuals, cleanPageText, hasText, manualPageHref, parseManualAnswer, queryTerms } from "@/lib/assistant/manuals-prompt";
import { OFFLINE_MESSAGE } from "@/lib/assistant/features";
import { gateFor } from "@/lib/module-gate";
import { grantDevLicense } from "../license/dev";
import { startAnthropicMock } from "../test-mail/anthropic-mock.mjs";
import { checkShop, cleanup } from "./lib";
import { assertUnchanged, expectNotFound, RUN, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const dayStr = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function expectError(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: threw ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, `${label}: wrong message`);
    return;
  }
  assert.fail(`${label}: nothing was refused`);
}

// ---------- the fixture manuals ----------

async function makePdf(file: string, pages: (string | null)[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of pages) {
    const p = doc.addPage([420, 420]);
    if (t) p.drawText(t, { x: 24, y: 380, size: 10, font, maxWidth: 370, lineHeight: 13 });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await doc.save());
}

const SERVICE = [
  "Hook timing procedure. Loosen the timing screw, then set the hook point to the center of the needle at the rising stroke. Tighten the timing screw. Hook timing is critical to stitch quality.",
  null, // a page that is a picture: no text
  "Bobbin case cleaning. Remove the bobbin case and brush out the lint. Put one drop of oil on the race.",
  "Hook parts list. hook hook hook hook hook hook hook gib race driver hook hook hook hook.",
  "Error codes. E3 means the motor stalled. UNIQUE-ERRCODE-5 appears when the needle bar is blocked.",
];

// ---------- the stand-in hub in front of the Anthropic mock ----------

type HubCall = { auth: string | null; shop: string | null; body: Record<string, unknown> };
const PASSWORD = "unused";
async function startHub(mock: Awaited<ReturnType<typeof startAnthropicMock>>) {
  const calls: HubCall[] = [];
  let count = 0;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return send(200, { ok: true });
    if (req.url === "/v1/assistant" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> & { model: string; system: string; messages: { role: string; content: string }[]; maxTokens: number };
      calls.push({ auth: req.headers.authorization ?? null, shop: (req.headers["x-shop-ref"] as string) ?? null, body });
      const r = await fetch(`${mock.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-ant-check-0000000000", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: body.maxTokens, system: [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: body.messages.at(-1)!.content }] }),
      });
      const a = (await r.json()) as { content: { text: string }[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } };
      count += 1;
      return send(200, {
        text: a.content[0].text,
        stopReason: a.stop_reason,
        usage: { input: a.usage.input_tokens, cacheRead: a.usage.cache_read_input_tokens, output: a.usage.output_tokens },
        costMillicents: 5600,
        model: "claude-opus-5-5",
        month: "2026-10",
        calls: count,
        limit: 300,
      });
    }
    send(404, { error: "no such route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))) };
}

const mockAnswer = (rec: { system: string; userText: string }): string => {
  if (!rec.system.startsWith("You answer a repair technician's question")) return "unexpected request";
  const q = /Question: (.*)/.exec(rec.userText)?.[1] ?? "";
  if (q.includes("INVENTED")) return JSON.stringify({ found: true, answer: "It is made up [m99].", sources: ["m99"] });
  if (q.includes("MODELSAYSNO")) return '{"found":false}';
  const pages = rec.userText.split(/\n\n(?=\[m\d+\] )/);
  const hit = pages.find((p) => p.includes("Loosen the timing screw"));
  const ref = hit ? /^\[?(?:Pages from the manuals:\n)?\[(m\d+)\]/m.exec(hit)?.[1] : undefined;
  if (!ref) return '{"found":false}';
  return JSON.stringify({ found: true, answer: `Loosen the timing screw and set the hook to the needle [${ref}]. Also see [m99].`, sources: [ref, "m99"] });
};

async function main() {
  void PASSWORD;
  // ===== 1. the pure half =====
  assert.deepEqual(queryTerms("Where is the hook timing procedure for the ZZ6700P?", ["Zorkbrand", "ZZ6700P"]), ["where", "is", "the", "hook", "timing", "procedure", "for"], "the model's own name is left out, stop words are the index's job");
  assert.deepEqual(queryTerms("hook-timing; DROP TABLE 'x' | & ! ( )  hook"), ["hook", "timing", "drop", "table"], "nothing a tsquery reads as syntax; each word once");
  assert.deepEqual(queryTerms("!!! ?? a"), [], "no words");
  assert.equal(cleanPageText([{ str: "Hook", hasEOL: false }, { str: "timing", hasEOL: true }, { str: "Step  2\u0000", hasEOL: true }]), "Hook timing\nStep 2");
  assert.ok(hasText("Loosen the timing screw and tighten it."));
  assert.ok(!hasText("12  3  --  "), "a page of page numbers is not text");
  assert.equal(manualPageHref("Sewing\\Zorkbrand\\ZZ6700P Service Manual.pdf", 47), "/api/library/file?path=Sewing%2FZorkbrand%2FZZ6700P%20Service%20Manual.pdf#page=47");
  const offered = [
    { kind: "manual" as const, ref: "m1", label: "Service Manual, p. 47", href: "/api/library/file?path=a.pdf#page=47", page: 47 },
    { kind: "manual" as const, ref: "m2", label: "Service Manual, p. 3", href: "/api/library/file?path=a.pdf#page=3", page: 3 },
  ];
  const good = parseManualAnswer('Sure {"found":true,"answer":"Loosen the screw [m1]. Then tighten [m9] it [m2].","sources":["m1","m5"]}', offered);
  assert.equal(good.found, true);
  assert.deepEqual(good.citations.map((c) => [c.ref, c.page]), [["m1", 47], ["m2", 3]], "only offered pages are cited");
  assert.ok(!good.answer.includes("m9"), "an unknown marker is taken out of the text");
  assert.equal(parseManualAnswer('{"found":true,"answer":"Made up [m9].","sources":["m9"]}', offered).found, false, "no page behind it = not found");
  assert.equal(parseManualAnswer('{"found":true,"answer":"No refs at all.","sources":[]}', offered).found, false);
  assert.equal(parseManualAnswer('{"found":false}', offered).found, false);
  assert.equal(parseManualAnswer("not json", offered).found, false);
  const built = buildAskManuals({
    brand: "Zorkbrand",
    model: "ZZ6700P",
    question: "hook timing? call Pat Quill 555-123-4567",
    passages: [{ ref: "m1", docId: "d", page: 4, label: "Service Manual", text: "x".repeat(9000), href: "h" }],
    r: { names: ["Pat Quill", "Pat", "Quill"] },
  });
  assert.equal(built.cls, "manuals");
  assert.equal(built.feature, "ask_manuals");
  assert.ok(!/Pat Quill|555-123/.test(JSON.stringify(built)), "the question is redacted");
  assert.ok(built.messages[0].content.length < 4200, "a page is cut to 3,500 characters");
  assert.ok(!JSON.stringify(built.messages).includes("href"), "links never go to the model");
  ok("pure: search words, page text, page link, answer checked against the offered pages, request shape");

  // ===== set-up: library folder, companies, a mock model, the stand-in hub =====
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), `chk-lib-${RUN}-`));
  const savedLib = process.env.LIBRARY_DIR;
  process.env.LIBRARY_DIR = lib;
  const fileA = `ZZ6700P Service Manual ${RUN}.pdf`;
  await makePdf(path.join(lib, "Sewing", "Zorkbrand", fileA), SERVICE);
  await makePdf(path.join(lib, "Sewing", "Zorkbrand", `Other ${RUN}.pdf`), ["Hook timing procedure for the 9999 machine. UNIQUE-OTHER-MODEL is only in this manual."]);
  await makePdf(path.join(lib, "Sewing", "Zorkbrand", `Scan ${RUN}.pdf`), [null, null, null]);
  await makePdf(path.join(lib, "_business-notes", `Prices ${RUN}.pdf`), ["Our private price sheet with margins. PRIVATE-PRICES."]);
  const big = Array.from({ length: 12 }, (_, i) => `Resume page ${i + 1}. Adjust the presser foot pressure dial on this page number ${i + 1} of the resume manual.`);
  await makePdf(path.join(lib, "Sewing", "Zorkbrand", `Resume ${RUN}.pdf`), big);
  const ids = { a: `chk${RUN}a`, other: `chk${RUN}o`, scan: `chk${RUN}s`, priv: `chk${RUN}p`, resume: `chk${RUN}r` };
  const mk = (id: string, file: string, folder: string, modelKeys: string[]) =>
    db.libraryDoc.create({ data: { id, path: `${folder}\\${file}`, category: folder.split("\\")[0], brand: "Zorkbrand", file, docType: "ServiceManual", title: file.replace(/\.pdf$/, ""), modelKeys } });
  await mk(ids.a, fileA, "Sewing\\Zorkbrand", ["ZZ6700P"]);
  await mk(ids.other, `Other ${RUN}.pdf`, "Sewing\\Zorkbrand", ["ZZ9999"]);
  await mk(ids.scan, `Scan ${RUN}.pdf`, "Sewing\\Zorkbrand", ["ZZSCAN1"]);
  await mk(ids.priv, `Prices ${RUN}.pdf`, "_business-notes", ["ZZPRIV1"]);
  await mk(ids.resume, `Resume ${RUN}.pdf`, "Sewing\\Zorkbrand", ["ZZRESUME1"]);

  const a = await checkShop();
  const b = await checkShop();
  const mock = await startAnthropicMock({ port: 0, key: "sk-ant-check-0000000000", respond: mockAnswer });
  const hub = await startHub(mock);
  const savedHub = await hubState();
  const savedOff = process.env.ASSISTANT;
  const net = (globalThis as unknown as { __hubNet?: { offlineSince: number | null; checkedAt: number; lastOk: number } }).__hubNet;
  const online = async (url: string) => {
    await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, url, installKey: "ik_check", scope: "member", installId: "inst_check" }, update: { url, installKey: "ik_check", scope: "member", installId: "inst_check" } });
    if (net) Object.assign(net, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
  };
  const wait = async () => {
    await Promise.race([kickIndexer(), new Promise((_, rej) => setTimeout(() => rej(new Error("the indexer didn't finish in 90 s")), 90_000))]);
  };
  const pagesOf = (shopId: string, docId: string) => db.manualPage.findMany({ where: { shopId, docId }, orderBy: { page: "asc" } });
  try {
    await online(hub.url);
    const machineA = await db.machine.create({ data: { shopId: a.shopId, brand: "Zorkbrand", model: "ZZ6700P", modelKey: "ZZ6700P", serial: "SN48211" } });
    const custA = await db.customer.create({ data: { shopId: a.shopId, name: "Pat Quill", phone: "555-123-4567" } });
    const ticketA = await db.ticket.create({ data: { shopId: a.shopId, number: 51, machineId: machineA.id, customerId: custA.id, problem: "A-SECRET-PROBLEM skips stitches" } });

    // ===== 2. module gating =====
    assert.equal(await gateFor(a.shopId, "assistant"), "hidden");
    await expectError("index, module off", () => startIndexing(a.user, { brand: "Zorkbrand", model: "ZZ6700P" }), /Assistant isn't turned on/);
    await expectError("ask, module off", () => askManuals(a.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "hook timing" }), /Assistant isn't turned on/);
    await expectError("search, module off", () => searchManualText(a.user, "hook"), /Assistant isn't turned on/);
    assert.deepEqual(await entryFor(a.shopId, "manuals"), { show: false }, "no Ask box without the module");
    assert.equal(await db.manualIndexDoc.count({ where: { shopId: a.shopId } }), 0, "nothing was queued");
    ok("module off: every body refused, no entry, nothing queued");

    await grantDevLicense(a.shopId, ["assistant"], { from: dayStr(-2) });
    await grantDevLicense(b.shopId, ["assistant"], { from: dayStr(-2) });
    assert.deepEqual(await entryFor(a.shopId, "manuals"), { show: true });
    await expectError("ask before indexing", () => askManuals(a.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "hook timing" }), /Index this model's manuals first/);
    await expectError("a model with no manuals", () => askManuals(a.user, { brand: "Zorkbrand", model: "ZZNOMANUAL", question: "hook timing" }), /no manuals for this model/);
    assert.equal(hub.calls.length, 0);

    // The switch for this feature.
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, manualsOn: false, offerFirstNames: false, voice: null });
    assert.deepEqual(await entryFor(a.shopId, "manuals"), { show: false });
    await expectError("index, switched off", () => startIndexing(a.user, { brand: "Zorkbrand", model: "ZZ6700P" }), /switched off/);
    await expectError("ask, switched off", () => askManuals(a.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "hook timing" }), /switched off/);
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, manualsOn: true, offerFirstNames: false, voice: null });
    ok("module on and the switch: asking works, off = hidden and refused");

    // ===== 3. the indexer =====
    const queued = await startIndexing(a.user, { brand: "Zorkbrand", model: "ZZ6700P" });
    assert.equal(queued, 1, "only this model's file is queued");
    await wait();
    const prog = await indexProgress(a.shopId, { brand: "Zorkbrand", model: "ZZ6700P" });
    assert.deepEqual([prog.files, prog.done, prog.waiting, prog.failed, prog.pages, prog.pagesDone, prog.blankPages, prog.searchable], [1, 1, 0, 0, 5, 5, 1, 4]);
    const rows = await pagesOf(a.shopId, ids.a);
    assert.deepEqual(rows.map((r) => r.page), [1, 3, 4, 5], "the picture page (2) has no row");
    assert.match(rows[0].text, /Hook timing procedure\. Loosen the timing screw/);
    assert.equal(await db.manualPage.count({ where: { shopId: a.shopId, docId: ids.other } }), 0, "another model's file was not read");
    assert.equal(await db.manualPage.count({ where: { shopId: b.shopId } }), 0);
    assert.equal(hub.calls.length, 0, "indexing sends nothing anywhere");
    const st = await modelIndexState(a.shopId, "Zorkbrand", "ZZ6700P");
    assert.deepEqual([st.searchable, st.scanned, st.indexedFiles], [4, 1, 1], "one scanned page is noted");
    await expectError("again when done", () => startIndexing(a.user, { brand: "Zorkbrand", model: "ZZ6700P" }), /already indexed/);
    ok("indexer: pages stored, the picture page counted and skipped, nothing sent, progress");

    // Resume: a file left half read (8 of 12 pages, as a restart would) carries on from page 9 and doesn't read 1-8 again.
    await db.manualIndexDoc.create({ data: { shopId: a.shopId, docId: ids.resume, totalPages: 12, donePages: 8, status: "running" } });
    await db.manualPage.createMany({ data: Array.from({ length: 8 }, (_, i) => ({ shopId: a.shopId, docId: ids.resume, page: i + 1, text: `SENTINEL-OLD page ${i + 1} kept as it was` })) });
    const prog0 = await indexProgress(a.shopId, { brand: "Zorkbrand", model: "ZZRESUME1" });
    assert.equal(prog0.active, false, "after a restart nothing is running by itself");
    assert.equal(prog0.waiting, 1);
    await startIndexing(a.user, { brand: "Zorkbrand", model: "ZZRESUME1" });
    await wait();
    const rr = await pagesOf(a.shopId, ids.resume);
    assert.equal(rr.length, 12);
    assert.ok(rr.slice(0, 8).every((r) => r.text.startsWith("SENTINEL-OLD")), "pages already done are not read again");
    assert.ok(rr.slice(8).every((r) => r.text.startsWith("Resume page")), "the rest are read from page 9");
    assert.equal((await db.manualIndexDoc.findUniqueOrThrow({ where: { shopId_docId: { shopId: a.shopId, docId: ids.resume } } })).status, "done");
    ok("resume: carries on from the saved page");

    // Stop and Continue.
    await db.manualPage.deleteMany({ where: { shopId: a.shopId, docId: ids.resume } });
    await db.manualIndexDoc.deleteMany({ where: { shopId: a.shopId, docId: ids.resume } });
    await startIndexing(a.user, { brand: "Zorkbrand", model: "ZZRESUME1" });
    await stopIndexing(a.user);
    await wait();
    const afterStop = await db.manualIndexDoc.findUniqueOrThrow({ where: { shopId_docId: { shopId: a.shopId, docId: ids.resume } } });
    assert.ok(["paused", "done"].includes(afterStop.status), `stop left it ${afterStop.status}`);
    await db.manualIndexDoc.update({ where: { shopId_docId: { shopId: a.shopId, docId: ids.resume } }, data: { status: "paused", donePages: 4 } });
    await db.manualPage.deleteMany({ where: { shopId: a.shopId, docId: ids.resume, page: { gt: 4 } } });
    assert.equal(await startIndexing(a.user, { brand: "Zorkbrand", model: "ZZRESUME1" }), 1, "Continue queues the stopped file");
    await wait();
    assert.equal((await pagesOf(a.shopId, ids.resume)).length, 12, "Continue finished it");
    ok("stop keeps what was read; continue finishes the file");

    // A scan-only file, and a file in a private folder.
    await startIndexing(a.user, { brand: "Zorkbrand", model: "ZZSCAN1" });
    await wait();
    const scan = await db.manualIndexDoc.findUniqueOrThrow({ where: { shopId_docId: { shopId: a.shopId, docId: ids.scan } } });
    assert.deepEqual([scan.status, scan.totalPages, scan.blankPages], ["done", 3, 3]);
    assert.equal(await db.manualPage.count({ where: { shopId: a.shopId, docId: ids.scan } }), 0);
    await expectError("ask a scan-only model", () => askManuals(a.user, { brand: "Zorkbrand", model: "ZZSCAN1", question: "hook timing" }), /scanned pictures/);
    await startIndexing(a.user, { brand: "Zorkbrand", model: "ZZPRIV1" });
    await wait();
    const priv = await db.manualIndexDoc.findUniqueOrThrow({ where: { shopId_docId: { shopId: a.shopId, docId: ids.priv } } });
    assert.equal(priv.status, "failed", "a private folder is never read");
    assert.equal(await db.manualPage.count({ where: { shopId: a.shopId, docId: ids.priv } }), 0);
    assert.ok(!(await db.manualPage.findFirst({ where: { text: { contains: "PRIVATE-PRICES" } } })), "the private price sheet is in no index");
    ok("scan-only file: nothing searchable and it says so; private folder: refused");

    // ===== 4. search ranking =====
    const docs = [ids.a];
    const hits = await searchPages(a.shopId, docs, "Where is the hook timing procedure for the ZZ6700P?", { drop: ["Zorkbrand", "ZZ6700P"] });
    assert.equal(hits[0].page, 1, "the page with all the words is first");
    assert.ok(hits.length >= 2 && hits.some((h) => h.page === 4), "the page that only repeats 'hook' still matches, lower");
    assert.ok(hits.findIndex((h) => h.page === 4) > 0);
    assert.ok(!hits.some((h) => h.page === 3 || h.page === 5), "pages with none of the words are not offered");
    const err = await searchPages(a.shopId, docs, "what does error E3 mean");
    assert.equal(err[0].page, 5);
    assert.deepEqual(await searchPages(a.shopId, docs, "zzzqq wombat"), []);
    assert.deepEqual(await searchPages(a.shopId, [], "hook"), []);
    const textHits = await searchManualText(a.user, "hook timing");
    assert.equal(textHits[0].page, 1);
    assert.match(textHits[0].snippet, /«[Hh]ook»|«timing»/, "the snippet marks the words found");
    assert.match(textHits[0].href, /^\/api\/library\/file\?path=Sewing%2FZorkbrand%2F.*#page=1$/);
    assert.deepEqual(await searchManualText(a.user, "UNIQUE-OTHER-MODEL"), [], "the other model's file was never indexed");
    ok("search: the page with all the words ranks first; no match = nothing; the manuals page's search finds pages");

    // ===== 5. asking =====
    const ans = await askManuals(a.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "Where is the hook timing procedure for the ZZ6700P? Pat Quill 555-123-4567 is waiting.", ticketId: ticketA.id });
    assert.equal(hub.calls.length, 1);
    const call = hub.calls[0];
    assert.equal(call.auth, "Bearer ik_check");
    assert.equal(call.shop, a.shopId);
    assert.equal(call.body.feature, "ask_manuals");
    assert.equal(call.body.model, "manuals", "the manuals class; the hub maps it to a model");
    const sent = JSON.stringify(call.body);
    assert.match(sent, /Loosen the timing screw/, "the matching page goes");
    assert.ok(!/UNIQUE-ERRCODE-5|Bobbin case cleaning/.test(sent), "pages that don't match are not sent: never the whole manual");
    assert.ok(!/UNIQUE-OTHER-MODEL|PRIVATE-PRICES/.test(sent), "nothing from another model or a private folder");
    assert.ok(!/Pat Quill|555-123|A-SECRET-PROBLEM|SN48211/.test(sent), "no customer, no ticket text, no serial");
    const userMsg = (call.body.messages as { content: string }[]).at(-1)!.content;
    assert.ok(userMsg.includes("[m2]") && !userMsg.includes("[m3]"), "two pages of five, not the manual");
    assert.equal(ans.found, true);
    assert.equal(ans.sent, 2, "the two pages that matched");
    assert.deepEqual(ans.citations.map((c) => [c.ref, c.page]), [["m1", 1]], "an invented [m99] is dropped");
    assert.ok(!ans.answer.includes("m99"));
    assert.match(ans.answer, /\[m1\]/);
    assert.equal(ans.citations[0].href, manualPageHref(`Sewing\\Zorkbrand\\${fileA}`, 1), "the link opens the library file at that page");
    assert.equal(ans.scanned, 1);
    const log = await db.assistantCall.findFirstOrThrow({ where: { id: ans.callId } });
    assert.equal(log.feature, "ask_manuals");
    assert.equal(log.shopId, a.shopId);
    assert.equal(log.ticketId, ticketA.id);
    assert.equal(log.machineId, machineA.id);
    assert.equal(log.model, "claude-opus-5-5");
    assert.equal(log.costMillicents, 5600);
    assert.ok(Array.isArray(log.sources) && (log.sources as { kind: string }[]).every((s) => s.kind === "manual"), "the log's sources are the pages offered");
    const shopRow = await db.shop.findUniqueOrThrow({ where: { id: a.shopId } });
    assert.equal(shopRow.assistantCalls, 1, "it counts against the allowance");
    ok("ask: only the matching pages and the redacted question go; the answer cites the page, with a link into the library file; logged and counted");

    // Refusal: nothing matches (no call, nothing counted), the model says no, the model cites nothing real.
    const none = await askManuals(a.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "zzzqq wombat tractor" });
    assert.deepEqual([none.found, none.sent, none.answer], [false, 0, ""]);
    assert.equal(hub.calls.length, 1, "no matching page = no call");
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).assistantCalls, 1, "and nothing counted");
    const no = await askManuals(a.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "hook timing MODELSAYSNO" });
    assert.equal(no.found, false);
    assert.equal(no.sent, 2);
    const invented = await askManuals(a.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "hook timing INVENTED" });
    assert.equal(invented.found, false, "an answer that cites no offered page is not shown");
    assert.equal(invented.citations.length, 0);
    await expectError("an empty question", () => askManuals(a.user, { brand: "Zorkbrand", model: "ZZ6700P", question: " " }), /question/);
    ok("refusal: nothing matched = not found without a call; the model's no and an unsupported answer are not found");

    // ===== 6. offline =====
    if (net) Object.assign(net, { offlineSince: Date.now(), checkedAt: Date.now(), lastOk: 0 });
    await expectError("ask offline", () => askManuals(a.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "hook timing" }), new RegExp(OFFLINE_MESSAGE.replace(".", "\\.")));
    assert.deepEqual(await entryFor(a.shopId, "manuals"), { show: true, unavailable: OFFLINE_MESSAGE });
    assert.equal((await searchManualText(a.user, "hook timing")).length > 0, true, "search works offline");
    await clearIndex(a.user, { brand: "Zorkbrand", model: "ZZRESUME1" });
    assert.equal(await db.manualPage.count({ where: { shopId: a.shopId, docId: ids.resume } }), 0);
    assert.equal(await startIndexing(a.user, { brand: "Zorkbrand", model: "ZZRESUME1" }), 1, "indexing works offline");
    await wait();
    await online(hub.url);
    process.env.ASSISTANT = "off";
    await expectError("ask, ASSISTANT=off", () => askManuals(a.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "hook timing" }), /switched off on this server/);
    if (savedOff === undefined) delete process.env.ASSISTANT;
    else process.env.ASSISTANT = savedOff;
    ok("offline: asking says it needs the internet; indexing and search still work; ASSISTANT=off stops asking");

    // ===== 7. tenant =====
    const tables = ["ManualPage", "AssistantCall"];
    const idxRows = async () => JSON.stringify(await db.manualIndexDoc.findMany({ where: { shopId: a.shopId }, orderBy: { docId: "asc" } }));
    const idxBefore = await idxRows();
    const before = await snapshot(a.shopId, tables);
    assert.deepEqual(await searchPages(b.shopId, [ids.a], "hook timing procedure"), [], "B has none of A's pages");
    assert.deepEqual(await searchManualText(b.user, "hook timing"), []);
    await expectError("B asks before indexing", () => askManuals(b.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "hook timing" }), /Index this model's manuals first/);
    await expectNotFound("B asks with A's ticket", () => askManuals(b.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "hook timing", ticketId: ticketA.id }));
    assert.equal((await indexProgress(b.shopId, { brand: "Zorkbrand", model: "ZZ6700P" })).done, 0, "B's progress is B's");
    await startIndexing(b.user, { brand: "Zorkbrand", model: "ZZ6700P" });
    await wait();
    const sentB = hub.calls.length;
    const ansB = await askManuals(b.user, { brand: "Zorkbrand", model: "ZZ6700P", question: "hook timing procedure" });
    assert.equal(ansB.found, true);
    assert.equal(hub.calls.at(-1)!.body.shopRef, b.shopId);
    assert.ok(!/A-SECRET-PROBLEM|Pat Quill/.test(JSON.stringify(hub.calls.at(-1)!.body)), "nothing of A in B's request");
    assert.equal(hub.calls.length, sentB + 1);
    // B stopping or deleting its index leaves A's alone.
    await stopIndexing(b.user);
    await clearIndex(b.user);
    assert.equal(await db.manualPage.count({ where: { shopId: b.shopId } }), 0);
    const after = await snapshot(a.shopId, tables);
    assertUnchanged("B's work leaves A alone", before, after);
    assert.equal(await idxRows(), idxBefore, "A's indexing state is unchanged");
    assert.ok((await db.manualPage.count({ where: { shopId: a.shopId, docId: ids.a } })) > 0, "A's pages are still there");
    // A deleting its whole index.
    await clearIndex(a.user);
    assert.equal(await db.manualPage.count({ where: { shopId: a.shopId } }), 0);
    assert.equal(await db.manualIndexDoc.count({ where: { shopId: a.shopId } }), 0);
    assert.ok(await db.libraryDoc.findUnique({ where: { id: ids.a } }), "the library list is untouched");
    assert.ok(fs.existsSync(path.join(lib, "Sewing", "Zorkbrand", fileA)), "so are the manuals");
    ok("tenant: B sees none of A's pages and can't use A's ticket; each company's index is its own to stop and delete");

    console.log(`assistant-manuals check: ${steps} checks passed`);
  } finally {
    if (savedOff === undefined) delete process.env.ASSISTANT;
    else process.env.ASSISTANT = savedOff;
    if (savedLib === undefined) delete process.env.LIBRARY_DIR;
    else process.env.LIBRARY_DIR = savedLib;
    await hub.close().catch(() => {});
    await mock.close().catch(() => {});
    if (savedHub) await db.hubState.update({ where: { id: 1 }, data: { url: savedHub.url, installKey: savedHub.installKey, installId: savedHub.installId, scope: savedHub.scope } }).catch(() => {});
    else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => {});
    await db.libraryDoc.deleteMany({ where: { id: { startsWith: `chk${RUN}` } } }).catch(() => {});
    fs.rmSync(lib, { recursive: true, force: true });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await db.$disconnect();
  });
