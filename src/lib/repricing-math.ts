// "Raise prices" and the margin floor (shop-features-round-2-design.md 4.4): the pure part. Whose prices (a supplier, a
// maker, a kind, a collection, or the items under the margin floor), by how much, how a new price is rounded (always up,
// so a raise never comes out lower), an item's margin, and the floor for its kind. No "server-only", no database.

export const ROUNDINGS = {
  "99": "Ends in .99 ($12.99)",
  "25": "Up to the next 25 cents ($12.25, $12.50)",
  "50": "Up to the next 50 cents ($12.50, $13.00)",
  "1": "To the cent",
} as const;
export type Rounding = keyof typeof ROUNDINGS;
export const isRounding = (s: unknown): s is Rounding => typeof s === "string" && s in ROUNDINGS;

export const WHOSE = { supplier: "Supplier", brand: "Maker", kind: "Kind", collection: "Collection", floor: "Under your margin floor" } as const;
export type Whose = keyof typeof WHOSE;
export const isWhose = (s: unknown): s is Whose => typeof s === "string" && s in WHOSE;

export type RaiseRule = { whose: Whose; value: string | null; pct: number; round: Rounding };

/** A price rounded up the shop's way: the smallest price at or above `cents` that ends right. */
export function roundUp(cents: number, round: Rounding): number {
  const c = Math.ceil(cents);
  if (round === "1") return c;
  if (round === "99") return Math.ceil((c + 1) / 100) * 100 - 1;
  const step = Number(round);
  return Math.ceil(c / step) * step;
}

/** The new price for a raise of `pct` percent, rounded; never below the old price. */
export function raised(oldCents: number, pct: number, round: Rounding): number {
  // In whole numbers (thousandths of a percent): $10.00 + 10% is exactly 1100 cents, not 1100.0000000000002 rounded up a step.
  const per = Math.round((100 + pct) * 1000);
  return Math.max(oldCents, roundUp(Math.ceil((Math.round(oldCents) * per) / 100_000), round));
}

/** The margin as a percent of the price ((price - cost) / price), or null without both. */
export function marginPct(priceCents: number | null | undefined, costCents: number | null | undefined): number | null {
  if (priceCents == null || costCents == null || priceCents <= 0) return null;
  return ((priceCents - costCents) / priceCents) * 100;
}

export type Floors = { all: number | null; [kind: string]: number | null };

/** The shop's floors read safely from its saved JSON: percents 1 to 95, anything else dropped. */
export function floorsOf(j: unknown): Floors {
  const out: Floors = { all: null };
  if (!j || typeof j !== "object" || Array.isArray(j)) return out;
  for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
    const n = Number(v);
    if (/^[A-Z_]+$|^all$/.test(k) && Number.isFinite(n) && n >= 1 && n <= 95) out[k] = Math.round(n);
  }
  return out;
}

/** The floor for an item's kind (its own figure, else the shop's), or null when off. */
export const floorFor = (f: Floors, kind: string): number | null => f[kind] ?? f.all ?? null;

/** The price that brings an item up to its floor, rounded the shop's way; never below its price now. */
export function floorPrice(priceCents: number, costCents: number, floor: number, round: Rounding): number {
  // Whole numbers: a cost of $3.00 at a 25% floor is exactly $4.00.
  return Math.max(priceCents, roundUp(Math.ceil((Math.round(costCents) * 100) / (100 - Math.round(floor))), round));
}

/** True when the item has a price and a cost and its margin is under its floor. */
export function underFloor(p: { priceCents: number | null; costCents: number | null; kind: string }, f: Floors): boolean {
  const floor = floorFor(f, p.kind);
  const m = marginPct(p.priceCents, p.costCents);
  return floor != null && m != null && m < floor - 1e-9;
}

/** Percent typed the forgiving way ("10", "10%", " 7.5 "): 0.5 to 200, else null. */
export function pctInput(s: string | null | undefined): number | null {
  const n = Number((s ?? "").replace(/[%\s]/g, ""));
  return Number.isFinite(n) && n >= 0.5 && n <= 200 ? Math.round(n * 100) / 100 : null;
}

/** "Raised Moda's prices 10%, ends in .99" for the list of raises. */
export function ruleWords(r: RaiseRule): string {
  const who = r.whose === "floor" ? "items under the margin floor" : `${WHOSE[r.whose].toLowerCase()} ${r.value ?? ""}`.trim();
  const how = r.whose === "floor" ? "up to the floor" : `${r.pct}%`;
  return `${who}, ${how}, ${ROUNDINGS[r.round].split(" (")[0].toLowerCase()}`;
}
