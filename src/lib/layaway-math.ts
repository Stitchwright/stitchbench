// Layaway arithmetic (tax-machine-sales-layaway-design.md section 4), the same in the register (while setting one up)
// and on the server. Pure: no database. Cents; days are YYYY-MM-DD in the shop's zone.
import { addDays, addMonths, ymdParts } from "@/lib/zoned";

export const LAYAWAY_EVERY = ["2w", "month"] as const;
export type LayawayEvery = (typeof LAYAWAY_EVERY)[number];
export const isEvery = (s: unknown): s is LayawayEvery => (LAYAWAY_EVERY as readonly string[]).includes(s as string);
export const EVERY_LABEL: Record<LayawayEvery, string> = { "2w": "every 2 weeks", month: "every month" };

export const LAYAWAY_STATUS_LABEL: Record<string, string> = { OPEN: "Paying", COMPLETED: "Picked up", CANCELLED: "Cancelled" };

export type PlanPayment = { due: string; cents: number };

/** The least deposit: this percent of the price, whole cents rounded up. */
export const minDeposit = (priceCents: number, pct: number) => Math.max(0, Math.ceil((priceCents * Math.max(0, pct)) / 100));

/** The last day to pay: the start plus the term in days. */
export const dueByOf = (startYmd: string, days: number) => addDays(startYmd, Math.max(1, Math.round(days)));

/** The month's last day when the same date doesn't exist (Jan 31 + 1 month is Feb 28). */
function monthLater(ymd: string, n: number): string {
  const same = addMonths(ymd, n);
  if (same) return same;
  const { y, m } = ymdParts(ymd);
  return addDays(new Date(Date.UTC(y, m - 1 + n + 1, 1)).toISOString().slice(0, 10), -1);
}

/**
 * Equal payments of what is left after the deposit, every 2 weeks or every month from the start, the last one on the
 * last day to pay (a date past it is pulled back to it). The cents that don't split evenly go on the last payment.
 */
export function layawayPlan(startYmd: string, dueBy: string, every: LayawayEvery, owedCents: number): PlanPayment[] {
  const owed = Math.max(0, Math.round(owedCents));
  if (!owed) return [];
  const dates: string[] = [];
  for (let i = 1; i < 60; i++) {
    const d = every === "month" ? monthLater(startYmd, i) : addDays(startYmd, 14 * i);
    if (d >= dueBy) break;
    dates.push(d);
  }
  dates.push(dueBy);
  const each = Math.floor(owed / dates.length);
  return dates.map((due, i) => ({ due, cents: i === dates.length - 1 ? owed - each * (dates.length - 1) : each }));
}

/** What should have been paid by `todayYmd`: the deposit and every planned payment due by then. */
export const dueSoFar = (plan: PlanPayment[], depositMinCents: number, todayYmd: string) => depositMinCents + plan.filter((p) => p.due <= todayYmd).reduce((a, p) => a + p.cents, 0);

/** Behind on payments: less paid than was due by today, or past the last day with money still owed. */
export function behind(a: { plan: PlanPayment[]; depositMinCents: number; dueBy: string; paidCents: number; owedCents: number }, todayYmd: string): number {
  const due = todayYmd > a.dueBy ? a.owedCents : Math.min(a.owedCents, dueSoFar(a.plan, a.depositMinCents, todayYmd));
  return Math.max(0, due - a.paidCents);
}

/** On cancelling: what the shop keeps (its fee, never more than was paid) and what goes back. */
export function cancelSplit(paidCents: number, feeCents: number, feePct: number): { fee: number; back: number } {
  const paid = Math.max(0, paidCents);
  const fee = Math.min(paid, Math.max(0, feeCents) + Math.round((paid * Math.max(0, feePct)) / 100));
  return { fee, back: paid - fee };
}

/** The wording customers sign when the shop has typed none: plain, and meant to be adapted (a lawyer question by state). */
export const DEFAULT_LAYAWAY_TERMS = [
  "We hold the items above for you until they are paid for.",
  "Pay at least the payments shown, by the dates shown. You can pay more, or pay it off, at any time.",
  "Sales tax is worked out on the day you pick the items up.",
  "If you cancel, or the last payment is not made by the last day, the layaway ends and the items go back on sale. What you paid comes back to you as described below.",
].join("\n");

/** Each planned payment with whether it is paid (everything up to it, the deposit first, is covered) or late. */
export function planProgress(plan: PlanPayment[], depositCents: number, paidCents: number, todayYmd: string) {
  let running = depositCents;
  return plan.map((p) => {
    running += p.cents;
    return { ...p, paid: paidCents >= running, late: p.due < todayYmd && paidCents < running };
  });
}
