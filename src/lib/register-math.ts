// Register totals, the same in the browser (while ringing up) and on the server (when the sale is saved). Cents.

export type TenderMethod = "CASH" | "CARD" | "CHECK" | "GIFT" | "OTHER";
export type Tender = { method: TenderMethod; amountCents: number; note?: string | null };
export const TENDER_METHODS: TenderMethod[] = ["CASH", "CARD", "CHECK", "GIFT", "OTHER"];
export const TENDER_LABEL: Record<TenderMethod, string> = { CASH: "Cash", CARD: "Card", CHECK: "Check", GIFT: "Gift card", OTHER: "Other" };

type Line = { qty: number; unitPriceCents: number; discountCents?: number; taxable: boolean; discountable?: boolean };

export const lineNet = (l: Line) => Math.round(l.qty * l.unitPriceCents) - (l.qty < 0 ? -1 : 1) * (l.discountCents ?? 0);

/** What a whole-sale discount can come off: items being bought (not returns, not a partner's repair bill). */
export function discountBase(lines: Line[]) {
  return lines.filter((l) => l.discountable !== false && lineNet(l) > 0).reduce((a, l) => a + lineNet(l), 0);
}

/**
 * Subtotal of the lines after their own discounts, less a whole-sale discount, plus tax on the taxable part. The
 * whole-sale discount comes off the items being bought and lowers their taxable amount in proportion; returns and
 * repair bills are left as they are. Negative quantities are returns.
 */
export function saleTotals(lines: Line[], orderDiscountCents: number, taxRatePct: number, tenders: Tender[] = []) {
  const subtotal = lines.reduce((a, l) => a + lineNet(l), 0);
  const taxableNet = lines.filter((l) => l.taxable).reduce((a, l) => a + lineNet(l), 0);
  const eligible = lines.filter((l) => l.discountable !== false && lineNet(l) > 0);
  const base = eligible.reduce((a, l) => a + lineNet(l), 0);
  const orderDiscount = Math.max(0, Math.min(Math.round(orderDiscountCents), base));
  const eligibleTaxable = eligible.filter((l) => l.taxable).reduce((a, l) => a + lineNet(l), 0);
  const taxReduction = base > 0 ? Math.min(eligibleTaxable, Math.round((orderDiscount * eligibleTaxable) / base)) : 0;
  const tax = Math.round(((taxableNet - taxReduction) * taxRatePct) / 100);
  const total = subtotal - orderDiscount + tax;
  const paid = tenders.reduce((a, t) => a + t.amountCents, 0);
  const change = total >= 0 ? Math.max(0, paid - total) : 0;
  return { subtotal, orderDiscount, tax, total, paid, change, due: Math.max(0, total - paid) };
}

/** "2.375" -> "2 3/8" for fabric cut in eighths of a yard. */
export function yards(q: number): string {
  if (q < 0) return `-${yards(-q)}`;
  const whole = Math.trunc(q);
  const eighths = Math.round((q - whole) * 8);
  if (eighths === 8) return String(whole + 1);
  if (!eighths) return String(whole);
  const [n, d] = eighths % 4 === 0 ? [eighths / 4, 2] : eighths % 2 === 0 ? [eighths / 2, 4] : [eighths, 8];
  return `${whole ? `${whole} ` : ""}${n}/${d}`;
}

export function qtyText(q: number, unit: string | null | undefined) {
  if (unit === "yd") return `${yards(q)} yd`;
  return Number.isInteger(q) ? String(q) : q.toFixed(2);
}
