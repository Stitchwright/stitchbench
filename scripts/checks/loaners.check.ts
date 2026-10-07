// Loaner and demo machines (shop-features-round-2-design.md 1.7): a unit's use (owner or admin; not while out; "Sell
// this one" back on sale as open box); loaners and demos left out of the register's machine search and refused there;
// lending on a ticket (only loaners in, the due day by default, the deposit rung up as money held, once at a time);
// "It's back" (the deposit given back, or part kept as "Loaner charges" by an owner); a demo out with no customer; the
// overdue count; the books; the tenant section.
//   npm run -s check scripts/checks/loaners.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { balanced, buildBooks } from "@/lib/books";
import { DEFAULT_BOOKS } from "@/lib/books-accounts";
import { completeSaleAs } from "@/lib/register-sale";
import { receiveUnitsFor, unitsForSaleFor } from "@/lib/units/units";
import { registerUnitHits } from "@/lib/units/sale-units";
import { backFor, heldForLoans, lendFor, loanCounts, loanDefaults, loansFor, setUnitUseFor, unitsToLend } from "@/lib/loans";
import { addDays, ymdOf } from "@/lib/zoned";
import { shopTimeZone } from "@/lib/shop-zone";
import { checkShop, cleanup } from "./lib";
import { expectNotFound } from "./tenant";

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

const SEWING = { kind: "sewing", brand: "Brother", model: "CS6000i", condition: "NEW", priceCents: "199.00" };

async function main() {
  const a = await checkShop({ retail: true, repair: true });
  const b = await checkShop({ retail: true, repair: true });
  const tech = { ...a.user, role: "TECH" as const };
  try {
    const [loaner, demo] = await receiveUnitsFor(a.user, form({ ...SEWING, serials: "LOAN-1\nDEMO-1" }));
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Borrower" } });
    const machine = await db.machine.create({ data: { shopId: a.shopId, customerId: jane.id, brand: "Janome", model: "HD3000", modelKey: "HD3000" } });
    const ticket = await db.ticket.create({ data: { shopId: a.shopId, number: 1, customerId: jane.id, machineId: machine.id } });

    // 1. Uses.
    await expectError("a tech", () => setUnitUseFor(tech, loaner, form({ use: "LOANER" })), /owner or admin/);
    await setUnitUseFor(a.user, loaner, form({ use: "LOANER" }));
    await setUnitUseFor(a.user, demo, form({ use: "DEMO" }));
    assert.deepEqual(await unitsForSaleFor(a.shopId, "CS6000i"), [], "loaners and demos aren't for sale");
    assert.deepEqual(await registerUnitHits({ shopId: a.shopId, q: "LOAN-1", mode: "code" }), []);
    await expectError("selling a loaner", () => completeSaleAs(a.user, { customerId: jane.id, lines: [{ description: "", qty: 1, unitPriceCents: 19_900, taxable: true, stockUnitId: loaner }], tenders: [{ method: "CASH", amountCents: 19_900 }] }), /is a loaner/);
    assert.deepEqual((await unitsToLend(a.shopId, "LOANER")).length, 1);
    ok("a loaner and a demo: out of the register's machine search and refused there; techs can't change a use");

    // 2. Lend on a ticket with a $50 deposit.
    await db.shop.update({ where: { id: a.shopId }, data: { loanerDepositCents: 5000 } });
    const d = await loanDefaults(a.shopId);
    const today = ymdOf(new Date(), await shopTimeZone(a.shopId));
    assert.deepEqual(d, { dueOn: addDays(today, 14), depositCents: 5000 });
    await expectError("no customer", () => lendFor(a.user, { unitId: loaner }), /who's borrowing/);
    await expectError("a demo as a loaner", () => lendFor(a.user, { unitId: demo, customerId: jane.id }), /isn't a loaner/);
    await expectError("no tender", () => lendFor(a.user, { unitId: loaner, customerId: jane.id, ticketId: ticket.id, depositCents: 5000 }), /how she's paying/);
    const l1 = await lendFor(tech, { unitId: loaner, customerId: jane.id, ticketId: ticket.id, depositCents: 5000, tender: { method: "CASH", amountCents: 5000 }, conditionOut: "Good, scratch on the bed" });
    const dep = await db.saleLine.findFirstOrThrow({ where: { saleId: l1.saleId! } });
    assert.ok(dep.kind === "DEPOSIT" && dep.unitLoanId === l1.loanId && !dep.taxable);
    assert.equal((await heldForLoans(a.shopId, [l1.loanId])).get(l1.loanId), 5000);
    await expectError("lent twice", () => lendFor(a.user, { unitId: loaner, customerId: jane.id }), /out already/);
    assert.deepEqual(await unitsToLend(a.shopId, "LOANER"), [], "an out loaner isn't offered");
    const onTicket = await loansFor(a.shopId, { ticketId: ticket.id, out: true });
    assert.ok(onTicket.length === 1 && onTicket[0].dueOn === addDays(today, 14) && onTicket[0].conditionOut === "Good, scratch on the bed");
    await expectError("changing an out loaner's use", () => setUnitUseFor(a.user, loaner, form({ use: "SALE" })), /out right now/);
    ok("lent on her ticket by a tech: due in 14 days by default, the $50 deposit money held (untaxed); once at a time; not offered while out");

    // 3. A demo, overdue; back.
    const l2 = await lendFor(a.user, { unitId: demo, kind: "DEMO", dueOn: addDays(today, -1), note: "Guild meeting" });
    assert.deepEqual(await loanCounts(a.shopId), { out: 2, overdue: 1 });
    await backFor(a.user, l2.loanId, { conditionBack: "Fine" });
    await expectError("back twice", () => backFor(a.user, l2.loanId), /back already/);
    await expectError("a tech keeping the deposit", () => backFor(tech, l1.loanId, { keepCents: 2000 }), /owner or admin/);
    const r = await backFor(a.user, l1.loanId, { conditionBack: "Bobbin cover cracked", keepCents: 2000, method: "CASH" });
    assert.deepEqual([r.backCents, r.keptCents], [3000, 2000]);
    const sale = await db.sale.findUniqueOrThrow({ where: { id: r.saleId! }, include: { lines: true } });
    assert.ok(sale.lines.some((l) => l.kind === "LOAN_FEE" && l.unitPriceCents === 2000) && sale.totalCents === -3000);
    assert.equal(await db.auditEntry.count({ where: { shopId: a.shopId, action: "loan.keep" } }), 1);
    assert.deepEqual(await loanCounts(a.shopId), { out: 0, overdue: 0 });
    ok("a demo out with no customer (overdue counted) and back; the loaner back with $20 kept as a loaner charge and $30 given back");

    // 4. Sell this one; the books.
    await setUnitUseFor(a.user, demo, form({ use: "SALE" }));
    const sold = await db.stockUnit.findUniqueOrThrow({ where: { id: demo } });
    assert.ok(sold.use === "SALE" && sold.condition === "OPEN_BOX");
    assert.equal((await unitsForSaleFor(a.shopId, "DEMO-1")).length, 1);
    const books = await buildBooks(a.shopId, "America/New_York", new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000), DEFAULT_BOOKS);
    assert.ok(books.days.every(balanced) && books.unbalancedSales === 0);
    const deposits = books.days.flatMap((x) => x.lines).filter((l) => l.account === "Customer Deposits").reduce((x, l) => x + l.creditCents - l.debitCents, 0);
    assert.equal(deposits, 0, "the deposit in and out of Customer Deposits");
    ok("Sell this one: the demo for sale again as open box; the books balance with the deposit in and out");

    // 5. Tenant.
    await expectNotFound("B lends A's loaner", () => lendFor(b.user, { unitId: loaner, customerId: jane.id }));
    await expectNotFound("B marks A's loan back", () => backFor(b.user, l1.loanId));
    await expectNotFound("B changes A's unit", () => setUnitUseFor(b.user, loaner, form({ use: "SALE" })));
    assert.deepEqual(await loansFor(b.shopId, { unitId: loaner }), []);
    assert.deepEqual(await unitsToLend(b.shopId, "LOANER"), []);
    ok("tenant: another company can't lend, mark back, change or see A's loaners");

    console.log(`loaners.check: ${steps} groups passed`);
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
