// Decorating orders (docs/plans/decorators-proposal.md, package D1 and D2): the words, the steps an order may take, the
// shop's price table and what an order comes to. Embroidery is priced by stitch count (a table of "up to this many
// stitches costs this much a piece", then so much for every extra thousand), less a quantity break, plus a digitizing fee
// for a design that has to be made and a set-up fee. Pure: pages, the server and the checks share it. Money in cents.
// The numbers in DEFAULT_PRICES are starting values for a new shop to change, not market prices.
import { roundCents } from "@/lib/register-math";

export const DECOR_STATUSES = ["QUOTED", "APPROVED", "IN_PRODUCTION", "READY", "COLLECTED", "CANCELLED", "TURNED_DOWN"] as const;
export type DecorStatus = (typeof DECOR_STATUSES)[number];

export const DECOR_LABEL: Record<string, string> = {
  QUOTED: "Quoted",
  APPROVED: "Approved",
  IN_PRODUCTION: "In production",
  READY: "Ready",
  COLLECTED: "Collected",
  CANCELLED: "Cancelled",
  TURNED_DOWN: "Turned down",
};
export const decorStatusLabel = (s: string) => DECOR_LABEL[s] ?? s;
export const DECOR_TONE: Record<string, string> = { QUOTED: "tone-neutral", APPROVED: "tone-work", IN_PRODUCTION: "tone-work", READY: "tone-ready", COLLECTED: "tone-done", CANCELLED: "tone-bad", TURNED_DOWN: "tone-bad" };
export const OPEN_DECOR: DecorStatus[] = ["QUOTED", "APPROVED", "IN_PRODUCTION", "READY"];

/** The steps an order may take by hand (collecting is the register's; turning down has its own button). */
export const DECOR_MOVES: Record<string, DecorStatus[]> = {
  QUOTED: ["APPROVED", "CANCELLED"],
  APPROVED: ["IN_PRODUCTION", "QUOTED", "CANCELLED"],
  IN_PRODUCTION: ["READY", "APPROVED"],
  READY: ["IN_PRODUCTION"],
};

/** The decoration methods. Only embroidery is priced so far (screen printing is the next package). */
export const DECOR_METHODS = ["EMBROIDERY"] as const;
export type DecorMethod = (typeof DECOR_METHODS)[number];
export const METHOD_LABEL: Record<string, string> = { EMBROIDERY: "Embroidery" };

export const PLACEMENTS = ["Left chest", "Right chest", "Full back", "Back yoke", "Left sleeve", "Right sleeve", "Cap front", "Cap side", "Cap back", "Other"] as const;

export type StitchTier = { upTo: number; cents: number };
export type QtyBreak = { min: number; pct: number };
export type DecorPrices = {
  tiers: StitchTier[]; // ascending by upTo
  extraPer1000Cents: number; // each started thousand past the last tier
  breaks: QtyBreak[]; // ascending by min: from this many pieces, this percent off the decoration
  digitizingCents: number; // once per new design
  setupCents: number; // once per order
  stitchesPerMinute: number; // the machine's sewing speed, for run time
  colorChangeSeconds: number;
};

export const DEFAULT_PRICES: DecorPrices = {
  tiers: [
    { upTo: 5000, cents: 600 },
    { upTo: 8000, cents: 750 },
    { upTo: 12000, cents: 900 },
    { upTo: 20000, cents: 1200 },
  ],
  extraPer1000Cents: 80,
  breaks: [
    { min: 12, pct: 5 },
    { min: 24, pct: 10 },
    { min: 48, pct: 15 },
    { min: 100, pct: 20 },
  ],
  digitizingCents: 3500,
  setupCents: 0,
  stitchesPerMinute: 700,
  colorChangeSeconds: 45,
};

const MAX_CENTS = 10_000_000;
const int = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
};

/** Whatever was stored, made safe: bad or missing parts fall back to the starting values. */
export function cleanPrices(raw: unknown): DecorPrices {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tiers = Array.isArray(r.tiers)
    ? (r.tiers as unknown[])
        .map((t) => ({ upTo: int((t as StitchTier)?.upTo, 1, 1_000_000, 0), cents: int((t as StitchTier)?.cents, 0, MAX_CENTS, -1) }))
        .filter((t) => t.upTo > 0 && t.cents >= 0)
        .sort((a, b) => a.upTo - b.upTo)
        .slice(0, 20)
    : [];
  const breaks = Array.isArray(r.breaks)
    ? (r.breaks as unknown[])
        .map((b) => ({ min: int((b as QtyBreak)?.min, 2, 100_000, 0), pct: int((b as QtyBreak)?.pct, 0, 90, -1) }))
        .filter((b) => b.min >= 2 && b.pct >= 0)
        .sort((a, b) => a.min - b.min)
        .slice(0, 20)
    : [];
  return {
    tiers: tiers.length ? tiers : DEFAULT_PRICES.tiers,
    extraPer1000Cents: int(r.extraPer1000Cents, 0, 100_000, DEFAULT_PRICES.extraPer1000Cents),
    breaks: Array.isArray(r.breaks) ? breaks : DEFAULT_PRICES.breaks,
    digitizingCents: int(r.digitizingCents, 0, MAX_CENTS, DEFAULT_PRICES.digitizingCents),
    setupCents: int(r.setupCents, 0, MAX_CENTS, DEFAULT_PRICES.setupCents),
    stitchesPerMinute: int(r.stitchesPerMinute, 50, 3000, DEFAULT_PRICES.stitchesPerMinute),
    colorChangeSeconds: int(r.colorChangeSeconds, 0, 3600, DEFAULT_PRICES.colorChangeSeconds),
  };
}

/** What one piece costs to embroider: the tier for its stitch count, or the last tier plus the extra thousands. */
export function basePriceCents(stitches: number, p: DecorPrices): number {
  const s = Math.max(0, Math.round(stitches));
  const tier = p.tiers.find((t) => s <= t.upTo);
  if (tier) return tier.cents;
  const last = p.tiers[p.tiers.length - 1];
  if (!last) return 0;
  return last.cents + Math.ceil((s - last.upTo) / 1000) * p.extraPer1000Cents;
}

/** The percent off for this many pieces: the largest break whose minimum is reached, else 0. */
export function breakPct(pieces: number, p: DecorPrices): number {
  let pct = 0;
  for (const b of p.breaks) if (pieces >= b.min) pct = b.pct;
  return pct;
}

/** One piece's embroidery price for an order of this many pieces, rounded to the cent. */
export function pieceCents(stitches: number, pieces: number, p: DecorPrices): number {
  return roundCents((basePriceCents(stitches, p) * (100 - breakPct(pieces, p))) / 100);
}

/** Machine time for one piece, in whole minutes (at least 1 for anything with stitches). */
export function runMinutes(stitches: number, colors: number, p: DecorPrices): number {
  if (stitches <= 0) return 0;
  const changes = Math.max(0, Math.round(colors) - 1);
  return Math.max(1, Math.ceil(stitches / p.stitchesPerMinute + (changes * p.colorChangeSeconds) / 60));
}

export type OrderLine = { qty: number; garmentCents: number };
export type OrderPlacement = { stitches: number; newDesign: boolean; priceEachCents: number | null };
export type OrderPrice = {
  pieces: number;
  garmentCents: number;
  decorationCents: number;
  /** Each placement's price per piece, in the order given (a typed price wins over the table). */
  eachCents: number[];
  digitizingCents: number;
  setupCents: number;
  totalCents: number;
};

/**
 * What an order comes to. Every piece gets every placement, so decoration = pieces x each placement's price per piece.
 * A placement with a typed price per piece uses it (a negotiated price); otherwise the table sets it. Digitizing is charged
 * once for each placement marked as a new design.
 */
export function orderPrice(lines: OrderLine[], placements: OrderPlacement[], p: DecorPrices): OrderPrice {
  const pieces = lines.reduce((s, l) => s + Math.max(0, Math.round(l.qty)), 0);
  const garmentCents = lines.reduce((s, l) => s + Math.max(0, Math.round(l.qty)) * Math.max(0, Math.round(l.garmentCents)), 0);
  const eachCents = placements.map((pl) => (pl.priceEachCents != null ? Math.max(0, Math.round(pl.priceEachCents)) : pieceCents(pl.stitches, pieces, p)));
  const decorationCents = eachCents.reduce((s, c) => s + c * pieces, 0);
  const digitizingCents = placements.filter((pl) => pl.newDesign).length * p.digitizingCents;
  const setupCents = pieces > 0 || placements.length > 0 ? p.setupCents : 0;
  return { pieces, garmentCents, decorationCents, eachCents, digitizingCents, setupCents, totalCents: garmentCents + decorationCents + digitizingCents + setupCents };
}

// ---- the price table as the settings form shows it -------------------------------------------------------------

/** "5000: 6.00" a line (stitches up to: dollars a piece) -> tiers; null with a message when a line can't be read. */
export function parseTiers(text: string): { tiers: StitchTier[] } | { error: string } {
  const tiers: StitchTier[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(\d{1,7})\s*[:=,]\s*\$?(\d{1,6}(?:\.\d{1,2})?)$/.exec(line);
    if (!m) return { error: `"${line}" isn't a price line. Write stitches, a colon and dollars, like 5000: 6.00` };
    tiers.push({ upTo: Number(m[1]), cents: Math.round(Number(m[2]) * 100) });
  }
  if (!tiers.length) return { error: "Give at least one price line, like 5000: 6.00" };
  if (tiers.length > 20) return { error: "Twenty price lines is the most." };
  tiers.sort((a, b) => a.upTo - b.upTo);
  for (let i = 1; i < tiers.length; i++) if (tiers[i].upTo === tiers[i - 1].upTo) return { error: `${tiers[i].upTo} stitches is listed twice.` };
  return { tiers };
}
export const tiersText = (tiers: StitchTier[]) => tiers.map((t) => `${t.upTo}: ${(t.cents / 100).toFixed(2)}`).join("\n");

/** "12: 5" a line (pieces from: percent off) -> breaks; an empty text means no breaks. */
export function parseBreaks(text: string): { breaks: QtyBreak[] } | { error: string } {
  const breaks: QtyBreak[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(\d{1,6})\s*[:=,]\s*(\d{1,2})\s*%?$/.exec(line);
    if (!m || Number(m[1]) < 2) return { error: `"${line}" isn't a break line. Write pieces, a colon and the percent off, like 12: 5` };
    breaks.push({ min: Number(m[1]), pct: Number(m[2]) });
  }
  if (breaks.length > 20) return { error: "Twenty break lines is the most." };
  breaks.sort((a, b) => a.min - b.min);
  for (let i = 1; i < breaks.length; i++) if (breaks[i].min === breaks[i - 1].min) return { error: `${breaks[i].min} pieces is listed twice.` };
  return { breaks };
}
export const breaksText = (breaks: QtyBreak[]) => breaks.map((b) => `${b.min}: ${b.pct}`).join("\n");

/** "S 2, M 4, L 4" -> 10; null when it isn't a list of sizes and counts. Used to check a line's quantity against its sizes. */
export function sizesTotal(text: string): number | null {
  const parts = text.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  let total = 0;
  for (const p of parts) {
    const m = /^([A-Za-z0-9/.-]{1,8})\s*[x:=]?\s*(\d{1,5})$/.exec(p);
    if (!m) return null;
    total += Number(m[2]);
  }
  return total;
}

/** 135 -> "2 h 15 min", 45 -> "45 min", 120 -> "2 h", 0 -> "0 min". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h === 0 ? `${r} min` : r === 0 ? `${h} h` : `${h} h ${r} min`;
}
