// Fabric cuts (fabric-smarts-design.md sections 2 and 9). Pure: no "server-only", no database, so the Fabric page, the
// server body (src/lib/fabric.ts) and the check script share one set of numbers. Yards are eighths, money integer cents.
import { tenThouToCents } from "@/lib/format";
import { yards } from "@/lib/register-math";

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

/** "1 3/8 yd makes 5 fat quarters, with 1/8 yd left." */
export function cutWords(kind: CutKind, onHand: number): string {
  const p = cutPlan(kind, onHand);
  if (kind === "REMNANT") return `${yards(onHand)} yd goes to the remnant bin.`;
  const info = CUT_INFO[kind];
  if (p.count === 0) return `${yards(onHand)} yd is too short for a ${info.one}.`;
  return `${yards(onHand)} yd makes ${p.count} ${p.count === 1 ? info.one : info.many}${p.leftYards > 0 ? `, with ${yards(p.leftYards)} yd left` : ""}.`;
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

// ----- the quilt planner (shop-features-round-2-design.md 5.3): yards worked out here, never by the model -----

/** Strips and squares are cut across the fabric: 42-44" wide, about 40" usable once the selvages are off. */
export const USABLE_WIDTH_IN = 40;

/** Up to the next eighth of a yard (fabric is cut in eighths). */
export const roundUpEighth = (y: number): number => Math.ceil(Math.max(0, y) * 8 - 1e-9) / 8;

const UNICODE_FRACTIONS: Record<string, string> = { "¼": " 1/4", "½": " 1/2", "¾": " 3/4", "⅛": " 1/8", "⅜": " 3/8", "⅝": " 5/8", "⅞": " 7/8", "⅓": " 1/3", "⅔": " 2/3" };

/** "2 1/4", "2-1/4", "2¼", "2.25", "1/2 yd", "3 3/4 yards" -> yards; null for anything else. */
export function parseYards(s: string | null | undefined): number | null {
  let t = String(s ?? "").toLowerCase();
  for (const [k, v] of Object.entries(UNICODE_FRACTIONS)) t = t.split(k).join(v);
  t = t.replace(/yards?|yds?\.?|yd\.?/g, " ").replace(/(\d)-(\d+\/\d+)/, "$1 $2").trim();
  const m = /^(\d+(?:\.\d+)?)?\s*(?:(\d+)\s*\/\s*(\d+))?$/.exec(t);
  if (!m || (!m[1] && !m[2])) return null;
  if (m[1] && m[2] && m[1].includes(".")) return null;
  const whole = m[1] ? Number(m[1]) : 0;
  const frac = m[2] ? Number(m[2]) / Number(m[3]) : 0;
  if (m[2] && (!Number(m[3]) || frac >= 1)) return null;
  const y = whole + frac;
  return Number.isFinite(y) && y > 0 && y <= 100 ? Math.round(y * 1000) / 1000 : null;
}

export type PatternNeedLine = { size: string; role: string; yards: number };

/**
 * The back of a pattern as typed once: one size a line, "Throw: background 2 1/4 yd, focus 1 yd, binding 1/2 yd,
 * backing 3 3/4 yd". A line without "size:" belongs to the size before it (or "One size"). Returns the lines read and
 * the bits it couldn't read, in her words.
 */
export function parsePatternNeeds(text: string): { lines: PatternNeedLine[]; problems: string[] } {
  const lines: PatternNeedLine[] = [];
  const problems: string[] = [];
  let size = "One size";
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const colon = /^([^:]{1,40}):(.*)$/.exec(line);
    if (colon) {
      size = colon[1].trim().replace(/\s+/g, " ");
      line = colon[2];
    }
    for (const bit of line.split(/[,;]/)) {
      const b = bit.trim();
      if (!b) continue;
      const m = /^(.*?)\s+((?:\d+(?:\.\d+)?)?\s*(?:\d+\s*\/\s*\d+)?[¼½¾⅛⅜⅝⅞⅓⅔]?)\s*(?:yards?|yds?\.?|yd\.?)?$/i.exec(b);
      const role = m?.[1]?.trim().replace(/\s+/g, " ") ?? "";
      const y = m ? parseYards(m[2]) : null;
      if (!role || y == null) problems.push(`${size}: "${b}"`);
      else lines.push({ size: size.slice(0, 40), role: role.slice(0, 40), yards: y });
    }
  }
  return { lines, problems };
}

/** The needs as she'd type them again: one line a size. */
export function patternNeedsText(needs: readonly PatternNeedLine[]): string {
  const bySize = new Map<string, PatternNeedLine[]>();
  for (const n of needs) bySize.set(n.size, [...(bySize.get(n.size) ?? []), n]);
  return [...bySize].map(([size, ns]) => `${size}: ${ns.map((n) => `${n.role} ${yards(n.yards)} yd`).join(", ")}`).join("\n");
}

/** Sizes a quilt is usually made in (finished inches). */
export const QUILT_SIZES = [
  { key: "baby", label: "Baby (40 x 52)", width: 40, length: 52 },
  { key: "throw", label: "Throw (60 x 72)", width: 60, length: 72 },
  { key: "twin", label: "Twin (70 x 90)", width: 70, length: 90 },
  { key: "full", label: "Full (84 x 90)", width: 84, length: 90 },
  { key: "queen", label: "Queen (90 x 108)", width: 90, length: 108 },
  { key: "king", label: "King (108 x 108)", width: 108, length: 108 },
] as const;

export type PlainQuilt = { widthIn: number; lengthIn: number; blockIn: number; fabrics: number; backgroundPct: number; borderIn: number };
/** The planner opens on a throw of 6" squares in four fabrics. */
export const PLAIN_DEFAULTS: PlainQuilt = { widthIn: 60, lengthIn: 72, blockIn: 6, fabrics: 4, backgroundPct: 0, borderIn: 0 };
export type QuiltRole = { role: string; yards: number; note: string };
export type QuiltPlan = { roles: QuiltRole[]; cols: number; rows: number; blocks: number; finishedWidth: number; finishedLength: number };

/** What's wrong with a plain quilt's numbers, in words, or null. */
export function plainQuiltProblem(q: PlainQuilt): string | null {
  if (!(q.widthIn >= 12 && q.widthIn <= 130) || !(q.lengthIn >= 12 && q.lengthIn <= 130)) return "Give the quilt's size in inches, 12 to 130 each way.";
  if (!(q.blockIn >= 1 && q.blockIn <= 36)) return "Blocks are 1 to 36 inches.";
  if (!(Number.isInteger(q.fabrics) && q.fabrics >= 1 && q.fabrics <= 12)) return "Use 1 to 12 fabrics in the blocks.";
  if (!(q.backgroundPct >= 0 && q.backgroundPct <= 90)) return "Background is 0 to 90 percent of the blocks.";
  if (!(q.borderIn >= 0 && q.borderIn <= 12)) return "A border is 0 to 12 inches.";
  if (q.widthIn - 2 * q.borderIn < q.blockIn || q.lengthIn - 2 * q.borderIn < q.blockIn) return "The border leaves no room for a block.";
  return null;
}

/** Yards for `n` squares cut `cut` inches across the usable width, plus an eighth for straightening. */
const squaresYards = (n: number, cut: number) => {
  if (n <= 0) return 0;
  const per = Math.max(1, Math.floor(USABLE_WIDTH_IN / cut));
  return roundUpEighth((Math.ceil(n / per) * cut) / 36 + 0.125);
};
/** Yards for strips `cut` inches wide, end to end for `lengthIn`. */
const stripsYards = (lengthIn: number, cut: number) => roundUpEighth((Math.ceil(lengthIn / USABLE_WIDTH_IN) * cut) / 36 + 0.125);

/**
 * A plain quilt of squares: the blocks across and down (rounded to whole blocks, the finished size follows), each
 * cut with 1/4" seams; the background's share and the rest spread over the block fabrics; a border, 2 1/2" binding and
 * backing 4" bigger all round, pieced from usable widths the cheaper way.
 */
export function plainQuiltPlan(q: PlainQuilt): QuiltPlan {
  const cut = q.blockIn + 0.5;
  const cols = Math.max(1, Math.round((q.widthIn - 2 * q.borderIn) / q.blockIn));
  const rows = Math.max(1, Math.round((q.lengthIn - 2 * q.borderIn) / q.blockIn));
  const blocks = cols * rows;
  const W = cols * q.blockIn + 2 * q.borderIn;
  const L = rows * q.blockIn + 2 * q.borderIn;
  const bg = q.fabrics > 0 ? Math.round((blocks * q.backgroundPct) / 100) : 0;
  const rest = blocks - bg;
  const roles: QuiltRole[] = [];
  if (bg > 0) roles.push({ role: "Background", yards: squaresYards(bg, cut), note: `${bg} squares cut ${cut}"` });
  for (let i = 0; i < q.fabrics; i++) {
    const n = Math.floor(rest / q.fabrics) + (i < rest % q.fabrics ? 1 : 0);
    if (n > 0) roles.push({ role: i === 0 ? "Focus" : `Fabric ${i + 1}`, yards: squaresYards(n, cut), note: `${n} squares cut ${cut}"` });
  }
  if (q.borderIn > 0) roles.push({ role: "Border", yards: stripsYards(2 * (W + L) + 10, q.borderIn + 0.5), note: `strips cut ${q.borderIn + 0.5}"` });
  roles.push({ role: "Binding", yards: stripsYards(2 * (W + L) + 15, 2.5), note: 'strips cut 2 1/2"' });
  const bw = W + 8;
  const bl = L + 8;
  const backing = Math.min(Math.ceil(bw / USABLE_WIDTH_IN) * bl, Math.ceil(bl / USABLE_WIDTH_IN) * bw) / 36;
  roles.push({ role: "Backing", yards: roundUpEighth(backing), note: `${bw}" x ${bl}", pieced` });
  return { roles, cols, rows, blocks, finishedWidth: W, finishedLength: L };
}
