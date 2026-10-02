// Register totals, the same in the browser (while ringing up) and on the server (when the sale is saved). Cents.

export type TenderMethod = "CASH" | "CARD" | "CHECK" | "GIFT" | "OTHER" | "ONLINE";
export type Tender = { method: TenderMethod; amountCents: number; note?: string | null };
/** What the counter takes. ONLINE is only ever written by the online shop at payment (online-and-parts-design.md section 3). */
export const TENDER_METHODS: TenderMethod[] = ["CASH", "CARD", "CHECK", "GIFT", "OTHER"];
export const ALL_TENDER_METHODS: TenderMethod[] = [...TENDER_METHODS, "ONLINE"];
export const TENDER_LABEL: Record<TenderMethod, string> = { CASH: "Cash", CARD: "Card", CHECK: "Check", GIFT: "Gift card", OTHER: "Other", ONLINE: "Paid online" };

type Line = { qty: number; unitPriceCents: number; discountCents?: number; taxable: boolean; discountable?: boolean };

/**
 * Cents, half a cent rounded away from zero. Math.round rounds -649.5 up to -649, so a return would refund a cent less
 * than the same sale charged (650); this gives -650.
 */
export function roundCents(x: number) {
  const r = Math.round(Math.abs(x));
  return x < 0 && r ? -r : r;
}

export const lineNet = (l: Line) => roundCents(l.qty * l.unitPriceCents) - (l.qty < 0 ? -1 : 1) * (l.discountCents ?? 0);

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
  // The rate in millionths (6.35% is 63500), so the cents come out exact and a return's tax mirrors the sale's.
  const tax = roundCents(((taxableNet - taxReduction) * Math.round(taxRatePct * 10_000)) / 1_000_000);
  const total = subtotal - orderDiscount + tax;
  const paid = tenders.reduce((a, t) => a + t.amountCents, 0);
  const change = total >= 0 ? Math.max(0, paid - total) : 0;
  return { subtotal, orderDiscount, tax, total, paid, change, due: Math.max(0, total - paid) };
}

/** Each line's share of the whole-sale discount (the split saleTotals uses for tax): 0 for lines it doesn't come off. */
export function discountShares(lines: Line[], orderDiscountCents: number): number[] {
  const base = discountBase(lines);
  const d = Math.max(0, Math.min(Math.round(orderDiscountCents), base));
  return lines.map((l) => (base > 0 && l.discountable !== false && lineNet(l) > 0 ? Math.round((d * lineNet(l)) / base) : 0));
}

/**
 * Each line's part of the whole-sale discount, in line order: shared over the items being bought in proportion to
 * their price, so what each one sold for is known (a partner's consigned item is paid out on that). Adds up to the
 * discount exactly; returns and repair bills get 0.
 */
export function orderDiscountShares(lines: Line[], orderDiscountCents: number) {
  const nets = lines.map((l) => (l.discountable !== false && lineNet(l) > 0 ? lineNet(l) : 0));
  let rest = nets.reduce((a, n) => a + n, 0);
  let left = Math.max(0, Math.min(Math.round(orderDiscountCents), rest));
  return nets.map((n) => {
    if (!n) return 0;
    const share = Math.round((left * n) / rest);
    left -= share;
    rest -= n;
    return share;
  });
}

/**
 * Why the payments can't settle this sale, or null when they do. A sale is paid in full with positive amounts, and only
 * cash gives change; a refund is paid out in full as negative amounts, in any way.
 */
export function tenderProblem(totals: { total: number; paid: number }, tenders: Tender[]): string | null {
  const refund = totals.total < 0;
  if (!refund && totals.paid < totals.total) return `Still due: $${((totals.total - totals.paid) / 100).toFixed(2)}.`;
  if (refund && totals.paid !== totals.total) {
    const left = totals.paid - totals.total; // above 0: still to pay back; below 0: paid back too much
    return left > 0 ? `Still to refund: $${(left / 100).toFixed(2)}.` : `Refunded $${(-left / 100).toFixed(2)} too much. Take a payment off or lower it.`;
  }
  if (tenders.some((t) => (refund ? t.amountCents > 0 : t.amountCents < 0))) return refund ? "A refund is paid out as negative amounts." : "Payments are positive amounts on a sale.";
  const cash = tenders.filter((t) => t.method === "CASH").reduce((a, t) => a + t.amountCents, 0);
  if (!refund && totals.paid - cash > totals.total) return "Card, check and gift amounts can't be more than the total. Only cash gives change.";
  return null;
}

/** Fabric is cut in eighths of a yard: 2.375 is, 2.3751 isn't. */
export const inEighths = (q: number) => Math.abs(q * 8 - Math.round(q * 8)) < 1e-6;

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
