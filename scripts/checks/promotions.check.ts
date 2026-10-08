// Promotions (tax-machine-sales-layaway-design.md section 2): the tax backed out of a sticker price, percent and amount
// off, the form's checks, a sale through completeSaleAs on the promotion's days (a tech gets the discount, a bigger one
// an owner types stands, a brand's machines, the promotion named on the line), "price includes the tax" (refused until
// the owner turns it on, the customer pays the sticker price, the real tax recorded), switching it off, removing a used
// promotion, and the tenant section.
//   npm run check scripts/checks/promotions.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { completeSaleAs } from "@/lib/register-sale";
import type { CurrentUser } from "@/lib/session";
import { bestDiscount, includedTax, priceBeforeTax, promoDiscount } from "@/lib/promo-math";
import { deletePromotionFor, listPromotions, promotionsOn, savePromotionFor, setTaxIncludedFor } from "@/lib/promotions";
import { receiveUnitsFor } from "@/lib/units/units";
import { addDays, ymdOf } from "@/lib/zoned";
import { checkShop, cleanup, type CheckShop } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });
const NY = "America/New_York";

function form(entries: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

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

const cash = (amountCents: number) => [{ method: "CASH" as const, amountCents }];

async function main() {
  const a = await checkShop({ retail: true, repair: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 7, timeZone: NY } });
    const today = ymdOf(new Date(), NY);

    // 1. The math.
    assert.equal(priceBeforeTax(100_000, 7), 93_458, "$1,000 at 7% is $934.58 plus $65.42");
    assert.equal(includedTax(93_458, 7), 6542);
    for (const s of [1999, 4999, 12_345, 250_000]) assert.equal(priceBeforeTax(s, 6.25) + includedTax(priceBeforeTax(s, 6.25), 6.25), s, `${s} lands exactly`);
    assert.equal(promoDiscount({ effect: "PERCENT", value: 20 }, { qty: 2, unitPriceCents: 1250 }), 500);
    assert.equal(promoDiscount({ effect: "AMOUNT", value: 5000 }, { qty: 1, unitPriceCents: 3000 }), 3000, "never below zero");
    const best = bestDiscount(
      [
        { id: "x", name: "10%", effect: "PERCENT", value: 10, scope: { kinds: ["FABRIC"], brands: [], partIds: [] } },
        { id: "y", name: "$5", effect: "AMOUNT", value: 500, scope: { kinds: ["FABRIC"], brands: [], partIds: [] } },
      ],
      { kind: "FABRIC", qty: 1, unitPriceCents: 3000 },
    );
    assert.equal(best?.promo.id, "y", "the bigger discount wins");
    ok("the tax backed out of a sticker price lands on it exactly; percent and amount off; the best of two promotions wins");

    // 2. The form.
    const base = { name: "Fall fabric sale", firstDay: today, lastDay: addDays(today, 3), effect: "PERCENT", value: "20" };
    await expectError("a tech", () => savePromotionFor(tech(a), null, form({ ...base, kinds: ["FABRIC"] })), /owner or admin/);
    await expectError("covers nothing", () => savePromotionFor(user(a), null, form(base)), /what the sale covers/);
    await expectError("an unknown item", () => savePromotionFor(user(a), null, form({ ...base, items: "NOPE-1" })), /isn't in your inventory/);
    await expectError("tax included while off", () => savePromotionFor(user(a), null, form({ ...base, effect: "TAX_INCLUDED", kinds: ["UNIT"] })), /Turn on/);
    await expectError("100% off", () => savePromotionFor(user(a), null, form({ ...base, value: "100", kinds: ["FABRIC"] })), /1 to 90/);
    const fall = await savePromotionFor(user(a), null, form({ ...base, kinds: ["FABRIC"] }));
    const brother = await savePromotionFor(user(a), null, form({ ...base, name: "Brother days", effect: "AMOUNT", value: "$50", brands: "brother" }));
    await savePromotionFor(user(a), null, form({ ...base, name: "Next month", firstDay: addDays(today, 30), lastDay: addDays(today, 31), kinds: ["NOTION"] }));
    assert.deepEqual((await promotionsOn(a.shopId, today)).map((p) => p.name).sort(), ["Brother days", "Fall fabric sale"]);
    ok("an owner plans sales by kind, brand or item; refused: a tech, covering nothing, an unknown item, 100% off, tax included while off");

    // 3. A sale on those days.
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Promo Pat" } });
    const fabric = await db.part.create({ data: { shopId: a.shopId, partNumber: "FAB-2", description: "Batik", priceCents: 1000, qtyOnHand: 40, unit: "yd", kind: "FABRIC", numberKeys: ["FAB2"] } });
    const [bro] = await receiveUnitsFor(user(a), form({ kind: "sewing", brand: "Brother", model: "PQ1500", condition: "NEW", priceCents: "600", serials: "PQ-1" }));
    const s1 = await completeSaleAs(tech(a), {
      customerId: cust.id,
      lines: [
        { partId: fabric.id, description: "", qty: 2, unitPriceCents: 1000, taxable: true },
        { description: "", qty: 1, unitPriceCents: 60_000, taxable: true, stockUnitId: bro },
      ],
      tenders: cash(Math.round((1600 + 55_000) * 1.07)),
    });
    const lines = await db.saleLine.findMany({ where: { saleId: s1.saleId }, orderBy: { unitPriceCents: "asc" } });
    assert.deepEqual([lines[0].discountCents, lines[0].promotionId], [400, fall], "20% off the fabric, named");
    assert.deepEqual([lines[1].discountCents, lines[1].promotionId], [5000, brother], "$50 off the Brother machine");
    assert.equal((await db.stockUnit.findUniqueOrThrow({ where: { id: bro } })).soldNetCents, 55_000, "the machine sold for its sale price");
    await expectError("a tech's own discount is still refused", () => completeSaleAs(tech(a), { lines: [{ partId: fabric.id, description: "", qty: 1, unitPriceCents: 1000, discountCents: 100, taxable: true }], tenders: cash(1000) }), /owner or admin/);
    const s2 = await completeSaleAs(user(a), { lines: [{ partId: fabric.id, description: "", qty: 1, unitPriceCents: 1000, discountCents: 500, taxable: true }], tenders: cash(535) });
    const l2 = await db.saleLine.findFirstOrThrow({ where: { saleId: s2.saleId } });
    assert.deepEqual([l2.discountCents, l2.promotionId], [500, null], "an owner's bigger discount stands");
    ok("on the sale's days a tech rings up 20% off fabric and $50 off a Brother machine, each named on its line; a bigger discount an owner types stands");

    // 4. Price includes the tax.
    await expectError("a tech turns it on", () => setTaxIncludedFor(tech(a), true), /owner or admin/);
    await setTaxIncludedFor(user(a), true);
    const incl = await savePromotionFor(user(a), null, form({ ...base, name: "We pay the tax", effect: "TAX_INCLUDED", brands: "Janome" }));
    const [jan] = await receiveUnitsFor(user(a), form({ kind: "sewing", brand: "Janome", model: "M7", condition: "NEW", priceCents: "1000", serials: "M7-1" }));
    const s3 = await completeSaleAs(tech(a), { customerId: cust.id, lines: [{ description: "", qty: 1, unitPriceCents: 100_000, taxable: true, stockUnitId: jan }], tenders: cash(100_000) });
    const sale3 = await db.sale.findUniqueOrThrow({ where: { id: s3.saleId }, include: { lines: true } });
    assert.deepEqual([sale3.totalCents, sale3.subtotalCents, sale3.taxCents], [100_000, 93_458, 6542], "the customer pays the sticker; the real tax is recorded");
    assert.deepEqual([sale3.lines[0].taxNote, sale3.lines[0].promotionId, sale3.lines[0].unitPriceCents], ["included", incl, 93_458]);
    await setTaxIncludedFor(user(a), false);
    assert.ok(!(await promotionsOn(a.shopId, today)).some((p) => p.effect === "TAX_INCLUDED"), "switched off: not applied");
    ok("price includes the tax: refused until the owner turns it on; a $1,000 machine is $934.58 plus $65.42, the customer pays $1,000; off again, not applied");

    // 5. Removing a used one switches it off; tenant.
    await deletePromotionFor(user(a), fall);
    assert.equal((await listPromotions(a.shopId)).find((p) => p.id === fall)?.active, false, "used: switched off, not deleted");
    await expectError("B changes A's", () => savePromotionFor(user(b), brother, form({ ...base, kinds: ["FABRIC"] })), /not found/);
    await deletePromotionFor(user(b), brother);
    assert.ok(await db.promotion.findUnique({ where: { id: brother } }), "B's delete touches nothing of A's");
    assert.deepEqual(await promotionsOn(b.shopId, today), []);
    await expectError("B's promotion can't name A's item", () => savePromotionFor(user(b), null, form({ ...base, items: "FAB-2" })), /isn't in your inventory/);
    ok("a used promotion is switched off, not deleted; B can't change, remove or see A's, nor name A's items");
  } finally {
    await cleanup();
  }
  console.log(`promotions.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
