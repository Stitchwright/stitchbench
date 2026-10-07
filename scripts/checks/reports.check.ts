// Reports and the sales-tax report (later-round-1-design.md section 3): a seeded March and April with discounts, a return, a
// void on a later day (across a quarter's end), a partner-style gift card sold and spent, an online order, tickets with labor
// and parts, an exempt customer and a rate change give hand-worked figures; the days add up to the totals; one company never
// sees another's rows.
//   npm run check scripts/checks/reports.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { completeSaleAs, voidSaleAs, type SaleInput } from "@/lib/register-sale";
import { modelKey } from "@/lib/format";
import { monthRange } from "@/lib/time-zone";
import { periodKey, salesReport } from "@/lib/reports/sales";
import { ticketsReport, topCustomers } from "@/lib/reports/tickets";
import { liabilityReport } from "@/lib/reports/giftcards";
import { stateOf, taxReport } from "@/lib/reports/tax";
import { saleLineKind } from "@/lib/sale-kind";
import { checkShop, cleanup } from "./lib";
import { rowsOf } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

const TZ = "America/New_York";
const at = (day: string) => new Date(`${day}T16:00:00Z`); // noon in New York, either side of the clock change
const cash = (cents: number) => ({ method: "CASH" as const, amountCents: cents });
let n = 9900;

async function main() {
  const a = await checkShop({ repair: true, retail: true });
  const b = await checkShop({ repair: true, retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 6 } });
    const p1 = await db.part.create({ data: { shopId: a.shopId, partNumber: "RP-1", description: "Hook", kind: "NOTION", priceCents: 1000, costCents: 400, qtyOnHand: 500, numberKeys: [] } });
    const p2 = await db.part.create({ data: { shopId: a.shopId, partNumber: "RP-2", description: "Spool", kind: "THREAD", priceCents: 2000, costCents: 800, qtyOnHand: 500, numberKeys: [] } });
    const item = (p: typeof p1, qty: number, extra: Partial<SaleInput["lines"][number]> = {}): SaleInput["lines"][number] => ({ partId: p.id, description: "x", qty, unitPriceCents: p.priceCents!, taxable: true, ...extra });
    const custA = await db.customer.create({ data: { shopId: a.shopId, name: "Ann A" } });
    const custB = await db.customer.create({ data: { shopId: a.shopId, name: "Bea B" } });
    const exempt = await db.customer.create({ data: { shopId: a.shopId, name: "Resale Co", taxExemptId: "RC-77" } });
    const put = async (id: string, day: string) => {
      await db.sale.update({ where: { id }, data: { createdAt: at(day) } });
      return id;
    };

    // ---------- March ----------
    const s1 = await completeSaleAs(a.user, { customerId: custA.id, lines: [item(p1, 3)], tenders: [cash(3180)] });
    await put(s1.saleId, "2026-03-03");
    const s2 = await completeSaleAs(a.user, { customerId: custB.id, lines: [item(p2, 1)], orderDiscountCents: 500, tenders: [{ method: "CARD", amountCents: 1590 }] });
    await put(s2.saleId, "2026-03-03");
    const s3 = await completeSaleAs(a.user, { customerId: custA.id, lines: [item(p1, 2, { discountCents: 200 })], tenders: [cash(2000)] });
    await put(s3.saleId, "2026-03-04");
    const s4 = await completeSaleAs(a.user, { lines: [item(p1, -1)], tenders: [cash(-1060)] });
    await put(s4.saleId, "2026-03-05");
    const s5 = await completeSaleAs(a.user, { lines: [item(p1, 1)], tenders: [cash(1060)] });
    await put(s5.saleId, "2026-03-06");
    await voidSaleAs(a.user, s5.saleId, "check");
    await db.sale.update({ where: { id: s5.saleId }, data: { voidedAt: at("2026-03-08") } });
    const gift = await completeSaleAs(a.user, { customerId: custB.id, lines: [{ giftCard: { mode: "new" }, description: "Gift card", qty: 1, unitPriceCents: 5000, taxable: false }], tenders: [cash(5000)] });
    await put(gift.saleId, "2026-03-07");
    const card = await db.giftCard.findFirstOrThrow({ where: { shopId: a.shopId } });
    const s7 = await completeSaleAs(a.user, { customerId: custB.id, lines: [item(p2, 1)], tenders: [{ method: "GIFT", amountCents: 2120, cardNumber: card.number }] });
    await put(s7.saleId, "2026-03-09");
    const s8 = await completeSaleAs(a.user, { lines: [item(p1, 1)], tenders: [{ method: "ONLINE", amountCents: 1060 }] }, { paidOnline: true });
    await put(s8.saleId, "2026-03-10");
    const s11 = await completeSaleAs(a.user, { lines: [item(p1, 1)], tenders: [cash(1060)] });
    await put(s11.saleId, "2026-03-30");
    await voidSaleAs(a.user, s11.saleId, "check");
    await db.sale.update({ where: { id: s11.saleId }, data: { voidedAt: at("2026-04-02") } });
    await db.giftCardEntry.updateMany({ where: { saleId: gift.saleId }, data: { at: at("2026-03-07") } });
    await db.giftCardEntry.updateMany({ where: { saleId: s7.saleId }, data: { at: at("2026-03-09") } });

    const m = await db.machine.create({ data: { shopId: a.shopId, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
    const ticket = async (o: { customerId?: string; status: "COLLECTED" | "RETURNED_UNREPAIRED" | "ON_BENCH"; intake: string; ready?: string; closed?: string; rate?: number; exemptId?: string; lines: { kind: "SERVICE" | "LABOR" | "PART"; qty?: number; cents: number; taxable?: boolean }[]; pays?: { method: "CASH" | "CARD"; cents: number; day: string }[] }) => {
      const t = await db.ticket.create({
        data: {
          shopId: a.shopId,
          number: n++,
          status: o.status,
          machineId: m.id,
          customerId: o.customerId,
          techId: a.user.id,
          intake: {},
          intakeAt: at(o.intake),
          readyAt: o.ready ? at(o.ready) : null,
          closedAt: o.closed ? at(o.closed) : null,
          taxRatePct: o.rate ?? 6,
          taxExemptId: o.exemptId,
        },
      });
      for (const l of o.lines) await db.ticketLine.create({ data: { ticketId: t.id, kind: l.kind, description: l.kind, qty: l.qty ?? 1, unitPriceCents: l.cents, taxable: l.taxable ?? true } });
      for (const p of o.pays ?? []) await db.payment.create({ data: { ticketId: t.id, method: p.method, amountCents: p.cents, paidAt: at(p.day) } });
      return t;
    };
    await ticket({ customerId: custA.id, status: "COLLECTED", intake: "2026-03-08", ready: "2026-03-11", closed: "2026-03-12", lines: [{ kind: "SERVICE", cents: 8000 }, { kind: "LABOR", cents: 2000, taxable: false }, { kind: "PART", cents: 1000 }], pays: [{ method: "CASH", cents: 11540, day: "2026-03-12" }] });
    await ticket({ customerId: custB.id, status: "RETURNED_UNREPAIRED", intake: "2026-03-18", closed: "2026-03-20", lines: [{ kind: "SERVICE", cents: 2500 }], pays: [{ method: "CARD", cents: 2650, day: "2026-03-20" }] });
    await ticket({ status: "ON_BENCH", intake: "2026-03-25", lines: [] });
    await ticket({ status: "ON_BENCH", intake: "2026-02-01", lines: [] });

    const mar = monthRange("2026-03-01", "2026-03-31", TZ);
    const r = await salesReport(a.shopId, TZ, mar.start, mar.end, "day");
    const day = (d: string) => r.rows.find((x) => x.period === d)!;
    assert.deepEqual(r.rows.map((x) => x.period), ["2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10", "2026-03-12", "2026-03-20", "2026-03-30"]);
    assert.deepEqual({ ...day("2026-03-03") }, { period: "2026-03-03", counter: 4500, repairs: 0, online: 0, returns: 0, voids: 0, discounts: 500, net: 4500, tax: 270, taken: 4770 });
    assert.deepEqual({ ...day("2026-03-04") }, { period: "2026-03-04", counter: 1800, repairs: 0, online: 0, returns: 0, voids: 0, discounts: 200, net: 1800, tax: 108, taken: 1908 }, "line discount; change comes off cash");
    assert.deepEqual({ ...day("2026-03-05") }, { period: "2026-03-05", counter: 0, repairs: 0, online: 0, returns: -1000, voids: 0, discounts: 0, net: -1000, tax: -60, taken: -1060 }, "a return on its own day");
    assert.equal(day("2026-03-06").counter, 1000);
    assert.equal(day("2026-03-07").net, 0, "a gift card sold is not a sale");
    assert.equal(day("2026-03-07").taken, 5000, "but the money was taken");
    assert.deepEqual({ voids: day("2026-03-08").voids, tax: day("2026-03-08").tax, taken: day("2026-03-08").taken }, { voids: -1000, tax: -60, taken: -1060 }, "a void on the day it happened");
    assert.deepEqual({ counter: day("2026-03-09").counter, taken: day("2026-03-09").taken }, { counter: 2000, taken: 0 }, "spent from a gift card: a sale, no new money");
    assert.deepEqual({ online: day("2026-03-10").online, taken: day("2026-03-10").taken }, { online: 1000, taken: 1060 });
    assert.deepEqual({ repairs: day("2026-03-12").repairs, tax: day("2026-03-12").tax, taken: day("2026-03-12").taken }, { repairs: 11000, tax: 540, taken: 11540 }, "a repair when handed back");
    assert.deepEqual({ repairs: day("2026-03-20").repairs, tax: day("2026-03-20").tax, taken: day("2026-03-20").taken }, { repairs: 2500, tax: 150, taken: 2650 });
    assert.deepEqual({ ...r.totals }, { period: "Total", counter: 10300, repairs: 13500, online: 1000, returns: -1000, voids: -1000, discounts: 700, net: 22800, tax: 1248, taken: 26928 });
    for (const k of ["counter", "repairs", "online", "returns", "voids", "discounts", "net", "tax", "taken"] as const) assert.equal(r.rows.reduce((s, x) => s + x[k], 0), r.totals[k], `days add up: ${k}`);
    ok("sales by day: hand-worked figures for every kind of day, and the days add up to the totals");

    // week and month
    assert.equal(periodKey("2026-03-03", "week"), "2026-03-02");
    assert.equal(periodKey("2026-03-08", "week"), "2026-03-02", "a Sunday belongs to the week before");
    assert.equal(periodKey("2026-03-09", "week"), "2026-03-09");
    const w = await salesReport(a.shopId, TZ, mar.start, mar.end, "week");
    assert.deepEqual(w.rows.map((x) => [x.period, x.net]), [["2026-03-02", 5300], ["2026-03-09", 14000], ["2026-03-16", 2500], ["2026-03-30", 1000]]);
    assert.equal(w.totals.net, 22800);
    const mo = await salesReport(a.shopId, TZ, mar.start, mar.end, "month");
    assert.deepEqual(mo.rows.map((x) => [x.period, x.net]), [["2026-03", 22800]]);
    ok("by week (Monday to Sunday) and by month");

    // categories and tenders
    const cat = (k: string) => r.counterCategories.find((c) => c.key === k)!;
    assert.deepEqual({ qty: cat("NOTION").qty, net: cat("NOTION").net, cost: cat("NOTION").cost, margin: cat("NOTION").margin }, { qty: 6, net: 5800, cost: 2400, margin: 3400 });
    assert.deepEqual({ qty: cat("THREAD").qty, net: cat("THREAD").net, cost: cat("THREAD").cost, margin: cat("THREAD").margin }, { qty: 2, net: 3500, cost: 1600, margin: 1900 });
    assert.equal(cat("GIFT_CARD").sale, false);
    assert.equal(cat("GIFT_CARD").net, 5000);
    assert.deepEqual(r.notSales, [{ key: "GIFT_CARD", label: "Gift cards", cents: 5000 }]);
    const rc = (k: string) => r.repairCategories.find((c) => c.key === k)!;
    assert.deepEqual([rc("SERVICE").net, rc("LABOR").net, rc("PART").net], [10500, 2000, 1000]);
    const tender = (k: string) => r.tenders.find((t) => t.key === k)?.cents;
    assert.deepEqual([tender("CASH"), tender("CARD"), tender("GIFT"), tender("ONLINE"), tender("T:CASH"), tender("T:CARD")], [10088, 1590, 2120, 1060, 11540, 2650]);
    const categoryNet = r.counterCategories.filter((c) => c.sale).reduce((s, c) => s + c.net, 0);
    assert.equal(categoryNet, r.totals.counter + r.totals.online + r.totals.returns + r.totals.voids, "categories add up to the sales");
    ok("by category (qty, net, cost, margin; a gift card marked not a sale) and by how it was paid");

    // kinds written on new lines and the fallback for old ones
    const lines = await db.saleLine.findMany({ where: { saleId: { in: [s1.saleId, gift.saleId] } } });
    assert.deepEqual(lines.map((l) => l.kind).sort(), ["GIFT_CARD", "NOTION"]);
    assert.equal(saleLineKind({ partKind: "FABRIC" }), "FABRIC");
    assert.equal(saleLineKind({ kind: "THREAD", partKind: "NOTION" }), "THREAD", "the kind written at sale time wins over today's part kind");
    assert.equal(saleLineKind({ repairJobId: "x", partKind: "PART" }), "REPAIR");
    assert.equal(saleLineKind({}), "MISC");
    ok("SaleLine.kind is written at sale time");

    // ---------- tickets ----------
    const now = at("2026-03-31");
    const t = await ticketsReport(a.shopId, mar.start, mar.end, now);
    assert.deepEqual([t.ticketsIn, t.ticketsOut, t.openNow, t.abandoned], [3, 2, 2, 0]);
    assert.deepEqual(t.openAges, [{ band: "0 to 7 days", count: 1 }, { band: "8 to 14 days", count: 0 }, { band: "15 to 30 days", count: 0 }, { band: "Over 30 days", count: 1 }]);
    assert.equal(t.averageRepair, 6750, "(11000 + 2500) / 2 before tax");
    assert.deepEqual(t.daysToReady, { median: 3, longest: 3, count: 1 });
    assert.deepEqual(t.daysToCollected, { median: 3, longest: 4, count: 2 });
    assert.deepEqual(t.techs.map((x) => [x.closed, x.laborHours, x.laborCents, x.partsCents]), [[2, 1, 2000, 1000]]);
    ok("tickets: in, out, open by age, days to ready and collected, average repair, per tech");

    // ---------- top customers ----------
    const top = await topCustomers(a.shopId, mar.start, mar.end);
    assert.deepEqual(top.map((c) => [c.name, c.counterCents, c.repairCents, c.totalCents, c.visits]), [["Ann A", 4800, 11000, 15800, 3], ["Bea B", 3500, 2500, 6000, 3]], "the gift card Bea bought is not spending");
    ok("top customers: counter and repairs together, gift cards left out");

    // ---------- gift cards ----------
    const g = await liabilityReport(a.shopId, mar.start, mar.end);
    const gc = g.kinds.find((k) => k.kind === "gift")!;
    assert.deepEqual([gc.opening, gc.closing], [0, 2880]);
    assert.deepEqual(gc.movement.map((x) => [x.reason, x.cents]).sort(), [["REDEEMED", -2120], ["SOLD", 5000]]);
    assert.equal(g.today, 2880);
    const apr0 = monthRange("2026-04-01", "2026-04-30", TZ);
    const ga = (await liabilityReport(a.shopId, apr0.start, apr0.end)).kinds.find((k) => k.kind === "gift")!;
    assert.deepEqual([ga.opening, ga.closing, ga.movement.length], [2880, 2880, 0], "the liability carries over a quiet month");
    // A void card's row with money on it owes nothing: not in today's liability or the count.
    const voidCard = await db.giftCard.create({ data: { shopId: a.shopId, number: `VOIDCHECK${Date.now()}`, kind: "gift", status: "void", balanceCents: 999 } });
    const gv = await liabilityReport(a.shopId, apr0.start, apr0.end);
    assert.deepEqual([gv.today, gv.kinds.find((k) => k.kind === "gift")!.cardsWithBalance], [2880, ga.cardsWithBalance], "a void card isn't owed");
    await db.giftCard.delete({ where: { id: voidCard.id } });
    ok("gift card liability: start, movement by reason, end; void cards aren't in today's liability");

    // ---------- April: exempt, a rate change, a void across the quarter's end ----------
    const s9 = await completeSaleAs(a.user, { customerId: exempt.id, lines: [item(p1, 2)], tenders: [cash(2000)] });
    await put(s9.saleId, "2026-04-02");
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 7 } });
    const s10 = await completeSaleAs(a.user, { lines: [item(p1, 1)], tenders: [cash(1070)] });
    await put(s10.saleId, "2026-04-06");
    await ticket({ customerId: exempt.id, status: "COLLECTED", intake: "2026-04-01", closed: "2026-04-05", rate: 0, exemptId: "RC-77", lines: [{ kind: "SERVICE", cents: 3000 }] });

    const q1 = monthRange("2026-01-01", "2026-03-31", TZ);
    const tq1 = await taxReport(a.shopId, TZ, q1.start, q1.end);
    const row6 = tq1.rates.find((x) => x.ratePct === 6)!;
    // S11 (Mar 30) is still in; its void (Apr 2) is not: gross = 22800 (sales 8300 + 1000 + tickets 13500)
    assert.deepEqual([row6.gross, row6.nonTaxable, row6.taxable, row6.tax], [22800, 2000, 20800, 1248], "taxable = gross - non-taxable; tax to the cent");
    assert.deepEqual([row6.returnsGross, row6.returnsTax], [-2000, -120], "the return and the earlier void are shown apart, netted in (a return of 1000, the void of the sale made and voided in March)");
    assert.equal(tq1.oddTax.length, 0, "taxable times rate equals tax on every sale");
    assert.equal(tq1.exempt.length, 0);
    const apr = await taxReport(a.shopId, TZ, apr0.start, apr0.end);
    assert.deepEqual(apr.rates.map((x) => [x.ratePct, x.gross, x.nonTaxable, x.taxable, x.tax]), [[7, 1000, 0, 1000, 70], [6, -1000, 0, -1000, -60], [0, 5000, 5000, 0, 0]], "two rates in a quarter are two lines; the void is counted in the later period");
    assert.deepEqual([apr.totals.gross, apr.totals.nonTaxable, apr.totals.taxable, apr.totals.tax], [5000, 5000, 0, 10]);
    assert.deepEqual(apr.exempt.map((e) => [e.kind, e.certificate, e.amountCents]), [["Sale", "RC-77", 2000], ["Ticket", "RC-77", 3000]]);
    assert.equal(apr.exemptTotal, 5000);
    // taxable times rate: the 7% sale
    assert.equal(Math.round((1000 * 7) / 100), 70);
    // the sales report agrees with the tax report on tax
    const sApr = await salesReport(a.shopId, TZ, apr0.start, apr0.end, "month");
    assert.equal(sApr.totals.tax, apr.totals.tax, "the two reports agree on tax collected");
    ok("sales tax: two rates are two lines, exempt sales and tickets listed with certificates, a void counts in the later period, both reports agree");

    // a Stripe Tax order is listed apart and left out of the rate lines
    const s12 = await completeSaleAs(a.user, { lines: [item(p1, 1)], tenders: [{ method: "ONLINE", amountCents: 1090 }], taxCents: 90 }, { paidOnline: true });
    await put(s12.saleId, "2026-04-10");
    await db.webOrder.create({
      data: { shopId: a.shopId, number: 4001, status: "DONE", name: "Far Away", fulfil: "ship", address: "12 Elm St, Springfield, IL 62704", subtotalCents: 1000, taxCents: 90, totalCents: 1090, taxVia: "stripe", tokenHash: `chk${Date.now()}`, saleId: s12.saleId, paidAt: at("2026-04-10") },
    });
    const apr2 = await taxReport(a.shopId, TZ, apr0.start, apr0.end);
    assert.deepEqual(apr2.stripe, [{ orderNumber: 4001, day: "2026-04-10", state: "IL", taxCents: 90, shipped: true }]);
    assert.equal(apr2.totals.tax, 10, "Stripe's tax is not in the rate lines");
    assert.equal(stateOf("1 Main St, Austin, tx 78701-1234"), "TX");
    assert.equal(stateOf("somewhere"), "Unknown");
    ok("Stripe Tax orders listed apart by ship-to state");

    // ---------- tenant ----------
    const before = await Promise.all(["Sale", "Ticket", "GiftCard"].map((t) => rowsOf(t, a.shopId)));
    const wide = monthRange("2026-01-01", "2026-12-31", TZ);
    const rb = await salesReport(b.shopId, TZ, wide.start, wide.end, "month");
    assert.equal(rb.rows.length, 0);
    assert.equal(rb.totals.net + rb.totals.tax + rb.totals.taken, 0);
    assert.equal(rb.counterCategories.length + rb.repairCategories.length + rb.tenders.length, 0);
    const tb = await ticketsReport(b.shopId, wide.start, wide.end, now);
    assert.deepEqual([tb.ticketsIn, tb.ticketsOut, tb.openNow], [0, 0, 0]);
    assert.equal((await topCustomers(b.shopId, wide.start, wide.end)).length, 0);
    const gb = await liabilityReport(b.shopId, wide.start, wide.end);
    assert.equal(gb.today, 0);
    assert.ok(gb.kinds.every((k) => k.opening === 0 && k.closing === 0 && k.movement.length === 0));
    const xb = await taxReport(b.shopId, TZ, wide.start, wide.end);
    assert.deepEqual([xb.rates.length, xb.exempt.length, xb.stripe.length], [0, 0, 0]);
    assert.deepEqual(await Promise.all(["Sale", "Ticket", "GiftCard"].map((t) => rowsOf(t, a.shopId))), before);
    ok("tenant: company B's reports over A's months are empty and change nothing");

    console.log(`\n${steps} reports checks passed`);
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
