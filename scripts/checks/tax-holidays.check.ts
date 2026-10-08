// Sales tax holidays (tax-machine-sales-layaway-design.md section 1): the Massachusetts preset's dates, the per-item
// limit (after the line's own discount), a sale on a holiday through completeSaleAs (covered kinds untaxed with the
// holiday on the line, a dearer item and other kinds taxed, "charge tax anyway"), a receipt return given back as sold,
// an exempt customer's lines, a layaway begun on a holiday and picked up after it, the tax report's holiday split, the
// "confirm the dates" reminder, removing a used holiday, and the tenant section.
//   npm run check scripts/checks/tax-holidays.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { pickUpLayawayAs, pickUpQuote, startLayawayAs } from "@/lib/layaway";
import { completeSaleAs } from "@/lib/register-sale";
import { taxReport } from "@/lib/reports/tax";
import type { CurrentUser } from "@/lib/session";
import { deleteHolidayFor, holidaysOn, listHolidays, presetReminders, saveHolidayFor } from "@/lib/tax-holidays";
import { GOODS_KINDS, holidayCovers, holidayDays, presetByKey } from "@/lib/tax-holiday-math";
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
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 6.25, timeZone: NY } });
    const today = ymdOf(new Date(), NY);

    // 1. The preset and the limit rule.
    const ma = presetByKey("MA")!;
    assert.deepEqual(ma.datesFor(2026), { firstDay: "2026-08-08", lastDay: "2026-08-09" });
    assert.deepEqual(ma.datesFor(2027), { firstDay: "2027-08-14", lastDay: "2027-08-15" });
    assert.equal(holidayDays(ma.datesFor(2026)), "Aug 8 to 9, 2026");
    const h = { kinds: GOODS_KINDS, maxUnitCents: 250_000 };
    assert.ok(holidayCovers(h, { kind: "UNIT", qty: 1, unitPriceCents: 250_000, taxable: true }), "at the limit: covered");
    assert.ok(!holidayCovers(h, { kind: "UNIT", qty: 1, unitPriceCents: 250_001, taxable: true }), "a cent over: taxed in full");
    assert.ok(holidayCovers(h, { kind: "UNIT", qty: 1, unitPriceCents: 260_000, discountCents: 10_000, taxable: true }), "its own discount brings it under");
    assert.ok(!holidayCovers(h, { kind: "CLASS", qty: 1, unitPriceCents: 1000, taxable: true }), "classes are left out");
    assert.ok(!holidayCovers(h, { kind: "FABRIC", qty: 1, unitPriceCents: 1000, taxable: false }), "an untaxed line stays as it is");
    ok("Massachusetts: Aug 8 to 9 2026, the second August weekend after; $2,500 each or less (after its own discount) is covered, a cent more is taxed; classes left out");

    // 2. Setting one up.
    await expectError("a tech", () => saveHolidayFor(tech(a), null, form({ name: "X", firstDay: today, lastDay: today, kinds: ["FABRIC"] })), /owner or admin/);
    await expectError("nothing ticked", () => saveHolidayFor(user(a), null, form({ name: "X", firstDay: today, lastDay: today })), /Tick what it covers/);
    await expectError("backwards", () => saveHolidayFor(user(a), null, form({ name: "X", firstDay: today, lastDay: addDays(today, -1), kinds: ["FABRIC"] })), /before the first/);
    const hid = await saveHolidayFor(user(a), null, form({ name: "Massachusetts sales tax holiday", preset: "MA", firstDay: today, lastDay: addDays(today, 1), kinds: GOODS_KINDS, maxUnitCents: "$2,500" }));
    assert.equal((await holidaysOn(a.shopId, [today], null))[0]?.id, hid);
    assert.deepEqual(await holidaysOn(a.shopId, [addDays(today, 2)], null), []);
    ok("a holiday is saved by an owner (price typed as $2,500), checked for its days and kinds, and found by date");

    // 3. A sale on the holiday.
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Holiday Hal" } });
    const fabric = await db.part.create({ data: { shopId: a.shopId, partNumber: "FAB-1", description: "Cotton", priceCents: 1200, qtyOnHand: 50, unit: "yd", kind: "FABRIC", numberKeys: ["FAB1"] } });
    const notion = await db.part.create({ data: { shopId: a.shopId, partNumber: "PIN-1", description: "Pins", priceCents: 500, qtyOnHand: 50, kind: "NOTION", numberKeys: ["PIN1"] } });
    const [u1] = await receiveUnitsFor(user(a), form({ kind: "sewing", brand: "Bernina", model: "790", condition: "NEW", priceCents: "3000", serials: "B790-1" }));
    const s1 = await completeSaleAs(user(a), {
      customerId: cust.id,
      lines: [
        { partId: fabric.id, description: "", qty: 2, unitPriceCents: 1200, taxable: true },
        { partId: notion.id, description: "", qty: 1, unitPriceCents: 500, taxable: true, taxAnyway: true },
        { description: "", qty: 1, unitPriceCents: 300_000, taxable: true, stockUnitId: u1 },
      ],
      tenders: cash(2400 + 500 + 300_000 + Math.round(((500 + 300_000) * 625) / 10_000)),
    });
    const sale = await db.sale.findUniqueOrThrow({ where: { id: s1.saleId }, include: { lines: { orderBy: { unitPriceCents: "asc" } } } });
    const [pins, cloth, machine] = sale.lines;
    assert.ok(!cloth.taxable && cloth.taxNote === `holiday:${hid}`, "fabric: no tax, the holiday noted");
    assert.ok(pins.taxable && pins.taxNote === null, "charged anyway");
    assert.ok(machine.taxable && machine.taxNote === null, "$3,000 machine: over the limit, taxed in full");
    assert.equal(sale.taxCents, Math.round(((500 + 300_000) * 625) / 10_000));
    ok("on the holiday: the fabric untaxed with the holiday on its line, the pins charged anyway, the $3,000 machine taxed in full");

    // 3b. A sale the program builds (a print job, rent, event money: tenderExact) on the holiday: its one payment is the
    // sale's own total, the holiday taken off (it used to be sized at the shop's rate and refused as "Still due").
    const pj = await completeSaleAs(user(a), { lines: [{ description: "Print job", qty: 1, unitPriceCents: 2000, taxable: true }], tenders: [] }, { tenderExact: { method: "CASH", amountCents: 0 } });
    const pjSale = await db.sale.findUniqueOrThrow({ where: { id: pj.saleId } });
    assert.equal(pj.totalCents, 2000);
    assert.deepEqual(pjSale.tenders, [{ method: "CASH", amountCents: 2000, note: null, cardNumber: null }].map(({ cardNumber, ...t }) => (void cardNumber, t)));
    ok("a program-built sale on the holiday: one payment for exactly its total (tax off what the holiday covers)");

    // 4. A receipt return gives the fabric back tax free; an exempt customer's lines say exempt.
    const r1 = await completeSaleAs(user(a), { customerId: cust.id, returnOfSaleId: s1.saleId, lines: [{ partId: fabric.id, description: "", qty: -1, unitPriceCents: 1200, taxable: true }], tenders: cash(-1200) });
    const ret = await db.sale.findUniqueOrThrow({ where: { id: r1.saleId }, include: { lines: true } });
    assert.ok(ret.taxCents === 0 && !ret.lines[0].taxable && ret.lines[0].taxNote === `holiday:${hid}`);
    const exemptCust = await db.customer.create({ data: { shopId: a.shopId, name: "Church Guild", taxExemptId: "E-123" } });
    const s2 = await completeSaleAs(user(a), { customerId: exemptCust.id, lines: [{ partId: notion.id, description: "", qty: 1, unitPriceCents: 500, taxable: true }], tenders: cash(500) });
    const ex = await db.saleLine.findFirstOrThrow({ where: { saleId: s2.saleId } });
    assert.equal(ex.taxNote, "exempt");
    ok("a receipt return of holiday fabric refunds no tax; an exempt customer's line says exempt");

    // 5. Layaway: begun on a holiday, picked up after it: still tax free (the Streamlined rule).
    await db.part.update({ where: { id: notion.id }, data: { priceCents: 10_000 } });
    const lw = await startLayawayAs(user(a), { customerId: cust.id, lines: [{ partId: notion.id, qty: 1, unitPriceCents: 10_000 }], depositCents: 2000, tender: cash(2000)[0] });
    const yesterday = addDays(today, -1);
    await db.taxHoliday.update({ where: { id: hid }, data: { firstDay: addDays(today, -3), lastDay: yesterday } });
    await db.layaway.update({ where: { id: lw.layawayId }, data: { startedAt: new Date(Date.now() - 2 * 86_400_000) } });
    assert.equal((await pickUpQuote(a.shopId, lw.layawayId)).dueCents, 8000, "the pick-up total knows the holiday rule");
    const pu = await pickUpLayawayAs(user(a), { layawayId: lw.layawayId, tender: cash(8000)[0] });
    const puSale = await db.sale.findUniqueOrThrow({ where: { id: pu.saleId }, include: { lines: true } });
    assert.equal(puSale.changeCents, 0);
    assert.ok(puSale.taxCents === 0 && puSale.lines.some((l) => l.taxNote === `holiday:${hid}`), "begun on the holiday: tax free at pick-up");
    const lw2 = await startLayawayAs(user(a), { customerId: cust.id, lines: [{ partId: notion.id, qty: 1, unitPriceCents: 10_000 }], depositCents: 2000, tender: cash(2000)[0] });
    const pu2 = await pickUpLayawayAs(user(a), { layawayId: lw2.layawayId, tender: cash(8625)[0] });
    assert.equal((await db.sale.findUniqueOrThrow({ where: { id: pu2.saleId } })).taxCents, 625, "begun and picked up after it: taxed");
    ok("a layaway begun on the holiday is tax free when picked up after it; one begun after it is taxed");

    // 6. The tax report lists the holiday's sales apart.
    const rep = await taxReport(a.shopId, NY, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    const hol = rep.holidays.find((x) => x.name === "Massachusetts sales tax holiday");
    assert.equal(hol?.amountCents, 2400 - 1200 + 2000 + 10_000, "the fabric sold less the one returned, the print job, and the layaway's pick-up");
    ok("the tax report lists what was sold tax free on the holiday, returns netted in");

    // 7. The yearly reminder, and removing a used holiday.
    const year = Number(today.slice(0, 4));
    await db.taxHoliday.update({ where: { id: hid }, data: { firstDay: `${year - 1}-08-09`, lastDay: `${year - 1}-08-10` } });
    assert.deepEqual(await presetReminders(a.shopId, `${year}-07-10`), [], "too early");
    assert.deepEqual(await presetReminders(a.shopId, `${year}-07-20`), [{ key: "MA", state: "Massachusetts" }], "two weeks before August");
    await saveHolidayFor(user(a), null, form({ name: "MA", preset: "MA", firstDay: `${year}-08-08`, lastDay: `${year}-08-09`, kinds: GOODS_KINDS }));
    assert.deepEqual(await presetReminders(a.shopId, `${year}-07-20`), [], "confirmed for this year");
    assert.deepEqual(await presetReminders(b.shopId, `${year}-07-20`), [], "a shop that never used it isn't asked");
    await deleteHolidayFor(user(a), hid);
    const kept = (await listHolidays(a.shopId)).find((x) => x.id === hid);
    assert.ok(kept && !kept.active, "sales were made under it: switched off, not deleted");
    ok("'confirm the dates' from two weeks before August until this year's is set; a used holiday is switched off, not deleted");

    // 7b. Stores in different states: a holiday names its stores; a preset ticks the stores in its state.
    const fl = await db.location.create({ data: { shopId: a.shopId, name: "Florida", address: "2 Gulf Rd, Naples FL 34102", taxRatePct: 6 } });
    const main = await db.location.findFirst({ where: { shopId: a.shopId, main: true } });
    const boston = main ?? (await db.location.create({ data: { shopId: a.shopId, name: "Main store", main: true, address: "1 Main St, Boston, MA 02110" } }));
    await db.location.update({ where: { id: boston.id }, data: { address: "1 Main St, Boston, MA 02110" } });
    const { storesInState } = await import("@/lib/tax-holiday-math");
    assert.deepEqual(storesInState([boston, fl], presetByKey("MA")!).map((s) => s.id), [boston.id], "the MA preset ticks the Boston store");
    await expectError("no store ticked", () => saveHolidayFor(user(a), null, form({ name: "MA only", firstDay: today, lastDay: today, kinds: ["FABRIC"], storesShown: "1" })), /Tick the stores/);
    const maOnly = await saveHolidayFor(user(a), null, form({ name: "MA only", firstDay: `${year + 1}-08-08`, lastDay: `${year + 1}-08-09`, kinds: ["FABRIC"], storesShown: "1", stores: [boston.id] }));
    assert.deepEqual((await holidaysOn(a.shopId, [`${year + 1}-08-08`], boston.id)).map((h) => h.id), [maOnly], "at the Boston store");
    assert.deepEqual((await holidaysOn(a.shopId, [`${year + 1}-08-08`], null)).map((h) => h.id), [maOnly], "null is the main store");
    assert.deepEqual(await holidaysOn(a.shopId, [`${year + 1}-08-08`], fl.id), [], "not at the Florida store");
    const both = await saveHolidayFor(user(a), null, form({ name: "Both", firstDay: `${year + 1}-09-01`, lastDay: `${year + 1}-09-01`, kinds: ["FABRIC"], storesShown: "1", stores: [boston.id, fl.id] }));
    assert.deepEqual((await db.taxHoliday.findUniqueOrThrow({ where: { id: both } })).locationIds, [], "every store ticked: every store");
    await expectError("B's store", () => saveHolidayFor(user(b), null, form({ name: "X", firstDay: today, lastDay: today, kinds: ["FABRIC"], storesShown: "1", stores: [fl.id] })), /Tick the stores/);
    await db.taxHoliday.deleteMany({ where: { id: { in: [maOnly, both] } } });
    await db.location.delete({ where: { id: fl.id } });
    ok("stores in different states: a holiday covers the stores ticked (the MA preset ticks the MA store), none ticked refused, all ticked is every store");

    // 8. Tenant.
    await expectError("B changes A's", () => saveHolidayFor(user(b), hid, form({ name: "Mine", firstDay: today, lastDay: today, kinds: ["FABRIC"] })), /not found/);
    await deleteHolidayFor(user(b), hid);
    assert.ok(await db.taxHoliday.findUnique({ where: { id: hid } }), "B's delete touches nothing of A's");
    assert.deepEqual(await listHolidays(b.shopId), []);
    assert.deepEqual(await holidaysOn(b.shopId, [`${year}-08-08`], null), []);
    ok("tenant: B can't change or remove A's holidays, nor see them");
  } finally {
    await cleanup();
  }
  console.log(`tax-holidays.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
