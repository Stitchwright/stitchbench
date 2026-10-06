// The Assistant's parts helpers (docs/plans/ai-assistant-scope.md 1.5 and 1.6 a), package assistant:
//   1. the pure half: part-number variants ("Type 15J" is also "15J"), the search words, the three requests (model
//      class, redacted, no customer field, cells clipped) and the three parsers (an unknown reference or a repeat is
//      dropped, a column used twice is dropped, garbage is null)
//   2. module off: every action refused, no button, no call; the "parts" switch in Settings hides the buttons and refuses
//   3. Looks like: a part the cross-reference doesn't know by number gets candidates from the shared cross-reference
//      ("Type 15J" found as "15J") and from this company's own stock only; the request names no customer; the answer's
//      unknown references are dropped; a part already in the cross-reference by number is refused; no candidates = no
//      call; another company's stock never travels
//   4. Parts this job usually needs: this shop's PART lines on closed jobs on the model (counted) and the parts the
//      cross-reference says fit it, with this shop's stock; another company's lines never travel; no history = no call
//   5. Match the columns: headings and three sample rows only; the map is checked; a useless answer is a plain message
//   6. tenant: company B can't use A's part or ticket
//   npm run check scripts/checks/assistant-parts.check.ts
// Shares the dev database: throwaway companies "Check <run>" and cross-reference rows "chk<run>..." (removed at the end);
// the HubState row is put back.
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/user-error";
import { hubState } from "@/lib/hub";
import { modelKey } from "@/lib/format";
import { entryFor } from "@/lib/assistant/ui";
import { saveSettings } from "@/lib/assistant/bodies";
import { looksLike, matchColumns, partsForJob } from "@/lib/assistant/parts";
import { buildLooksLike, buildMatchColumns, buildPartsForJob, nameTerms, numberVariants, parseColumnMap, parseJobParts, parseMatches } from "@/lib/assistant/parts-prompt";
import { grantDevLicense } from "../license/dev";
import { startAnthropicMock } from "../test-mail/anthropic-mock.mjs";
import { checkShop, cleanup } from "./lib";
import { RUN } from "./tenant";

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

type HubCall = { body: Record<string, unknown> & { model: string; system: string; messages: { content: string }[] } };
const MODEL = { draft: "claude-sonnet-5-5", suggest: "claude-sonnet-5-5", read: "claude-haiku-4-5-20251001", manuals: "claude-opus-5-5" } as Record<string, string>;

async function startHub(mock: Awaited<ReturnType<typeof startAnthropicMock>>) {
  const calls: HubCall[] = [];
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return send(200, { ok: true });
    if (req.url === "/v1/assistant" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HubCall["body"] & { maxTokens: number };
      calls.push({ body });
      const r = await fetch(`${mock.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-ant-check-0000000000", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL[body.model], max_tokens: body.maxTokens, system: [{ type: "text", text: body.system }], messages: [{ role: "user", content: body.messages[body.messages.length - 1].content }] }),
      });
      const a = (await r.json()) as { content: { text: string }[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } };
      return send(200, { text: a.content[0].text, stopReason: a.stop_reason, usage: { input: a.usage.input_tokens, cacheRead: a.usage.cache_read_input_tokens, output: a.usage.output_tokens }, costMillicents: 100, model: MODEL[body.model], month: "2026-10", calls: calls.length, limit: 300 });
    }
    send(404, { error: "no such route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))) };
}

/** What the stand-in model says: it picks the first community entry and the first stock item it was offered, plus one reference it wasn't. */
const mockAnswer = (rec: { system: string; userText: string }): string => {
  if (rec.system.startsWith("You help a sewing-machine, vacuum")) {
    const x = /\[(x\d+)\]/.exec(rec.userText)?.[1];
    const s = /\[(s\d+)\]/.exec(rec.userText)?.[1];
    return JSON.stringify({ matches: [x && { ref: x, confidence: "likely", why: "Same number without the Type prefix." }, s && { ref: s, confidence: "possible", why: "Same name." }, { ref: "x99", confidence: "likely", why: "invented" }].filter(Boolean) });
  }
  if (rec.system.startsWith("You help a repair technician plan the parts")) {
    const u = /\[(u\d+)\]/.exec(rec.userText)?.[1];
    const f = /\[(f\d+)\]/.exec(rec.userText)?.[1];
    return JSON.stringify({ parts: [u && { ref: u, reason: "Used on past jobs on this model." }, f && { ref: f, reason: "Listed as fitting." }, { ref: "u99", reason: "invented" }].filter(Boolean) });
  }
  if (rec.system.startsWith("You match the columns")) {
    // Item=0, Barcode=1, Name=2, Wholesale=3, Retail=4, On hand=5; a repeat and an out-of-range number the parser must drop.
    return rec.userText.includes("Garbage") ? "I cannot tell." : '{"map":{"partNumber":0,"barcode":1,"description":2,"cost":3,"price":4,"qty":5,"brand":4,"location":42,"nonsense":1}}';
  }
  return "?";
};

async function main() {
  // ===== 1. the pure half =====
  assert.deepEqual(numberVariants("Type 15J"), ["TYPE15J", "15J"]);
  assert.deepEqual(numberVariants("XA-1234-001", "no"), ["XA1234001"], "a code with no prefix word has one form; two characters is no number");
  assert.deepEqual(numberVariants("No. 7"), ["NO7"], "the prefix is only stripped when 3 characters are left");
  assert.deepEqual(numberVariants("7"), [], "too short to compare");
  assert.deepEqual(nameTerms("Genuine needle plate screw, 2 pcs for the Singer set"), ["needle", "plate", "screw", "pcs", "singer"]);
  const r = { names: ["Pat Quill"] };
  const lb = buildLooksLike({ number: "Type 15J", alts: [], description: "screw for Pat Quill pat@example.com", brand: "Singer", fits: "Singer 15-91" }, [{ ref: "x1", kind: "xpart", name: "Needle plate screw", numbers: "Singer 15J", fits: "Singer 15-91", href: "/xref/a" }, { ref: "s1", kind: "part", name: "Hook gib", numbers: "HG1", fits: "", href: "/parts/b", qty: 2 }], r);
  assert.equal(lb.cls, "read");
  assert.equal(lb.feature, "looks_like");
  const lbText = lb.system + lb.messages[0].content;
  assert.ok(!/Pat Quill|pat@example/.test(lbText), "no customer in the request");
  assert.match(lb.messages[0].content, /\[x1\] Community cross-reference: Needle plate screw/);
  assert.match(lb.messages[0].content, /\[s1\] In your stock: Hook gib/);
  assert.ok(!/\/xref\/a|\/parts\/b/.test(lbText), "addresses stay on the PC");
  assert.deepEqual(lb.sources?.map((s) => s.ref), ["x1", "s1"]);
  assert.deepEqual(parseMatches('ok {"matches":[{"ref":"x1","confidence":"likely","why":"w"},{"ref":"x1","why":"again"},{"ref":"nope"},{"ref":"s1","confidence":"maybe"}]}', lb.sources!), [
    { ref: "x1", confidence: "likely", why: "w" },
    { ref: "s1", confidence: "possible", why: "" },
  ]);
  assert.deepEqual(parseMatches('{"matches":[]}', lb.sources!), []);
  assert.equal(parseMatches("no json", lb.sources!), null);
  const pj = buildPartsForJob({ brand: "Janome", model: "MC6700P", serviceRequested: null, problem: "skips, Pat Quill", diagnosis: null }, [{ ref: "u1", kind: "used", label: "hook gib", text: "used on 2 of 5 closed jobs", href: "/parts/z" }], r, { instruction: "cheap ones first" });
  assert.equal(pj.cls, "suggest");
  assert.ok(!/Pat Quill/.test(pj.messages[0].content));
  assert.match(pj.messages[0].content, /Also: cheap ones first/);
  assert.equal(pj.sources?.[0].kind, "ticket");
  assert.deepEqual(parseJobParts('{"parts":[{"ref":"u1","reason":"r"},{"ref":"u2","reason":"x"}]}', pj.sources!), [{ ref: "u1", reason: "r" }]);
  const fields = [{ key: "partNumber", label: "Item number" }, { key: "price", label: "Price" }];
  const mc = buildMatchColumns(fields, ["Item", "Retail"], [["A-1", "9.99"], ["mail me at pat@example.com", "x".repeat(200)]], r);
  assert.equal(mc.cls, "read");
  assert.ok(!/pat@example/.test(mc.messages[0].content), "an email in a cell is blanked");
  assert.ok(!/x{60}/.test(mc.messages[0].content), "a cell is clipped to 40 characters");
  assert.deepEqual(parseColumnMap('{"map":{"partNumber":0,"price":0,"x":1}}', ["partNumber", "price"], 2), { partNumber: 0 }, "a column goes to one field; unknown fields are ignored");
  assert.deepEqual(parseColumnMap('{"map":{"partNumber":5,"price":-1}}', ["partNumber", "price"], 2), null, "out of range is nothing");
  assert.equal(parseColumnMap("[1,2]", ["partNumber"], 2), null);
  ok("pure: variants, search words, the three requests (redacted, no addresses), the three parsers");

  // ===== set-up =====
  const a = await checkShop();
  const b = await checkShop();
  const mock = await startAnthropicMock({ port: 0, key: "sk-ant-check-0000000000", respond: mockAnswer });
  const hub = await startHub(mock);
  const savedHub = await hubState();
  const net = (globalThis as unknown as { __hubNet?: { offlineSince: number | null; checkedAt: number; lastOk: number } }).__hubNet;
  const online = async (url: string) => {
    await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, url, installKey: "ik_check", scope: "member", installId: "inst_check" }, update: { url, installKey: "ik_check", scope: "member", installId: "inst_check" } });
    if (net) Object.assign(net, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
  };
  const xIds: string[] = [];
  const xpart = async (name: string, numberKeys: string[], fits: { brand: string; model: string }[] = []) => {
    const id = `chk${RUN}${xIds.length}`;
    xIds.push(id);
    return db.xPart.create({
      data: {
        id,
        name,
        numbers: numberKeys.map((k) => ({ brand: "Singer", number: k })),
        numberKeys,
        fits: fits.map((f) => ({ ...f, modelKey: modelKey(f.model), evidence: "tested" })),
        fitKeys: fits.map((f) => modelKey(f.model)),
        sources: [],
        updatedAt: new Date(),
      },
    });
  };
  try {
    await online(hub.url);
    const word = `Plategrub${RUN.replace(/[^A-Za-z0-9]/g, "").slice(-6)}`; // a name nothing else in the shared database holds
    const xMatch = await xpart(`${word} needle plate screw`, [`15J${RUN.replace(/\D/g, "").slice(-5)}`]);
    const filed = xMatch.numberKeys[0];
    await xpart(`Unrelated spring ${RUN}`, ["ZZ99999"]);
    const custA = await db.customer.create({ data: { shopId: a.shopId, name: "Pat Quill" } });
    const partA = await db.part.create({ data: { shopId: a.shopId, partNumber: `Type ${filed}`, description: `${word} screw (Pat Quill's order)`, brand: "Singer", numberKeys: [`TYPE${filed}`], qtyOnHand: 4 } });
    const stockA = await db.part.create({ data: { shopId: a.shopId, partNumber: `GEN-${RUN}`, description: `${word} needle plate screw generic`, numberKeys: [`GEN${RUN.replace(/[^A-Za-z0-9]/g, "")}`], qtyOnHand: 9 } });
    const partB = await db.part.create({ data: { shopId: b.shopId, partNumber: `BSEC-${RUN}`, description: `${word} B-SECRET-PART needle plate screw`, numberKeys: [`BSEC${RUN.replace(/[^A-Za-z0-9]/g, "")}`] } });
    const lonely = await db.part.create({ data: { shopId: a.shopId, partNumber: `Q${RUN}`, description: "Zzyzx quux", numberKeys: [`Q${RUN.replace(/[^A-Za-z0-9]/g, "")}`] } });
    const exact = await db.part.create({ data: { shopId: b.shopId, partNumber: filed, description: "exact", numberKeys: [filed] } });

    // ===== 2. module off =====
    await expectError("looks like, module off", () => looksLike(a.user, { partId: partA.id }), /Assistant isn't turned on/);
    await expectError("job parts, module off", () => partsForJob(a.user, { ticketId: "x" }), /Assistant isn't turned on/);
    await expectError("columns, module off", () => matchColumns(a.user, { fields, headers: ["a", "b"], sample: [] }), /Assistant isn't turned on/);
    assert.deepEqual(await entryFor(a.shopId, "parts"), { show: false });
    assert.equal(hub.calls.length, 0);
    ok("module off: all three refused, no button, no call");

    await grantDevLicense(a.shopId, ["assistant"], { from: dayStr(-2) });
    await grantDevLicense(b.shopId, ["assistant"], { from: dayStr(-2) });
    assert.deepEqual(await entryFor(a.shopId, "parts"), { show: true });

    // ===== 3. Looks like =====
    const lk = await looksLike(a.user, { partId: partA.id });
    assert.equal(hub.calls.length, 1);
    const sent = hub.calls[0].body;
    assert.equal(sent.model, "read", "the cheap class");
    assert.equal(sent.feature, "looks_like");
    const text = sent.system + sent.messages.map((m) => m.content).join("\n");
    assert.match(text, new RegExp(`Community cross-reference: ${word} needle plate screw`), "'Type 15J' found the entry filed as '15J'");
    assert.match(text, new RegExp(`In your stock: ${word} needle plate screw generic`));
    assert.ok(!/Unrelated spring/.test(text), "an unrelated entry is not offered");
    assert.ok(!/Pat Quill/.test(text), "the customer's name is blanked");
    assert.ok(!/B-SECRET|BSEC/.test(text), "another company's stock never travels");
    assert.ok(!/Zzyzx/.test(text), "the part itself is not its own candidate");
    assert.deepEqual(lk.matches.map((m) => [m.kind, m.confidence]), [["xpart", "likely"], ["part", "possible"]], "the invented reference is dropped");
    assert.equal(lk.matches[0].href, `/xref/${xMatch.id}`);
    assert.equal(lk.matches[1].href, `/parts/${stockA.id}`);
    assert.equal(lk.matches[1].qty, 9);
    const logged = await db.assistantCall.findFirstOrThrow({ where: { shopId: a.shopId, feature: "looks_like" } });
    assert.equal(logged.partId, partA.id);
    assert.ok(!/Pat Quill/.test(JSON.stringify(logged.request)), "the log holds the redacted request");
    ok("Looks like: 'Type 15J' finds '15J' and the shop's own stock, redacted, checked, logged against the part");

    await expectError("already in the cross-reference", () => looksLike(b.user, { partId: exact.id }), /already in the cross-reference/);
    const before = hub.calls.length;
    const none = await looksLike(a.user, { partId: lonely.id });
    assert.deepEqual(none, { matches: [], sent: 0 });
    assert.equal(hub.calls.length, before, "nothing to compare: no call");
    ok("Looks like: a part the cross-reference has is refused; nothing to compare = no call and no count");

    // ===== 4. parts this job usually needs =====
    const machine = await db.machine.create({ data: { shopId: a.shopId, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P"), serial: "SN7000" } });
    const ticket = await db.ticket.create({ data: { shopId: a.shopId, number: 71, machineId: machine.id, customerId: custA.id, problem: "skips stitches, Pat Quill called" } });
    for (const n of [61, 62]) {
      await db.ticket.create({
        data: { shopId: a.shopId, number: n, machineId: machine.id, status: "COLLECTED", closedAt: new Date(), problem: "skipping", lines: { create: [{ kind: "PART", description: `${word} hook gib`, qty: 1, unitPriceCents: 900, partId: stockA.id }] } },
      });
    }
    const machineB = await db.machine.create({ data: { shopId: b.shopId, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
    await db.ticket.create({ data: { shopId: b.shopId, number: 5, machineId: machineB.id, status: "COLLECTED", closedAt: new Date(), problem: "x", lines: { create: [{ kind: "PART", description: "B-SECRET-LINE", qty: 1, unitPriceCents: 100 }] } } });
    const fit = await xpart(`${word} bobbin case`, [`BC${RUN.replace(/\D/g, "").slice(-5)}`], [{ brand: "Janome", model: "MC6700P" }]);
    const jp = await partsForJob(a.user, { ticketId: ticket.id });
    const jsent = hub.calls[hub.calls.length - 1].body;
    assert.equal(jsent.model, "suggest");
    const jtext = jsent.system + jsent.messages.map((m) => m.content).join("\n");
    assert.match(jtext, new RegExp(`\\[u1\\] ${word} hook gib: used on 2 of 2 closed jobs on this model`));
    assert.match(jtext, new RegExp(`\\[f1\\] ${word} bobbin case: fits this model \\(tested\\)`));
    assert.ok(!/B-SECRET/.test(jtext), "another company's lines never travel");
    assert.ok(!/Pat Quill|SN7000/.test(jtext), "no customer, no serial");
    assert.deepEqual(jp.parts.map((p) => [p.kind, p.label.endsWith("hook gib") || p.label.endsWith("bobbin case")]), [["used", true], ["fits", true]], "the invented reference is dropped");
    assert.equal(jp.parts[0].href, `/parts/${stockA.id}`, "a used part links to the shop's own item");
    assert.equal(jp.parts[1].href, `/xref/${fit.id}`);
    assert.equal((await db.assistantCall.findFirstOrThrow({ where: { shopId: a.shopId, feature: "parts_for_job" } })).ticketId, ticket.id);
    const other = await db.machine.create({ data: { shopId: a.shopId, brand: "Zzyzx", model: "NoHistory1", modelKey: modelKey("NoHistory1") } });
    const lone = await db.ticket.create({ data: { shopId: a.shopId, number: 72, machineId: other.id } });
    const before2 = hub.calls.length;
    assert.deepEqual(await partsForJob(a.user, { ticketId: lone.id }), { parts: [], sent: 0 });
    assert.equal(hub.calls.length, before2, "no history and nothing fitting: no call");
    ok("Parts this job needs: shop's PART lines counted by job, cross-reference fits with stock, redacted, checked; thin history = no call");

    // ===== 5. match the columns =====
    const headers = ["Item", "Barcode", "Name", "Wholesale", "Retail", "On hand"];
    const sample = [["A-1", "0123456789012", "Seam ripper", "4.10", "8.25", "6"], ["A-2", "", "Contact pat@example.com", "1", "2", "3"]];
    const cm = await matchColumns(a.user, { fields: [{ key: "partNumber", label: "Item" }, { key: "barcode", label: "Barcode" }, { key: "description", label: "Description" }, { key: "cost", label: "Cost" }, { key: "price", label: "Price" }, { key: "qty", label: "Qty" }, { key: "brand", label: "Brand" }, { key: "location", label: "Bin" }], headers, sample });
    assert.deepEqual(cm.map, { partNumber: 0, barcode: 1, description: 2, cost: 3, price: 4, qty: 5 }, "brand repeats column 4, location is out of range, nonsense is not a field");
    const csent = hub.calls[hub.calls.length - 1].body;
    assert.equal(csent.model, "read");
    assert.ok(!/pat@example/.test(csent.messages[0].content), "an email in a sample cell is blanked");
    assert.match(csent.messages[0].content, /Row 1: 0=A-1/);
    await expectError("a useless answer", () => matchColumns(a.user, { fields, headers: ["Garbage", "x"], sample: [] }), /couldn't tell which columns/);
    await expectError("no header row", () => matchColumns(a.user, { fields, headers: ["one"], sample: [] }), /header row/);
    ok("Match the columns: headings and three rows only, map checked, a useless answer is a plain message");

    // ===== the switch, offline, tenant =====
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, manualsOn: true, partsOn: false, offerFirstNames: false, voice: null });
    assert.deepEqual(await entryFor(a.shopId, "parts"), { show: false });
    await expectError("parts switched off", () => looksLike(a.user, { partId: partA.id }), /switched off in Settings/);
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, manualsOn: true, partsOn: true, offerFirstNames: false, voice: null });
    await online("http://127.0.0.1:9");
    if (net) Object.assign(net, { offlineSince: Date.now() - 1000, checkedAt: Date.now() });
    const off = await entryFor(a.shopId, "parts");
    assert.equal(off.show && off.unavailable, "The Assistant needs the internet.");
    await online(hub.url);
    await expectError("B uses A's part", () => looksLike(b.user, { partId: partA.id }), /Part not found/);
    await expectError("B uses A's ticket", () => partsForJob(b.user, { ticketId: ticket.id }), /Ticket not found/);
    assert.ok(partB.id);
    ok("the parts switch hides and refuses; offline says so; company B can't use A's part or ticket");

    console.log(`assistant-parts check: ${steps} checks passed`);
  } finally {
    await hub.close().catch(() => {});
    await mock.close().catch(() => {});
    await db.xPart.deleteMany({ where: { id: { in: xIds } } }).catch(() => {});
    if (savedHub) await db.hubState.update({ where: { id: 1 }, data: { url: savedHub.url, installKey: savedHub.installKey, installId: savedHub.installId, scope: savedHub.scope } }).catch(() => {});
    else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => {});
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
