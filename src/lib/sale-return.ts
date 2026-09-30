// Splitting a sold line's exact charge into whole-cent unit prices for a return (used by src/actions/register.ts's
// saleForReturn, which the register's "S<number>" scan calls — see src/lib/scan-codes.ts for the barcode itself).
import { roundCents } from "@/lib/register-math";

export type ReturnUnit = { qty: number; unitPriceCents: number };

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
