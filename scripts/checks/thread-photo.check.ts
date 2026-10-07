// Thread match from a phone photo (shop-features-round-2-design.md 9.10, package thread-photo): the color math (Lab
// distance, the ranking: on the shelf first unless one out of stock is much closer), the answer's colors (real hex only,
// three at most), the request (feature thread_photo, class read, the photo as an image; no item list sent), the gate
// (Assistant module, the Fabric and thread helpers switch), the matches from the shop's own threads with a swatch color
// (never another company's), nothing saved, one call counted.
//   npm run check scripts/checks/thread-photo.check.ts
// A stand-in hub in this process answers the Assistant's call.
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/user-error";
import { hubState } from "@/lib/hub";
import { saveSettings } from "@/lib/assistant/bodies";
import { buildThreadPhoto, parseThreadColors } from "@/lib/assistant/prompts";
import { colorDistance, rankByColor } from "@/lib/thread-photo-math";
import { threadMatchFor } from "@/lib/thread-photo";
import { grantDevLicense } from "../license/dev";
import { checkShop, cleanup } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
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
const PHOTO = Buffer.alloc(900, 7).toString("base64");
const dayStr = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function startHub(answer: string) {
  const calls: { feature: string; model: string; system: string; messages: { content: string }[]; image?: { mediaType: string; data: string } }[] = [];
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return send(200, { ok: true });
    if (req.url === "/v1/assistant" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      return send(200, { text: answer, stopReason: "end_turn", usage: { input: 900, cacheRead: 0, output: 40 }, costMillicents: 90, model: "claude-haiku-4-5-20251001", month: "2026-10", calls: calls.length, limit: 300 });
    }
    send(404, { error: "no such route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))) };
}

async function main() {
  // 1. The pure parts.
  assert.equal(colorDistance("#000080", "#000080"), 0);
  assert.ok(colorDistance("#000080", "#00008b")! < 6, "two navies are close");
  assert.ok(colorDistance("#000080", "#ff0000")! > 50, "navy and red are far");
  assert.equal(colorDistance("navy", "#000000"), null);
  const ranked = rankByColor("#000080", [
    { id: "a", colorHex: "#000085", qtyOnHand: 0 },
    { id: "b", colorHex: "#00008a", qtyOnHand: 3 },
    { id: "c", colorHex: null, qtyOnHand: 9 },
    { id: "d", colorHex: "#ff0000", qtyOnHand: 9 },
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ["b", "a", "d"], "on the shelf first when about as close; no swatch can't match");
  assert.deepEqual(parseThreadColors('{"colors":[{"hex":"#1F2A6B","name":"Navy","where":"the thread"},{"hex":"zzz"},{"hex":"#1f2a6b"},{"hex":"#fc0","name":"gold"}]}'), [
    { hex: "#1f2a6b", name: "Navy", where: "the thread" },
    { hex: "#ffcc00", name: "gold", where: null },
  ]);
  assert.equal(parseThreadColors('{"colors":[]}'), null);
  const b = buildThreadPhoto();
  assert.deepEqual([b.feature, b.cls], ["thread_photo", "read"]);
  ok("the color distance and ranking, the answer's colors (real hex, each once), the request shape");

  // 2. Gate and the match.
  const a = await checkShop({ retail: true });
  const other = await checkShop({ retail: true });
  const hub = await startHub('{"colors":[{"hex":"#000080","name":"navy","where":"the thread"}]}');
  const savedHub = await hubState();
  const net = (globalThis as unknown as { __hubNet?: { offlineSince: number | null; checkedAt: number; lastOk: number } }).__hubNet;
  try {
    await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, url: hub.url, installKey: "ik_check", scope: "member", installId: "inst_check" }, update: { url: hub.url, installKey: "ik_check", scope: "member", installId: "inst_check" } });
    if (net) Object.assign(net, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
    const thread = (shopId: string, n: string, hex: string | null, qty: number) =>
      db.part.create({ data: { shopId, partNumber: n, numberKeys: [n.toLowerCase()], description: `Thread ${n}`, kind: "SUPPLY", itemType: "thread", brand: "Isacord", colorNumber: n, colorName: "x", colorHex: hex, priceCents: 899, qtyOnHand: qty, location: "Wall B" } });
    await thread(a.shopId, "3644", "#00007f", 4);
    await thread(a.shopId, "3622", "#000090", 0);
    await thread(a.shopId, "1902", "#cc0000", 6);
    await thread(a.shopId, "0015", null, 6);
    await thread(other.shopId, "9999", "#000080", 9);

    await expectError("module off", () => threadMatchFor(a.user, PHOTO, "image/jpeg"), /Assistant isn't turned on/);
    await grantDevLicense(a.shopId, ["assistant"], { from: dayStr(-2) });
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, fabricOn: false, offerFirstNames: false, voice: null });
    await expectError("switch off", () => threadMatchFor(a.user, PHOTO, "image/jpeg"), /switched off in Settings/);
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, fabricOn: true, offerFirstNames: false, voice: null });
    await expectError("a photo that isn't one", () => threadMatchFor(a.user, "abc", "image/jpeg"), /Take the photo again/);
    assert.equal(hub.calls.length, 0, "refused before any call");

    const r = await threadMatchFor(a.user, PHOTO, "image/jpeg");
    assert.equal(hub.calls.length, 1);
    const c = hub.calls[0];
    assert.deepEqual([c.feature, c.model, c.image?.data], ["thread_photo", "read", PHOTO]);
    assert.ok(!JSON.stringify(c).includes("3644"), "no item list is sent: the program does the matching");
    assert.equal(r.matches.length, 1);
    assert.deepEqual(r.matches[0].hits.map((h) => [h.partNumber, h.closeness]), [["3644", "very close"], ["3622", "close"], ["1902", "the nearest we have"]]);
    assert.equal(r.matches[0].hits[0].location, "Wall B");
    assert.equal(r.unmatched, 1, "the thread without a swatch is counted");
    assert.ok(!r.matches[0].hits.some((h) => h.partNumber === "9999"), "never another company's thread");
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).assistantCalls, 1, "one call counted");
    assert.equal(await db.part.count({ where: { shopId: a.shopId } }), 4, "nothing saved");
    ok("gated by the module and the Fabric and thread helpers switch; the photo read; the shop's own threads ranked; one call; nothing saved");
  } finally {
    await hub.close().catch(() => {});
    if (savedHub) await db.hubState.update({ where: { id: 1 }, data: { url: savedHub.url, installKey: savedHub.installKey, installId: savedHub.installId, scope: savedHub.scope } }).catch(() => {});
    else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => {});
  }
  console.log(`thread-photo.check: ${steps} groups passed`);
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
