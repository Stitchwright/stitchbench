// Machines for sale for every shop (tax-machine-sales-layaway-design.md section 3): a sewing machine received and sold
// with no module, what comes with it, owner's classes (granted by the sale, used on a class seat, limited, given up by a
// return), the shop's service plans (included with a machine, sold as a line for a machine on the sale or one of the
// customer's), a ticket line covered by a plan (the visit limit, the term, charged again), plans ended by a void and a
// return and started again by voiding the return, the maker's terms, the registration reminder, the receipt words, the
// Vac Shop gate still on vacuums, and the tenant section. Through the register's own completeSaleAs / voidSaleAs.
//   npm run check scripts/checks/machine-sales.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import type { CurrentUser } from "@/lib/session";
import { applyClassCreditAs } from "@/lib/class-actions";
import { coverLineFor, coveredWork, endPlanFor, machinePlansFor, preparePlanLine, savePlanFor } from "@/lib/units/plans";
import { registerUnitHits } from "@/lib/units/sale-units";
import { classCreditsFor, listMakerTerms, makerTermsFor, receiveUnitsFor, saveMakerTermsFor, termsOf, termsText, unitDetail, unitsForSaleFor, unitsToRegister, updateUnitFor } from "@/lib/units/units";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { assertUnchanged, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });

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

const cash = (amountCents: number) => [{ method: "CASH" as const, amountCents }];
const SEWING = { kind: "sewing", brand: "Brother", model: "XJ1", condition: "NEW", priceCents: "$1,200.00", costCents: "800" };

async function main() {
  // A has a counter and Scheduling (classes) but no Vac Shop; B is another company.
  const a = await checkShop({ retail: true, repair: true, modules: ["scheduling"] });
  const b = await checkShop({ retail: true });
  try {
    // No sales tax here: the money in each sale is just its lines.
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Mary Buyer", phone: "555-0110" } });

    // 1. A plan, the maker's terms, and a sewing machine received with what comes with it, classes and the plan.
    const planId = await savePlanFor(user(a), null, form({ name: "Free yearly cleaning", visits: "2", months: "36", priceCents: "149" }));
    const warrantyPlan = await savePlanFor(user(a), null, form({ name: "Extended warranty", visits: "", months: "24", priceCents: "199.00", taxable: "on" }));
    await expectError("a tech can't add a plan", () => savePlanFor(tech(a), null, form({ name: "X", months: "12" })), /owner or admin/);
    await expectError("months out of range", () => savePlanFor(user(a), null, form({ name: "X", months: "500" })), /Months/);
    await saveMakerTermsFor(user(a), form({ brand: "Brother", partsYears: "25", laborYears: "2", electronicsYears: "5", registerUrl: "https://example.test/register" }));
    await saveMakerTermsFor(user(a), form({ brand: " brother ", partsYears: "20", laborYears: "2", electronicsYears: "5", registerUrl: "https://example.test/register" }));
    assert.equal((await listMakerTerms(a.shopId)).length, 1, "one row per brand, whatever the case and spaces");
    const terms = termsOf(await makerTermsFor(a.shopId, ["BROTHER"]), "Brother");
    assert.equal(terms && termsText(terms), "Parts 20 years, labor 2 years, electronics 5 years");
    await expectError("a bad registration address", () => saveMakerTermsFor(user(a), form({ brand: "Juki", registerUrl: "javascript:alert(1)" })), /web address/);
    const [u1, u2] = await receiveUnitsFor(user(a), form({ ...SEWING, serials: "XJ-1\nXJ-2", bundle: "Extension table\n\n Embroidery software ", classCredits: "2", includedPlanId: planId }));
    const d1 = await unitDetail(a.shopId, u1);
    assert.ok(d1 && d1.equipment === "SEWING" && d1.kind === "sewing" && d1.priceCents === 120000 && d1.costCents === 80000);
    assert.ok(d1.bundle === "Extension table\nEmbroidery software" && d1.classCredits === 2 && d1.includedPlanId === planId && d1.warrantyBy === "Brother");
    await expectError("too many classes", () => receiveUnitsFor(user(a), form({ ...SEWING, serials: "XJ-9", classCredits: "50" })), /Owner's classes/);
    await expectError("a vacuum without Vac Shop", () => receiveUnitsFor(user(a), form({ ...SEWING, kind: "vacuum", serials: "V-1", "f:bagged": "Bagged" })), /Vac Shop|module|isn't on/i);
    assert.equal((await unitsForSaleFor(a.shopId, "XJ1")).length, 2);
    assert.equal((await registerUnitHits({ shopId: a.shopId, q: "xj-1", mode: "code" })).length, 1);
    ok("a sewing machine goes on sale with no module: price typed as $1,200.00, bundle cleaned, classes and the plan; terms one row per brand; a vacuum still needs Vac Shop");

    // 2. Sell u1 with a separately sold plan for it and one for the customer's own machine.
    const own = await db.machine.create({ data: { shopId: a.shopId, brand: "Singer", model: "4423", modelKey: "4423", customerId: cust.id } });
    await expectError("a plan for a machine not on the sale", () =>
      completeSaleAs(user(a), { customerId: cust.id, lines: [{ description: "", qty: 1, unitPriceCents: 19900, taxable: true, servicePlan: { planId: warrantyPlan, stockUnitId: u2 } }], tenders: cash(19900) }),
    /must be on this sale/);
    await expectError("a tech changing a plan's price", () =>
      preparePlanLine({ shopId: a.shopId, role: "TECH", customerId: cust.id, unitIdsOnSale: [] }, { planId: warrantyPlan, machineId: own.id }, 1, 100),
    /owner or admin/);
    const s1 = await completeSaleAs(user(a), {
      customerId: cust.id,
      lines: [
        { description: "", qty: 1, unitPriceCents: 120000, taxable: true, stockUnitId: u1 },
        { description: "", qty: 1, unitPriceCents: 19900, taxable: false, servicePlan: { planId: warrantyPlan, stockUnitId: u1 } },
        { description: "", qty: 1, unitPriceCents: 14900, taxable: false, servicePlan: { planId, machineId: own.id } },
      ],
      tenders: cash(120000 + 19900 + 14900),
    });
    const lines = await db.saleLine.findMany({ where: { saleId: s1.saleId }, orderBy: { id: "asc" } });
    const planLines = lines.filter((l) => l.kind === "SERVICE_PLAN");
    assert.equal(planLines.length, 2);
    assert.ok(planLines.every((l) => l.machinePlanId && /^Service plan: /.test(l.description)));
    assert.ok(planLines.find((l) => /Extended warranty/.test(l.description))!.taxable, "the plan's own tax setting, not the register's");
    const m1 = (await unitDetail(a.shopId, u1))!.machineId;
    const plans1 = await machinePlansFor(a.shopId, m1, "America/New_York");
    assert.deepEqual(plans1.map((p) => p.name).sort(), ["Extended warranty", "Free yearly cleaning"], "the included plan and the one sold");
    assert.ok(plans1.every((p) => p.current));
    assert.equal((await machinePlansFor(a.shopId, own.id, "America/New_York")).length, 1);
    ok("sold with an included plan and two plans as lines (for the machine on the sale and the customer's own); each plan's tax rule; a plan for a machine not on the sale is refused");

    // 3. Owner's classes: 2 with the machine, used on seats, the third refused, a cancelled seat gives one back.
    const credits = await classCreditsFor(a.shopId, cust.id);
    assert.deepEqual(credits.map((c) => [c.granted, c.left]), [[2, 2]]);
    const cls = await db.shopClass.create({ data: { shopId: a.shopId, title: "Guide class", feeCents: 3500, seats: 10, status: "OPEN" } });
    const seat = (attendee: string | null) => db.enrollment.create({ data: { shopId: a.shopId, classId: cls.id, customerId: cust.id, name: cust.name, attendee, feeCents: 3500 } });
    const e1 = await seat(null);
    const e2 = await seat("Sam");
    const e3 = await seat("Pat");
    await applyClassCreditAs(user(a), e1.id, u1);
    await applyClassCreditAs(tech(a), e2.id, u1);
    assert.equal((await db.enrollment.findUniqueOrThrow({ where: { id: e1.id } })).feeCents, 0);
    await expectError("a third class", () => applyClassCreditAs(user(a), e3.id, u1), /No owner's classes left/);
    await db.enrollment.update({ where: { id: e2.id }, data: { status: "CANCELLED" } });
    await applyClassCreditAs(user(a), e3.id, u1);
    await applyClassCreditAs(user(a), e3.id, null);
    assert.equal((await db.enrollment.findUniqueOrThrow({ where: { id: e3.id } })).feeCents, 3500, "taken off: the class's price again");
    assert.deepEqual((await classCreditsFor(a.shopId, cust.id)).map((c) => c.left), [1]);
    ok("owner's classes: two free seats, the third refused, a cancelled seat gives one back, taking it off restores the price");

    // 4. A ticket line covered by the cleaning plan: twice (two tickets), not a third time; charged again.
    const ticket = async (n: number) =>
      db.ticket.create({
        data: { shopId: a.shopId, number: 9000 + n, machineId: m1, customerId: cust.id, lines: { create: [{ kind: "SERVICE", description: "Clean and oil", qty: 1, unitPriceCents: 8900 }, { kind: "DISCOUNT", description: "Off", qty: 1, unitPriceCents: -500 }] } },
        include: { lines: { orderBy: { unitPriceCents: "desc" } } },
      });
    const cleaning = plans1.find((p) => p.name === "Free yearly cleaning")!;
    const t1 = await ticket(1);
    const t2 = await ticket(2);
    const t3 = await ticket(3);
    await coverLineFor(tech(a), t1.lines[0].id, cleaning.id);
    const covered = await db.ticketLine.findUniqueOrThrow({ where: { id: t1.lines[0].id } });
    assert.ok(covered.unitPriceCents === 0 && covered.coveredCents === 8900 && covered.coveredPlanId === cleaning.id);
    await expectError("covering a discount", () => coverLineFor(user(a), t1.lines[1].id, cleaning.id), /service, labor and parts/);
    await coverLineFor(user(a), t2.lines[0].id, cleaning.id);
    await expectError("a third visit", () => coverLineFor(user(a), t3.lines[0].id, cleaning.id), /all 2 covered visits are used/);
    await coverLineFor(user(a), t2.lines[0].id, null);
    assert.equal((await db.ticketLine.findUniqueOrThrow({ where: { id: t2.lines[0].id } })).unitPriceCents, 8900, "charged again at its price");
    await coverLineFor(user(a), t3.lines[0].id, cleaning.id);
    const old = await db.ticket.create({ data: { shopId: a.shopId, number: 9099, machineId: m1, intakeAt: new Date(2020, 0, 1), lines: { create: { kind: "LABOR", description: "Repair", qty: 1, unitPriceCents: 5000 } } }, include: { lines: true } });
    await expectError("before the plan began", () => coverLineFor(user(a), old.lines[0].id, cleaning.id), /didn't cover the day/);
    assert.equal(await db.auditEntry.count({ where: { shopId: a.shopId, action: "ticket.covered" } }), 4);
    const report = await coveredWork(a.shopId, new Date(2026, 0, 1), new Date(2100, 0, 1));
    assert.deepEqual(report, [{ plan: "Free yearly cleaning", lines: 2, cents: 17800 }]);
    ok("a plan covers a line (zero charge, the price kept for the report), two visits then refused, charged again, not before it began; audited");

    // 5. Return the machine: its plans end and the classes go; void the return: back again; void the sale: plans end.
    const s2 = await completeSaleAs(user(a), { customerId: cust.id, lines: [{ description: "", qty: -1, unitPriceCents: 120000, taxable: true, stockUnitId: u1 }], tenders: cash(-120000) });
    assert.ok((await machinePlansFor(a.shopId, m1, "America/New_York")).every((p) => p.voided), "returned: its plans end");
    assert.deepEqual(await classCreditsFor(a.shopId, cust.id), [], "returned: no classes left to book");
    assert.ok((await machinePlansFor(a.shopId, own.id, "America/New_York")).every((p) => !p.voided), "the plan on the customer's own machine stays");
    await voidSaleAs(user(a), s2.saleId, "rung up by mistake");
    assert.ok((await machinePlansFor(a.shopId, m1, "America/New_York")).every((p) => !p.voided), "the return voided: the plans run again");
    await voidSaleAs(user(a), s1.saleId, "test");
    assert.ok((await machinePlansFor(a.shopId, m1, "America/New_York")).every((p) => p.voided), "the sale voided: its plans end");
    assert.ok((await machinePlansFor(a.shopId, own.id, "America/New_York")).every((p) => p.voided), "and the plan sold for the customer's machine");
    ok("a return ends the machine's plans and its classes; voiding the return starts them again; voiding the sale ends every plan it sold");

    // 6. Sold units are fixed; the registration reminder after a week; ending a plan by hand.
    const s3 = await completeSaleAs(user(a), { customerId: cust.id, lines: [{ description: "", qty: 1, unitPriceCents: 120000, taxable: false, stockUnitId: u2 }], tenders: cash(120000) });
    await updateUnitFor(user(a), u2, form({ classCredits: "9", bundle: "Bobbins" }));
    const d2 = (await unitDetail(a.shopId, u2))!;
    assert.ok(d2.classCredits === 2 && d2.bundle === "Bobbins", "classes are fixed once sold; the bundle can still be corrected");
    assert.equal((await unitsToRegister(a.shopId)).length, 0, "not a week yet");
    const later = await unitsToRegister(a.shopId, new Date(Date.now() + 8 * 86_400_000));
    assert.equal(later.length, 1);
    assert.equal(later[0].registerUrl, "https://example.test/register");
    const p2 = (await machinePlansFor(a.shopId, d2.machineId, "America/New_York"))[0];
    await expectError("a tech ending a plan", () => endPlanFor(tech(a), p2.id), /owner or admin/);
    await endPlanFor(user(a), p2.id);
    await expectError("ended twice", () => endPlanFor(user(a), p2.id), /already ended/);
    void s3;
    ok("classes and the plan are fixed once sold; the registration reminder after a week, with the maker's page; an owner ends a plan");

    // 7. Tenant: B can't see or touch A's units, plans, terms or ticket lines.
    const before = await snapshot(a.shopId, ["StockUnit", "MachinePlan", "ServicePlan", "MakerWarranty"]);
    assert.equal(await unitDetail(b.shopId, u2), null);
    await expectError("B ends A's plan", () => endPlanFor(user(b), p2.id), /not found/);
    await expectError("B covers A's line", () => coverLineFor(user(b), t3.lines[0].id, null), /not found/);
    await expectError("B changes A's plan", () => savePlanFor(user(b), planId, form({ name: "Mine", months: "12" })), /not found/);
    await expectError("B sells A's plan", () => preparePlanLine({ shopId: b.shopId, role: "OWNER", customerId: null, unitIdsOnSale: [] }, { planId, machineId: own.id }, 1, 0), /isn't on sale/);
    await expectError("B uses A's unit's classes", () => applyClassCreditAs(user(b), e3.id, u1), /not found|isn't turned on/);
    assert.deepEqual(await classCreditsFor(b.shopId, cust.id), []);
    assert.deepEqual(await listMakerTerms(b.shopId), []);
    assertUnchanged("tenant", before, await snapshot(a.shopId, ["StockUnit", "MachinePlan", "ServicePlan", "MakerWarranty"]));
    ok("tenant: B's calls with A's ids answer not found; A's rows are unchanged");
  } finally {
    await cleanup();
  }
  console.log(`machine-sales.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
