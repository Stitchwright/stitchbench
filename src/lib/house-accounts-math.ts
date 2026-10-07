// House charge accounts (shop-features-round-2-design.md 9.4): the balance, what is past due and how long, and a month's
// statement, from an account's entries. Pure.

export type Entry = { kind: string; amountCents: number; at: Date; voidedAt: Date | null };

/** What she owes: charges (and adjustments) less payments, voided entries left out. */
export function balanceOf(entries: Entry[]): number {
  return entries.reduce((a, e) => (e.voidedAt ? a : e.kind === "PAYMENT" ? a - e.amountCents : a + e.amountCents), 0);
}

export type Aging = { current: number; d30: number; d60: number; d90: number; total: number };

/**
 * The balance by age: payments (and credits) pay off the oldest charges first; what is left of each charge counts by
 * its age in days: up to 30 current, 31-60, 61-90, over 90.
 */
export function agingOf(entries: Entry[], now: Date): Aging {
  const live = entries.filter((e) => !e.voidedAt).sort((a, b) => +a.at - +b.at);
  let credit = live.filter((e) => e.kind === "PAYMENT").reduce((a, e) => a + e.amountCents, 0) + live.filter((e) => e.kind !== "PAYMENT" && e.amountCents < 0).reduce((a, e) => a - e.amountCents, 0);
  const out: Aging = { current: 0, d30: 0, d60: 0, d90: 0, total: 0 };
  for (const c of live.filter((e) => e.kind !== "PAYMENT" && e.amountCents > 0)) {
    const used = Math.min(credit, c.amountCents);
    credit -= used;
    const left = c.amountCents - used;
    if (!left) continue;
    const days = Math.floor((+now - +c.at) / 86_400_000);
    if (days <= 30) out.current += left;
    else if (days <= 60) out.d30 += left;
    else if (days <= 90) out.d60 += left;
    else out.d90 += left;
    out.total += left;
  }
  // Paid more than was charged: a credit balance.
  if (credit > 0) {
    out.current -= credit;
    out.total -= credit;
  }
  return out;
}

/** A month's statement: what was owed at its start, its charges and payments, and what is owed at its end. */
export function statementOf(entries: Entry[], start: Date, end: Date) {
  const live = entries.filter((e) => !e.voidedAt);
  const before = live.filter((e) => e.at < start);
  const inMonth = live.filter((e) => e.at >= start && e.at < end).sort((a, b) => +a.at - +b.at);
  const opening = balanceOf(before);
  const charges = inMonth.filter((e) => e.kind !== "PAYMENT").reduce((a, e) => a + e.amountCents, 0);
  const payments = inMonth.filter((e) => e.kind === "PAYMENT").reduce((a, e) => a + e.amountCents, 0);
  return { opening, charges, payments, closing: opening + charges - payments, lines: inMonth };
}
