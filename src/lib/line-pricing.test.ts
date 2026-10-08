// Unit tests for the one place a sale's lines are priced and taxed, shared by the register and the server (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { priceLine, type PricingCtx, type PricingLine } from "./line-pricing";
import type { Promo } from "./promo-math";
import { saleTotals } from "./register-math";

const pct10: Promo = { id: "p10", name: "10% off notions", effect: "PERCENT", value: 10, scope: { kinds: ["NOTION"], brands: [], partIds: [] } };
const incl: Promo = { id: "inc", name: "Tax included on machines", effect: "TAX_INCLUDED", value: 0, scope: { kinds: ["UNIT", "NOTION"], brands: [], partIds: [] } };
const holiday = { id: "h1", kinds: ["NOTION"], maxUnitCents: 250_000 };
const ctx = (o: Partial<PricingCtx> = {}): PricingCtx => ({ promos: [pct10, incl], rules: { yardBreaks: [{ minYards: 3, pctOff: 20, kinds: [] }] }, holidays: [], ratePct: 7, ...o });
const notion: PricingLine = { qty: 2, unitPriceCents: 1000, discountCents: 0, taxable: true, partId: "n1", kind: "NOTION" };

// What the register and the server each total: the same lines through the same function.
const total = (c: PricingCtx, lines: PricingLine[]) => {
  const priced = lines.map((l) => ({ ...l, ...priceLine(c, l) }));
  return saleTotals(priced, 0, c.ratePct).total;
};

test("an exchange: the receipt's line comes back as sold (tax free on a holiday), the new item gets today's promotion", () => {
  const back: PricingLine = { ...notion, qty: -1, taxable: true, asSold: { taxable: false, taxNote: "holiday:h0" } };
  const c = ctx();
  const b = priceLine(c, back);
  assert.equal(b.taxable, false, "returned as it was sold: no tax back");
  assert.equal(b.taxNote, "holiday:h0");
  assert.equal(b.discountCents, 0, "a return isn't repriced");
  const n = priceLine(c, notion);
  assert.equal(n.discountCents, 200, "the new item: 10% off today");
  assert.equal(n.promo?.id, "p10");
  // -$10.00 back (no tax) + $18.00 + 7% = $9.26
  assert.equal(total(c, [back, notion]), -1000 + 1800 + 126);
});

test("a whole return from the receipt is never repriced", () => {
  const back: PricingLine = { ...notion, qty: -2, asSold: { taxable: true, taxNote: null } };
  const p = priceLine(ctx({ wholeReturn: true }), back);
  assert.deepEqual([p.discountCents, p.taxable, p.taxIncluded, p.promo], [0, true, false, null]);
});

test("a special order picked up under a tax-included promotion keeps its order price (no tax backed out)", () => {
  const pickup: PricingLine = { qty: 1, unitPriceCents: 10_000, discountCents: 0, taxable: true, partId: "m1", kind: "NOTION", specialOrderId: "so1" };
  const p = priceLine(ctx({ promos: [incl] }), pickup);
  assert.equal(p.taxIncluded, false);
  assert.equal(p.unitPriceCents, 10_000);
  assert.equal(p.discountCents, 0, "no promotion either");
  // The same item off the shelf: the sticker is what she pays.
  const shelf = priceLine(ctx({ promos: [incl] }), { ...pickup, specialOrderId: null });
  assert.equal(shelf.taxIncluded, true);
  assert.equal(total(ctx({ promos: [incl] }), [{ ...pickup, specialOrderId: null }]), 10_000);
});

test("paid online, a pay link or a given tax: no promotion, no price rule (not even an item's own yard break)", () => {
  const fabric: PricingLine = { qty: 4, unitPriceCents: 1200, discountCents: 0, taxable: true, partId: "f1", kind: "FABRIC", unit: "yd", breakMinQty: 3, breakPriceCents: 900 };
  assert.equal(priceLine(ctx(), fabric).discountCents, 1200, "at the counter: the 3+ yd price");
  const p = priceLine(ctx({ promos: [], rules: null, givenTax: true }), fabric);
  assert.equal(p.discountCents, 0);
  assert.equal(p.ruleLabel, null);
});

test("a holiday at this store takes the tax off; charge-tax-anyway keeps it; exempt has none", () => {
  const c = ctx({ promos: [], holidays: [holiday] });
  assert.equal(priceLine(c, notion).taxable, false);
  assert.equal(priceLine(c, { ...notion, taxAnyway: true }).taxable, true);
  // Still marked as a holiday line, so the register offers Undo next to "tax charged".
  assert.equal(priceLine(c, { ...notion, taxAnyway: true }).holidayWaived, true);
  assert.equal(priceLine(c, notion).holidayWaived, false);
  const ex = priceLine(ctx({ holidays: [holiday], exempt: true }), notion);
  assert.equal(ex.taxNote, "exempt");
  assert.equal(ex.holidayId, null);
});

test("a trade-up credit wins over a smaller promotion and says so", () => {
  const machine: PricingLine = { qty: 1, unitPriceCents: 50_000, discountCents: 0, taxable: true, stockUnitId: "u1", kind: "UNIT", tradeUpCents: 7_500 };
  const p = priceLine(ctx({ promos: [{ ...pct10, scope: { kinds: ["UNIT"], brands: [], partIds: [] } }] }), machine);
  assert.equal(p.discountCents, 7_500);
  assert.equal(p.ruleLabel, "Trade-up credit");
  assert.equal(p.promo, null);
});
