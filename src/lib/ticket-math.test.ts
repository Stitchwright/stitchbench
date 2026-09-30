// Unit tests for a repair ticket's money and the partnership's commission (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { lineTotal, ticketTotals } from "./ticket-math";
import { normalizeTerms, repairCommission } from "./partner-terms";

const svc = (unitPriceCents: number, extra: { qty?: number; taxable?: boolean; kind?: string } = {}) => ({ kind: "SERVICE", qty: 1, unitPriceCents, taxable: false, ...extra });

test("line totals round to the cent; parts and labor can be fractions", () => {
  assert.equal(lineTotal({ qty: 2.5, unitPriceCents: 199 }), 498); // 497.5
  assert.equal(lineTotal({ qty: 0.25, unitPriceCents: 6000 }), 1500);
});

test("labor, part and fee with no tax", () => {
  const t = ticketTotals([svc(4500), { kind: "LABOR", qty: 0.5, unitPriceCents: 6000, taxable: false }, { kind: "PART", qty: 2, unitPriceCents: 350, taxable: false }], [], 0);
  assert.deepEqual([t.subtotal, t.tax, t.total, t.balance], [8200, 0, 8200, 8200]);
  assert.deepEqual([t.service, t.labor, t.parts], [4500, 3000, 700]);
});

test("tax is on the taxable lines only, after the discount takes its proportional share off", () => {
  // $100 taxable service, $20 off, 8.25%: tax on $80
  const t = ticketTotals([svc(10000, { taxable: true }), { kind: "DISCOUNT", qty: 1, unitPriceCents: -2000, taxable: false }], [], 8.25);
  assert.equal(t.subtotal, 8000);
  assert.equal(t.tax, 660);
  assert.equal(t.total, 8660);
  // A taxable and a non-taxable line share the discount in proportion: $60 of $100 taxable, $10 off = $6 off the taxable part
  const mixed = ticketTotals([svc(6000, { taxable: true }), svc(4000), { kind: "DISCOUNT", qty: 1, unitPriceCents: -1000, taxable: false }], [], 10);
  assert.equal(mixed.tax, 540); // 10% of 5400
  assert.equal(mixed.total, 9000 + 540);
});

test("a discount larger than the bill never makes negative tax", () => {
  const t = ticketTotals([svc(5000, { taxable: true }), { kind: "DISCOUNT", qty: 1, unitPriceCents: -8000, taxable: false }], [], 8.25);
  assert.equal(t.tax, 0);
  assert.equal(t.total, -3000);
});

test("payments: refunds add to the balance, a bill put on account stays owed", () => {
  const lines = [svc(8000, { taxable: true })];
  const paid = ticketTotals(lines, [{ amountCents: 10000, method: "CASH" }, { amountCents: -1340, method: "CASH" }], 8.25);
  assert.equal(paid.total, 8660);
  assert.equal(paid.paid, 8660);
  assert.equal(paid.balance, 0);
  const onAccount = ticketTotals(lines, [{ amountCents: 8660, method: "INVOICE" }], 8.25);
  assert.equal(onAccount.paid, 0);
  assert.equal(onAccount.balance, 8660);
  // Money a partner shop took at its counter is paid, as far as the customer is concerned
  assert.equal(ticketTotals(lines, [{ amountCents: 8660, method: "SHOP_COLLECTED" }], 8.25).balance, 0);
});

test("a trade account's commission is a share of the service price; a partner job's own figure wins", () => {
  const lines = [svc(9998, { qty: 1 }), { kind: "PART", qty: 1, unitPriceCents: 5000, taxable: false }];
  assert.equal(ticketTotals(lines, [], 0, 10).commission, 1000); // 999.8 rounds to 1000
  assert.equal(ticketTotals(lines, [], 0, 12.5).commission, 1250); // 1249.75
  assert.equal(ticketTotals(lines, [], 0, null).commission, 0);
  assert.equal(ticketTotals(lines, [], 0, 10, 1500).commission, 1500);
  assert.equal(ticketTotals(lines, [], 0, 10, 0).commission, 0, "a partner commission of zero is zero, not the trade percentage");
  assert.equal(ticketTotals([svc(4999, { qty: 2 })], [], 0, 12.5).commission, 1250); // 9998 x 12.5%
});

test("the sewing shop's commission on a repair, by the partnership's terms", () => {
  const bill = [
    { kind: "SERVICE", amountCents: 8000 },
    { kind: "LABOR", amountCents: 3000 },
    { kind: "PART", amountCents: 2500 },
    { kind: "DISCOUNT", amountCents: -1000 },
  ];
  assert.equal(repairCommission(bill, { repairCommissionPct: 10, commissionOn: "service" }), 1000); // 10% of 10,000
  assert.equal(repairCommission(bill, { repairCommissionPct: 10, commissionOn: "total" }), 1250); // 10% of 12,500
  assert.equal(repairCommission(bill, { repairCommissionPct: 0, commissionOn: "total" }), 0);
  assert.equal(repairCommission([{ kind: "DISCOUNT", amountCents: -500 }], { repairCommissionPct: 10, commissionOn: "service" }), 0, "never negative");
  assert.equal(repairCommission([{ kind: "SERVICE", amountCents: 1005 }], { repairCommissionPct: 10, commissionOn: "service" }), 101); // 100.5
});

test("terms from anywhere are kept in range", () => {
  assert.equal(normalizeTerms({ repairCommissionPct: 80 }).repairCommissionPct, 50);
  assert.equal(normalizeTerms({ repairCommissionPct: -5 }).repairCommissionPct, 0);
  assert.equal(normalizeTerms({ repairCommissionPct: "abc" }).repairCommissionPct, normalizeTerms({}).repairCommissionPct);
  assert.equal(normalizeTerms(null).commissionOn, "service");
});
