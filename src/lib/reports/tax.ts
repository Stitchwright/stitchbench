import "server-only";
// The sales-tax report (later-round-1-design.md 3.3) for a month, quarter or year: gross sales less non-taxable sales
// (untaxed lines and exempt customers) is taxable sales, with the tax collected, grouped by the rate charged so a
// mid-year rate change shows two lines. Returns and voids are netted into the period they happen in and shown apart.
// Stripe Tax orders (the tax Stripe worked out, by ship-to state) are listed apart; tax-exempt sales are listed with their
// certificate numbers, the list an auditor asks for. Sales made tax free on a sales tax holiday are listed apart by
// holiday (tax-machine-sales-layaway-design.md section 1: states ask for them on the return).
import { db } from "@/lib/db";
import { saleLines } from "@/lib/reports/sales";
import { NOT_SALE_KINDS } from "@/lib/sale-kind";
import { lineTotal } from "@/lib/ticket-math";
import { dateIn } from "@/lib/time-zone";

export type TaxRateRow = {
  /** The rate charged, in percent (0 for an exempt sale or an untaxed ticket). */
  ratePct: number;
  gross: number;
  nonTaxable: number;
  taxable: number;
  tax: number;
  /** Of gross and tax: what returns and voids took off in the period (negative), already netted in. */
  returnsGross: number;
  returnsTax: number;
};

export type ExemptRow = { kind: "Sale" | "Ticket"; number: number; day: string; customer: string; certificate: string; amountCents: number };
export type StripeRow = { orderNumber: number; day: string; state: string; taxCents: number; shipped: boolean };

export type TaxReport = {
  rates: TaxRateRow[];
  totals: { gross: number; nonTaxable: number; taxable: number; tax: number };
  exempt: ExemptRow[];
  exemptTotal: number;
  stripe: StripeRow[];
  stripeTotal: number;
  /** Sold tax free on each sales tax holiday (returns netted in), already counted in non-taxable sales. */
  holidays: { name: string; amountCents: number }[];
  /** Sales where taxable times the rate is not the tax charged to the cent (sales the report can't re-work). */
  oddTax: { kind: "Sale" | "Ticket"; number: number; day: string; taxCents: number; expectedCents: number }[];
};

/** The state in the last lines of a ship-to address ("Springfield, IL 62704"), else "Unknown". */
export function stateOf(address: string | null): string {
  const m = (address ?? "").toUpperCase().match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/);
  return m ? m[1] : "Unknown";
}

export async function taxReport(shopId: string, tz: string, start: Date, end: Date): Promise<TaxReport> {
  const rates = new Map<number, TaxRateRow>();
  const rate = (r: number) => {
    let x = rates.get(r);
    if (!x) rates.set(r, (x = { ratePct: r, gross: 0, nonTaxable: 0, taxable: 0, tax: 0, returnsGross: 0, returnsTax: 0 }));
    return x;
  };
  const exempt: ExemptRow[] = [];
  const oddTax: TaxReport["oddTax"] = [];
  const inRange = (d: Date | null) => d != null && d >= start && d < end;

  // Sales the tax of which Stripe worked out are reported apart.
  const stripeOrders = await db.webOrder.findMany({ where: { shopId, taxVia: "stripe", saleId: { not: null } }, select: { number: true, saleId: true, address: true, fulfil: true, status: true, tracking: true } });
  const stripeBySale = new Map(stripeOrders.map((o) => [o.saleId!, o]));

  const sales = await db.sale.findMany({
    where: { shopId, OR: [{ createdAt: { gte: start, lt: end } }, { status: "VOIDED", voidedAt: { gte: start, lt: end } }] },
    include: { lines: { include: { part: { select: { kind: true } } } }, customer: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const stripe: StripeRow[] = [];
  const byHoliday = new Map<string, number>();
  for (const s of sales) {
    const lines = saleLines(s).filter((x) => !NOT_SALE_KINDS.includes(x.kind));
    const gross = lines.reduce((a, x) => a + x.amount, 0);
    const taxableBase = lines.filter((x) => x.line.taxable).reduce((a, x) => a + x.amount, 0);
    const events: { at: Date; sign: 1 | -1 }[] = [];
    if (inRange(s.createdAt)) events.push({ at: s.createdAt, sign: 1 });
    if (s.status === "VOIDED" && inRange(s.voidedAt)) events.push({ at: s.voidedAt!, sign: -1 });
    const order = stripeBySale.get(s.id);
    for (const { at, sign } of events) {
      if (order) {
        if (sign === 1) stripe.push({ orderNumber: order.number, day: dateIn(at, tz), state: stateOf(order.address), taxCents: s.taxCents, shipped: order.fulfil === "ship" && order.status === "DONE" });
        continue;
      }
      const r = rate(s.taxRatePct);
      r.gross += sign * gross;
      r.tax += sign * s.taxCents;
      if (s.taxRatePct === 0 && s.taxExemptId) r.nonTaxable += sign * gross;
      else r.nonTaxable += sign * (gross - taxableBase);
      r.taxable += sign * (s.taxRatePct === 0 && s.taxExemptId ? 0 : taxableBase);
      if (sign === -1 || gross < 0) {
        r.returnsGross += sign === -1 ? -gross : gross;
        r.returnsTax += sign === -1 ? -s.taxCents : s.taxCents;
      }
      for (const x of lines) {
        if (x.line.taxNote?.startsWith("holiday:")) byHoliday.set(x.line.taxNote.slice(8), (byHoliday.get(x.line.taxNote.slice(8)) ?? 0) + sign * x.amount);
      }
      if (sign === 1 && s.taxExemptId) {
        exempt.push({ kind: "Sale", number: s.number, day: dateIn(at, tz), customer: s.customer?.name ?? "", certificate: s.taxExemptId, amountCents: taxableBase });
      }
    }
    // taxable times rate equals tax to the cent
    if (inRange(s.createdAt) && !order && s.taxRatePct > 0) {
      const expected = Math.round((taxableBase * Math.round(s.taxRatePct * 10_000)) / 1_000_000);
      if (Math.abs(expected - s.taxCents) > (s.discountCents > 0 ? 1 : 0)) oddTax.push({ kind: "Sale", number: s.number, day: dateIn(s.createdAt, tz), taxCents: s.taxCents, expectedCents: expected });
    }
  }

  // Repairs: the tax is due when the machine goes home.
  const tickets = await db.ticket.findMany({
    where: { shopId, status: { in: ["COLLECTED", "RETURNED_UNREPAIRED"] }, closedAt: { gte: start, lt: end } },
    include: { lines: true, customer: { select: { name: true } } },
  });
  for (const t of tickets) {
    const subtotal = t.lines.reduce((a, l) => a + lineTotal(l), 0);
    const taxableLines = t.lines.filter((l) => l.taxable).reduce((a, l) => a + lineTotal(l), 0);
    const discount = -t.lines.filter((l) => l.kind === "DISCOUNT").reduce((a, l) => a + lineTotal(l), 0);
    const g = subtotal + discount;
    const base = g > 0 ? Math.max(0, taxableLines - Math.round((discount * taxableLines) / g)) : taxableLines;
    const tax = Math.round((base * t.taxRatePct) / 100);
    const r = rate(t.taxRatePct);
    r.gross += subtotal;
    r.tax += tax;
    if (t.taxRatePct === 0 && t.taxExemptId) {
      r.nonTaxable += subtotal;
      exempt.push({ kind: "Ticket", number: t.number, day: dateIn(t.closedAt!, tz), customer: t.customer?.name ?? "", certificate: t.taxExemptId, amountCents: base > 0 ? base : taxableLines });
    } else {
      r.nonTaxable += subtotal - base;
      r.taxable += base;
    }
  }

  const rows = [...rates.values()].sort((a, b) => b.ratePct - a.ratePct);
  const totals = { gross: 0, nonTaxable: 0, taxable: 0, tax: 0 };
  for (const r of rows) {
    totals.gross += r.gross;
    totals.nonTaxable += r.nonTaxable;
    totals.taxable += r.taxable;
    totals.tax += r.tax;
  }
  // Exempt amounts of tickets are taxable lines that were not taxed: sum what an auditor would see.
  exempt.sort((a, b) => a.day.localeCompare(b.day) || a.number - b.number);
  const names = byHoliday.size ? new Map((await db.taxHoliday.findMany({ where: { shopId, id: { in: [...byHoliday.keys()] } }, select: { id: true, name: true } })).map((h) => [h.id, h.name])) : new Map<string, string>();
  const holidays = [...byHoliday].map(([id, amountCents]) => ({ name: names.get(id) ?? "Tax holiday", amountCents }));
  return { rates: rows, totals, holidays, exempt, exemptTotal: exempt.reduce((a, e) => a + e.amountCents, 0), stripe, stripeTotal: stripe.reduce((a, s) => a + s.taxCents, 0), oddTax };
}

