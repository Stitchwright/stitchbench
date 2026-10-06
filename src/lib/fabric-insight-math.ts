// Fabric insight math (fabric-smarts-design.md sections 2 and 9; formulas and defaults in
// docs/research/fabric-analytics-methods.md). Pure: no "server-only", no database, so the Fabric page, the server body
// (src/lib/fabric-insight.ts) and the check script share one set of numbers. Yards are eighths, money integer cents (the
// figures in between are floating point and rounded once at the end). Days are counted "days ago": 0 is today in the
// shop's time zone.
import { roundCents } from "@/lib/register-math";

// ---------------------------------------------------------------------------------------------------------------
// Shop settings: every threshold (Settings -> Fabric)
// ---------------------------------------------------------------------------------------------------------------

export type InsightSettings = {
  fabVelocityWeeks: number;
  fabEarlyDays: number;
  fabBlendDays: number;
  fabUnratedDays: number;
  fabWatchDays: number;
  fabWatchWeeks: number;
  fabMarkdownDays: number;
  fabClearanceDays: number;
  fabMarkdownSoldPct: number;
  fabStep1Pct: number;
  fabStep2Pct: number;
  fabStep3Pct: number;
  fabFloorPct: number;
  fabCutCostCents: number;
  fabAbcAPct: number;
  fabAbcBPct: number;
  fabGmroiGood: number;
  fabGmroiReview: number;
};

export const INSIGHT_DEFAULTS: InsightSettings = {
  fabVelocityWeeks: 12,
  fabEarlyDays: 21,
  fabBlendDays: 42,
  fabUnratedDays: 42,
  fabWatchDays: 90,
  fabWatchWeeks: 26,
  fabMarkdownDays: 120,
  fabClearanceDays: 180,
  fabMarkdownSoldPct: 60,
  fabStep1Pct: 20,
  fabStep2Pct: 35,
  fabStep3Pct: 50,
  fabFloorPct: 105,
  fabCutCostCents: 50,
  fabAbcAPct: 80,
  fabAbcBPct: 95,
  fabGmroiGood: 3,
  fabGmroiReview: 1.5,
};

export const INSIGHT_SELECT = Object.fromEntries(Object.keys(INSIGHT_DEFAULTS).map((k) => [k, true])) as Record<keyof InsightSettings, true>;

/** The Settings form: key, label, range. `cents` fields are typed in dollars. */
export const INSIGHT_FIELDS: { key: keyof InsightSettings; label: string; min: number; max: number; kind: "int" | "dec" | "cents" }[] = [
  { key: "fabVelocityWeeks", label: "Selling rate is worked out over this many weeks", min: 4, max: 52, kind: "int" },
  { key: "fabEarlyDays", label: "A fabric is \"early\" (no slow-fabric alerts) until it has been in stock this many days", min: 0, max: 120, kind: "int" },
  { key: "fabBlendDays", label: "A new fabric's rate is fully its own after this many in-stock days", min: 7, max: 120, kind: "int" },
  { key: "fabUnratedDays", label: "A/B/C grade waits until a fabric is this many days old", min: 0, max: 365, kind: "int" },
  { key: "fabAbcAPct", label: "A fabrics together make this percent of the fabric margin", min: 50, max: 95, kind: "int" },
  { key: "fabAbcBPct", label: "A and B fabrics together make this percent", min: 60, max: 99, kind: "int" },
  { key: "fabWatchDays", label: "Slow fabric: watch at this many days since it came in", min: 14, max: 720, kind: "int" },
  { key: "fabWatchWeeks", label: "...and only while the weeks of supply are over this (fast sellers aren't slow)", min: 1, max: 260, kind: "int" },
  { key: "fabMarkdownDays", label: "First markdown at this many days", min: 14, max: 720, kind: "int" },
  { key: "fabClearanceDays", label: "Clearance at this many days", min: 14, max: 1095, kind: "int" },
  { key: "fabMarkdownSoldPct", label: "Only fabric less than this percent sold counts as slow", min: 5, max: 100, kind: "int" },
  { key: "fabStep1Pct", label: "Markdown step 1: percent off the regular price", min: 1, max: 90, kind: "int" },
  { key: "fabStep2Pct", label: "Markdown step 2: percent off", min: 1, max: 90, kind: "int" },
  { key: "fabStep3Pct", label: "Markdown step 3: percent off", min: 1, max: 90, kind: "int" },
  { key: "fabFloorPct", label: "Never mark down below this percent of cost (105 = cost + 5%)", min: 100, max: 300, kind: "int" },
  { key: "fabCutCostCents", label: "Cutting and bagging cost per yard cut into fat quarters ($)", min: 0, max: 20, kind: "cents" },
  { key: "fabGmroiGood", label: "GMROI is good at this or more", min: 0.1, max: 20, kind: "dec" },
  { key: "fabGmroiReview", label: "GMROI needs a look under this", min: 0.1, max: 20, kind: "dec" },
];

/** What is wrong with a set of settings taken together, or null. */
export function settingsProblem(s: InsightSettings): string | null {
  if (!(s.fabWatchDays <= s.fabMarkdownDays && s.fabMarkdownDays <= s.fabClearanceDays)) return "Watch, first markdown and clearance days must run in that order (smallest first).";
  if (!(s.fabStep1Pct < s.fabStep2Pct && s.fabStep2Pct < s.fabStep3Pct)) return "The markdown steps must get deeper: step 1 less than step 2 less than step 3.";
  if (!(s.fabAbcAPct < s.fabAbcBPct)) return "The A cut must be lower than the A and B cut.";
  if (!(s.fabGmroiReview < s.fabGmroiGood)) return "The GMROI \"needs a look\" figure must be lower than the \"good\" figure.";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Day arithmetic
// ---------------------------------------------------------------------------------------------------------------

/** Whole days from `day` to `today` (both "YYYY-MM-DD"), so yesterday is 1. */
export function daysAgo(day: string, today: string): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------------------------------------------
// Velocity: yards a week over the in-stock days, Croston for lumpy sellers, a prior for new fabric
// ---------------------------------------------------------------------------------------------------------------

/**
 * Yards on hand at the end of each day, from `qNow` backwards: the end of day k is the end of day k-1 less the moves
 * made on day k-1. `net` is the day's moves (days ago -> yards in minus out). Index 0 is today.
 */
export function dayBalances(qNow: number, net: ReadonlyMap<number, number>, n: number): number[] {
  const out = [qNow];
  for (let k = 1; k < n; k++) out.push(out[k - 1] - (net.get(k - 1) ?? 0));
  return out;
}

export const CROSTON_ALPHA = 0.2;
/** Lumpy: more than this share of the weeks the fabric was in stock had no sale (and at least 4 such weeks to judge by). */
export const LUMPY_ZERO_SHARE = 0.5;
const MIN_WEEK_DAYS = 4;

/**
 * Croston's method with the Syntetos-Boylan correction, on weekly sales (oldest first, zero weeks included): the size of
 * the weeks that sold and the gap between them are smoothed separately (alpha 0.2), then size / gap x (1 - alpha / 2).
 * A silence longer than the smoothed gap counts as the gap, so a fabric that stopped selling fades instead of holding its
 * old rate.
 */
export function crostonSba(weekly: number[], alpha = CROSTON_ALPHA): number {
  let size: number | null = null;
  let gap = 0;
  let since = 0;
  for (const z of weekly) {
    since += 1;
    if (z > 0) {
      if (size == null) {
        size = z;
        gap = since;
      } else {
        size = alpha * z + (1 - alpha) * size;
        gap = alpha * since + (1 - alpha) * gap;
      }
      since = 0;
    }
  }
  if (size == null) return 0;
  return (size / Math.max(gap, since)) * (1 - alpha / 2);
}

export type Velocity = {
  /** Days of the window the fabric was in stock (on hand at the end of the day, or sold that day). */
  daysInStock: number;
  /** Yards sold in the window. */
  sold: number;
  /** Yards a week, from the in-stock days: sold / days in stock x 7. */
  trailing: number;
  lumpy: boolean;
  /** The fabric's own rate: the trailing rate, or Croston's for a lumpy seller. */
  own: number;
};

/**
 * One fabric's own selling rate. `existsAgo` is how many days ago the fabric first existed (its creation or first move);
 * days before that don't count as "in stock". `sold` is yards sold by day (days ago), returns counted as negative.
 */
export function velocityOf(o: { qNow: number; net: ReadonlyMap<number, number>; sold: ReadonlyMap<number, number>; existsAgo: number; weeks: number }): Velocity {
  const W = o.weeks * 7;
  const bal = dayBalances(o.qNow, o.net, W);
  const inStock: boolean[] = [];
  let sold = 0;
  for (let k = 0; k < W; k++) {
    const s = o.sold.get(k) ?? 0;
    inStock.push(k <= o.existsAgo && (bal[k] > 1e-9 || s > 0));
    if (k <= o.existsAgo) sold += s;
  }
  sold = Math.max(0, sold);
  const daysInStock = inStock.filter(Boolean).length;
  const trailing = daysInStock > 0 ? (sold / daysInStock) * 7 : 0;
  const weekly: number[] = [];
  for (let j = o.weeks - 1; j >= 0; j--) {
    let d = 0;
    let z = 0;
    for (let k = 7 * j; k < 7 * j + 7; k++) {
      if (inStock[k]) d += 1;
      z += o.sold.get(k) ?? 0;
    }
    if (d >= MIN_WEEK_DAYS) weekly.push(Math.max(0, z));
  }
  const zeroWeeks = weekly.filter((z) => z === 0).length;
  const lumpy = weekly.length >= 4 && zeroWeeks / weekly.length > LUMPY_ZERO_SHARE;
  return { daysInStock, sold, trailing, lumpy, own: lumpy ? crostonSba(weekly) : trailing };
}

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * A new fabric's rate: the weight on its own rate grows from 0 to 1 over `blendDays` in-stock days, the rest is the
 * prior (the median rate of comparable, established fabrics).
 */
export function blendVelocity(own: number, daysInStock: number, blendDays: number, prior: number): { rate: number; weight: number } {
  const weight = Math.min(1, Math.max(0, daysInStock / Math.max(1, blendDays)));
  return { rate: weight * own + (1 - weight) * prior, weight };
}

/** The best prior for a new fabric: the median of established fabrics in its maker, else its price band, else the shop. */
export function priorRate(o: { brand: string | null; band: string }, pool: { brand: string | null; band: string; rate: number }[]): number {
  const same = (f: (p: (typeof pool)[number]) => boolean) => median(pool.filter(f).map((p) => p.rate));
  return (o.brand ? same((p) => p.brand === o.brand) : null) ?? same((p) => p.band === o.band) ?? median(pool.map((p) => p.rate)) ?? 0;
}

/** Weeks the yards on hand last at this rate; null when nothing sells. */
export const weeksOfSupply = (qty: number, perWeek: number): number | null => (perWeek > 1e-9 ? qty / perWeek : null);

export function priceBand(cents: number | null): string {
  if (cents == null) return "No price";
  if (cents < 800) return "Under $8";
  if (cents < 1000) return "$8 to $10";
  if (cents < 1200) return "$10 to $12";
  if (cents < 1400) return "$12 to $14";
  return "$14 and up";
}

// ---------------------------------------------------------------------------------------------------------------
// Age: first in, first out from the receipts
// ---------------------------------------------------------------------------------------------------------------

export type Lot = { ago: number; yards: number };
export type Aged = {
  /** Yard-weighted age of the yards still on hand. */
  ageDays: number;
  /** Age of the oldest lot with yards still on hand. */
  oldestDays: number;
  /** Share of what came in (from the oldest unsold lot on) that is gone, 0 to 1. */
  soldShare: number;
  /** Yards on hand taken from lots (less than the count when some yards have no lot). */
  yards: number;
};

/**
 * FIFO: the oldest yards leave first, so what is on hand is the newest lots. Walks the lots newest first until the yards
 * on hand are used up. The sold share is 1 less the yards on hand over everything received from the oldest lot still
 * unsold up to now (cut and used yards count as gone, like sold).
 */
export function fifoAge(lots: Lot[], qNow: number): Aged | null {
  const sorted = [...lots].filter((l) => l.yards > 1e-9).sort((a, b) => a.ago - b.ago);
  let left = qNow;
  let took = 0;
  let weighted = 0;
  let oldest = 0;
  let intake = 0;
  for (const l of sorted) {
    if (left <= 1e-9) break;
    const t = Math.min(l.yards, left);
    left -= t;
    took += t;
    weighted += t * l.ago;
    oldest = Math.max(oldest, l.ago);
    intake += l.yards;
  }
  if (took <= 0 || intake <= 0) return null;
  return { ageDays: weighted / took, oldestDays: oldest, soldShare: Math.min(1, Math.max(0, 1 - took / intake)), yards: took };
}

export type SlowStage = "watch" | "markdown" | "clearance";

/**
 * Where an aged fabric stands: null when it is early, young, or sold well enough. Watch from `fabWatchDays`, first
 * markdown from `fabMarkdownDays`, clearance from `fabClearanceDays`; only while under `fabMarkdownSoldPct` sold. Watch also
 * needs the weeks of supply over `fabWatchWeeks` (or no sales at all), so an old lot of a steady seller isn't flagged.
 */
export function slowStage(a: Aged, sinceFirstStockDays: number, s: InsightSettings, weeks: number | null = null): SlowStage | null {
  if (sinceFirstStockDays < s.fabEarlyDays) return null;
  if (a.soldShare * 100 >= s.fabMarkdownSoldPct) return null;
  if (a.ageDays >= s.fabClearanceDays) return "clearance";
  if (a.ageDays >= s.fabMarkdownDays) return "markdown";
  if (a.ageDays >= s.fabWatchDays && (weeks == null || weeks > s.fabWatchWeeks)) return "watch";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The markdown ladder and the convert-or-mark-down comparison
// ---------------------------------------------------------------------------------------------------------------

/** A fabric's cost per yard in ten-thousandths of a dollar (the finer figure while it still agrees with costCents). */
export function yardCostTenThou(f: { costCents: number | null; costTenThou: number | null }): number | null {
  if (f.costCents == null) return null;
  return f.costTenThou != null && Math.round(f.costTenThou / 100) === f.costCents ? f.costTenThou : f.costCents * 100;
}

export type LadderRow = { id: string; step: number; regularCents: number; newCents: number; oldCents: number; day: string };
export type MarkdownOffer = { step: 1 | 2 | 3; pct: number; priceCents: number; fromCents: number; regularCents: number; held: boolean };
export type LadderView = {
  /** The step the price is on now (0: regular price). */
  step: number;
  regularCents: number | null;
  floorCents: number | null;
  /** The next markdown, or null with `stopped` saying why. */
  offer: MarkdownOffer | null;
  stopped: "noprice" | "last" | "floor" | null;
  /** The latest markdown, while it is still today's and the price is still its price. */
  undo: { id: string; backCents: number; step: number } | null;
};

/**
 * The ladder for one fabric. `rows` are its active (not undone) markdowns, latest first. The ladder is on the latest row
 * while the price is still that row's new price; a price changed by hand since starts the ladder again from the price it
 * has now. The next step is a percent off the regular price, never below the floor (cost x floor percent) and never up.
 */
export function ladderView(o: { priceCents: number | null; yardTenThou: number | null; rows: LadderRow[]; today: string }, s: InsightSettings): LadderView {
  const floorCents = o.yardTenThou == null ? null : Math.ceil((o.yardTenThou * s.fabFloorPct) / 10_000);
  if (o.priceCents == null) return { step: 0, regularCents: null, floorCents, offer: null, stopped: "noprice", undo: null };
  const latest = o.rows[0];
  const on = latest && latest.newCents === o.priceCents ? latest : null;
  const step = on?.step ?? 0;
  const regularCents = on?.regularCents ?? o.priceCents;
  const undo = on && on.day === o.today ? { id: on.id, backCents: on.oldCents, step: on.step } : null;
  const pcts = [s.fabStep1Pct, s.fabStep2Pct, s.fabStep3Pct];
  if (step >= 3) return { step, regularCents, floorCents, offer: null, stopped: "last", undo };
  const pct = pcts[step];
  const raw = roundCents((regularCents * (100 - pct)) / 100);
  const price = Math.max(raw, floorCents ?? 0);
  if (price >= o.priceCents) return { step, regularCents, floorCents, offer: null, stopped: "floor", undo };
  return { step, regularCents, floorCents, offer: { step: (step + 1) as 1 | 2 | 3, pct, priceCents: price, fromCents: o.priceCents, regularCents, held: price > raw }, stopped: null, undo };
}

export type Convert = { markdownMargin: number | null; fqMargin: number; better: "markdown" | "fq" };

/**
 * What a yard earns each way, in cents: marked down at the next step (price less cost), or cut into four fat quarters at
 * the cut price (four prices, less cost, less the cutting cost per yard). Tie goes to the markdown (no cutting).
 */
export function convertVsMarkdown(o: { markdownPriceCents: number | null; fqPriceCents: number; yardCostCents: number; cutCostCents: number }): Convert {
  const markdownMargin = o.markdownPriceCents == null ? null : Math.round(o.markdownPriceCents - o.yardCostCents);
  const fqMargin = Math.round(4 * o.fqPriceCents - o.yardCostCents - o.cutCostCents);
  return { markdownMargin, fqMargin, better: markdownMargin == null || fqMargin > markdownMargin ? "fq" : "markdown" };
}

// ---------------------------------------------------------------------------------------------------------------
// ABC and GMROI
// ---------------------------------------------------------------------------------------------------------------

export type Grade = "A" | "B" | "C" | "unrated";

/**
 * A/B/C by 12-month margin: fabrics sorted by margin, a running share of the margin of all rated fabrics; A while the
 * running share is at most `aPct` (the best seller is always A), B up to `bPct`, C after. No or negative margin is C.
 * Unrated fabrics (too new) are left out of the shares.
 */
export function abcGrades(items: { id: string; margin: number; rated: boolean }[], aPct: number, bPct: number): Map<string, Grade> {
  const out = new Map<string, Grade>();
  const rated = items.filter((i) => i.rated);
  for (const i of items) if (!i.rated) out.set(i.id, "unrated");
  const winners = rated.filter((i) => i.margin > 0).sort((a, b) => b.margin - a.margin);
  for (const i of rated) if (i.margin <= 0) out.set(i.id, "C");
  const total = winners.reduce((a, i) => a + i.margin, 0);
  let run = 0;
  winners.forEach((i, n) => {
    run += i.margin;
    const share = (run / total) * 100;
    out.set(i.id, n === 0 || share <= aPct + 1e-9 ? "A" : share <= bPct + 1e-9 ? "B" : "C");
  });
  return out;
}

/** Gross margin return on inventory: the margin of the window, scaled to a year, over the average inventory at cost. */
export function gmroi(o: { marginCents: number; avgInventoryCents: number; windowDays: number }): number | null {
  if (o.avgInventoryCents <= 0 || o.windowDays <= 0) return null;
  return (o.marginCents * (365 / o.windowDays)) / o.avgInventoryCents;
}

export type GmroiBand = "good" | "ok" | "review";
export const gmroiBand = (g: number, s: Pick<InsightSettings, "fabGmroiGood" | "fabGmroiReview">): GmroiBand => (g >= s.fabGmroiGood ? "good" : g < s.fabGmroiReview ? "review" : "ok");
