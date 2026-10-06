// Kit math (fabric-smarts-design.md sections 4 and 9; formulas in docs/research/fabric-analytics-methods.md section 8).
// Pure: no "server-only", no database, so the kit pages, the server bodies (src/lib/kits.ts) and the check script share one
// set of numbers. Money is integer cents, yards are eighths, a kit's amounts are per kit.
import { lineCostCents } from "@/lib/format";
import { roundCents } from "@/lib/register-math";

export type KitSettings = { fabKitMarginPct: number; fabBundleDiscountPct: number };
export const KIT_DEFAULTS: KitSettings = { fabKitMarginPct: 50, fabBundleDiscountPct: 5 };
export const KIT_SELECT = Object.fromEntries(Object.keys(KIT_DEFAULTS).map((k) => [k, true])) as Record<keyof KitSettings, true>;

export const KIT_FIELDS: { key: keyof KitSettings; label: string; min: number; max: number }[] = [
  { key: "fabKitMarginPct", label: "Kit margin target (percent of the price that is margin; 50 means the price is twice the cost)", min: 5, max: 90 },
  { key: "fabBundleDiscountPct", label: "Bundle discount off the parts' shelf prices (0 to 10)", min: 0, max: 10 },
];

/** One kit line as the math sees it: the amount per kit and what the item costs and sells for (a yard, or one each). */
export type KitPart = { qty: number; costCents: number | null; costTenThou?: number | null; priceCents: number | null };

/** What the kit's parts cost, in cents: each line's amount x its cost (a cost finer than a cent counts), rounded per line. Lines with no cost add nothing. */
export const partsCost = (parts: KitPart[]): number => parts.reduce((a, p) => a + (p.costCents == null ? 0 : lineCostCents(p.qty, p.costCents, p.costTenThou ?? null)), 0);

/** What a customer would pay for the parts separately, in cents. */
export const partsRetail = (parts: KitPart[]): number => parts.reduce((a, p) => a + (p.priceCents == null ? 0 : roundCents(p.qty * p.priceCents)), 0);

export type KitPrice = {
  costCents: number;
  retailCents: number;
  /** cost / (1 - margin target). */
  byMargin: number;
  /** The parts' retail less the bundle discount. */
  byBundle: number;
  /** The larger of the two. */
  priceCents: number;
  basis: "margin" | "bundle";
  /** Margin at the suggested price, percent (null when the price is 0). */
  marginPct: number | null;
};

/** The suggestion: the larger of cost / (1 - margin) and the parts' retail less the bundle discount; cents. */
export function suggestKitPrice(o: { costCents: number; retailCents: number; marginPct: number; bundlePct: number }): KitPrice {
  const byMargin = roundCents(o.costCents / (1 - o.marginPct / 100));
  const byBundle = roundCents(o.retailCents * (1 - o.bundlePct / 100));
  const priceCents = Math.max(byMargin, byBundle);
  return { costCents: o.costCents, retailCents: o.retailCents, byMargin, byBundle, priceCents, basis: byMargin >= byBundle ? "margin" : "bundle", marginPct: kitMarginPct(priceCents, o.costCents) };
}

/** Margin as a percent of the price (one decimal, as 33.3); null with no price. */
export function kitMarginPct(priceCents: number | null | undefined, costCents: number): number | null {
  if (priceCents == null || priceCents <= 0) return null;
  return Math.round(((priceCents - costCents) / priceCents) * 1000) / 10;
}

/** How many kits the stock covers: the fewest whole kits any line allows (0 when a line is empty). */
export function makeableKits(lines: { qty: number; onHand: number }[]): number | null {
  if (!lines.length) return null;
  return Math.min(...lines.map((l) => (l.qty > 0 ? Math.max(0, Math.floor(l.onHand / l.qty + 1e-9)) : Infinity)));
}

export type Shortage = { partNumber: string; need: number; have: number; unit: string | null };

/** Which lines can't be taken off the shelf for `n` kits, with what they need and what is there. */
export function shortages(lines: { partNumber: string; qty: number; onHand: number; unit: string | null }[], n: number): Shortage[] {
  return lines.flatMap((l) => (l.qty * n > l.onHand + 1e-9 ? [{ partNumber: l.partNumber, need: l.qty * n, have: l.onHand, unit: l.unit }] : []));
}

/** A kit amount is yards in eighths for fabric sold by the yard, a whole number of units for anything else. */
export function kitQtyProblem(unit: string | null, qty: number): string | null {
  if (!Number.isFinite(qty) || qty <= 0 || qty > 10_000) return "enter an amount over 0";
  if (unit === "yd") return Math.abs(qty * 8 - Math.round(qty * 8)) < 1e-6 ? null : "yards are counted in eighths (1/8 = 0.125)";
  return Number.isInteger(qty) ? null : "this item is counted in whole units";
}
