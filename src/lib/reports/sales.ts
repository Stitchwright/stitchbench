import "server-only";
// The sales report (later-round-1-design.md 3.1 and 3.2): counter, repairs, online, returns, voids, discounts, net sales,
// tax and money taken by day, week or month; by category; by tender. One function, shared by the page and the CSV.
//
// When things count: a counter sale on its day, its void on the void's day, a return on its own day; a repair when the
// machine is handed back (COLLECTED or RETURNED_UNREPAIRED, by closedAt); an online order on the day it was paid.
// Not sales: gift cards sold (a liability), trade-in credit (a purchase), a partner repair bill collected at the counter.
import { db } from "@/lib/db";
import { PAYMENT_LABEL } from "@/lib/constants";
import { lineNet, TENDER_LABEL, type Tender } from "@/lib/register-math";
import { NOT_SALE_KINDS, SALE_KIND_LABEL, saleLineKind } from "@/lib/sale-kind";
import { lineTotal, ticketTotals } from "@/lib/ticket-math";
import { PAID_ELSEWHERE } from "@/lib/sales";
import { dateIn } from "@/lib/time-zone";
import type { LineKind } from "@/generated/prisma/enums";

export type Period = "day" | "week" | "month";
export const PERIODS: Period[] = ["day", "week", "month"];

/** "2026-10-06" to its period's label key: the day, the Monday of its week, or "2026-10". */
export function periodKey(day: string, period: Period): string {
  if (period === "day") return day;
  if (period === "month") return day.slice(0, 7);
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Monday is 0
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export type SalesRow = {
  period: string;
  counter: number;
  repairs: number;
  online: number;
  returns: number;
  voids: number;
  discounts: number;
  net: number;
  tax: number;
  taken: number;
};

const emptyRow = (period: string): SalesRow => ({ period, counter: 0, repairs: 0, online: 0, returns: 0, voids: 0, discounts: 0, net: 0, tax: 0, taken: 0 });

export type CategoryRow = { key: string; label: string; qty: number; net: number; cost: number | null; margin: number | null; sale: boolean };

type SaleWithLines = Awaited<ReturnType<typeof loadSales>>[number];

function loadSales(shopId: string, start: Date, end: Date) {
  return db.sale.findMany({
    where: { shopId, OR: [{ createdAt: { gte: start, lt: end } }, { status: "VOIDED", voidedAt: { gte: start, lt: end } }] },
    include: { lines: { include: { part: { select: { kind: true } } } } },
    orderBy: { createdAt: "asc" },
  });
}

/** A line's unit cost times its quantity, in cents, where the line knows it. */
function lineCost(l: { qty: number; costCents: number | null; costTenThou: number | null }): number | null {
  if (l.costTenThou != null) return Math.round((l.qty * l.costTenThou) / 100);
  if (l.costCents != null) return Math.round(l.qty * l.costCents);
  return null;
}

/**
 * Each line of a sale with the sale's own whole-sale discount spread over the items bought (the way the sale was totalled):
 * the category, what it came to, and what it cost.
 */
export function saleLines(s: SaleWithLines) {
  const kinds = s.lines.map((l) => saleLineKind({ ...l, partKind: l.part?.kind }));
  const eligible = s.lines.map((l, i) => lineNet(l) > 0 && !["REPAIR", "GIFT_CARD", "TRADE_IN", "CLASS", "APPOINTMENT", "LAYAWAY", "LAYAWAY_FEE", "DEPOSIT", "DEPOSIT_KEPT"].includes(kinds[i]));
  const base = s.lines.reduce((a, l, i) => a + (eligible[i] ? lineNet(l) : 0), 0);
  const orderDiscount = Math.min(s.discountCents, base);
  let left = orderDiscount;
  let rest = base;
  return s.lines.map((l, i) => {
    let amount = lineNet(l);
    let share = 0;
    if (orderDiscount > 0 && eligible[i]) {
      share = rest === amount ? left : Math.min(left, Math.round((left * amount) / rest));
      left -= share;
      rest -= amount;
      amount -= share;
    }
    return { line: l, kind: kinds[i], amount, discount: l.discountCents + share, cost: lineCost(l) };
  });
}

export type SalesReport = {
  period: Period;
  rows: SalesRow[];
  totals: SalesRow;
  counterCategories: CategoryRow[];
  repairCategories: CategoryRow[];
  tenders: { key: string; label: string; cents: number }[];
  /** Counted apart from sales: gift cards sold, trade-in credit given, partner repair bills taken at the counter. */
  notSales: { key: string; label: string; cents: number }[];
};

/** `start` and `end` are the shop-zone day bounds of the range (end exclusive), as monthRange gives them. */
export async function salesReport(shopId: string, tz: string, start: Date, end: Date, period: Period): Promise<SalesReport> {
  const rows = new Map<string, SalesRow>();
  const row = (at: Date) => {
    const key = periodKey(dateIn(at, tz), period);
    let r = rows.get(key);
    if (!r) rows.set(key, (r = emptyRow(key)));
    return r;
  };
  const cats = new Map<string, CategoryRow>();
  const addCat = (map: Map<string, CategoryRow>, key: string, label: string, qty: number, net: number, cost: number | null, sale: boolean) => {
    let c = map.get(key);
    if (!c) map.set(key, (c = { key, label, qty: 0, net: 0, cost: null, margin: null, sale }));
    c.qty += qty;
    c.net += net;
    if (cost != null) c.cost = (c.cost ?? 0) + cost;
  };
  const tenders = new Map<string, number>();
  const addTender = (key: string, cents: number) => tenders.set(key, (tenders.get(key) ?? 0) + cents);
  const notSales = new Map<string, number>();
  const inRange = (d: Date | null) => d != null && d >= start && d < end;

  // ----- counter and online sales, their returns and voids -----
  for (const s of await loadSales(shopId, start, end)) {
    const lines = saleLines(s);
    const online = (s.tenders as Tender[]).some((t) => t.method === "ONLINE");
    const salesAmount = lines.filter((x) => !NOT_SALE_KINDS.includes(x.kind)).reduce((a, x) => a + x.amount, 0);
    const discounts = lines.filter((x) => lineNet(x.line) > 0 && !NOT_SALE_KINDS.includes(x.kind)).reduce((a, x) => a + x.discount, 0);
    // The sale on its day (+1), its void on the void's day (-1).
    const events: { at: Date; sign: 1 | -1 }[] = [];
    if (inRange(s.createdAt)) events.push({ at: s.createdAt, sign: 1 });
    if (s.status === "VOIDED" && inRange(s.voidedAt)) events.push({ at: s.voidedAt!, sign: -1 });
    for (const { at, sign } of events) {
      const r = row(at);
      if (sign === -1) r.voids -= salesAmount;
      else if (salesAmount < 0) r.returns += salesAmount;
      else if (online) r.online += salesAmount;
      else r.counter += salesAmount;
      r.discounts += sign * (salesAmount < 0 ? 0 : discounts);
      r.tax += sign * s.taxCents;
      for (const t of s.tenders as Tender[]) {
        addTender(t.method, sign * t.amountCents);
        // Gift cards and store credit were taken before; financing is the lender's money, owed until it pays.
        if (t.method !== "GIFT" && t.method !== "CREDIT" && t.method !== "FINANCED") r.taken += sign * t.amountCents;
      }
      if (s.changeCents) {
        addTender("CASH", -sign * s.changeCents);
        r.taken -= sign * s.changeCents;
      }
      for (const x of lines) {
        const label = SALE_KIND_LABEL[x.kind] ?? x.kind;
        addCat(cats, x.kind, label, sign * x.line.qty, sign * x.amount, x.cost == null ? null : sign * x.cost, !NOT_SALE_KINDS.includes(x.kind));
        if (NOT_SALE_KINDS.includes(x.kind)) notSales.set(x.kind, (notSales.get(x.kind) ?? 0) + sign * x.amount);
      }
    }
  }

  // ----- repairs, when the machine goes home -----
  const closed = await db.ticket.findMany({
    where: { shopId, status: { in: ["COLLECTED", "RETURNED_UNREPAIRED"] }, closedAt: { gte: start, lt: end } },
    include: { lines: true, payments: true },
  });
  const repairCats = new Map<string, CategoryRow>();
  for (const t of closed) {
    const x = ticketTotals(t.lines, t.payments, t.taxRatePct);
    const r = row(t.closedAt!);
    r.repairs += x.subtotal;
    r.tax += x.tax;
    for (const l of t.lines) addCat(repairCats, l.kind, LINE_KIND_LABEL[l.kind], l.qty, lineTotal(l), null, true);
  }

  // ----- repair money, when it is paid -----
  const pays = await db.payment.findMany({ where: { ticket: { shopId }, paidAt: { gte: start, lt: end } }, select: { amountCents: true, method: true, paidAt: true } });
  for (const p of pays) {
    addTender(`T:${p.method}`, p.amountCents);
    if (!PAID_ELSEWHERE.includes(p.method) && p.method !== "GIFT" && p.method !== "CREDIT") row(p.paidAt).taken += p.amountCents;
  }

  const sorted = [...rows.values()].sort((a, b) => a.period.localeCompare(b.period));
  const totals = emptyRow("Total");
  for (const r of sorted) {
    r.net = r.counter + r.repairs + r.online + r.returns + r.voids;
    for (const k of ["counter", "repairs", "online", "returns", "voids", "discounts", "net", "tax", "taken"] as const) totals[k] += r[k];
  }
  const finish = (m: Map<string, CategoryRow>) =>
    [...m.values()]
      .filter((c) => c.qty !== 0 || c.net !== 0)
      .map((c) => ({ ...c, margin: c.cost == null ? null : c.net - c.cost }))
      .sort((a, b) => b.net - a.net);
  const tenderLabel = (k: string) => (k.startsWith("T:") ? `${PAYMENT_LABEL[k.slice(2) as keyof typeof PAYMENT_LABEL]} (repairs)` : (TENDER_LABEL[k as keyof typeof TENDER_LABEL] ?? k));
  return {
    period,
    rows: sorted,
    totals,
    counterCategories: finish(cats),
    repairCategories: finish(repairCats),
    tenders: [...tenders].filter(([, c]) => c !== 0).map(([key, cents]) => ({ key, label: tenderLabel(key), cents })),
    notSales: [...notSales].filter(([, c]) => c !== 0).map(([key, cents]) => ({ key, label: SALE_KIND_LABEL[key] ?? key, cents })),
  };
}

const LINE_KIND_LABEL: Record<LineKind, string> = { SERVICE: "Service", LABOR: "Labor", PART: "Parts on tickets", FEE: "Fees", DISCOUNT: "Discounts on tickets" };
