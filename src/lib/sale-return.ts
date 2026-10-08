// Splitting a sold line's exact charge into whole-cent unit prices for a return (used by src/actions/register.ts's
// saleForReturn, which the register's "S<number>" scan calls — see src/lib/scan-codes.ts for the barcode itself).
import { roundCents } from "@/lib/register-math";

export type ReturnUnit = { qty: number; unitPriceCents: number };

/**
 * Why a sold line can't come back as a plain return line from its receipt (null: it can). A repair bill is sorted out
 * with the repair shop; a gift card through the card; a class seat or appointment, a vacuum from stock or a trade-in
 * through "Return an item" with its own tools, so the booking or the unit is settled with the refund (a plain line
 * would refund the money and leave the booking paid or the unit sold, ready to be refunded again). A machine's service
 * plan comes back with its machine (sales-features); a layaway's payments, used-up payments and cancel fee are settled
 * on the layaway itself (a plain line would refund money the layaway still counts as paid); a special order's or a
 * loaner's deposit, a kept deposit, rent and loaner charges likewise on the special order, loaner or rental.
 */
export function returnSkip(l: {
  repairJobId?: string | null;
  giftCardId?: string | null;
  enrollmentId?: string | null;
  appointmentId?: string | null;
  stockUnitId?: string | null;
  tradeInUnitId?: string | null;
  machinePlanId?: string | null;
  kind?: string | null;
}): "repair" | "card" | "booking" | "unit" | "layaway" | "held" | null {
  if (l.repairJobId) return "repair";
  if (l.giftCardId) return "card";
  if (l.enrollmentId || l.appointmentId) return "booking";
  if (l.stockUnitId || l.tradeInUnitId || l.machinePlanId) return "unit";
  if (l.kind === "LAYAWAY" || l.kind === "LAYAWAY_FEE") return "layaway";
  if (l.kind === "DEPOSIT" || l.kind === "DEPOSIT_KEPT" || l.kind === "RENT" || l.kind === "LOAN_FEE") return "held";
  return null;
}

/** Each return line is an item the sale sold: the same part, or (a line with no part) the same description. */
export function linesOfSale(returned: { partId?: string | null; description: string }[], sold: { partId: string | null; description: string }[]): boolean {
  return returned.every((r) => sold.some((s) => (r.partId ? s.partId === r.partId : !s.partId && s.description === r.description)));
}

/**
 * The register's scanned receipt still stands for the cart: there are return lines and every one came from that
 * receipt (another receipt's lines, or return lines typed by hand, take the shop's rate today).
 */
export function receiptStands(saleId: string | null | undefined, cart: { qty: number; fromSale?: string }[]): boolean {
  const back = cart.filter((l) => l.qty < 0);
  return !!saleId && back.length > 0 && back.every((l) => l.fromSale === saleId);
}

/**
 * A sold line's `qty` at a total charge of `netCents` (what lineNet gives for it), split into the lines a return
 * needs to refund exactly that amount: negative quantities, non-negative whole-cent prices.
 *
 * One line, its price rounded to the nearest cent, unless `qty` is a whole number of 2 or more units and the charge
 * doesn't divide evenly among them (qty 3 at $10.00 with a $1.00 discount charged $29.00, not a whole number of
 * cents per unit): then two lines, all but the last unit at the price rounded toward zero, and the last unit for
 * whatever is left over, so the two add back up to netCents exactly instead of a single rounded price being a cent
 * off. A fractional quantity (fabric by the yard) isn't whole units to split, so it always stays one line.
 */
export function splitForReturn(qty: number, netCents: number): ReturnUnit[] {
  if (!qty) return [];
  if (!Number.isInteger(qty) || Math.abs(qty) < 2) return [{ qty: -qty, unitPriceCents: roundCents(netCents / qty) }];
  const per = netCents / qty;
  if (Number.isInteger(per)) return [{ qty: -qty, unitPriceCents: per }];
  // Same sign as qty, so "qty - sign" is every unit but the last, moving toward zero.
  const sign = qty < 0 ? -1 : 1;
  const bulk = qty - sign;
  const bulkPrice = Math.trunc(per); // per is never negative: netCents and qty always agree in sign for a real sale line
  // What's left for the last, single unit, as a per-unit price rather than a total (dividing by ±1 unit is *sign).
  const lastPrice = (netCents - bulk * bulkPrice) * sign;
  return [
    { qty: -bulk, unitPriceCents: bulkPrice },
    { qty: -sign, unitPriceCents: lastPrice },
  ];
}
