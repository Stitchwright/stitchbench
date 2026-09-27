// Ticket totals. All amounts in cents.
type Line = { kind: string; qty: number; unitPriceCents: number; taxable: boolean };
type Pay = { amountCents: number; method?: string };

export function lineTotal(l: { qty: number; unitPriceCents: number }): number {
  return Math.round(l.qty * l.unitPriceCents);
}

/**
 * A ticket's money. A discount lowers the taxable amount in proportion, as at the register. For a machine that came
 * from a partner sewing shop, pass that job's commission (the partnership's rule); otherwise a trade account's
 * commission is a share of the service price, as on the route sheet. A bill put on a trade account ("Invoice (on
 * account)") isn't money in: it stays in the balance, owed, until the account pays it.
 */
export function ticketTotals(lines: Line[], payments: Pay[], taxRatePct: number, commissionPct?: number | null, partnerCommissionCents?: number | null) {
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const taxable = lines.filter((l) => l.taxable).reduce((s, l) => s + lineTotal(l), 0);
  const discount = -lines.filter((l) => l.kind === "DISCOUNT").reduce((s, l) => s + lineTotal(l), 0);
  const gross = subtotal + discount;
  const taxBase = gross > 0 ? Math.max(0, taxable - Math.round((discount * taxable) / gross)) : taxable;
  const tax = Math.round((taxBase * taxRatePct) / 100);
  const total = subtotal + tax;
  const paid = payments.filter((p) => p.method !== "INVOICE").reduce((s, p) => s + p.amountCents, 0);
  const service = lines.filter((l) => l.kind === "SERVICE").reduce((s, l) => s + lineTotal(l), 0);
  const parts = lines.filter((l) => l.kind === "PART").reduce((s, l) => s + lineTotal(l), 0);
  const labor = lines.filter((l) => l.kind === "LABOR").reduce((s, l) => s + lineTotal(l), 0);
  const commission = partnerCommissionCents != null ? partnerCommissionCents : commissionPct ? Math.round((service * commissionPct) / 100) : 0;
  return { subtotal, tax, total, paid, balance: total - paid, service, parts, labor, commission };
}
