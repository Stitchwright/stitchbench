// Fabric orders (fabric-smarts-design.md, package F3): the reorder math on hand-computed examples, lead time learning,
// "Reorder now", the Reorder tab on real rows (in print only, on order from open orders, the half-bolt rounding), the
// purchase order lifecycle (draft, send, receive, close, cancel), RECEIVED moves, bolt ends skipping fabric on order,
// the CSV and email text, and the tenant section.
//   npm run check scripts/checks/fabric-orders.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { todayIn } from "@/lib/time-zone";
import { boltEndsFor } from "@/lib/fabric";
import {
  addLineFor,
  addToDraftFor,
  cancelOrderFor,
  closeOrderFor,
  createOrderFor,
  mailtoFor,
  onOrderFor,
  orderCsvRows,
  orderFor,
  orderText,
  ordersListFor,
  receiveOrderFor,
  reorderFor,
  saveOrderFor,
  saveSupplierFor,
  sendOrderFor,
  suppliersFor,
} from "@/lib/fabric-orders";
import { ORDER_DEFAULTS, isUrgent, leadDaysOf, learnLead, lineCostTotal, lineYards, orderTotal, outstandingYards, reorderMath, statusAfterReceive, weeklySigma } from "@/lib/fabric-orders-math";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const near = (got: number, want: number, label: string, eps = 1e-9) => assert.ok(Math.abs(got - want) < eps, `${label}: got ${got}, want ${want}`);

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

const TZ = "America/New_York";
const TODAY = todayIn(TZ);
const at = (k: number) => new Date(Date.parse(`${TODAY}T16:00:00Z`) - k * 86_400_000);
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function fab(shopId: string, number: string, o: { qty: number; collection?: string | null; supplier?: string | null; inPrint?: "YES" | "NO" | "UNKNOWN"; cost?: number | null }) {
  return db.part.create({
    data: {
      shopId,
      partNumber: number,
      numberKeys: [number.replace(/[^A-Z0-9]/gi, "").toUpperCase()],
      description: `Batik ${number}`,
      kind: "FABRIC",
      unit: "yd",
      brand: "Moda",
      collection: o.collection === undefined ? "Bali" : o.collection,
      supplier: o.supplier === undefined ? "Moda Wholesale" : o.supplier,
      inPrint: o.inPrint ?? "YES",
      qtyOnHand: o.qty,
      priceCents: 1400,
      costCents: o.cost === undefined ? 700 : o.cost,
      createdAt: at(200),
    },
  });
}
let saleNo = 0;
async function sale(shopId: string, partId: string, qty: number, ago: number) {
  saleNo += 1;
  await db.sale.create({
    data: {
      shopId,
      number: saleNo,
      subtotalCents: Math.round(qty * 1400),
      taxCents: 0,
      totalCents: Math.round(qty * 1400),
      taxRatePct: 0,
      createdAt: at(ago),
      lines: { create: { partId, description: "Fabric", qty, unit: "yd", unitPriceCents: 1400, costCents: 700, taxable: true } },
    },
  });
  await db.stockMove.create({ data: { shopId, partId, qty: -qty, reason: "SOLD", createdAt: at(ago) } });
}
/** One sale in each of the last 12 weeks (3 days into each week's window), `qty(j)` yards in week j (0 = this week). */
async function weekly(shopId: string, partId: string, qty: (j: number) => number) {
  await db.stockMove.create({ data: { shopId, partId, qty: 100, reason: "RECEIVED", createdAt: at(200) } });
  for (let j = 0; j < 12; j++) await sale(shopId, partId, qty(j), 7 * j + 3);
}

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    // 1. The math, by hand.
    // sigma: 2, 4, 4, 4, 5, 5, 7, 9 has mean 5 and population standard deviation 2.
    near(weeklySigma([2, 4, 4, 4, 5, 5, 7, 9]), 2, "sigma");
    assert.equal(weeklySigma([5]), 0);
    // 4 yd a week, sigma 2, 2 weeks lead + 2 review, z 1.28, 10 on hand: safety = 1.28 x 2 x sqrt(2) = 3.62039,
    // target = 4 x 4 + 3.62039 = 19.62039, need = 9.62039 = 1.28 half bolts -> 1 half bolt = 7.5 yd.
    const base = { perWeek: 4, sigmaWeek: 2, leadWeeks: 2, reviewWeeks: 2, z: 1.28, onHand: 10, onOrder: 0, boltYards: 15 };
    let m = reorderMath(base);
    near(m.safety, 1.28 * 2 * Math.SQRT2, "safety");
    near(m.target, 16 + 1.28 * 2 * Math.SQRT2, "target");
    near(m.need, 6 + 1.28 * 2 * Math.SQRT2 + 0 + 0 - 0, "need", 1e-9);
    assert.deepEqual([m.halves, m.yards], [1, 7.5]);
    // Nothing on hand: need 19.62 = 2.62 half bolts -> 3 = 22.5 yd (1.5 bolts).
    m = reorderMath({ ...base, onHand: 0 });
    assert.deepEqual([m.halves, m.yards], [3, 22.5]);
    // On order counts: nothing on hand and 15 yd on order leaves a need of 4.62 = 0.62 half bolts -> 1.
    assert.equal(reorderMath({ ...base, onHand: 0, onOrder: 15 }).halves, 1);
    assert.equal(reorderMath({ ...base, onHand: 0, onOrder: 18.5 }).halves, 0, "need 1.12 yd is under a quarter of a half bolt (1.875): not worth an order");
    // Exact: 10 a week, no variation, 3 + 2 weeks = 50, have 5, 15 on order -> 30 = 4 half bolts = 30 yd exactly.
    m = reorderMath({ perWeek: 10, sigmaWeek: 0, leadWeeks: 3, reviewWeeks: 2, z: 1.65, onHand: 5, onOrder: 15, boltYards: 15 });
    assert.deepEqual([m.need, m.halves, m.yards], [30, 4, 30]);
    // Staple z 1.65, sigma 3, 4 weeks lead: safety = 1.65 x 3 x 2 = 9.9.
    near(reorderMath({ perWeek: 1, sigmaWeek: 3, leadWeeks: 4, reviewWeeks: 2, z: 1.65, onHand: 0, onOrder: 0, boltYards: 15 }).safety, 9.9, "staple safety");
    // Under half a yard a week: one half bolt at most, however big the need.
    assert.equal(reorderMath({ perWeek: 0.4, sigmaWeek: 6, leadWeeks: 8, reviewWeeks: 2, z: 1.65, onHand: 0, onOrder: 0, boltYards: 15 }).halves, 1);
    // A 10 yd bolt rounds to 5 yd halves; a 10.125 yd bolt's half stays in eighths.
    assert.equal(reorderMath({ ...base, onHand: 0, boltYards: 10 }).yards, 20);
    assert.equal(reorderMath({ ...base, onHand: 0, boltYards: 10.125 }).yards, Math.round(4 * 5.0625 * 8) / 8);
    ok("reorder math: safety 1.28 x 2 x sqrt 2, target 19.62, half-bolt rounding (7.5 / 22.5 yd), on order, the quarter-half-bolt floor, 30 yd exact, staple 9.9, slow sellers capped at one half bolt");

    // Lead time: learned once there is a record; the average remembers three.
    assert.deepEqual(leadDaysOf(null, 14), { days: 14, from: "shop" });
    assert.deepEqual(leadDaysOf({ leadDays: 9, learnedDays: null, learnedOrders: 0 }, 14), { days: 9, from: "supplier" });
    assert.deepEqual(leadDaysOf({ leadDays: 9, learnedDays: 12, learnedOrders: 2 }, 14), { days: 12, from: "learned" });
    let lead = learnLead({ leadDays: null, learnedDays: null, learnedOrders: 0 }, 12);
    assert.deepEqual(lead, { learnedDays: 12, learnedOrders: 1 });
    lead = learnLead({ leadDays: null, ...lead }, 20); // (12 + 20) / 2
    assert.deepEqual(lead, { learnedDays: 16, learnedOrders: 2 });
    lead = learnLead({ leadDays: null, ...lead }, 8); // (16 x 2 + 8) / 3 = 13.33
    assert.deepEqual(lead, { learnedDays: 13, learnedOrders: 3 });
    lead = learnLead({ leadDays: null, ...lead }, 30); // (13 x 3 + 30) / 4 = 17.25
    assert.deepEqual(lead, { learnedDays: 17, learnedOrders: 4 });
    lead = learnLead({ leadDays: null, ...lead }, 13); // memory stays 3: (17 x 3 + 13) / 4 = 16
    assert.deepEqual(lead, { learnedDays: 16, learnedOrders: 5 });
    assert.equal(learnLead({ leadDays: null, learnedDays: 5, learnedOrders: 1 }, 0).learnedDays, 3, "same-day delivery counts as 1 day: (5 + 1) / 2");
    ok("lead time: shop default, supplier figure, learned 12 then 16, 13, 17, 16 (the average remembers three)");

    // Reorder now: 60% of the window's stock sold and the weeks of supply under lead + 2.
    const u = (sold: number, lot: number, weeks: number | null, leadWeeks: number) => isUrgent({ sold, lot, weeks, leadWeeks }, ORDER_DEFAULTS);
    assert.equal(u(9, 15, 3.9, 2), true);
    assert.equal(u(9, 15, 4, 2), false, "weeks of supply must be under lead + 2");
    assert.equal(u(8.85, 15, 1, 2), false, "59% is not 60%");
    assert.equal(u(0.75, 1, 0.5, 2), false, "under a yard sold is not a best seller");
    assert.equal(u(9, 15, null, 2), false);
    ok("Reorder now: 60% sold and weeks under lead + 2 (9 of 15 at 3.9 weeks yes, at 4.0 no, 59% no, under a yard no)");

    // Order lines.
    const bolts = { unit: "BOLT" as const, qty: 1.5, boltYards: 15, costCents: 700, receivedYards: 10 };
    assert.equal(lineYards(bolts), 22.5);
    assert.equal(outstandingYards(bolts), 12.5);
    assert.equal(lineCostTotal(bolts), 15750);
    assert.equal(outstandingYards({ ...bolts, receivedYards: 30 }), 0, "an over-delivery leaves nothing outstanding");
    assert.equal(lineCostTotal({ unit: "YD", qty: 2.125, boltYards: 15, costCents: 1399, receivedYards: 0 }), Math.round(2.125 * 1399));
    assert.equal(orderTotal([bolts, { unit: "YD", qty: 2, boltYards: 15, costCents: null, receivedYards: 0 }]), 15750, "a line with no cost adds nothing");
    assert.equal(statusAfterReceive([{ ...bolts, receivedYards: 22.5 }]), "RECEIVED");
    assert.equal(statusAfterReceive([{ ...bolts, receivedYards: 22.5 }, bolts]), "PARTLY_RECEIVED");
    ok("order lines: 1.5 bolts = 22.5 yd, 12.5 outstanding, $157.50, over-delivery leaves none, status after a receipt");

    // 2. The Reorder tab on real rows.
    const r1 = await fab(a.shopId, "REO-1", { qty: 10 });
    await weekly(a.shopId, r1.id, () => 4);
    const r4 = await fab(a.shopId, "REO-4", { qty: 2, collection: null, supplier: "moda wholesale" });
    await weekly(a.shopId, r4.id, (j) => (j % 2 === 0 ? 2 : 6));
    const r2 = await fab(a.shopId, "REO-2", { qty: 10, inPrint: "NO" });
    await weekly(a.shopId, r2.id, () => 4);
    const r3 = await fab(a.shopId, "REO-3", { qty: 10, supplier: null });
    await weekly(a.shopId, r3.id, () => 4);
    const rare = await fab(a.shopId, "REO-5", { qty: 50 });
    await weekly(a.shopId, rare.id, () => 1);
    let v = await reorderFor(a.shopId);
    const row = (n: string) => v.rows.find((r) => r.item.partNumber === n);
    const x1 = row("REO-1")!;
    near(x1.item.perWeek, 4, "REO-1 rate");
    near(x1.item.sigmaWeek, 0, "REO-1 sigma");
    assert.equal(x1.lead.days, 14);
    assert.equal(x1.lead.from, "shop");
    assert.equal(x1.staple, false);
    // target 4 x (2 + 2) = 16, have 10, need 6 -> 0.8 half bolts -> 1 half bolt = 7.5 yd.
    assert.deepEqual([x1.math.need, x1.math.halves, x1.math.yards], [6, 1, 7.5]);
    // Reorder now: 16 sold in 28 days of 26 (10 on hand + 16 sold) = 62%, weeks of supply 2.5 under 2 + 2.
    near(x1.item.urgentSold, 16, "sold in 28 days");
    near(x1.item.urgentLot, 26, "stock of the window");
    assert.equal(x1.urgent, true);
    assert.equal(x1.soldPct, 62);
    const x4 = row("REO-4")!;
    near(x4.item.perWeek, 4, "REO-4 rate");
    near(x4.item.sigmaWeek, 2, "REO-4 sigma (2 and 6 alternating)");
    assert.equal(x4.staple, true);
    assert.equal(x4.z, 1.65);
    // safety 1.65 x 2 x sqrt 2 = 4.6669, target 20.6669, have 2: need 18.6669 = 2.49 half bolts -> 2 = 15 yd. The supplier's
    // text differs only in capitals, so it is the same supplier.
    near(x4.math.safety, 1.65 * 2 * Math.SQRT2, "REO-4 safety");
    assert.deepEqual([x4.math.halves, x4.math.yards], [2, 15]);
    assert.equal(x4.item.sigmaWeek > 0 && x1.item.sigmaWeek === 0, true);
    assert.equal(row("REO-2"), undefined, "closed out (not in print): never suggested");
    const x3 = row("REO-3")!;
    assert.equal(x3.supplier, null);
    assert.equal(v.noSupplier, 1);
    assert.equal(row("REO-5"), undefined, "50 yd of 1 yd a week: nothing to order");
    assert.deepEqual(v.rows.map((r) => r.item.partNumber), ["REO-4", "REO-1", "REO-3"], "Reorder now rows first, fewest weeks of supply first (REO-4 has 0.5, REO-1 and REO-3 2.5)");
    ok("Reorder tab: REO-1 needs 6 yd -> 7.5 yd and is Reorder now (62% of 26 yd in 28 days, 2.5 weeks); REO-4 staple z 1.65 sigma 2 -> 15 yd; closed-out fabric and slow stock are left out; no supplier is counted");

    // Settings change the numbers: a 28 day supplier lead time (4 weeks): target 4 x 6 = 24, need 14 = 1.87 -> 2 half bolts = 15 yd.
    await saveSupplierFor(user(a), fd({ name: "Moda Wholesale", leadDays: "28", minOrder: "250", orderEmail: "orders@moda.test" }));
    v = await reorderFor(a.shopId);
    const y1 = row("REO-1")!;
    assert.deepEqual([y1.lead.days, y1.lead.from, y1.math.halves, y1.math.yards], [28, "supplier", 2, 15]);
    await db.shop.update({ where: { id: a.shopId }, data: { fabReviewWeeks: 1 } });
    v = await reorderFor(a.shopId);
    // target 4 x 5 = 20, need 10 = 1.33 -> 1 half bolt.
    assert.equal(row("REO-1")!.math.halves, 1);
    await db.shop.update({ where: { id: a.shopId }, data: { fabReviewWeeks: 2 } });
    await expectError("lead blank is fine, 0 is not", () => saveSupplierFor(user(a), fd({ name: "Moda Wholesale", leadDays: "0" })), /Lead time/);
    await expectError("bad email", () => saveSupplierFor(user(a), fd({ name: "Moda Wholesale", orderEmail: "not an email" })), /order email/);
    await expectError("no name", () => saveSupplierFor(user(a), fd({ leadDays: "5" })), /Which supplier/);
    const sup = await suppliersFor(a.shopId);
    const moda = sup.find((s) => s.name === "Moda Wholesale")!;
    assert.deepEqual([moda.leadDays, moda.minOrderCents, moda.orderEmail, moda.fabrics], [28, 25000, "orders@moda.test", 4]);
    assert.equal(sup.filter((s) => s.name.toLowerCase() === "moda wholesale").length, 1, "one supplier whatever the capitals");
    ok("supplier figures: lead 28 days -> 15 yd, the review period moves the suggestion, bad input is refused, one supplier whatever the capitals");

    // 3. Draft orders from ticked rows.
    await expectError("no supplier", () => addToDraftFor(user(a), [{ partId: r3.id, bolts: 1 }]), /Give REO-3 a supplier/);
    await expectError("quarter bolts", () => addToDraftFor(user(a), [{ partId: r1.id, bolts: 0.25 }]), /halves/);
    const text = await addToDraftFor(user(a), [{ partId: r1.id, bolts: 1 }, { partId: r4.id, bolts: 1.5 }]);
    assert.match(text, /order #1 \(Moda Wholesale, 2 lines\)/);
    let po1 = (await db.purchaseOrder.findFirstOrThrow({ where: { shopId: a.shopId, number: 1 }, include: { lines: true } }));
    assert.equal(po1.status, "DRAFT");
    assert.equal(po1.lines.length, 2);
    const l1 = po1.lines.find((l) => l.partId === r1.id)!;
    assert.deepEqual([l1.unit, l1.qty, l1.boltYards, l1.costCents, l1.itemNumber], ["BOLT", 1, 15, 700, "REO-1"]);
    // The same fabric again sets the amount; it is not doubled. A draft is not "on order" but is shown.
    await addToDraftFor(user(a), [{ partId: r1.id, bolts: 2 }]);
    po1 = await db.purchaseOrder.findFirstOrThrow({ where: { shopId: a.shopId, number: 1 }, include: { lines: true } });
    assert.equal(po1.lines.length, 2);
    assert.equal(po1.lines.find((l) => l.partId === r1.id)!.qty, 2);
    assert.equal((await db.purchaseOrder.count({ where: { shopId: a.shopId } })), 1, "one draft per supplier");
    const oo = await onOrderFor(a.shopId);
    assert.deepEqual(oo.get(r1.id), { open: 0, draft: 30 });
    v = await reorderFor(a.shopId);
    assert.equal(row("REO-1")!.inDraft, 30);
    assert.ok(row("REO-1"), "a draft doesn't reduce the suggestion");
    ok("ticked rows: one draft per supplier (any capitals), the same fabric sets its line (not doubled), quarter bolts and no-supplier refused, drafts shown but not counted as on order");

    // By hand: another supplier, add lines by number, refusals.
    const poId2 = await createOrderFor(user(a), "Other Fabrics Co");
    const notion = await db.part.create({ data: { shopId: a.shopId, partNumber: "THR-1", numberKeys: ["THR1"], description: "Thread", kind: "NOTION", qtyOnHand: 5 } });
    await expectError("unknown number", () => addLineFor(user(a), poId2, fd({ itemNumber: "NOPE-9", qty: "1", unit: "BOLT" })), /No item numbered NOPE-9/);
    await expectError("an item sold each comes in whole pieces", () => addLineFor(user(a), poId2, fd({ itemNumber: notion.partNumber, qty: "1.5", unit: "YD" })), /whole number of pieces/);
    await expectError("eighths", () => addLineFor(user(a), poId2, fd({ itemNumber: "REO-2", qty: "2.1", unit: "YD" })), /eighths/);
    await expectError("halves", () => addLineFor(user(a), poId2, fd({ itemNumber: "REO-2", qty: "1.3", unit: "BOLT" })), /halves/);
    await expectError("zero", () => addLineFor(user(a), poId2, fd({ itemNumber: "REO-2", qty: "0", unit: "YD" })), /over 0/);
    await addLineFor(user(a), poId2, fd({ itemNumber: "reo-2 | Batik REO-2", qty: "12.5", unit: "YD", cost: "6.25" }));
    await expectError("duplicate line", () => addLineFor(user(a), poId2, fd({ itemNumber: "REO-2", qty: "1", unit: "YD" })), /already on this order/);
    let o2 = (await orderFor(a.shopId, poId2))!;
    assert.deepEqual([o2.number, o2.lines.length, o2.lines[0].unit, o2.lines[0].qty, o2.lines[0].costCents, o2.totalCents, o2.totalYards], [2, 1, "YD", 12.5, 625, 7813, 12.5]);
    assert.equal(o2.supplier.lead.days, 14);
    await expectError("send an empty order", async () => sendOrderFor(user(a), await createOrderFor(user(a), "Empty Co")), /at least one line/);
    // Save: amount, unit, cost, remove, note.
    const lineId = o2.lines[0].id;
    await saveOrderFor(user(a), poId2, fd({ [`qty.${lineId}`]: "1", [`unit.${lineId}`]: "BOLT", [`cost.${lineId}`]: "6.50", note: "Ship with the March order" }));
    o2 = (await orderFor(a.shopId, poId2))!;
    assert.deepEqual([o2.lines[0].unit, o2.lines[0].qty, o2.lines[0].costCents, o2.note, o2.totalYards, o2.totalCents], ["BOLT", 1, 650, "Ship with the March order", 15, 9750]);
    await expectError("bad amount on save", () => saveOrderFor(user(a), poId2, fd({ [`qty.${lineId}`]: "abc", [`unit.${lineId}`]: "BOLT" })), /over 0/);
    await saveOrderFor(user(a), poId2, fd({ [`qty.${lineId}`]: "1", [`unit.${lineId}`]: "BOLT", [`remove.${lineId}`]: "on" }));
    assert.equal((await orderFor(a.shopId, poId2))!.lines.length, 0);
    ok("by hand: lines by number (case and the 'number | words' suggestion), refusals (unknown, not by the yard, eighths, halves, zero, duplicate, empty send), save changes amount, unit, cost, note and removes");

    // 4. Send: from draft only; then nothing edits; email, CSV, print text.
    await addLineFor(user(a), poId2, fd({ itemNumber: "REO-2", qty: "2.5", unit: "BOLT" }));
    o2 = (await orderFor(a.shopId, poId2))!;
    assert.equal(o2.lines[0].costCents, 700, "the line takes the fabric's own cost when none is typed");
    assert.match(await sendOrderFor(user(a), poId2), /marked sent/);
    await expectError("send twice", () => sendOrderFor(user(a), poId2), /already sent/);
    await expectError("edit after send", () => saveOrderFor(user(a), poId2, fd({})), /isn't a draft/);
    await expectError("add after send", () => addLineFor(user(a), poId2, fd({ itemNumber: "REO-1", qty: "1", unit: "BOLT" })), /isn't a draft/);
    o2 = (await orderFor(a.shopId, poId2))!;
    assert.equal(o2.status, "SENT");
    assert.ok(o2.sentAt);
    const csv = orderCsvRows(o2);
    assert.deepEqual(csv[0], ["item_number", "description", "quantity", "unit", "yards", "cost_per_yard", "line_total"]);
    assert.deepEqual(csv[1], ["REO-2", "Batik REO-2", 2.5, "bolt", 37.5, "7.00", "262.50"]);
    assert.match(orderText(o2), /REO-2  Batik REO-2  2\.5 bolts \(37 1\/2 yd\)  @ \$7\.00\/yd/);
    const mail = mailtoFor(o2);
    assert.ok(mail.startsWith("mailto:?subject=") && mail.includes("body="), "no address on file: an empty to");
    assert.equal((await onOrderFor(a.shopId)).get(r2.id)?.open, 37.5, "a sent order counts as on order");
    ok("send: draft only, once, then locked; the CSV, the email text and the mailto read right; sent yards count as on order");

    // 5. On order counts in the reorder math and keeps a fabric off Bolt ends.
    const be = await fab(a.shopId, "BE-1", { qty: 0.75, supplier: "Other Fabrics Co" });
    assert.ok((await boltEndsFor(a.shopId)).rows.some((r) => r.id === be.id), "a bolt end with nothing coming is listed");
    const poBe = await createOrderFor(user(a), "Other Fabrics Co");
    await addLineFor(user(a), poBe, fd({ itemNumber: "BE-1", qty: "1", unit: "BOLT" }));
    assert.ok((await boltEndsFor(a.shopId)).rows.some((r) => r.id === be.id), "on a draft only: still a bolt end");
    await sendOrderFor(user(a), poBe);
    assert.ok(!(await boltEndsFor(a.shopId)).rows.some((r) => r.id === be.id), "yards coming on a sent order: not a bolt end");
    // REO-1: a sent order of 1 bolt (15 yd) against need 6 leaves nothing to order.
    const poR1 = await createOrderFor(user(a), "Moda Wholesale");
    await addLineFor(user(a), poR1, fd({ itemNumber: "REO-1", qty: "1", unit: "BOLT" }));
    await sendOrderFor(user(a), poR1);
    v = await reorderFor(a.shopId);
    assert.equal(row("REO-1"), undefined, "15 yd on order covers the need");
    assert.equal((await onOrderFor(a.shopId)).get(r1.id)?.open, 15);
    await cancelOrderFor(user(a), poR1);
    await cancelOrderFor(user(a), poBe);
    v = await reorderFor(a.shopId);
    assert.ok(row("REO-1"), "cancelled: back on the tab");
    assert.ok((await boltEndsFor(a.shopId)).rows.some((r) => r.id === be.id), "cancelled: a bolt end again");
    await expectError("cancel twice", () => cancelOrderFor(user(a), poR1), /already cancelled/);
    ok("on order: a sent order's outstanding yards cut the reorder suggestion and hide the bolt end; cancelling brings both back");

    // 6. Receive: moves, partly received, lead time learned once, close, refusals.
    await db.part.update({ where: { id: r2.id }, data: { costCents: null } });
    const before2 = (await db.part.findUniqueOrThrow({ where: { id: r2.id } })).qtyOnHand;
    await db.purchaseOrder.update({ where: { id: poId2 }, data: { sentAt: at(10) } });
    const lines2 = (await orderFor(a.shopId, poId2))!.lines;
    await expectError("receive nothing", () => receiveOrderFor(user(a), poId2, fd({})), /at least one line/);
    await expectError("eighths", () => receiveOrderFor(user(a), poId2, fd({ [`yards.${lines2[0].id}`]: "5.1" })), /eighths/);
    await expectError("draft receive", async () => receiveOrderFor(user(a), await createOrderFor(user(a), "Moda Wholesale"), fd({})), /hasn't been sent/);
    const msg = await receiveOrderFor(user(a), poId2, fd({ [`yards.${lines2[0].id}`]: "30" }));
    assert.match(msg, /Received 30 yd on 1 line of order #2/);
    assert.match(msg, /Other Fabrics Co's lead time is now 10 days \(this one took 10\)/);
    const after = await db.part.findUniqueOrThrow({ where: { id: r2.id } });
    assert.equal(after.qtyOnHand, before2 + 30);
    assert.equal(after.costCents, 700, "a fabric with no cost takes the line's cost");
    const mv = await db.stockMove.findFirstOrThrow({ where: { shopId: a.shopId, partId: r2.id, reason: "RECEIVED", note: { startsWith: "Order #2" } } });
    assert.deepEqual([mv.qty, mv.note, mv.userId], [30, "Order #2 from Other Fabrics Co", a.user.id]);
    o2 = (await orderFor(a.shopId, poId2))!;
    assert.deepEqual([o2.status, o2.lines[0].receivedYards, outstandingYards(o2.lines[0])], ["PARTLY_RECEIVED", 30, 7.5]);
    let s2 = await db.fabricSupplier.findFirstOrThrow({ where: { shopId: a.shopId, name: "Other Fabrics Co" } });
    assert.deepEqual([s2.learnedDays, s2.learnedOrders], [10, 1]);
    assert.equal((await onOrderFor(a.shopId)).get(r2.id)?.open, 7.5);
    // The rest: received; the lead time is not learned a second time.
    assert.match(await receiveOrderFor(user(a), poId2, fd({ [`yards.${lines2[0].id}`]: "7.5" })), /all in/);
    o2 = (await orderFor(a.shopId, poId2))!;
    assert.equal(o2.status, "RECEIVED");
    assert.ok(o2.receivedAt && o2.firstReceivedAt);
    s2 = await db.fabricSupplier.findFirstOrThrow({ where: { id: s2.id } });
    assert.deepEqual([s2.learnedDays, s2.learnedOrders], [10, 1], "learned from the first delivery only");
    await expectError("receive a received order", () => receiveOrderFor(user(a), poId2, fd({ [`yards.${lines2[0].id}`]: "1" })), /already received/);
    await expectError("cancel a received order", () => cancelOrderFor(user(a), poId2), /already received/);
    assert.equal((await onOrderFor(a.shopId)).get(r2.id), undefined);
    ok("receive: 30 of 37.5 yd -> partly received, a RECEIVED move naming the order, cost filled in, lead time learned (10 days) once; the rest -> received; nothing more can be received or cancelled");

    // A second order teaches again: lead 20 days -> (10 + 20) / 2 = 15; the reorder tab then uses 15 days.
    const poL = await createOrderFor(user(a), "Other Fabrics Co");
    await addLineFor(user(a), poL, fd({ itemNumber: "BE-1", qty: "1", unit: "BOLT" }));
    await sendOrderFor(user(a), poL);
    await db.purchaseOrder.update({ where: { id: poL }, data: { sentAt: at(20) } });
    const lL = (await orderFor(a.shopId, poL))!.lines[0];
    await receiveOrderFor(user(a), poL, fd({ [`yards.${lL.id}`]: "5" }));
    s2 = await db.fabricSupplier.findFirstOrThrow({ where: { id: s2.id } });
    assert.deepEqual([s2.learnedDays, s2.learnedOrders], [15, 2]);
    assert.deepEqual((await suppliersFor(a.shopId)).find((s) => s.name === "Other Fabrics Co")!.lead, { days: 15, from: "learned" });
    await expectError("cancel a partly received order", () => cancelOrderFor(user(a), poL), /Close order/);
    assert.match(await closeOrderFor(user(a), poL), /is closed/);
    assert.equal((await orderFor(a.shopId, poL))!.status, "RECEIVED");
    await expectError("close a closed order", () => closeOrderFor(user(a), poL), /isn't partly received/);
    assert.equal((await onOrderFor(a.shopId)).get(be.id), undefined, "closed: the rest isn't on order");
    // A supplier with a lead time of its own is overridden by a learned one.
    await saveSupplierFor(user(a), fd({ name: "Other Fabrics Co", leadDays: "3" }));
    assert.equal((await suppliersFor(a.shopId)).find((s) => s.name === "Other Fabrics Co")!.lead.days, 15, "learned beats the typed figure once there is a record");
    ok("lead time: a second delivery (20 days) moves the learned figure to 15; partly received orders are closed, not cancelled; a closed order's rest isn't on order");

    // 7. Orders list.
    const list = await ordersListFor(a.shopId);
    assert.ok(list.length >= 6);
    const firstDone = list.findIndex((r) => r.status === "RECEIVED" || r.status === "CANCELLED");
    assert.ok(list.slice(0, firstDone).every((r) => r.status === "DRAFT" || r.status === "SENT" || r.status === "PARTLY_RECEIVED"), "open orders first");
    assert.equal(new Set(list.map((r) => r.number)).size, list.length, "order numbers are unique");
    ok("orders list: open first, numbers unique");

    // 8. Tenant: B with A's ids.
    const tables = ["Part", "StockMove", "FabricSupplier", "PurchaseOrder", "PurchaseOrderLine", "Shop"];
    const snap = await snapshot(a.shopId, tables);
    const aOrder = (await db.purchaseOrder.findFirstOrThrow({ where: { shopId: a.shopId, status: "DRAFT", lines: { some: {} } }, orderBy: { number: "asc" }, include: { lines: true } }));
    const aLine = aOrder.lines[0];
    assert.equal(await orderFor(b.shopId, aOrder.id), null, "B can't open A's order");
    await expectNotFound("sendOrderFor(B)", () => sendOrderFor(user(b), aOrder.id));
    await expectNotFound("cancelOrderFor(B)", () => cancelOrderFor(user(b), aOrder.id));
    await expectNotFound("closeOrderFor(B)", () => closeOrderFor(user(b), aOrder.id));
    await expectNotFound("receiveOrderFor(B)", () => receiveOrderFor(user(b), aOrder.id, fd({ [`yards.${aLine.id}`]: "5" })));
    await expectNotFound("saveOrderFor(B)", () => saveOrderFor(user(b), aOrder.id, fd({ [`remove.${aLine.id}`]: "on" })));
    await expectNotFound("addLineFor(B, A's order)", () => addLineFor(user(b), aOrder.id, fd({ itemNumber: "REO-1", qty: "1", unit: "YD" })));
    await expectNotFound("addToDraftFor(B, A's fabric)", () => addToDraftFor(user(b), [{ partId: r1.id, bolts: 1 }]));
    assert.equal((await reorderFor(b.shopId)).rows.length, 0);
    assert.equal((await suppliersFor(b.shopId)).length, 0);
    assert.equal((await onOrderFor(b.shopId)).size, 0);
    assert.equal((await ordersListFor(b.shopId)).length, 0);
    assert.equal((await boltEndsFor(b.shopId)).rows.length, 0);
    assertUnchanged("tenant", snap, await snapshot(a.shopId, tables));
    // B's own "Moda Wholesale" is a different supplier with its own figures.
    await saveSupplierFor(user(b), fd({ name: "Moda Wholesale", leadDays: "5" }));
    assert.equal((await db.fabricSupplier.findFirstOrThrow({ where: { shopId: a.shopId, name: "Moda Wholesale" } })).leadDays, 28);
    assert.equal((await db.fabricSupplier.findFirstOrThrow({ where: { shopId: b.shopId, name: "Moda Wholesale" } })).leadDays, 5);
    ok("tenant: B can't open, send, cancel, close, receive, edit or add to A's order, or order A's fabric; B sees no suggestions, suppliers or orders of A's; A's rows are unchanged; same supplier name, separate records");
  } finally {
    await cleanup();
  }
  console.log(`fabric-orders.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
