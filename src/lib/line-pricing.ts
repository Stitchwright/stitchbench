// How each line of a sale is priced and taxed, the same in the register (while ringing up) and on the server (when the
// sale is saved), so the two always agree: promotions, the customer's price rules, a repair's trade-up credit, a tax
// holiday and "price includes the tax". Pure: no database. Cents.
//
// - A return line from the scanned receipt comes back as it was sold (taxed or not, as on the receipt).
// - A new line being bought (an item from the shelf or a machine) gets the best of a promotion, her price rule and a
//   trade-up credit (a bigger discount typed at the register stands); a special order's, a layaway's or a loan's line
//   was priced when it began, so none of this touches it, nor the tax-included back-out.
// - Then the tax: a tax-exempt sale none; a holiday in force at this store takes it off the lines it covers (unless
//   "charge tax anyway" on that line); "price includes the tax" backs it out of the price of an undiscounted item.
import type { Promo } from "@/lib/promo-math";
import { bestDiscount, includedPromo, priceBeforeTax } from "@/lib/promo-math";
import type { RuleCtx } from "@/lib/price-rules";
import { bestRule } from "@/lib/price-rules";
import type { Holiday } from "@/lib/tax-holiday-math";
import { holidayCovers } from "@/lib/tax-holiday-math";

export type PricingCtx = {
  /** Promotions in force ([] when none apply: a layaway, an online or pay-link sale, a given tax amount, a whole return). */
  promos: Promo[];
  /** The customer's price rules, or null when none apply (as for promotions). */
  rules: RuleCtx | null;
  /** Holidays in force at this store today (and on a layaway's first day). */
  holidays: Pick<Holiday, "id" | "kinds" | "maxUnitCents">[];
  /** The rate the sale is taxed at (the store's). */
  ratePct: number;
  /** The sale is tax exempt (a certificate), or the tax was given (Stripe): no holiday, no tax-included. */
  exempt?: boolean;
  givenTax?: boolean;
  /** Every line is a return from the scanned receipt: nothing is repriced. */
  wholeReturn?: boolean;
};

export type PricingLine = {
  qty: number;
  unitPriceCents: number;
  /** The discount typed at the register (or the program's, e.g. a rental's buy-out credit). */
  discountCents: number;
  taxable: boolean;
  partId?: string | null;
  stockUnitId?: string | null;
  kind?: string | null;
  brand?: string | null;
  unit?: string | null;
  machineId?: string | null;
  wholesaleCents?: number | null;
  breakMinQty?: number | null;
  breakPriceCents?: number | null;
  specialOrderId?: string | null;
  unitLoanId?: string | null;
  layaway?: boolean;
  noRule?: boolean;
  taxAnyway?: boolean;
  /** A repair's trade-up credit on this machine, when one is used on it. */
  tradeUpCents?: number | null;
  /** A return line from the scanned receipt, as sold there (its tax note: a holiday's, "exempt", ...). */
  asSold?: { taxable: boolean; taxNote: string | null } | null;
};

export type PricedLine = {
  discountCents: number;
  /** The price the line is booked at: before tax when the price includes it. */
  unitPriceCents: number;
  taxable: boolean;
  taxNote: string | null;
  promo: Promo | null;
  /** The price rule that won ("Wholesale price", "Trade-up credit"), or null. */
  ruleLabel: string | null;
  groupId: string | null;
  tradeUp: boolean;
  taxIncluded: boolean;
  holidayId: string | null;
};

/** An item being bought that the shop's own promotions and rules can price. */
export function priceable(ctx: Pick<PricingCtx, "wholeReturn">, l: PricingLine): boolean {
  return l.qty > 0 && Boolean(l.partId || l.stockUnitId) && !l.specialOrderId && !l.unitLoanId && !l.layaway && !ctx.wholeReturn;
}

export function priceLine(ctx: PricingCtx, l: PricingLine): PricedLine {
  const out: PricedLine = { discountCents: l.discountCents, unitPriceCents: l.unitPriceCents, taxable: l.taxable, taxNote: null, promo: null, ruleLabel: null, groupId: null, tradeUp: false, taxIncluded: false, holidayId: null };
  if (l.qty < 0 && l.asSold) {
    out.taxable = l.asSold.taxable;
    out.taxNote = l.asSold.taxNote;
    return out;
  }
  const item = priceable(ctx, l);
  const best = item && ctx.promos.length ? bestDiscount(ctx.promos, l) : null;
  if (best && best.cents > out.discountCents) {
    out.discountCents = best.cents;
    out.promo = best.promo;
  }
  const hit = item && ctx.rules && !l.noRule && l.kind !== "MEMBERSHIP" ? bestRule(ctx.rules, { ...l, onPromo: !!best }) : null;
  if (hit && hit.cents > out.discountCents) {
    out.discountCents = hit.cents;
    out.promo = null;
    out.ruleLabel = hit.label;
    out.groupId = hit.groupId ?? null;
  }
  if (l.tradeUpCents != null && l.tradeUpCents > out.discountCents) {
    out.discountCents = l.tradeUpCents;
    out.promo = null;
    out.groupId = null;
    out.ruleLabel = "Trade-up credit";
    out.tradeUp = true;
  }
  if (ctx.givenTax || ctx.wholeReturn) return out;
  if (ctx.exempt) {
    if (out.taxable) out.taxNote = "exempt";
    return out;
  }
  if (l.qty > 0 && out.taxable && !l.taxAnyway) {
    const h = ctx.holidays.find((x) => holidayCovers(x, { ...l, kind: l.kind ?? "MISC", discountCents: out.discountCents, taxable: true }));
    if (h) {
      out.taxable = false;
      out.taxNote = `holiday:${h.id}`;
      out.holidayId = h.id;
      return out;
    }
  }
  if (item && out.taxable && !out.discountCents && ctx.ratePct > 0) {
    const p = includedPromo(ctx.promos, l);
    if (p) {
      out.unitPriceCents = priceBeforeTax(l.unitPriceCents, ctx.ratePct);
      out.taxNote = "included";
      out.taxIncluded = true;
      out.promo = p;
    }
  }
  return out;
}
