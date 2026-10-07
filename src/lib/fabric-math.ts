// Fabric cuts (fabric-smarts-design.md sections 2 and 9). Pure: no "server-only", no database, so the Fabric page, the
// server body (src/lib/fabric.ts) and the check script share one set of numbers. Yards are eighths, money integer cents.
import { tenThouToCents } from "@/lib/format";
import { inEighths, yards } from "@/lib/register-math";

export type CutKind = "FQ" | "HALF" | "REMNANT";
export const CUT_KINDS: CutKind[] = ["FQ", "HALF", "REMNANT"];

export const CUT_INFO: Record<CutKind, { suffix: string; tag: string; one: string; many: string; each: boolean }> = {
  FQ: { suffix: "FQ", tag: "fat quarter", one: "fat quarter", many: "fat quarters", each: true },
  HALF: { suffix: "HY", tag: "half yard", one: "half yard", many: "half yards", each: true },
  REMNANT: { suffix: "REM", tag: "remnant", one: "remnant", many: "remnant", each: false },
};

export type CutSettings = { fatQuarterMarkupPct: number; halfYardMarkupPct: number; remnantPricePct: number };
export const CUT_DEFAULTS: CutSettings = { fatQuarterMarkupPct: 15, halfYardMarkupPct: 10, remnantPricePct: 50 };

/**
 * What a cut takes off the bolt and what it makes. A fat quarter is 1/4 yd, a half yard 1/2 yd: as many as fit
 * (floor), the rest stays on the bolt. A remnant takes all that's left; its count is the yards, since the remnant item
 * is sold by the yard. `count` is what is added to the target item.
 */
export function cutPlan(kind: CutKind, onHand: number): { count: number; usedYards: number; leftYards: number } {
  // The yards exactly as counted: a bolt can hold a non-eighth amount (a sale by the inch, a count fixed by hand), and
  // rounding it would take more than is there or leave a sliver behind.
  const have = Math.max(0, onHand);
  if (kind === "REMNANT") return { count: have, usedYards: have, leftYards: 0 };
  const per = kind === "FQ" ? 0.25 : 0.5;
  const count = Math.floor(have / per + 1e-9);
  const usedYards = count * per;
  return { count, usedYards, leftYards: Math.max(0, Math.round((have - usedYards) * 10_000) / 10_000) };
}

/** Yards as they are: eighths as a fraction ("1 3/8"), anything else as a decimal ("1.3", "0.24"), never rounded to an eighth. */
export function exactYards(q: number): string {
  return inEighths(q) ? yards(q) : String(Math.round(q * 10_000) / 10_000);
}

/** "1 3/8 yd makes 5 fat quarters, with 1/8 yd left." */
export function cutWords(kind: CutKind, onHand: number): string {
  const p = cutPlan(kind, onHand);
  if (kind === "REMNANT") return `${exactYards(onHand)} yd goes to the remnant bin.`;
  const info = CUT_INFO[kind];
  if (p.count === 0) return `${exactYards(onHand)} yd is too short for a ${info.one}.`;
  return `${exactYards(onHand)} yd makes ${p.count} ${p.count === 1 ? info.one : info.many}${p.leftYards > 0 ? `, with ${exactYards(p.leftYards)} yd left` : ""}.`;
}

type Priced = { priceCents: number | null; costCents: number | null; costTenThou: number | null };

/**
 * The price and cost of the target item, from the fabric's price and cost per yard. Fat quarter: yard price / 4 x 1.15;
 * half yard: yard price / 2 x 1.10 (the shop's markups). Remnant: a percent of the yard price per yard, never under cost x
 * 1.05. The cost follows the fabric's: a quarter of the yard cost for a fat quarter, half for a half yard.
 */
export function cutPrices(kind: CutKind, f: Priced, s: CutSettings = CUT_DEFAULTS): Priced {
  const yardTenThou = f.costCents == null ? null : f.costTenThou != null && tenThouToCents(f.costTenThou) === f.costCents ? f.costTenThou : f.costCents * 100;
  const div = kind === "FQ" ? 4 : kind === "HALF" ? 2 : 1;
  const costTenThou = yardTenThou == null ? null : Math.round(yardTenThou / div);
  const costCents = costTenThou == null ? null : tenThouToCents(costTenThou);
  let priceCents: number | null = null;
  if (f.priceCents != null) {
    if (kind === "FQ") priceCents = Math.round((f.priceCents * (100 + s.fatQuarterMarkupPct)) / 400);
    else if (kind === "HALF") priceCents = Math.round((f.priceCents * (100 + s.halfYardMarkupPct)) / 200);
    else {
      priceCents = Math.round((f.priceCents * s.remnantPricePct) / 100);
      if (yardTenThou != null) priceCents = Math.max(priceCents, Math.ceil((yardTenThou * 105) / 10_000));
    }
  }
  return { priceCents, costCents, costTenThou };
}
