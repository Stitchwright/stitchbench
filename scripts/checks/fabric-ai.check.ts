// Fabric Smarts F5, the Assistant's fabric helpers (fabric-smarts-design.md section 3, ai-assistant-scope.md):
//   1. the pure parts: the bolt label's JSON, the swatch tags (themes only from the list, at most five)
//   2. gating: the assistant module off = refused and hidden; the "Fabric helpers" switch off = refused and hidden;
//      offline = "The Assistant needs the internet."
//   3. the bolt-label read as the hub receives it (feature read_label, class read, the photo as an image block, the shop's
//      usual makers only), what the form gets back, the log, the count
//   4. tags from a swatch (feature tag_fabric): added to the fabric's own tags, a batch of three counts three calls,
//      another company's fabric (or a non-fabric item) is "not found", and What sells' roll-up by color tag uses them
//   npm run check scripts/checks/fabric-ai.check.ts
// Shares the dev database: throwaway companies "Check <run>"; the HubState row is put back. A stand-in hub in this
// process in front of the Anthropic mock (scripts/test-mail/anthropic-mock.mjs).
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/user-error";
import { hubState } from "@/lib/hub";
import { entryFor } from "@/lib/assistant/ui";
import { labelRead, saveSettings, tagFromPicture } from "@/lib/assistant/bodies";
import { OFFLINE_MESSAGE } from "@/lib/assistant/features";
import { buildLabelRead, buildSwatchTags, parseLabel, parseTags } from "@/lib/assistant/prompts";
import { insightFor } from "@/lib/fabric-insight";
import { grantDevLicense } from "../license/dev";
import { startAnthropicMock } from "../test-mail/anthropic-mock.mjs";
import { checkShop, cleanup } from "./lib";
import { expectNotFound } from "./tenant";

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

type HubCall = { body: Record<string, unknown> & { feature: string; model: string; messages: { content: string }[]; image?: { mediaType: string; data: string } } };
const MODEL = { draft: "claude-sonnet-5-5", suggest: "claude-sonnet-5-5", read: "claude-haiku-4-5-20251001", manuals: "claude-opus-5-5" } as Record<string, string>;
const PHOTO = Buffer.alloc(900, 7).toString("base64");

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
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HubCall["body"] & { system: string; maxTokens: number };
      calls.push({ body });
      const last = body.messages[body.messages.length - 1];
      const content = body.image ? [{ type: "image", source: { type: "base64", media_type: body.image.mediaType, data: body.image.data } }, { type: "text", text: last.content }] : last.content;
      const r = await fetch(`${mock.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-ant-check-0000000000", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL[body.model], max_tokens: body.maxTokens, system: [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content }] }),
      });
      const a = (await r.json()) as { content: { text: string }[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } };
      count += 1;
      return send(200, {
        text: a.content[0].text,
        stopReason: a.stop_reason,
        usage: { input: a.usage.input_tokens, cacheRead: a.usage.cache_read_input_tokens, output: a.usage.output_tokens },
        costMillicents: 90,
        model: MODEL[body.model],
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

const mockAnswer = (rec: { system: string }): string => {
  if (rec.system.startsWith("You read the label on the end of a bolt")) {
    return '```json\n{"itemNumber":"C1234-56","name":"Spring Meadow","color":"Sky blue","maker":"Moda","collection":"Meadow Song","widthInches":"44/45","content":"100% cotton","confidence":"sure"}\n```';
  }
  if (rec.system.startsWith("You look at a photo of a quilting fabric")) return '{"colors":["Blue","white"],"themes":["floral","paisley"]}';
  return "MOCK";
};

async function main() {
  // ===== 1. the pure parts =====
  const l = parseLabel('{"itemNumber":" C1234-56 ","name":"Meadow","color":"Sky   blue","maker":"Moda","collection":"","widthInches":"44/45","content":"100% cotton","confidence":"sure"}');
  assert.deepEqual(l, { itemNumber: "C1234-56", name: "Meadow", color: "Sky blue", maker: "Moda", collection: null, widthInches: 44, content: "100% cotton", sure: true });
  assert.equal(parseLabel('{"itemNumber":"","name":"","color":""}'), null, "nothing read");
  assert.equal(parseLabel('{"name":"Meadow","confidence":"sure"}')?.sure, false, "sure without an item number is not sure");
  assert.equal(parseLabel("no json"), null);
  assert.deepEqual(parseTags('{"colors":["Blue","BLUE","navy","red","pink"],"themes":["Floral","paisley","batik","holiday"]}'), ["blue", "navy", "red", "floral", "batik"], "three colors, themes from the list only, five at most");
  assert.equal(parseTags('{"colors":[],"themes":["paisley"]}'), null);
  const b1 = buildLabelRead(["Moda"]);
  assert.deepEqual([b1.feature, b1.cls], ["read_label", "read"]);
  assert.match(b1.messages[0].content, /Moda/);
  assert.deepEqual([buildSwatchTags().feature, buildSwatchTags().cls], ["tag_fabric", "read"]);
  ok("parseLabel, parseTags, the request shapes (class read, Haiku)");

  // ===== set-up =====
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const mock = await startAnthropicMock({ port: 0, key: "sk-ant-check-0000000000", respond: mockAnswer });
  const hub = await startHub(mock);
  const savedHub = await hubState();
  const net = (globalThis as unknown as { __hubNet?: { offlineSince: number | null; checkedAt: number; lastOk: number } }).__hubNet;
  const online = async (url: string) => {
    await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, url, installKey: "ik_check", scope: "member", installId: "inst_check" }, update: { url, installKey: "ik_check", scope: "member", installId: "inst_check" } });
    if (net) Object.assign(net, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
  };
  try {
    await online(hub.url);
    const fab = (shopId: string, n: string, extra: Record<string, unknown> = {}) =>
      db.part.create({ data: { shopId, partNumber: n, numberKeys: [n.toLowerCase()], description: `Fabric ${n}`, kind: "FABRIC", unit: "yd", brand: "Moda", collection: "Meadow Song", priceCents: 1200, qtyOnHand: 10, ...extra } });
    const f1 = await fab(a.shopId, "F-1", { colorTags: ["batik"] });
    const f2 = await fab(a.shopId, "F-2");
    const f3 = await fab(a.shopId, "F-3");
    const notFabric = await db.part.create({ data: { shopId: a.shopId, partNumber: "P-1", numberKeys: ["p-1"], description: "A belt", kind: "PART", qtyOnHand: 1 } });
    const other = await fab(b.shopId, "B-1");

    // ===== 2. gating =====
    await expectError("label, module off", () => labelRead(a.user, PHOTO, "image/jpeg"), /Assistant isn't turned on/);
    await expectError("tags, module off", () => tagFromPicture(a.user, f1.id, PHOTO, "image/jpeg"), /Assistant isn't turned on/);
    assert.deepEqual(await entryFor(a.shopId, "fabric"), { show: false });
    assert.equal(hub.calls.length, 0, "refused before any call");
    await grantDevLicense(a.shopId, ["assistant"], { from: dayStr(-2) });
    assert.deepEqual(await entryFor(a.shopId, "fabric"), { show: true });
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, fabricOn: false, offerFirstNames: false, voice: null });
    await expectError("label, Fabric helpers off", () => labelRead(a.user, PHOTO, "image/jpeg"), /switched off in Settings/);
    assert.deepEqual(await entryFor(a.shopId, "fabric"), { show: false });
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, fabricOn: true, offerFirstNames: false, voice: null });
    assert.deepEqual(await entryFor(a.shopId, "fabric"), { show: true });
    await expectError("a photo that isn't one", () => labelRead(a.user, "abc", "image/jpeg"), /Take the photo again/);
    assert.equal(hub.calls.length, 0);
    ok("gating: module off and the Fabric helpers switch hide and refuse; no call");

    // ===== 3. the bolt label =====
    const r = await labelRead(a.user, PHOTO, "image/jpeg");
    assert.deepEqual(r.label, { itemNumber: "C1234-56", name: "Spring Meadow", color: "Sky blue", maker: "Moda", collection: "Meadow Song", widthInches: 44, content: "100% cotton", sure: true });
    const c1 = hub.calls[0].body;
    assert.equal(c1.feature, "read_label");
    assert.equal(c1.model, "read", "a model class, never a model id");
    assert.deepEqual(c1.image, { mediaType: "image/jpeg", data: PHOTO });
    assert.match(c1.messages[0].content, /Moda/, "the shop's usual makers help the read");
    const log = await db.assistantCall.findFirstOrThrow({ where: { shopId: a.shopId, feature: "read_label" } });
    assert.equal(log.byUserId, a.user.id);
    assert.equal(log.model, "claude-haiku-4-5-20251001");
    assert.equal((log.request as { image: { bytes: number } }).image.bytes, 900);
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).assistantCalls, 1, "counts against the allowance");
    assert.equal(await db.part.count({ where: { shopId: a.shopId } }), 4, "reading a label saves nothing");
    ok("bolt label: image block, class read, usual makers, answer, log, count, nothing saved");

    // ===== 4. tags =====
    const t1 = await tagFromPicture(a.user, f1.id, PHOTO, "image/jpeg");
    assert.deepEqual(t1.tags, ["batik", "blue", "white", "floral"], "added to the fabric's own, nothing removed");
    assert.equal(hub.calls.at(-1)!.body.feature, "tag_fabric");
    assert.deepEqual((await db.part.findUniqueOrThrow({ where: { id: f1.id } })).colorTags, ["batik", "blue", "white", "floral"]);
    const before = hub.calls.length;
    for (const f of [f2, f3]) await tagFromPicture(a.user, f.id, PHOTO, "image/jpeg");
    assert.equal(hub.calls.length, before + 2, "a batch is one call a fabric");
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).assistantCalls, 4);
    await expectNotFound("another company's fabric", () => tagFromPicture(a.user, other.id, PHOTO, "image/jpeg"));
    await expectNotFound("a part that isn't fabric", () => tagFromPicture(a.user, notFabric.id, PHOTO, "image/jpeg"));
    assert.equal(hub.calls.length, before + 2, "refused before any call");
    assert.deepEqual((await db.part.findUniqueOrThrow({ where: { id: other.id } })).colorTags, []);
    const ins = await insightFor(a.shopId);
    const blue = ins.groups.color.find((g) => g.name === "blue");
    assert.ok(blue && blue.items === 3, `What sells has a blue roll-up of 3 fabrics (got ${JSON.stringify(ins.groups.color)})`);
    assert.ok(!ins.groups.color.some((g) => g.name === "(no color tag)"), "every fabric is tagged now");
    ok("tags: added to the fabric's own, one call a fabric, tenant-safe, What sells rolls up by color tag");

    // ===== offline =====
    await hub.close();
    await expectError("hub gone", () => labelRead(a.user, PHOTO, "image/jpeg"), new RegExp(OFFLINE_MESSAGE));
    assert.deepEqual(await entryFor(a.shopId, "fabric"), { show: true, unavailable: OFFLINE_MESSAGE });
    ok("offline: the Assistant needs the internet");

    console.log(`fabric-ai check: ${steps} checks passed`);
  } finally {
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
