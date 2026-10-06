// The Assistant add-on (docs/plans/ai-assistant-scope.md), package assistant:
//   1. redact() on a dozen shapes (emails, phones, the customer, the trade account, known customers, serials) and the
//      pure builders and parsers: request shapes (model class, the shop's voice, no customer field), causes with unknown
//      citations turned into "general knowledge", the plate's JSON
//   2. module gating: off = hidden and refused, on = buttons, lapsed = the log readable and the Ask buttons hidden; the
//      switch per feature; the plate reader needs no module
//   3. each feature's request as the hub receives it (a stand-in hub in this process in front of the Anthropic mock,
//      scripts/test-mail/anthropic-mock.mjs): the drafts (no customer name, phone or email; {first_name} unless the
//      company offered first names; serial blanked), likely causes (this shop's tickets, notes and the specs, cited
//      and checked, nothing of another company's), the plate (the photo as an image block, Haiku then the stronger
//      model when guessing, the log keeps its size and hash, the serial masked), and what the log holds
//   4. offline and failure: the hub gone = "The Assistant needs the internet." and one logged failure; a 402 in the
//      hub's words; ASSISTANT=off; nothing calls the model on its own (the ticket slot and Settings page render
//      without a hub call)
//   5. tenant: company B can't draft on, mark or read A's ticket or calls, and A's rows are unchanged
//   npm run check scripts/checks/assistant.check.ts
// Shares the dev database: throwaway companies "Check <run>" (removed at the end); the HubState row is put back.
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/user-error";
import { hubState } from "@/lib/hub";
import { entryFor } from "@/lib/assistant/ui";
import { assistantAvailable } from "@/lib/assistant/client";
import { draftText, likelyCauses, markCall, plateRead, saveSettings } from "@/lib/assistant/bodies";
import { causeSources, ticketContext } from "@/lib/assistant/context";
import { OFFLINE_MESSAGE } from "@/lib/assistant/features";
import { buildLikelyCauses, buildPlateRead, buildWriteUp, jsonOf, parseCauses, parsePlate } from "@/lib/assistant/prompts";
import { maskSerials, namesToBlank, redact } from "@/lib/assistant/redact";
import { gateFor } from "@/lib/module-gate";
import { ticketAssistantView } from "@/lib/assistant/ticket-view";
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

// ---------- the stand-in hub in front of the Anthropic mock ----------

type HubCall = { auth: string | null; shop: string | null; body: Record<string, unknown> };
const MODEL = { draft: "claude-sonnet-5-5", suggest: "claude-sonnet-5-5", read: "claude-haiku-4-5-20251001", manuals: "claude-opus-5-5" } as Record<string, string>;
const PHOTO = Buffer.alloc(900, 7).toString("base64");

async function startHub(mock: Awaited<ReturnType<typeof startAnthropicMock>>) {
  const calls: HubCall[] = [];
  const next: { status: number; error: string }[] = [];
  const counts = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return send(200, { ok: true });
    if (req.url === "/v1/assistant" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> & { model: string; system: string; messages: { role: string; content: string }[]; maxTokens: number; image?: { mediaType: string; data: string } };
      calls.push({ auth: req.headers.authorization ?? null, shop: (req.headers["x-shop-ref"] as string) ?? null, body });
      const scripted = next.shift();
      if (scripted) return send(scripted.status, { error: scripted.error });
      const last = body.messages[body.messages.length - 1];
      const content = body.image ? [{ type: "image", source: { type: "base64", media_type: body.image.mediaType, data: body.image.data } }, { type: "text", text: last.content }] : last.content;
      const r = await fetch(`${mock.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-ant-check-0000000000", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL[body.model], max_tokens: body.maxTokens, system: [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content }] }),
      });
      const a = (await r.json()) as { content: { text: string }[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } };
      const shop = String(body.shopRef);
      counts.set(shop, (counts.get(shop) ?? 0) + 1);
      return send(200, {
        text: a.content[0].text,
        stopReason: a.stop_reason,
        usage: { input: a.usage.input_tokens, cacheRead: a.usage.cache_read_input_tokens, output: a.usage.output_tokens },
        costMillicents: 450,
        model: MODEL[body.model],
        free: !body.key,
        month: "2026-10",
        calls: counts.get(shop),
        limit: 300,
      });
    }
    send(404, { error: "no such route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    next,
    close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))),
  };
}

let plateMode: "sure" | "guess" = "sure";
const mockAnswer = (rec: { system: string; userText: string }): string => {
  if (rec.system.startsWith("You read the rating plate")) {
    if (plateMode === "guess" && rec.userText.includes("Read this plate.") && !(globalThis as { __retry?: boolean }).__retry) {
      (globalThis as { __retry?: boolean }).__retry = true;
      return '```json\n{"brand":"Janome","model":"MC6700","serial":"AB12345678","machineType":"","confidence":"guess"}\n```';
    }
    return '{"brand":"Janome","model":"MC6700P","serial":"AB12345678","machineType":"Embroidery","confidence":"sure"}';
  }
  if (rec.system.startsWith("You are a bench assistant")) {
    const ref = /\[(ticket:\d+)\]/.exec(rec.userText)?.[1];
    const note = /\[(gotcha:[a-z0-9]+)\]/.exec(rec.userText)?.[1];
    return JSON.stringify({
      causes: [
        { cause: "Hook timing is late", checks: ["Check hook timing", "Check needle height"], sources: [ref, note].filter(Boolean) },
        { cause: "Bobbin case cracked", checks: ["Inspect the bobbin case"], sources: ["ticket:9999"] },
        { cause: "Lint in the feed dogs", checks: [], sources: [] },
      ],
    });
  }
  return `Drafted: ${rec.userText.slice(0, 30)}`;
};

// ---------- main ----------

async function main() {
  // ===== 1. redact and the pure builders =====
  const blank = { names: ["Pat Quill", "Quill Fabrics", "Pat", "Quill"], serials: ["SN48211"] };
  assert.equal(redact("call pat@example.com now", blank), "call [customer] now");
  assert.equal(redact("phone 555-123-4567 or (555) 123 4567", blank), "phone [customer] or [customer]");
  assert.equal(redact("cell +1 555 123 4567.", blank), "cell [customer].");
  assert.equal(redact("also 5551234567 said so", blank), "also [customer] said so");
  assert.equal(redact("part 55-1234 and model 6700", blank), "part 55-1234 and model 6700", "a part number is not a phone");
  assert.equal(redact("Pat Quill brought it; pat says it skips", blank), "[customer] brought it; [customer] says it skips");
  assert.equal(redact("from Quill Fabrics, a dealer", blank), "from [customer], a dealer");
  assert.equal(redact("Patrick fixed the patent", blank), "Patrick fixed the patent", "whole words only");
  assert.equal(redact("SN48211 is stuck", blank), "[serial] is stuck");
  assert.equal(redact("PAT QUILL", blank), "[customer]", "case does not matter");
  assert.equal(redact("", blank), "");
  assert.equal(redact(null, blank), "");
  assert.equal(redact("it is a to", { names: ["to"] }), "it is a to", "names under three characters are words");
  assert.deepEqual(namesToBlank({ customer: "Pat Quill", account: "Quill Fabrics", allCustomers: ["Lee Roy", "Solo"] }).sort(), ["Lee Roy", "Pat", "Pat Quill", "Quill", "Quill Fabrics"].sort());
  assert.equal(maskSerials('{"serial":"AB12345678"}', ["AB12345678"]), '{"serial":"[serial]"}');
  ok("redact: emails, phones, names, serials, whole words only");

  const facts = {
    number: 51,
    noun: "sewing machine",
    brand: "Janome",
    model: "MC6700P",
    machineType: "Embroidery",
    serviceRequested: "Clean and oil",
    problem: "skips stitches, pat@example.com 555-123-4567",
    diagnosis: "hook timing 2 mm late",
    workDone: "reset timing, bobbin case cracked, replaced",
    notes: "ask Pat Quill about payment",
    accessories: ["foot pedal"],
    lines: [{ kind: "PART", description: "Bobbin case", qty: 1, unitPriceCents: 1250 }],
  };
  const built = buildWriteUp("work_done", facts, { shopName: "Quill Sew & Vac", sample: "We cleaned and oiled it." }, blank, { instruction: "mention the belt, 555-123-4567" });
  assert.equal(built.cls, "draft");
  assert.equal(built.feature, "draft_work_done");
  assert.match(built.system, /We cleaned and oiled it\./);
  const text = built.system + built.messages.map((m) => m.content).join("\n");
  assert.ok(!/pat@example|555-123|Pat Quill|SN48211/.test(text), "nothing identifying in the built request");
  assert.match(text, /\[customer\]/);
  assert.match(built.messages[0].content, /Bobbin case.*\$12\.50/);
  ok("buildWriteUp: class, voice, redacted, lines");

  const offered = [
    { kind: "ticket" as const, ref: "ticket:0042", label: "This shop's ticket #0042", href: "/tickets/x" },
    { kind: "spec" as const, ref: "spec:1", label: "Factory tension spec", href: "/specs" },
  ];
  const causes = parseCauses('Sure! {"causes":[{"cause":"A","checks":["c1"],"sources":["ticket:0042","ticket:9999"]},{"cause":"B","checks":[],"sources":["nope:1"]},{"cause":"","sources":[]}]}', offered);
  assert.equal(causes?.length, 2, "an empty cause is dropped");
  assert.deepEqual(causes?.[0].sources.map((s) => s.ref), ["ticket:0042"], "an unknown reference is dropped");
  assert.equal(causes?.[0].general, false);
  assert.equal(causes?.[1].general, true, "no valid source = general knowledge");
  assert.equal(parseCauses("no json at all", offered), null);
  assert.equal(parseCauses('{"causes":[]}', offered), null);
  assert.deepEqual(jsonOf('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parsePlate('{"brand":"Janome","model":"MC6700P","serial":" AB 1 ","machineType":"","confidence":"sure"}'), { brand: "Janome", model: "MC6700P", serial: "AB 1", machineType: null, sure: true });
  assert.equal(parsePlate('{"brand":"Janome","model":"","serial":"","confidence":"sure"}')?.sure, false, "sure without a model is not sure");
  assert.equal(parsePlate('{"brand":"","model":"","serial":""}'), null);
  assert.equal(buildPlateRead(["Janome"], false).cls, "read");
  assert.equal(buildPlateRead(["Janome"], true).cls, "suggest");
  assert.equal(buildLikelyCauses(facts, [], blank).cls, "suggest");
  ok("parseCauses (citations checked), parsePlate, model classes");

  // ===== set-up: companies, a mock model, the stand-in hub =====
  const a = await checkShop();
  const b = await checkShop();
  const mock = await startAnthropicMock({ port: 0, key: "sk-ant-check-0000000000", respond: mockAnswer });
  const hub = await startHub(mock);
  const savedHub = await hubState();
  const savedOff = process.env.ASSISTANT;
  const restoreOff = () => {
    if (savedOff === undefined) delete process.env.ASSISTANT;
    else process.env.ASSISTANT = savedOff;
  };
  const net = (globalThis as unknown as { __hubNet?: { offlineSince: number | null; checkedAt: number; lastOk: number } }).__hubNet;
  const online = async (url: string) => {
    await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, url, installKey: "ik_check", scope: "member", installId: "inst_check" }, update: { url, installKey: "ik_check", scope: "member", installId: "inst_check" } });
    if (net) Object.assign(net, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
  };
  try {
    await online(hub.url);
    const machineA = await db.machine.create({ data: { shopId: a.shopId, brand: "Janome", model: "MC6700P", modelKey: "MC6700P", serial: "SN48211", machineType: "Embroidery" } });
    const custA = await db.customer.create({ data: { shopId: a.shopId, name: "Pat Quill", phone: "555-123-4567", email: "pat@example.com" } });
    const ticketA = await db.ticket.create({
      data: {
        shopId: a.shopId,
        number: 51,
        machineId: machineA.id,
        customerId: custA.id,
        problem: "Skips stitches. Customer Pat Quill, 555-123-4567, pat@example.com. Serial SN48211.",
        diagnosis: "hook timing 2 mm late",
        workDone: "reset timing; bobbin case cracked, replaced",
        lines: { create: [{ kind: "PART", description: "Bobbin case", qty: 1, unitPriceCents: 1250 }] },
      },
    });
    // History on the same model for A, a gotcha note, and ANOTHER company's ticket on the same model (it must never travel).
    const past = await db.ticket.create({
      data: { shopId: a.shopId, number: 40, machineId: machineA.id, status: "COLLECTED", closedAt: new Date(), problem: "skipping stitches", diagnosis: "timing", workDone: "retimed hook", lines: { create: [{ kind: "PART", description: "hook gib", qty: 1, unitPriceCents: 900 }] } },
    });
    const note = await db.modelNote.create({ data: { shopId: a.shopId, brand: "Janome", modelKey: "MC6700P", modelLabel: "MC6700P", body: "GOTCHA: the hook timing screw strips easily" } });
    const machineB = await db.machine.create({ data: { shopId: b.shopId, brand: "Janome", model: "MC6700P", modelKey: "MC6700P" } });
    const ticketB = await db.ticket.create({
      data: { shopId: b.shopId, number: 7, machineId: machineB.id, status: "COLLECTED", closedAt: new Date(), problem: "B-SECRET-PROBLEM", diagnosis: "B-SECRET-DIAGNOSIS", workDone: "B-SECRET-WORK" },
    });

    // ===== 2. module gating =====
    assert.equal(await gateFor(a.shopId, "assistant"), "hidden", "off, no records: hidden");
    await expectError("draft, module off", () => draftText(a.user, { ticketId: ticketA.id, kind: "work_done" }), /Assistant isn't turned on/);
    await expectError("causes, module off", () => likelyCauses(a.user, { ticketId: ticketA.id }), /Assistant isn't turned on/);
    await expectError("mark, module off", () => markCall(a.user, "x", true), /Assistant isn't turned on/);
    assert.deepEqual(await entryFor(a.shopId, "draft"), { show: false }, "no Ask buttons without the module");
    assert.equal((await assistantAvailable(a.shopId)).ok, false);
    assert.equal(hub.calls.length, 0, "refused before any call");
    ok("module off: gate hidden, every action refused, no button, no call");

    const key = await grantDevLicense(a.shopId, ["assistant"], { from: dayStr(-2) });
    assert.equal(await gateFor(a.shopId, "assistant"), "on");
    await db.shop.update({ where: { id: a.shopId }, data: { timeZone: "America/Chicago" } });

    // ===== 3a. the drafts =====
    const id1 = await draftText(a.user, { ticketId: ticketA.id, kind: "work_done", shorthand: "reset timing, COA, call Pat Quill 555-123-4567 when done", instruction: "shorter" });
    assert.equal(hub.calls.length, 1);
    const c1 = hub.calls[0];
    assert.equal(c1.auth, "Bearer ik_check", "the install key");
    assert.equal(c1.shop, a.shopId, "X-Shop-Ref names the company");
    assert.equal(c1.body.shopRef, a.shopId);
    assert.equal(c1.body.tz, "America/Chicago", "the shop's zone, for the month");
    assert.equal(c1.body.feature, "draft_work_done");
    assert.equal(c1.body.model, "draft", "a model class, never a model id");
    assert.equal(c1.body.key, key, "the company's own assistant key goes along for the hub to check");
    assert.equal(typeof c1.body.maxTokens, "number");
    const sent1 = JSON.stringify(c1.body);
    for (const bad of ["Pat Quill", "555-123-4567", "pat@example.com", "SN48211"]) assert.ok(!sent1.includes(bad), `${bad} must not be sent`);
    assert.match(sent1, /\[customer\]/);
    assert.match(sent1, /\[serial\]|Skips stitches/);
    assert.match(sent1, /reset timing, COA/, "the typed shorthand (not yet saved) is what is sent");
    assert.match(sent1, /Bobbin case/, "the bill's lines are sent");
    const log1 = await db.assistantCall.findFirstOrThrow({ where: { id: id1 } });
    assert.equal(log1.shopId, a.shopId);
    assert.equal(log1.ticketId, ticketA.id);
    assert.equal(log1.machineId, machineA.id);
    assert.equal(log1.byUserId, a.user.id);
    assert.equal(log1.model, "claude-sonnet-5-5");
    assert.equal(log1.costMillicents, 450);
    assert.deepEqual((log1.request as { messages: unknown }).messages, c1.body.messages, "the log holds the request exactly as sent");
    assert.deepEqual((log1.request as { system: unknown }).system, c1.body.system);
    assert.match(log1.response, /^Drafted:/);
    const shopRow = await db.shop.findUniqueOrThrow({ where: { id: a.shopId } });
    assert.deepEqual([shopRow.assistantMonth, shopRow.assistantCalls, shopRow.assistantLimit], ["2026-10", 1, 300], "the local count follows the hub's");
    ok("draft: request shape, redaction, log, count");

    // First names: off = the placeholder, on = the first name only.
    await draftText(a.user, { ticketId: ticketA.id, kind: "estimate" });
    assert.match(JSON.stringify(hub.calls[1].body.system), /\{first_name\}/);
    assert.ok(!JSON.stringify(hub.calls[1].body).includes("Pat Quill"));
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, offerFirstNames: true, voice: "We keep it short." });
    await draftText(a.user, { ticketId: ticketA.id, kind: "ready" });
    const sent3 = JSON.stringify(hub.calls[2].body);
    assert.match(sent3, /first name is Pat/);
    assert.ok(!/Quill|555-123|pat@example/.test(sent3), "only the first name is offered");
    assert.match(sent3, /We keep it short\./, "the voice sample goes in the system prompt");
    await expectError("tech can't change settings", () => saveSettings({ shopId: a.shopId, role: "TECH" }, { draftOn: false, causesOn: true, plateOn: true, offerFirstNames: false, voice: null }), /owner or an admin/);
    ok("estimate and ready messages: {first_name} unless offered; the voice sample; settings need an admin");

    await expectError("partner note on a bench ticket", () => draftText(a.user, { ticketId: ticketA.id, kind: "partner_note" }), /isn't a partner/);
    await expectError("unknown kind", () => draftText(a.user, { ticketId: ticketA.id, kind: "poem" }), /isn't something/);
    assert.equal(hub.calls.length, 3);

    // ===== 3b. likely causes =====
    const sources = await causeSources(a.shopId, await ticketContext(a.shopId, ticketA.id));
    assert.ok(sources.some((s) => s.ref === `ticket:0040`), "the shop's past ticket on the model is a source");
    assert.ok(sources.some((s) => s.ref === `gotcha:${note.id}`), "the shop's gotcha is a source");
    assert.ok(!sources.some((s) => /B-SECRET/.test(s.text)), "another company's ticket is never a source");
    assert.ok(!sources.some((s) => s.ref === `ticket:0051`), "the ticket itself is not its own history");
    const callsBefore = hub.calls.length;
    const idC = await likelyCauses(a.user, { ticketId: ticketA.id, instruction: "it's the Mark II" });
    assert.equal(hub.calls.length, callsBefore + 1);
    const cc = hub.calls.at(-1)!;
    assert.equal(cc.body.feature, "likely_causes");
    assert.equal(cc.body.model, "suggest");
    const sentC = JSON.stringify(cc.body);
    assert.match(sentC, /ticket:0040/);
    assert.match(sentC, /retimed hook/);
    assert.match(sentC, /gotcha:/);
    assert.ok(!/B-SECRET|Pat Quill|555-123|pat@example|SN48211/.test(sentC), "no customer, no other company, no serial");
    const logC = await db.assistantCall.findFirstOrThrow({ where: { id: idC } });
    const offeredSources = logC.sources as { ref: string; href?: string }[];
    assert.ok(offeredSources.find((s) => s.ref === "ticket:0040")?.href === `/tickets/${past.id}`, "each source can be opened");
    const parsed = parseCauses(logC.response, offeredSources as never);
    assert.equal(parsed?.length, 3);
    assert.ok(parsed![0].sources.length >= 1 && !parsed![0].general, "a cited cause shows its sources");
    assert.equal(parsed![1].general, true, "ticket:9999 was never offered: general knowledge");
    assert.equal(parsed![2].general, true);
    ok("likely causes: sources are this shop's and cited; unknown citations become general knowledge");

    await db.assistantSettings.update({ where: { shopId: a.shopId }, data: { causesOn: false } });
    await expectError("causes switched off", () => likelyCauses(a.user, { ticketId: ticketA.id }), /switched off in Settings/);
    assert.deepEqual(await entryFor(a.shopId, "causes"), { show: false });
    await db.assistantSettings.update({ where: { shopId: a.shopId }, data: { causesOn: true } });
    ok("a feature switched off in Settings is refused and hidden");

    // ===== 3c. the plate =====
    const n0 = hub.calls.length;
    const first = await plateRead(a.user, PHOTO, "image/jpeg");
    assert.equal(hub.calls.length, n0 + 1, "a sure read is one call");
    assert.equal(first.retried, false);
    assert.deepEqual(first.plate, { brand: "Janome", model: "MC6700P", serial: "AB12345678", machineType: "Embroidery", sure: true });
    const cp = hub.calls.at(-1)!;
    assert.equal(cp.body.feature, "read_plate");
    assert.equal(cp.body.model, "read");
    assert.deepEqual(cp.body.image, { mediaType: "image/jpeg", data: PHOTO }, "the photo goes as an image");
    assert.equal(mock.requests.at(-1)!.hasImage, true);
    assert.equal(mock.requests.at(-1)!.model, "claude-haiku-4-5-20251001");
    assert.ok(!JSON.stringify(cp.body.messages).includes("Pat"), "nothing but the plate and the shop's brands");
    const logP = await db.assistantCall.findFirstOrThrow({ where: { shopId: a.shopId, feature: "read_plate" }, orderBy: { createdAt: "desc" } });
    const reqP = logP.request as { image?: { bytes: number; sha256: string } };
    assert.ok(reqP.image && reqP.image.bytes > 600 && /^[0-9a-f]{16}$/.test(reqP.image.sha256), "the log keeps the photo's size and hash");
    assert.ok(!JSON.stringify(logP.request).includes(PHOTO), "never the photo itself");
    assert.ok(!logP.response.includes("AB12345678") && logP.response.includes("[serial]"), "the logged answer has the serial masked");
    assert.equal(cp.body.key, key);

    // A guess goes once more to the stronger model.
    plateMode = "guess";
    const n1 = hub.calls.length;
    const second = await plateRead(a.user, PHOTO, "image/jpeg");
    assert.equal(hub.calls.length, n1 + 2);
    assert.equal(second.retried, true);
    assert.equal(hub.calls.at(-1)!.body.model, "suggest", "the retry is the stronger class");
    assert.equal(second.plate.sure, true);
    plateMode = "sure";
    await expectError("a photo that isn't one", () => plateRead(a.user, "abc", "image/jpeg"), /Take the photo again/);
    ok("plate: image block, Haiku then Sonnet when guessing, the log keeps size and hash, serial masked");

    // The plate reader needs no module: free reads (counted by the hub).
    await online(hub.url);
    const free = await plateRead(b.user, PHOTO, "image/jpeg");
    assert.equal(free.plate.model, "MC6700P");
    assert.equal(hub.calls.at(-1)!.body.key, undefined, "no key to send without the module: the hub counts a free read");
    assert.deepEqual(await entryFor(b.shopId, "plate", { module: false }), { show: true });
    assert.deepEqual(await entryFor(b.shopId, "draft"), { show: false });
    ok("plate reads need no module");

    // ===== 2b. lapsed: the log readable, the Ask buttons hidden =====
    const lapsed = await checkShop();
    await grantDevLicense(lapsed.shopId, ["assistant"], { from: dayStr(-60), until: dayStr(-30), grace: 14 });
    assert.equal(await gateFor(lapsed.shopId, "assistant"), "readonly", "ended, past grace: read-only");
    await expectError("draft after the module ended", () => draftText(lapsed.user, { ticketId: "whatever", kind: "work_done" }), /Assistant ended on/);
    assert.deepEqual(await entryFor(lapsed.shopId, "draft"), { show: false });
    const lm = await db.machine.create({ data: { shopId: lapsed.shopId, brand: "Brother", model: "PE800", modelKey: "PE800" } });
    const lt = await db.ticket.create({ data: { shopId: lapsed.shopId, number: 1, machineId: lm.id } });
    await db.assistantCall.create({ data: { shopId: lapsed.shopId, feature: "draft_work_done", ticketId: lt.id, model: "claude-sonnet-5-5", request: {}, response: "An old draft" } });
    const vLapsed = await ticketAssistantView({ shopId: lapsed.shopId, ticketId: lt.id, canWork: true });
    assert.ok(vLapsed && vLapsed.gate === "readonly" && !vLapsed.buttons, "the card is read-only");
    assert.deepEqual([vLapsed.drafts, vLapsed.causes], [{ show: false }, { show: false }], "no Ask or Draft buttons while lapsed");
    assert.equal(vLapsed.history.length, 1, "the log is still readable");
    assert.equal(vLapsed.latest.draft_work_done?.text, "An old draft");
    ok("lapsed: log readable, no Ask or Draft buttons");

    // ===== 4. offline, refusals, nothing on its own =====
    const nSlot = hub.calls.length;
    const vOn = await ticketAssistantView({ shopId: a.shopId, ticketId: ticketA.id, canWork: true });
    assert.ok(vOn?.buttons && vOn.drafts.show && vOn.causes.show, "the buttons work");
    assert.equal(vOn.drafts.show && vOn.drafts.unavailable, undefined);
    assert.match(vOn.previews.draft_diagnosis ?? "", /Technician's shorthand to rewrite/, "the first-use preview shows what would be sent");
    assert.equal(vOn.previews.draft_work_done, undefined, "no preview once a feature has been used on the ticket");
    assert.equal(vOn.previews.likely_causes, undefined, "nor once the causes were asked for");
    const fresh = await db.ticket.create({ data: { shopId: a.shopId, number: 52, machineId: machineA.id, problem: "noisy" } });
    const vFresh = await ticketAssistantView({ shopId: a.shopId, ticketId: fresh.id, canWork: true });
    assert.match(vFresh?.previews.likely_causes ?? "", /Sources:[\s\S]*ticket:0040/, "a ticket's first look shows the causes request, sources listed");
    assert.match(vFresh?.previews.draft_work_done ?? "", /Technician's shorthand/);
    assert.match(vOn.latest.draft_work_done?.text ?? "", /^Drafted:/);
    assert.equal(hub.calls.length, nSlot, "building the ticket's Assistant card never calls the model");
    assert.ok(!/Pat Quill|555-123-4567|pat@example|SN48211/.test(JSON.stringify(vOn.previews)), "the preview is redacted too");
    assert.ok(await ticketAssistantView({ shopId: a.shopId, ticketId: ticketB.id, canWork: true }).then((v) => v == null), "another company's ticket has no card");

    hub.next.push({ status: 402, error: "You've used this month's 300 Assistant calls. They start again with next month, or an owner can add 300 more." });
    await expectError("allowance used", () => draftText(a.user, { ticketId: ticketA.id, kind: "work_done" }), /used this month's 300 Assistant calls/);
    const failed = await db.assistantCall.findFirstOrThrow({ where: { shopId: a.shopId, error: { not: null } }, orderBy: { createdAt: "desc" } });
    assert.match(failed.error!, /used this month's 300/);
    assert.equal(failed.response, "");
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).assistantCalls, 300, "the local count follows the refusal");
    ok("a 402 comes through in the hub's words and is logged");

    process.env.ASSISTANT = "off";
    await expectError("ASSISTANT=off", () => draftText(a.user, { ticketId: ticketA.id, kind: "work_done" }), /switched off on this server/);
    assert.deepEqual(await entryFor(a.shopId, "draft"), { show: false }, "no buttons while the server has the Assistant off");
    restoreOff();

    const sentBeforeOffline = hub.calls.length;
    await hub.close();
    const logsBefore = await db.assistantCall.count({ where: { shopId: a.shopId } });
    await expectError("hub gone", () => draftText(a.user, { ticketId: ticketA.id, kind: "work_done" }), new RegExp(OFFLINE_MESSAGE));
    assert.equal(await db.assistantCall.count({ where: { shopId: a.shopId } }), logsBefore + 1, "one logged failure");
    const off = await entryFor(a.shopId, "draft");
    assert.deepEqual(off, { show: true, unavailable: OFFLINE_MESSAGE }, "buttons say the Assistant needs the internet");
    const vOff = await ticketAssistantView({ shopId: a.shopId, ticketId: ticketA.id, canWork: true });
    assert.deepEqual([vOff?.drafts, vOff?.causes], [off, off], "every card says it needs the internet");
    assert.equal(hub.calls.length, sentBeforeOffline);
    assert.deepEqual(await entryFor(a.shopId, "plate", { module: false }), { show: true, unavailable: OFFLINE_MESSAGE });
    ok("offline: the Assistant needs the internet, one logged failure, no spinner state");

    // ===== 5. tenant isolation =====
    const hub2 = await startHub(mock);
    await online(hub2.url);
    const tables = ["AssistantCall", "Ticket"];
    const before = await snapshot(a.shopId, tables);
    const sentB = hub2.calls.length;
    await grantDevLicense(b.shopId, ["assistant"], { from: dayStr(-2) });
    await expectNotFound("draft on A's ticket as B (module on)", () => draftText(b.user, { ticketId: ticketA.id, kind: "work_done" }));
    await expectNotFound("likely causes on A's ticket as B", () => likelyCauses(b.user, { ticketId: ticketA.id }));
    await expectNotFound("mark A's call as B", () => markCall(b.user, id1, true));
    assert.equal(hub2.calls.length, sentB, "no call was made for B on A's ticket");
    assertUnchanged("B's calls leave A alone", before, await snapshot(a.shopId, tables));
    // B's own request carries only B's data.
    await likelyCauses(b.user, { ticketId: ticketB.id });
    const sentOwnB = JSON.stringify(hub2.calls.at(-1)!.body);
    assert.ok(!/retimed hook|hook timing screw|Pat Quill|bobbin case/i.test(sentOwnB), "nothing of company A in B's request");
    assert.equal(hub2.calls.at(-1)!.body.shopRef, b.shopId);
    // A's own mark works and is A's.
    assert.equal(await markCall(a.user, id1, true), ticketA.id);
    assert.equal((await db.assistantCall.findFirstOrThrow({ where: { id: id1 } })).accepted, true);
    await hub2.close();
    ok("tenant: B can't draft on, ask about or mark A's rows; B's request holds only B's data");

    console.log(`assistant check: ${steps} checks passed`);
  } finally {
    restoreOff();
    await hub.close().catch(() => {});
    await mock.close().catch(() => {});
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

void RUN;
