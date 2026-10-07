// Rentals, rent-to-own and trial purchases (shop-features-round-2-design.md 1.8): renting a rental out (owner or admin;
// only a rental that's in; the first rent rung up, taxed as a rental, "Rentals" income); paid-through and overdue; rent
// by pay link; "Buy it now" with the rent credit off the price ("Rent credit", the rental ended, the machine sold); the
// window passed gives no credit; a trial purchase's "Try it until" on the unit (cleared by a void); the tenant section.
//   npm run -s check scripts/checks/rentals-trials.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { receiveUnitsFor } from "@/lib/units/units";
import { setUnitUseFor } from "@/lib/loans";
import { buyRentalAs, payRentAs, periodsAfter, rentalsFor, rentalsIn, rentalsOverdue, rentOutFor, saveTrialDaysFor, sendRentLinkAs } from "@/lib/rentals";
import { saveShopSettingsFor } from "@/lib/shop/online-shop";
import { shopTimeZone } from "@/lib/shop-zone";
import { addDays, ymdOf } from "@/lib/zoned";
import { checkShop, cleanup } from "./lib";
import { expectNotFound, RUN } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
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

const card = { method: "CARD" as const, amountCents: 0 };

async function main() {
  process.env.PUBLIC_URL = "http://localhost:3999";
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const tech = { ...a.user, role: "TECH" as const };
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 5 } });
    const today = ymdOf(new Date(), await shopTimeZone(a.shopId));
    const [rental, sold] = await receiveUnitsFor(a.user, form({ kind: "sewing", brand: "Janome", model: "Memory Craft 9850", condition: "NEW", priceCents: "1000.00", serials: "RENT-1\nTRIAL-1" }));
    await setUnitUseFor(a.user, rental, form({ use: "RENTAL" }));
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Renter" } });

    // 1. Rent it out.
    assert.equal((await rentalsIn(a.shopId)).length, 1);
    await expectError("a tech", () => rentOutFor(tech, { unitId: rental, customerId: jane.id, rateCents: 4000, ratePer: "month", tender: card }), /owner or admin/);
    await expectError("not a rental", () => rentOutFor(a.user, { unitId: sold, customerId: jane.id, rateCents: 4000, ratePer: "month", tender: card }), /isn't a rental/);
    const r1 = await rentOutFor(a.user, { unitId: rental, customerId: jane.id, rateCents: 4000, ratePer: "month", periods: 1, tender: card });
    const s1 = await db.sale.findUniqueOrThrow({ where: { id: r1.saleId }, include: { lines: true } });
    assert.ok(s1.lines[0].kind === "RENT" && s1.lines[0].taxable && s1.totalCents === 4200 && s1.lines[0].unitLoanId === r1.loanId);
    let v = (await rentalsFor(a.shopId))[0];
    assert.ok(v.paidCents === 4000 && v.paidThrough === addDays(periodsAfter(today, "month", 1), -1) && !v.overdue);
    assert.equal(v.ownPct, 100);
    assert.equal(v.creditCents, 4000, "rent-to-own: all the rent counts");
    await expectError("rented twice", () => rentOutFor(a.user, { unitId: rental, customerId: jane.id, rateCents: 4000, ratePer: "month", tender: card }), /isn't a rental in the shop|out already/);
    ok("rented out by an owner at $40 a month: the first month rung up taxed ($42), Rentals income; paid through a month; all the rent counts toward buying it");

    // 2. Overdue; rent at the counter by a tech; a pay link.
    await db.unitLoan.update({ where: { id: r1.loanId }, data: { outAt: new Date(Date.now() - 70 * 86_400_000) } });
    assert.equal(await rentalsOverdue(a.shopId), 1);
    await payRentAs(tech, { loanId: r1.loanId, periods: 2, tender: card });
    v = (await rentalsFor(a.shopId))[0];
    assert.ok(v.paidCents === 12_000 && !v.overdue, "three months paid: through the third");
    await saveShopSettingsFor(a.user, form({ slug: `check-${RUN}-rent`, pickup: "on", shipRate: "0", payVia: "own", stripeKey: "sk_test_rent1234567890", stripeWebhook: "whsec_rent1234567890" }));
    assert.match(await sendRentLinkAs(a.user, r1.loanId), /Pay link #\d+/);
    const link = await db.webOrder.findFirstOrThrow({ where: { shopId: a.shopId, source: "staff" } });
    assert.ok(link.subtotalCents === 4000 && link.taxCents === 200, "rent by link is taxed too");
    ok("overdue when the rent runs out; two months taken at the counter by a tech; the next month sent as a pay link, taxed");

    // 3. Buy it now with the rent credit.
    const buy = await buyRentalAs(a.user, { loanId: r1.loanId, tender: card });
    assert.equal(buy.creditCents, 12_000);
    const bs = await db.sale.findUniqueOrThrow({ where: { id: buy.saleId }, include: { lines: true } });
    const line = bs.lines[0];
    assert.ok(line.stockUnitId === rental && line.discountCents === 12_000 && line.priceNote === "Rent credit");
    assert.equal(bs.totalCents, Math.round(88_000 * 1.05));
    const unit = await db.stockUnit.findUniqueOrThrow({ where: { id: rental } });
    assert.ok(unit.status === "SOLD" && unit.use === "SALE");
    assert.ok((await db.unitLoan.findUniqueOrThrow({ where: { id: r1.loanId } })).backAt, "the rental ended");
    assert.deepEqual(await rentalsFor(a.shopId), []);
    ok("Buy it now: the $120 rent credit off the $1,000 machine (a discount labelled Rent credit), sold, the rental ended");

    // 4. The window passed: no credit.
    const [late] = await receiveUnitsFor(a.user, form({ kind: "sewing", brand: "Janome", model: "HD3000", condition: "USED", priceCents: "300.00", serials: "RENT-2" }));
    await setUnitUseFor(a.user, late, form({ use: "RENTAL" }));
    const r2 = await rentOutFor(a.user, { unitId: late, customerId: jane.id, rateCents: 1000, ratePer: "week", ownPct: 50, ownMonths: 1, tender: card });
    assert.equal((await rentalsFor(a.shopId))[0].creditCents, 500);
    await db.unitLoan.update({ where: { id: r2.loanId }, data: { ownUntil: addDays(today, -1) } });
    assert.equal((await rentalsFor(a.shopId))[0].creditCents, 0);
    ok("rent-to-own at 50% for a month: half the rent counts, nothing once the month is past");

    // 5. A trial purchase.
    await expectError("a tech sets trial days", () => saveTrialDaysFor(tech, form({ trialDays: "14" })), /owner or admin/);
    await saveTrialDaysFor(a.user, form({ trialDays: "14" }));
    const ts = await completeSaleAs(a.user, { customerId: jane.id, lines: [{ description: "", qty: 1, unitPriceCents: 100_000, taxable: true, stockUnitId: sold }], tenders: [{ method: "CASH", amountCents: 105_000 }] });
    const tu = await db.stockUnit.findUniqueOrThrow({ where: { id: sold } });
    assert.ok(tu.trialUntil && Math.round((tu.trialUntil.getTime() - tu.soldAt!.getTime()) / 86_400_000) === 14);
    await voidSaleAs(a.user, ts.saleId, "x");
    assert.equal((await db.stockUnit.findUniqueOrThrow({ where: { id: sold } })).trialUntil, null);
    ok("a machine sold while trial days are set: tried until 14 days on; a void clears it");

    // 6. Tenant.
    await expectNotFound("B pays A's rent", () => payRentAs(b.user, { loanId: r2.loanId, periods: 1, tender: card }));
    await expectNotFound("B buys A's rental", () => buyRentalAs(b.user, { loanId: r2.loanId, tender: card }));
    await expectNotFound("B rents A's machine", () => rentOutFor({ ...b.user }, { unitId: late, customerId: jane.id, rateCents: 1000, ratePer: "week", tender: card }));
    assert.deepEqual(await rentalsFor(b.shopId), []);
    ok("tenant: another company can't pay, buy, rent or see A's rentals");

    console.log(`rentals-trials.check: ${steps} groups passed`);
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
