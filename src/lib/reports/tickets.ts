import "server-only";
// The tickets, labor and customers reports (later-round-1-design.md 3.2): tickets in, out and open by age and kind, the days
// a repair takes, per tech, the average repair value, and the top customers.
import { db } from "@/lib/db";
import { saleLines } from "@/lib/reports/sales";
import { NOT_SALE_KINDS } from "@/lib/sale-kind";
import { ticketTotals } from "@/lib/ticket-math";

const DAY = 86_400_000;
export const CLOSED = ["COLLECTED", "RETURNED_UNREPAIRED"] as const;

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type TicketsReport = {
  ticketsIn: number;
  ticketsOut: number;
  abandoned: number;
  openNow: number;
  openAges: { band: string; count: number }[];
  byKind: { kind: string; in: number; out: number; open: number }[];
  daysToReady: { median: number | null; longest: number | null; count: number };
  daysToCollected: { median: number | null; longest: number | null; count: number };
  /** The average of what the machines handed back in the range were billed (before tax): service, labor, parts and fees less discounts. */
  averageRepair: number | null;
  repairValueTotal: number;
  techs: { id: string | null; name: string; closed: number; laborHours: number; laborCents: number; partsCents: number }[];
};

export async function ticketsReport(shopId: string, start: Date, end: Date, now: Date = new Date()): Promise<TicketsReport> {
  const [made, closed, open, abandoned] = await Promise.all([
    db.ticket.findMany({ where: { shopId, intakeAt: { gte: start, lt: end } }, select: { machine: { select: { equipment: true } } } }),
    db.ticket.findMany({
      where: { shopId, status: { in: [...CLOSED] }, closedAt: { gte: start, lt: end } },
      include: { lines: true, payments: true, machine: { select: { equipment: true } }, tech: { select: { name: true } } },
    }),
    db.ticket.findMany({
      where: { shopId, status: { notIn: [...CLOSED, "ABANDONED"] } },
      select: { intakeAt: true, machine: { select: { equipment: true } } },
    }),
    db.ticket.count({ where: { shopId, status: "ABANDONED", closedAt: { gte: start, lt: end } } }),
  ]);
  const kinds = new Map<string, { in: number; out: number; open: number }>();
  const kind = (k: string) => {
    let v = kinds.get(k);
    if (!v) kinds.set(k, (v = { in: 0, out: 0, open: 0 }));
    return v;
  };
  for (const t of made) kind(t.machine.equipment).in++;
  for (const t of closed) kind(t.machine.equipment).out++;
  for (const t of open) kind(t.machine.equipment).open++;
  const bands = [
    { band: "0 to 7 days", max: 7 },
    { band: "8 to 14 days", max: 14 },
    { band: "15 to 30 days", max: 30 },
    { band: "Over 30 days", max: Infinity },
  ].map((b) => ({ ...b, count: 0 }));
  for (const t of open) {
    const age = (now.getTime() - t.intakeAt.getTime()) / DAY;
    bands.find((b) => age <= b.max)!.count++;
  }
  const spans = (pick: (t: (typeof closed)[number]) => Date | null) => {
    const xs = closed.flatMap((t) => {
      const to = pick(t);
      return to ? [Math.max(0, (to.getTime() - t.intakeAt.getTime()) / DAY)] : [];
    });
    return { median: median(xs), longest: xs.length ? Math.max(...xs) : null, count: xs.length };
  };
  const tech = new Map<string | null, TicketsReport["techs"][number]>();
  let value = 0;
  for (const t of closed) {
    const x = ticketTotals(t.lines, t.payments, t.taxRatePct);
    value += x.subtotal;
    let r = tech.get(t.techId);
    if (!r) tech.set(t.techId, (r = { id: t.techId, name: t.tech?.name ?? "No tech named", closed: 0, laborHours: 0, laborCents: 0, partsCents: 0 }));
    r.closed++;
    r.laborHours += t.lines.filter((l) => l.kind === "LABOR").reduce((a, l) => a + l.qty, 0);
    r.laborCents += x.labor;
    r.partsCents += x.parts;
  }
  return {
    ticketsIn: made.length,
    ticketsOut: closed.length,
    abandoned,
    openNow: open.length,
    openAges: bands.map(({ band, count }) => ({ band, count })),
    byKind: [...kinds].map(([k, v]) => ({ kind: k, ...v })).sort((a, b) => b.in + b.out - (a.in + a.out)),
    daysToReady: spans((t) => t.readyAt),
    daysToCollected: spans((t) => t.closedAt),
    averageRepair: closed.length ? Math.round(value / closed.length) : null,
    repairValueTotal: value,
    techs: [...tech.values()].sort((a, b) => b.closed - a.closed),
  };
}

export type TopCustomer = { id: string; name: string; counterCents: number; repairCents: number; totalCents: number; visits: number };

/** The customers who spent most in the range: counter sales (not gift cards, trade-ins or partner bills) and repairs handed back. */
export async function topCustomers(shopId: string, start: Date, end: Date, limit = 20): Promise<TopCustomer[]> {
  const by = new Map<string, TopCustomer>();
  const get = (id: string) => {
    let c = by.get(id);
    if (!c) by.set(id, (c = { id, name: "", counterCents: 0, repairCents: 0, totalCents: 0, visits: 0 }));
    return c;
  };
  const sales = await db.sale.findMany({
    where: { shopId, customerId: { not: null }, status: "COMPLETED", createdAt: { gte: start, lt: end } },
    include: { lines: { include: { part: { select: { kind: true } } } } },
  });
  for (const s of sales) {
    const amount = saleLines(s).filter((x) => !NOT_SALE_KINDS.includes(x.kind)).reduce((a, x) => a + x.amount, 0);
    if (amount === 0) continue; // a gift card bought is not a visit that spent anything
    const c = get(s.customerId!);
    c.counterCents += amount;
    c.visits++;
  }
  const closed = await db.ticket.findMany({
    where: { shopId, customerId: { not: null }, status: { in: [...CLOSED] }, closedAt: { gte: start, lt: end } },
    include: { lines: true },
  });
  for (const t of closed) {
    const c = get(t.customerId!);
    c.repairCents += ticketTotals(t.lines, [], t.taxRatePct).subtotal;
    c.visits++;
  }
  const top = [...by.values()]
    .map((c) => ({ ...c, totalCents: c.counterCents + c.repairCents }))
    .filter((c) => c.totalCents > 0)
    .sort((a, b) => b.totalCents - a.totalCents || a.id.localeCompare(b.id))
    .slice(0, limit);
  const names = await db.customer.findMany({ where: { shopId, id: { in: top.map((c) => c.id) } }, select: { id: true, name: true } });
  return top.map((c) => ({ ...c, name: names.find((n) => n.id === c.id)?.name ?? "(deleted)" }));
}
