// Sales tax and tax-exempt customers (later-round-1-design.md 3.3): an exempt customer's sale and ticket charge no tax and
// keep the certificate number; "charge tax anyway" and an expired certificate charge it; taxable times rate equals the
// tax to the cent; the audit trail; one company's customers never exempt another's sales.
//   npm run check scripts/checks/sales-tax.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { completeSaleAs, voidSaleAs, type SaleInput } from "@/lib/register-sale";
import { exemptCertificate, parseExemptUntil } from "@/lib/tax-exempt";
import { openingTax, setTicketTaxFor } from "@/lib/ticket-tax";
import { ticketTotals } from "@/lib/ticket-math";
import { modelKey } from "@/lib/format";
import { AUDIT_ACTIONS } from "@/lib/audit-list";
import { checkShop, cleanup } from "./lib";
import { expectNotFound, rowsOf } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

const cash = (cents: number) => ({ method: "CASH" as const, amountCents: cents });
const DAY = 86_400_000;

async function main() {
  const a = await checkShop({ repair: true, retail: true });
  const b = await checkShop({ repair: true, retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 6.35 } });
    const part = await db.part.create({ data: { shopId: a.shopId, partNumber: "TX-P1", description: "Thread", priceCents: 1999, qtyOnHand: 100, numberKeys: [] } });
    const line = (qty: number): SaleInput["lines"][number] => ({ partId: part.id, description: "x", qty, unitPriceCents: 1999, taxable: true });

    // ---------- the rule ----------
    const now = new Date();
    assert.equal(exemptCertificate({ taxExemptId: "R-1", taxExemptUntil: null }), "R-1");
    assert.equal(exemptCertificate({ taxExemptId: "  ", taxExemptUntil: null }), null);
    assert.equal(exemptCertificate({ taxExemptId: "R-1", taxExemptUntil: new Date(now.getTime() - 2 * DAY) }), null, "expired");
    assert.equal(exemptCertificate({ taxExemptId: "R-1", taxExemptUntil: new Date(now.getTime() + DAY) }), "R-1");
    assert.equal(exemptCertificate({ taxExemptId: "R-1", taxExemptUntil: new Date(now.getTime() - 3600_000) }), "R-1", "good through its last day");
    assert.deepEqual(parseExemptUntil(""), { date: null });
    assert.ok("error" in parseExemptUntil("next June"));
    ok("the rule: a certificate number, good through its last day");

    const plain = await db.customer.create({ data: { shopId: a.shopId, name: "Plain Pat" } });
    const exempt = await db.customer.create({ data: { shopId: a.shopId, name: "Resale Rae", taxExemptId: "RC-4471", taxExemptUntil: new Date(now.getTime() + 30 * DAY) } });
    const expired = await db.customer.create({ data: { shopId: a.shopId, name: "Old Cert", taxExemptId: "RC-0001", taxExemptUntil: new Date(now.getTime() - 40 * DAY) } });

    // ---------- the register ----------
    const normal = await completeSaleAs(a.user, { customerId: plain.id, lines: [line(3)], tenders: [cash(7000)] });
    const n1 = await db.sale.findFirstOrThrow({ where: { id: normal.saleId } });
    assert.equal(n1.taxRatePct, 6.35);
    assert.equal(n1.taxCents, Math.round((3 * 1999 * 6.35) / 100), "taxable times rate equals tax to the cent");
    assert.equal(n1.taxExemptId, null);
    const none = await completeSaleAs(a.user, { lines: [line(1)], tenders: [cash(2500)] });
    assert.ok((await db.sale.findFirstOrThrow({ where: { id: none.saleId } })).taxCents > 0, "no customer: taxed");

    const ex = await completeSaleAs(a.user, { customerId: exempt.id, lines: [line(3)], tenders: [cash(7000)] });
    const s2 = await db.sale.findFirstOrThrow({ where: { id: ex.saleId } });
    assert.equal(s2.taxCents, 0);
    assert.equal(s2.taxRatePct, 0);
    assert.equal(s2.taxExemptId, "RC-4471", "the certificate is kept on the sale");
    assert.equal(s2.totalCents, 3 * 1999);
    assert.equal(ex.changeCents, 7000 - 3 * 1999);

    const anyway = await completeSaleAs(a.user, { customerId: exempt.id, chargeTax: true, lines: [line(3)], tenders: [cash(7000)] });
    const s3 = await db.sale.findFirstOrThrow({ where: { id: anyway.saleId } });
    assert.equal(s3.taxCents, n1.taxCents);
    assert.equal(s3.taxExemptId, null, "taxed anyway: no certificate recorded");

    const old = await completeSaleAs(a.user, { customerId: expired.id, lines: [line(1)], tenders: [cash(2500)] });
    const s4 = await db.sale.findFirstOrThrow({ where: { id: old.saleId } });
    assert.ok(s4.taxCents > 0 && s4.taxExemptId == null, "an expired certificate pays tax");

    // a return for an exempt customer mirrors: no tax comes back
    const ret = await completeSaleAs(a.user, { customerId: exempt.id, lines: [{ ...line(-1) }], tenders: [cash(-1999)] });
    const s5 = await db.sale.findFirstOrThrow({ where: { id: ret.saleId } });
    assert.equal(s5.taxCents, 0);
    assert.equal(s5.totalCents, -1999);

    // a void keeps the certificate on the record
    await voidSaleAs(a.user, ex.saleId, "check");
    assert.equal((await db.sale.findFirstOrThrow({ where: { id: ex.saleId } })).taxExemptId, "RC-4471");
    ok("register: exempt sales charge no tax and keep the certificate; charge-anyway and expired certificates are taxed; returns mirror");

    // ---------- tickets ----------
    const rate = 6.35;
    const t0 = await openingTax(db, a.shopId, rate, exempt.id, null);
    assert.deepEqual(t0, { taxRatePct: 0, taxExemptId: "RC-4471" });
    assert.deepEqual(await openingTax(db, a.shopId, rate, plain.id, null), { taxRatePct: rate, taxExemptId: null });
    assert.deepEqual(await openingTax(db, a.shopId, rate, expired.id, null), { taxRatePct: rate, taxExemptId: null });
    assert.deepEqual(await openingTax(db, a.shopId, rate, plain.id, exempt.id), { taxRatePct: 0, taxExemptId: "RC-4471" }, "a trade account's certificate counts");
    assert.deepEqual(await openingTax(db, a.shopId, rate, null, null), { taxRatePct: rate, taxExemptId: null });

    const m = await db.machine.create({ data: { shopId: a.shopId, customerId: exempt.id, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
    const t = await db.ticket.create({ data: { shopId: a.shopId, number: 9801, status: "ON_BENCH", machineId: m.id, customerId: exempt.id, intake: {}, taxRatePct: rate } });
    await db.ticketLine.create({ data: { ticketId: t.id, kind: "SERVICE", description: "Service", qty: 1, unitPriceCents: 10000 } });
    const lines = await db.ticketLine.findMany({ where: { ticketId: t.id } });
    assert.equal(ticketTotals(lines, [], rate).tax, 635);
    await setTicketTaxFor(a.user, t, false);
    const t1 = await db.ticket.findFirstOrThrow({ where: { id: t.id } });
    assert.equal(t1.taxRatePct, 0);
    assert.equal(t1.taxExemptId, "RC-4471");
    assert.equal(ticketTotals(lines, [], t1.taxRatePct).tax, 0);
    await setTicketTaxFor(a.user, t1, true);
    const t2 = await db.ticket.findFirstOrThrow({ where: { id: t.id } });
    assert.equal(t2.taxRatePct, rate);
    assert.equal(t2.taxExemptId, null);
    // a customer with no certificate can't have the tax taken off
    const m2 = await db.machine.create({ data: { shopId: a.shopId, customerId: plain.id, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
    const t3 = await db.ticket.create({ data: { shopId: a.shopId, number: 9802, status: "ON_BENCH", machineId: m2.id, customerId: plain.id, intake: {}, taxRatePct: rate } });
    await assert.rejects(setTicketTaxFor(a.user, t3, false), (e) => isUserError(e) && /no tax-exempt certificate/.test((e as Error).message));
    ok("tickets: open untaxed for an exempt customer (or trade account); switched off and on with the certificate recorded; none without one");

    // ---------- audit ----------
    assert.ok(AUDIT_ACTIONS["ticket.tax"] && AUDIT_ACTIONS["customer.taxexempt"]);
    const entries = await db.auditEntry.findMany({ where: { shopId: a.shopId, action: "ticket.tax" } });
    assert.equal(entries.length, 2, "both switches are on the log");
    assert.equal(entries[0].subjectId, t.id);
    ok("audit: ticket tax switches logged");

    // ---------- tenant ----------
    const before = await rowsOf("Sale", a.shopId);
    await expectNotFound("B sells to A's exempt customer", () => completeSaleAs(b.user, { customerId: exempt.id, lines: [{ description: "x", qty: 1, unitPriceCents: 1000, taxable: true }], tenders: [cash(2000)] }));
    assert.equal(await rowsOf("Sale", a.shopId), before);
    assert.deepEqual(await openingTax(db, b.shopId, rate, exempt.id, null), { taxRatePct: rate, taxExemptId: null }, "B's tickets never read A's certificate");
    await expectNotFound("B switches A's ticket", () => setTicketTaxFor(b.user, t3, true));
    ok("tenant: another company's customer and ticket stay out of reach");

    console.log(`\n${steps} sales-tax checks passed`);
  } finally {
    await cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
