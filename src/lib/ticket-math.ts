// Ticket totals. All amounts in cents.
type Line = { kind: string; qty: number; unitPriceCents: number; taxable: boolean };
type Pay = { amountCents: number };

export function lineTotal(l: { qty: number; unitPriceCents: number }): number {
  return Math.round(l.qty * l.unitPriceCents);
}

export function ticketTotals(lines: Line[], payments: Pay[], taxRatePct: number, commissionPct?: number | null) {
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const taxable = lines.filter((l) => l.taxable).reduce((s, l) => s + lineTotal(l), 0);
  const tax = Math.round((taxable * taxRatePct) / 100);
  const total = subtotal + tax;
  const paid = payments.reduce((s, p) => s + p.amountCents, 0);
  const service = lines.filter((l) => l.kind === "SERVICE").reduce((s, l) => s + lineTotal(l), 0);
  const parts = lines.filter((l) => l.kind === "PART").reduce((s, l) => s + lineTotal(l), 0);
  const labor = lines.filter((l) => l.kind === "LABOR").reduce((s, l) => s + lineTotal(l), 0);
  // Trade-account commission is a share of the service price, as on the route sheet.
  const commission = commissionPct ? Math.round((service * commissionPct) / 100) : 0;
  return { subtotal, tax, total, paid, balance: total - paid, service, parts, labor, commission };
}
