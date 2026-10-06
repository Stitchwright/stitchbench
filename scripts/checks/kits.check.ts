// Kits (fabric-smarts-design.md, package F4): cost and price suggestion on hand-computed examples, the builder's refusals,
// Make N kits (stock checks, CUT and USED moves linked to the kit, all or none), Unmake 1, the Kits tab's sold counts,
// Block of the Month (months, handouts, roster) and the tenant section.
//   npm run check scripts/checks/kits.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import {
  addMemberFor,
  createSeriesFor,
  deleteKitFor,
  deleteSeriesFor,
  kitFor,
  kitsFor,
  linkKitFor,
  makeKitsFor,
  removeMemberFor,
  saveKitFor,
  seriesFor,
  seriesListFor,
  setHandoutFor,
  unmakeKitFor,
} from "@/lib/kits";
import { KIT_DEFAULTS, kitMarginPct, kitQtyProblem, makeableKits, partsCost, partsRetail, shortages, suggestKitPrice } from "@/lib/kits-math";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;

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

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
/** The builder's form: lines as [item, qty] pairs. */
const form = (o: { name: string; lines: [string, string][]; pattern?: string; patternNote?: string; patternCost?: string; price?: string; note?: string }) => {
  const f = fd({ name: o.name, pattern: o.pattern ?? "", patternNote: o.patternNote ?? "", patternCost: o.patternCost ?? "", price: o.price ?? "", note: o.note ?? "" });
  o.lines.forEach(([item, qty], i) => {
    f.set(`item.${i}`, item);
    f.set(`qty.${i}`, qty);
  });
  return f;
};

async function part(shopId: string, number: string, o: { kind: "FABRIC" | "NOTION" | "PATTERN"; unit: "yd" | null; qty: number; cost: number | null; price: number | null }) {
  return db.part.create({
    data: { shopId, partNumber: number, numberKeys: [number.replace(/[^A-Z0-9]/gi, "").toUpperCase()], description: `Item ${number}`, kind: o.kind, unit: o.unit, qtyOnHand: o.qty, costCents: o.cost, priceCents: o.price },
  });
}

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    // 1. The math, by hand.
    // Parts: 2.5 yd at $7.00 cost / $14.00 price, 3 yd at $5.50 / $12.00, 2 thread at $1.25 / $3.99, a pattern at $3.00 / $10.00.
    const parts = [
      { qty: 2.5, costCents: 700, priceCents: 1400 },
      { qty: 3, costCents: 550, priceCents: 1200 },
      { qty: 2, costCents: 125, priceCents: 399 },
      { qty: 1, costCents: 300, priceCents: 1000 },
    ];
    assert.equal(partsCost(parts), 1750 + 1650 + 250 + 300);
    assert.equal(partsRetail(parts), 3500 + 3600 + 798 + 1000);
    // cost 3950, retail 8898: by margin 3950 / 0.5 = 7900; by bundle 8898 x 0.95 = 8453.1 -> 8453; the larger is the bundle price.
    let p = suggestKitPrice({ costCents: 3950, retailCents: 8898, marginPct: 50, bundlePct: 5 });
    assert.deepEqual([p.byMargin, p.byBundle, p.priceCents, p.basis, p.marginPct], [7900, 8453, 8453, "bundle", 53.3]);
    // cost 4150 (a pattern note at $5.00), retail 7898: by margin 8300; by bundle 7898 x 0.95 = 7503.1 -> 7503: the margin price.
    p = suggestKitPrice({ costCents: 4150, retailCents: 7898, marginPct: 50, bundlePct: 5 });
    assert.deepEqual([p.byMargin, p.byBundle, p.priceCents, p.basis, p.marginPct], [8300, 7503, 8300, "margin", 50]);
    // No bundle discount, 40% margin target: 3000 / 0.6 = 5000.
    assert.equal(suggestKitPrice({ costCents: 3000, retailCents: 4000, marginPct: 40, bundlePct: 0 }).priceCents, 5000);
    assert.equal(kitMarginPct(0, 100), null);
    assert.equal(kitMarginPct(1000, 667), 33.3);
    // A cost finer than a cent counts: 1000 buttons at $0.004 (40 ten-thousandths) cost $4.00 for the lot.
    assert.equal(partsCost([{ qty: 1000, costCents: 0, costTenThou: 40, priceCents: null }]), 400);
    assert.equal(partsCost([{ qty: 3, costCents: null, priceCents: 100 }]), 0, "no cost adds nothing");
    // How many the stock covers: 20 / 2.5 = 8, 10 / 3 = 3.33 -> 3, 5 / 2 = 2.5 -> 2, 4 / 1 = 4: two.
    assert.equal(makeableKits([{ qty: 2.5, onHand: 20 }, { qty: 3, onHand: 10 }, { qty: 2, onHand: 5 }, { qty: 1, onHand: 4 }]), 2);
    assert.equal(makeableKits([{ qty: 2.5, onHand: 20 }, { qty: 3, onHand: 2.875 }]), 0);
    assert.equal(makeableKits([]), null);
    assert.deepEqual(shortages([{ partNumber: "A", qty: 2.5, onHand: 20, unit: "yd" }, { partNumber: "T", qty: 2, onHand: 5, unit: null }], 3), [{ partNumber: "T", need: 6, have: 5, unit: null }]);
    assert.equal(kitQtyProblem("yd", 2.3) != null, true);
    assert.equal(kitQtyProblem("yd", 2.375), null);
    assert.equal(kitQtyProblem(null, 1.5) != null, true);
    assert.equal(kitQtyProblem(null, 2), null);
    assert.equal(kitQtyProblem(null, 0) != null, true);
    ok("kit math: cost 3950, retail 8898, price max(7900, 8453) = 8453 (bundle, 53.3%); with a $5.00 pattern note max(8300, 7503) = 8300 (margin, 50%); makeable 2; fractions of a cent, shortages, quantity rules");

    // 2. The builder on real rows.
    const bt1 = await part(a.shopId, "BT-1", { kind: "FABRIC", unit: "yd", qty: 20, cost: 700, price: 1400 });
    const bt2 = await part(a.shopId, "BT-2", { kind: "FABRIC", unit: "yd", qty: 10, cost: 550, price: 1200 });
    const thr = await part(a.shopId, "THR-1", { kind: "NOTION", unit: null, qty: 5, cost: 125, price: 399 });
    const pat = await part(a.shopId, "PAT-1", { kind: "PATTERN", unit: null, qty: 4, cost: 300, price: 1000 });
    await part(a.shopId, "BT-3", { kind: "FABRIC", unit: "yd", qty: 50, cost: null, price: 900 });
    const lines: [string, string][] = [["BT-1", "2.5"], ["bt-2 | Item BT-2", "3"], ["THR-1", "2"]];
    await expectError("no name", () => saveKitFor(user(a), null, form({ name: "", lines })), /name/);
    await expectError("no lines", () => saveKitFor(user(a), null, form({ name: "Empty", lines: [] })), /at least one/);
    await expectError("unknown item", () => saveKitFor(user(a), null, form({ name: "X", lines: [["NOPE", "1"]] })), /No item numbered NOPE/);
    await expectError("eighths", () => saveKitFor(user(a), null, form({ name: "X", lines: [["BT-1", "2.3"]] })), /eighths/);
    await expectError("whole units", () => saveKitFor(user(a), null, form({ name: "X", lines: [["THR-1", "1.5"]] })), /whole units/);
    await expectError("zero", () => saveKitFor(user(a), null, form({ name: "X", lines: [["BT-1", "0"]] })), /over 0/);
    await expectError("twice", () => saveKitFor(user(a), null, form({ name: "X", lines: [["BT-1", "1"], ["bt1", "1"]] })), /twice/);
    await expectError("pattern kind", () => saveKitFor(user(a), null, form({ name: "X", lines, pattern: "BT-1" })), /isn't a pattern item/);
    await expectError("bad price", () => saveKitFor(user(a), null, form({ name: "X", lines, price: "abc" })), /Kit price/);
    assert.equal(await db.kit.count({ where: { shopId: a.shopId } }), 0, "refusals leave nothing behind");
    assert.equal(await db.part.count({ where: { shopId: a.shopId, kind: "ACCESSORY" } }), 0, "and no stock item");

    const saved = await saveKitFor(user(a), null, form({ name: "Bali Lap Quilt", lines, pattern: "PAT-1" }));
    assert.match(saved.text, /Made Bali Lap Quilt: cost \$39\.50, price \$84\.53 \(suggested\)/);
    let kit = (await kitFor(a.shopId, saved.id))!;
    assert.deepEqual([kit.cost, kit.retail, kit.priceCents, kit.suggestion.priceCents, kit.makeable, kit.patternCost], [3950, 8898, 8453, 8453, 2, 300]);
    assert.deepEqual(kit.lines.map((l) => [l.partNumber, l.qty, l.lineCost, l.lineRetail]), [["BT-1", 2.5, 1750, 3500], ["BT-2", 3, 1650, 3600], ["THR-1", 2, 250, 798]]);
    const stock = await db.part.findUniqueOrThrow({ where: { id: kit.stock!.partId } });
    assert.deepEqual([stock.partNumber, stock.kind, stock.ownNumber, stock.priceCents, stock.costCents, stock.qtyOnHand, stock.description, stock.unit], ["KIT-BALI-LAP-QUILT", "ACCESSORY", true, 8453, 3950, 0, "Bali Lap Quilt (kit)", null]);
    // A typed price stays; saving again keeps the same stock item and updates its price and cost.
    await saveKitFor(user(a), saved.id, form({ name: "Bali Lap Quilt", lines, pattern: "PAT-1", price: "99.00", note: "Includes binding" }));
    kit = (await kitFor(a.shopId, saved.id))!;
    assert.equal(kit.priceCents, 9900);
    assert.equal(kit.note, "Includes binding");
    assert.equal(kit.stock!.partId, stock.id, "the same stock item");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: stock.id } })).priceCents, 9900);
    assert.equal(await db.part.count({ where: { shopId: a.shopId, kind: "ACCESSORY" } }), 1);
    await expectError("same name", () => saveKitFor(user(a), null, form({ name: "bali lap QUILT", lines })), /already exists/);
    await expectError("the kit's own item as a part", () => saveKitFor(user(a), saved.id, form({ name: "Bali Lap Quilt", lines: [["KIT-BALI-LAP-QUILT", "1"]] })), /own stock item/);
    // A pattern note and cost instead of a pattern item: cost 1750 + 1650 + 250 + 500 = 4150, retail 7898, price 8300.
    const second = await saveKitFor(user(a), null, form({ name: "Bake Shop Throw", lines, patternNote: "Moda Bake Shop, personal use", patternCost: "5.00" }));
    const k2 = (await kitFor(a.shopId, second.id))!;
    assert.deepEqual([k2.cost, k2.retail, k2.priceCents, k2.suggestion.basis, k2.pattern, k2.patternNote], [4150, 7898, 8300, "margin", null, "Moda Bake Shop, personal use"]);
    // A fabric with no cost adds nothing to the cost (and the line says so).
    const k3 = await saveKitFor(user(a), null, form({ name: "Cheap One", lines: [["BT-3", "1"]] }));
    assert.equal((await kitFor(a.shopId, k3.id))!.cost, 0);
    ok("builder: refusals leave nothing behind; Bali Lap Quilt costs $39.50 and is priced $84.53 (suggested), a typed price stays, the stock item KIT-BALI-LAP-QUILT is made once and kept in step; a pattern note works; a missing cost counts as 0");

    // 3. Make N kits.
    await expectError("zero kits", () => makeKitsFor(user(a), saved.id, 0), /whole number/);
    await expectError("half kits", () => makeKitsFor(user(a), saved.id, 1.5), /whole number/);
    await expectError("too many", () => makeKitsFor(user(a), saved.id, 501), /at most/);
    // Three kits need 6 thread and only 5 are on the shelf: refused, naming it, and nothing moves.
    const movesBefore = await db.stockMove.count({ where: { shopId: a.shopId } });
    await expectError("short", () => makeKitsFor(user(a), saved.id, 3), /Not enough for 3 kits: THR-1 needs 6, has 5/);
    assert.equal(await db.stockMove.count({ where: { shopId: a.shopId } }), movesBefore, "a refusal records nothing");
    assert.deepEqual((await db.part.findMany({ where: { id: { in: [bt1.id, bt2.id, thr.id, pat.id] } }, orderBy: { partNumber: "asc" }, select: { qtyOnHand: true } })).map((x) => x.qtyOnHand), [20, 10, 4, 5]);
    const text = await makeKitsFor(user(a), saved.id, 2);
    assert.match(text, /Made 2 kits of Bali Lap Quilt, 11 yd of fabric cut\. 2 in stock\./);
    const qty = async (id: string) => (await db.part.findUniqueOrThrow({ where: { id } })).qtyOnHand;
    assert.deepEqual([await qty(bt1.id), await qty(bt2.id), await qty(thr.id), await qty(pat.id), await qty(stock.id)], [15, 4, 1, 2, 2]);
    const mv = await db.stockMove.findMany({ where: { shopId: a.shopId, note: "Made 2 kits: Bali Lap Quilt" }, orderBy: { qty: "asc" } });
    const by = (id: string) => mv.find((m) => m.partId === id)!;
    assert.deepEqual([by(bt1.id).qty, by(bt1.id).reason, by(bt1.id).otherPartId], [-5, "CUT", stock.id]);
    assert.deepEqual([by(bt2.id).qty, by(bt2.id).reason], [-6, "CUT"]);
    assert.deepEqual([by(thr.id).qty, by(thr.id).reason, by(thr.id).otherPartId], [-4, "USED", stock.id]);
    assert.deepEqual([by(pat.id).qty, by(pat.id).reason], [-2, "USED"], "the pattern comes out of stock, one a kit");
    assert.deepEqual([by(stock.id).qty, by(stock.id).reason, by(stock.id).userId, by(stock.id).otherPartId], [2, "RECEIVED", a.user.id, null]);
    assert.equal(mv.length, 5);
    kit = (await kitFor(a.shopId, saved.id))!;
    assert.equal(kit.makeable, 0, "the thread is down to 1, and a kit needs 2");
    // Costs change: the stock item's cost follows at the next make (BT-1 at $8.00: 2000 + 1650 + 250 + 300 = 4200).
    await db.part.update({ where: { id: bt1.id }, data: { costCents: 800 } });
    await db.part.update({ where: { id: thr.id }, data: { qtyOnHand: 10 } });
    await makeKitsFor(user(a), saved.id, 1);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: stock.id } })).costCents, 4200);
    assert.equal(await qty(stock.id), 3);
    ok("make: 3 kits refused (THR-1 needs 6, has 5) and nothing moves; 2 kits take 5 yd, 6 yd, 4 thread, 2 patterns with CUT and USED moves naming the kit and add 2 to its stock (RECEIVED); the kit's cost follows the parts");

    // 4. Unmake 1.
    const tIn = await db.stockMove.count({ where: { shopId: a.shopId } });
    assert.match(await unmakeKitFor(user(a), saved.id), /Unmade 1 Bali Lap Quilt: its parts are back on the shelf\. 2 left in stock\./);
    assert.deepEqual([await qty(bt1.id), await qty(bt2.id), await qty(thr.id), await qty(pat.id), await qty(stock.id)], [15 - 2.5 + 2.5, 4 - 3 + 3, 10 - 2 + 2, 2 - 1 + 1, 2]);
    const un = await db.stockMove.findMany({ where: { shopId: a.shopId, note: "Unmade 1 kit: Bali Lap Quilt" } });
    assert.equal(un.length, 5);
    assert.deepEqual([un.find((m) => m.partId === bt1.id)!.reason, un.find((m) => m.partId === bt1.id)!.qty, un.find((m) => m.partId === thr.id)!.reason, un.find((m) => m.partId === stock.id)!.qty], ["CUT", 2.5, "RETURNED", -1]);
    assert.equal(await db.stockMove.count({ where: { shopId: a.shopId } }), tIn + 5);
    // Sell what is left, then there is nothing to unmake.
    await db.part.update({ where: { id: stock.id }, data: { qtyOnHand: 0 } });
    await expectError("nothing to unmake", () => unmakeKitFor(user(a), saved.id), /No made Bali Lap Quilt is in stock/);
    ok("unmake 1: one kit off the stock, the parts back (CUT for fabric, RETURNED for the rest); refused when none is in stock");

    // 5. The Kits tab: stock, cost, price, margin, sold in 30 and 90 days.
    await db.part.update({ where: { id: stock.id }, data: { qtyOnHand: 4 } });
    const sellKit = async (n: number, qtySold: number, daysAgo: number, status: "COMPLETED" | "VOIDED" = "COMPLETED") =>
      db.sale.create({
        data: {
          shopId: a.shopId,
          number: n,
          status,
          subtotalCents: qtySold * 9900,
          taxCents: 0,
          totalCents: qtySold * 9900,
          taxRatePct: 0,
          createdAt: new Date(Date.now() - daysAgo * 86_400_000),
          lines: { create: { partId: stock.id, description: "Kit", qty: qtySold, unitPriceCents: 9900, taxable: true } },
        },
      });
    await sellKit(501, 1, 5);
    await sellKit(502, 2, 60);
    await sellKit(503, 5, 100);
    await sellKit(504, 7, 3, "VOIDED");
    const rows = await kitsFor(a.shopId);
    const r = rows.find((x) => x.id === saved.id)!;
    assert.deepEqual([r.stock, r.cost, r.priceCents, r.marginPct, r.sold30, r.sold90], [4, 4200, 9900, 57.6, 1, 3]);
    assert.deepEqual(rows.map((x) => x.name), ["Bake Shop Throw", "Bali Lap Quilt", "Cheap One"], "alphabetical");
    ok("Kits tab: stock 4, cost $42.00, price $99.00, margin 57.6%, sold 1 in 30 days and 3 in 90 (100 days ago and voided sales don't count)");

    // 6. Block of the Month.
    const sid = await createSeriesFor(user(a), fd({ name: "Block of the Month 2027", months: "3" }));
    await expectError("series twice", () => createSeriesFor(user(a), fd({ name: "block of the month 2027", months: "3" })), /already exists/);
    await expectError("months", () => createSeriesFor(user(a), fd({ name: "Long", months: "13" })), /2 to 12/);
    await expectError("month out of range", () => linkKitFor(user(a), sid, 4, saved.id), /Month: 1 to 3/);
    await linkKitFor(user(a), sid, 1, saved.id);
    await linkKitFor(user(a), sid, 2, second.id);
    let s = (await seriesFor(a.shopId, sid))!;
    assert.deepEqual(s.slots.map((x) => x.kit?.name ?? null), ["Bali Lap Quilt", "Bake Shop Throw", null]);
    // Month 1 given to the other kit: the first one leaves the series, and month 2 empties (the kit moved).
    await linkKitFor(user(a), sid, 1, second.id);
    s = (await seriesFor(a.shopId, sid))!;
    assert.deepEqual(s.slots.map((x) => x.kit?.name ?? null), ["Bake Shop Throw", null, null]);
    assert.equal((await kitFor(a.shopId, saved.id))!.series, null);
    await linkKitFor(user(a), sid, 2, saved.id);
    await linkKitFor(user(a), sid, 3, k3.id);
    await linkKitFor(user(a), sid, 3, null);
    s = (await seriesFor(a.shopId, sid))!;
    assert.deepEqual(s.slots.map((x) => x.kit?.name ?? null), ["Bake Shop Throw", "Bali Lap Quilt", null]);
    // Handouts.
    await expectError("handout of a loose kit", () => setHandoutFor(user(a), k3.id, true), /isn't a month/);
    assert.match(await setHandoutFor(user(a), second.id, true), /marked done/);
    s = (await seriesFor(a.shopId, sid))!;
    assert.ok(s.slots[0].kit!.handoutDoneAt);
    assert.equal(s.slots[1].kit!.handoutDoneAt, null);
    await setHandoutFor(user(a), second.id, false);
    assert.equal((await kitFor(a.shopId, second.id))!.handoutDoneAt, null);
    // A kit moved to another month starts with its handout not done.
    await setHandoutFor(user(a), second.id, true);
    await linkKitFor(user(a), sid, 3, second.id);
    assert.equal((await kitFor(a.shopId, second.id))!.handoutDoneAt, null);
    assert.equal((await kitFor(a.shopId, second.id))!.seriesMonth, 3);
    // The roster reuses the shop's customers.
    const pat1 = await db.customer.create({ data: { shopId: a.shopId, name: "Pat Quilter", phone: "555-0101", email: "pat@example.test" } });
    const lee = await db.customer.create({ data: { shopId: a.shopId, name: "Lee Sewer" } });
    assert.match(await addMemberFor(user(a), sid, pat1.id, "Prepaid"), /Pat Quilter is signed up/);
    await addMemberFor(user(a), sid, lee.id, null);
    await expectError("already signed up", () => addMemberFor(user(a), sid, pat1.id, null), /already signed up/);
    await expectError("no customer", () => addMemberFor(user(a), sid, "", null), /Search for the customer/);
    s = (await seriesFor(a.shopId, sid))!;
    assert.deepEqual(s.members.map((m) => [m.name, m.note]), [["Pat Quilter", "Prepaid"], ["Lee Sewer", null]]);
    assert.deepEqual((await seriesListFor(a.shopId)).map((x) => [x.name, x.members, x.kits]), [["Block of the Month 2027", 2, 2]]);
    await removeMemberFor(user(a), s.members[1].id);
    assert.equal((await seriesFor(a.shopId, sid))!.members.length, 1);
    ok("Block of the Month: a month holds one kit (moving it empties its old month), handouts marked done and reset when a kit moves month, a roster of the shop's customers with no duplicates");

    // 7. Delete: a kit with stock is refused; one with none goes (its item stays); a series goes with its roster, its kits stay.
    await expectError("delete with stock", () => deleteKitFor(user(a), saved.id), /made kits in stock/);
    assert.match(await deleteKitFor(user(a), k3.id), /Deleted Cheap One/);
    assert.equal(await db.kit.count({ where: { id: k3.id } }), 0);
    assert.equal(await db.part.count({ where: { shopId: a.shopId, partNumber: "KIT-CHEAP-ONE" } }), 1, "the stock item stays in inventory");
    assert.match(await deleteSeriesFor(user(a), sid), /Deleted Block of the Month 2027/);
    assert.equal(await db.kitSeriesMember.count({ where: { shopId: a.shopId } }), 0);
    assert.equal((await kitFor(a.shopId, second.id))!.series, null, "the kits stay");
    ok("delete: a kit with stock is refused, an empty one goes (its item stays); a series goes with its roster and its kits stay");

    // 8. Tenant: B with A's ids.
    const tables = ["Part", "StockMove", "Kit", "KitLine", "KitSeries", "KitSeriesMember", "Customer", "Shop"];
    const sid2 = await createSeriesFor(user(a), fd({ name: "Second Series", months: "2" }));
    await linkKitFor(user(a), sid2, 1, saved.id);
    await addMemberFor(user(a), sid2, pat1.id, null);
    const snap = await snapshot(a.shopId, tables);
    const bSeries = await createSeriesFor(user(b), fd({ name: "B Series", months: "2" }));
    const bCust = await db.customer.create({ data: { shopId: b.shopId, name: "B Customer" } });
    const bSnap = await snapshot(b.shopId, ["Part", "Kit", "KitSeriesMember"]);
    assert.equal(await kitFor(b.shopId, saved.id), null, "B can't open A's kit");
    assert.equal(await seriesFor(b.shopId, sid2), null, "or A's series");
    await expectNotFound("makeKitsFor(B)", () => makeKitsFor(user(b), saved.id, 1));
    await expectNotFound("unmakeKitFor(B)", () => unmakeKitFor(user(b), saved.id));
    await expectNotFound("deleteKitFor(B)", () => deleteKitFor(user(b), saved.id));
    await expectNotFound("saveKitFor(B, A's kit)", () => saveKitFor(user(b), saved.id, form({ name: "Mine now", lines: [["BT-1", "1"]] })));
    await expectError("saveKitFor(B, A's item numbers)", () => saveKitFor(user(b), null, form({ name: "B Kit", lines: [["BT-1", "1"]] })), /No item numbered BT-1/);
    await expectNotFound("linkKitFor(B, A's kit into B's series)", () => linkKitFor(user(b), bSeries, 1, saved.id));
    await expectNotFound("linkKitFor(B, A's series)", () => linkKitFor(user(b), sid2, 2, null));
    await expectNotFound("setHandoutFor(B)", () => setHandoutFor(user(b), saved.id, true));
    await expectNotFound("addMemberFor(B, A's customer)", () => addMemberFor(user(b), bSeries, pat1.id, null));
    await expectNotFound("addMemberFor(B, A's series)", () => addMemberFor(user(b), sid2, bCust.id, null));
    await expectNotFound("removeMemberFor(B)", async () => removeMemberFor(user(b), (await db.kitSeriesMember.findFirstOrThrow({ where: { seriesId: sid2 } })).id));
    await expectNotFound("deleteSeriesFor(B)", () => deleteSeriesFor(user(b), sid2));
    assert.equal((await kitsFor(b.shopId)).length, 0);
    assert.equal((await seriesListFor(b.shopId)).length, 1, "B sees only its own series");
    assertUnchanged("tenant (A)", snap, await snapshot(a.shopId, tables));
    assertUnchanged("tenant (B)", bSnap, await snapshot(b.shopId, ["Part", "Kit", "KitSeriesMember"]));
    ok("tenant: B can't open, make, unmake, delete, edit or hand out A's kit, use A's items, customers or series, and A's rows (and B's) are unchanged");
  } finally {
    await cleanup();
  }
  console.log(`kits.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
void KIT_DEFAULTS;
