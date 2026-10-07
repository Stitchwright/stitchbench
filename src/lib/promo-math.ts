// Promotions (tax-machine-sales-layaway-design.md section 2), the same in the register (while ringing up) and on the
// server (when the sale is saved). Pure: no database. Cents; percents are whole numbers.
import { roundCents } from "@/lib/register-math";

export const PROMO_EFFECTS = ["PERCENT", "AMOUNT", "TAX_INCLUDED"] as const;
export type PromoEffect = (typeof PROMO_EFFECTS)[number];
export const isEffect = (s: unknown): s is PromoEffect => (PROMO_EFFECTS as readonly string[]).includes(s as string);
export const EFFECT_LABEL: Record<PromoEffect, string> = { PERCENT: "Percent off", AMOUNT: "Amount off each", TAX_INCLUDED: "Price includes the sales tax" };

/** The warning the owner reads before turning "price includes the tax" on (owner's answer 5). */
export const TAX_INCLUDED_WARNING =
  "Some states forbid advertising or saying that you pay or absorb the sales tax (Massachusetts, Connecticut, Virginia, Nebraska). Check your state's rule, or ask your lawyer, before you use this. You can always simply lower the price instead.";

export type PromoScope = { kinds: string[]; brands: string[]; partIds: string[] };
export type Promo = { id: string; name: string; effect: PromoEffect; value: number; scope: PromoScope };

/** The scope as saved (JSON), cleaned. */
export function readScope(raw: unknown): PromoScope {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);
  return { kinds: list(o.kinds), brands: list(o.brands), partIds: list(o.partIds) };
}

type PromoLine = { kind?: string | null; brand?: string | null; partId?: string | null; qty: number; unitPriceCents: number };

/** Does the promotion cover this line? Any of: its kind, its brand (any case), the item itself. Items being bought only. */
export function promoCovers(p: Pick<Promo, "scope">, l: PromoLine): boolean {
  if (!(l.qty > 0)) return false;
  const s = p.scope;
  if (l.partId && s.partIds.includes(l.partId)) return true;
  if (l.kind && s.kinds.includes(l.kind)) return true;
  const brand = l.brand?.trim().toLowerCase();
  return !!brand && s.brands.some((b) => b.toLowerCase() === brand);
}

/** What a percent or amount promotion takes off the line (never below zero); 0 for a tax-included one. */
export function promoDiscount(p: Pick<Promo, "effect" | "value">, l: { qty: number; unitPriceCents: number }): number {
  const gross = Math.abs(roundCents(l.qty * l.unitPriceCents));
  if (p.effect === "PERCENT") return Math.min(gross, Math.round((gross * Math.max(0, Math.min(100, p.value))) / 100));
  if (p.effect === "AMOUNT") return Math.min(gross, Math.round(Math.max(0, p.value) * Math.abs(l.qty)));
  return 0;
}

/** The best discount among the promotions covering a line, and which one gave it. */
export function bestDiscount(promos: Promo[], l: PromoLine): { promo: Promo; cents: number } | null {
  let best: { promo: Promo; cents: number } | null = null;
  for (const p of promos) {
    if (p.effect === "TAX_INCLUDED" || !promoCovers(p, l)) continue;
    const cents = promoDiscount(p, l);
    if (cents > 0 && (!best || cents > best.cents)) best = { promo: p, cents };
  }
  return best;
}

/** A tax-included promotion covering the line, if any. */
export const includedPromo = (promos: Promo[], l: PromoLine) => promos.find((p) => p.effect === "TAX_INCLUDED" && promoCovers(p, l)) ?? null;

const taxOn = (cents: number, ratePct: number) => roundCents((cents * Math.round(ratePct * 10_000)) / 1_000_000);

/**
 * The price before tax that, with the tax at this rate on top, comes to the sticker price: a $1,000 machine at 7% is
 * $934.58 plus $65.42. When no price lands exactly (rounding), the nearest under it.
 */
export function priceBeforeTax(stickerCents: number, ratePct: number): number {
  const guess = Math.round(stickerCents / (1 + ratePct / 100));
  for (const p of [guess, guess - 1, guess + 1, guess - 2, guess + 2]) if (p >= 0 && p + taxOn(p, ratePct) === stickerCents) return p;
  return guess + taxOn(guess, ratePct) > stickerCents ? guess - 1 : guess;
}

/** The tax a tax-included line carries, for "Price includes $65.42 sales tax". */
export const includedTax = (netCents: number, ratePct: number) => taxOn(netCents, ratePct);
