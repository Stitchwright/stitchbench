// A photo of the packing slip or invoice fills in receiving (shop-features-round-2-design.md 1.10): the pure parts
// (reading the answer, matching by item number, cost changes); gated by the Assistant module and the Stock helpers
// switch; two pages read as the hub receives them (feature read_invoice, class read, the picture, the order's id in the
// log); the three groups; "Receive these" (the order line through the order's receipt, an item not on the order, a new
// item made, a cost updated, a tech's cost refused); without an order; the tenant section. A stand-in hub in this process.
//   npm run -s check scripts/checks/invoice-reader.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/user-error";
import { hubState } from "@/lib/hub";
import { saveSettings } from "@/lib/assistant/bodies";
import { matchSlip, parseSlip, buildInvoiceRead, costChange } from "@/lib/invoice-reader-math";
import { readSlipFor, receiveSlipFor } from "@/lib/invoice-reader";
import { sendOrderFor } from "@/lib/fabric-orders";
import { grantDevLicense } from "../license/dev";
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

const PHOTO = Buffer.alloc(900, 7).toString("base64");
const PAGES: Record<string, string> = {
  "1": '```json\n{"lines":[{"itemNumber":"ISA-0015","description":"Isacord 0015 White","qty":6,"unitCost":"4.60"},{"itemNumber":"NEW-77","description":"Clover wonder clips 50","qty":2,"unitCost":12.5}],"supplier":"Notions Marketing"}\n```',
  "2": '{"lines":[{"itemNumber":"pin-1","description":"Glass head pins","qty":3,"unitCost":"3.10"},{"itemNumber":"","description":"Freight","qty":0}]}',
};

async function startHub() {
  const calls: { feature: string; model: string; image?: unknown; content: string }[] = [];
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return send(200, { ok: true });
    if (req.url === "/v1/assistant" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { feature: string; model: string; image?: unknown; messages: { content: string }[] };
      const content = body.messages[0].content;
      calls.push({ feature: body.feature, model: body.model, image: body.image, content });
      const page = /page (\d) of/.exec(content)?.[1] ?? "1";
      return send(200, { text: PAGES[page], stopReason: "end_turn", usage: { input: 10, cacheRead: 0, output: 10 }, costMillicents: 90, model: "claude-haiku-4-5-20251001", month: "2026-10", calls: calls.length, limit: 300 });
    }
    send(404, { error: "no such route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))) };
}

async function main() {
  // ===== 1. the pure parts =====
  const lines = parseSlip(PAGES["1"])!;
  assert.deepEqual(lines[0], { itemNumber: "ISA-0015", description: "Isacord 0015 White", qty: 6, unitCostTenThou: 46_000 });
  assert.equal(parseSlip(PAGES["2"])!.length, 1, "freight (no quantity) left out");
  assert.equal(parseSlip("no json"), null);
  assert.deepEqual([buildInvoiceRead(1, 2, "NM").feature, buildInvoiceRead(1, 2, "NM").cls], ["read_invoice", "read"]);
  assert.equal(Math.round(costChange(41_000, 46_000)! * 100), 12);
  const m = matchSlip(lines, [{ id: "L1", partId: "P1", itemNumber: "ISA 0015", qty: 10, receivedYards: 0, unit: "EACH", costCents: 410, keys: ["ISA0015"] }], [{ id: "P1", partNumber: "ISA-0015", description: "x", keys: ["ISA0015"], costTenThou: null, costCents: 410 }]);
  assert.deepEqual(m.map((x) => x.group), ["order", "new"]);
  ok("pure: lines read (freight left out), the request (class read), matched by number, cost up 12%");

  // ===== set-up =====
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const hub = await startHub();
  const savedHub = await hubState();
  const net = (globalThis as unknown as { __hubNet?: { offlineSince: number | null; checkedAt: number; lastOk: number } }).__hubNet;
  await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, url: hub.url, installKey: "ik_check", scope: "member", installId: "inst_check" }, update: { url: hub.url, installKey: "ik_check", scope: "member", installId: "inst_check" } });
  if (net) Object.assign(net, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
  const tech = { ...a.user, role: "TECH" as const };
  try {
    const item = (shopId: string, n: string, extra: Record<string, unknown> = {}) =>
      db.part.create({ data: { shopId, partNumber: n, numberKeys: [n.toUpperCase().replace(/[^A-Z0-9]/g, "")], description: `Item ${n}`, kind: "THREAD", qtyOnHand: 1, priceCents: 900, costCents: 410, supplier: "Notions Marketing", ...extra } });
    const isa = await item(a.shopId, "ISA-0015");
    const pin = await item(a.shopId, "PIN-1", { kind: "NOTION", costCents: 310 });
    const sup = await db.fabricSupplier.create({ data: { shopId: a.shopId, name: "Notions Marketing" } });
    const po = await db.purchaseOrder.create({ data: { shopId: a.shopId, number: 1, supplierId: sup.id, supplierName: sup.name, lines: { create: [{ shopId: a.shopId, partId: isa.id, itemNumber: "ISA-0015", description: "Isacord white", unit: "EACH", qty: 10, costCents: 410 }] } } });
    await sendOrderFor(a.user, po.id, "manual");
    const photos = [
      { data: PHOTO, mediaType: "image/jpeg" },
      { data: PHOTO, mediaType: "image/jpeg" },
    ];

    // ===== 2. gating =====
    await expectError("module off", () => readSlipFor(a.user, { orderId: po.id, photos }), /Assistant isn't turned on/);
    await grantDevLicense(a.shopId, ["assistant"], { from: dayStr(-2) });
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, offerFirstNames: false, voice: null, stockOn: false });
    await expectError("stock helpers off", () => readSlipFor(a.user, { orderId: po.id, photos }), /switched off/);
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, offerFirstNames: false, voice: null, stockOn: true });
    await expectError("six pictures", () => readSlipFor(a.user, { orderId: po.id, photos: Array(6).fill(photos[0]) }), /Up to 5/);
    assert.equal(hub.calls.length, 0, "refused before any call");
    ok("needs the Assistant module and its Stock helpers switch; five pictures at most");

    // ===== 3. read: two pages, the three groups =====
    const read = await readSlipFor(a.user, { orderId: po.id, photos });
    assert.equal(hub.calls.length, 2, "one call per page");
    assert.ok(hub.calls.every((c) => c.feature === "read_invoice" && c.model === "read" && c.image));
    assert.match(hub.calls[0].content, /Notions Marketing/);
    assert.equal(await db.assistantCall.count({ where: { shopId: a.shopId, feature: "read_invoice", purchaseOrderId: po.id } }), 2);
    const groups = read.rows.map((r) => [r.group, r.slip.itemNumber]);
    assert.deepEqual(groups, [["order", "ISA-0015"], ["new", "NEW-77"], ["item", "pin-1"]]);
    const onOrder = read.rows[0];
    assert.ok(onOrder.group === "order" && onOrder.onOrder === 10 && onOrder.outstanding === 10 && Math.round(onOrder.costChange! * 100) === 12);
    ok("two pages, one call each (read class, the picture, the order in the log); on the order, new to us, not on the order; cost up 12%");

    // ===== 4. receive these =====
    await expectError("a tech updating a cost", () => receiveSlipFor(tech, { orderId: po.id, rows: [{ group: "order", lineId: (onOrder as { lineId: string }).lineId, partId: isa.id, qty: 6, costTenThou: 46_000, updateCost: true }] }), /owner or admin/);
    const slipRows = [
      { group: "order" as const, lineId: (onOrder as { lineId: string }).lineId, partId: isa.id, qty: 6, costTenThou: 46_000, updateCost: true },
      { group: "new" as const, qty: 2, itemNumber: "NEW-77", description: "Clover wonder clips 50", costTenThou: 125_000 },
      { group: "item" as const, partId: pin.id, qty: 3, costTenThou: 31_000, updateCost: false },
    ];
    const slipKey = `slip-check-${Date.now()}-abcdef`;
    const words = await receiveSlipFor(a.user, {
      orderId: po.id,
      key: slipKey,
      rows: [
        { group: "order", lineId: (onOrder as { lineId: string }).lineId, partId: isa.id, qty: 6, costTenThou: 46_000, updateCost: true },
        { group: "new", qty: 2, itemNumber: "NEW-77", description: "Clover wonder clips 50", costTenThou: 125_000 },
        { group: "item", partId: pin.id, qty: 3, costTenThou: 31_000, updateCost: false },
      ],
    });
    assert.match(words, /Received 6 pieces on 1 line of order #1/);
    assert.match(words, /1 new item made/);
    assert.match(words, /1 cost updated/);
    const isaAfter = await db.part.findUniqueOrThrow({ where: { id: isa.id } });
    assert.ok(isaAfter.qtyOnHand === 7 && isaAfter.costTenThou === 46_000 && isaAfter.costCents === 460);
    assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status, "PARTLY_RECEIVED");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: pin.id } })).qtyOnHand, 4);
    const made = await db.part.findFirstOrThrow({ where: { shopId: a.shopId, partNumber: "NEW-77" } });
    assert.ok(made.qtyOnHand === 2 && made.costTenThou === 125_000 && made.supplier === "Notions Marketing" && made.priceCents === null);
    // Sent again with the same key (a retry after a lost answer): nothing received twice (review fix).
    assert.match(await receiveSlipFor(a.user, { orderId: po.id, key: slipKey, rows: slipRows }), /Received already/);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: pin.id } })).qtyOnHand, 4, "the pins once");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: isa.id } })).qtyOnHand, 7, "the order's line once");
    ok("received: 6 on the order through its receipt (partly received), the cost to $4.60; 3 pins not on the order; the clips made with their stock and cost; sent again, nothing twice");

    // ===== 5. without an order =====
    const loose = await readSlipFor(a.user, { orderId: null, photos: [photos[0]] });
    assert.deepEqual(loose.rows.map((r) => r.group), ["item", "item"], "both numbers now known items");
    ok("without an order: every line is an item of ours or new");

    // ===== 6. tenant =====
    await grantDevLicense(b.shopId, ["assistant"], { from: dayStr(-2) });
    await expectNotFound("B reads for A's order", () => readSlipFor(b.user, { orderId: po.id, photos }));
    await expectNotFound("B receives A's order", () => receiveSlipFor(b.user, { orderId: po.id, rows: [{ group: "order", lineId: (onOrder as { lineId: string }).lineId, qty: 1 }] }));
    await expectError("B receives A's item", () => receiveSlipFor(b.user, { orderId: null, rows: [{ group: "item", partId: isa.id, qty: 1 }] }), /isn't in your inventory/);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: isa.id } })).qtyOnHand, 7);
    ok("tenant: another company can't read for, receive against, or receive A's items");

    console.log(`invoice-reader.check: ${steps} groups passed`);
  } finally {
    if (savedHub) await db.hubState.update({ where: { id: 1 }, data: { url: savedHub.url, installKey: savedHub.installKey, scope: savedHub.scope, installId: savedHub.installId } }).catch(() => undefined);
    else await db.hubState.deleteMany({ where: { id: 1 } });
    await hub.close();
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
