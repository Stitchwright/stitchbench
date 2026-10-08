// Print and cut jobs (shop-features-round-2-design.md 6.5, package make-jobs): the words, the steps a job may take, how
// material is measured for each kind of supply, the price (machine time x the rate + material used x its price + the
// set-up fee) and the "never cut" check. Pure: the pages, the server and the check script share it. Money in cents.
import { roundCents } from "@/lib/register-math";
import { specsOf, typeOf } from "@/lib/item-details";

export const MAKE_KINDS = ["PRINT", "RESIN", "LASER", "CUT"] as const;
export type MakeKind = (typeof MAKE_KINDS)[number];
export const isMakeKind = (v: unknown): v is MakeKind => typeof v === "string" && (MAKE_KINDS as readonly string[]).includes(v);

export const MAKE_KIND_LABEL: Record<MakeKind, string> = { PRINT: "3D print", RESIN: "Resin print", LASER: "Laser cut or engrave", CUT: "Cut on the craft cutter" };

export const MAKE_STATUSES = ["QUOTED", "APPROVED", "WORKING", "READY", "COLLECTED", "CANCELLED", "TURNED_DOWN"] as const;
export type MakeStatus = (typeof MAKE_STATUSES)[number];

/** The status in shop words; "working" is printing or cutting by the kind. */
export function statusLabel(status: string, kind: string): string {
  switch (status) {
    case "QUOTED":
      return "Quoted";
    case "APPROVED":
      return "Approved";
    case "WORKING":
      return kind === "PRINT" || kind === "RESIN" ? "Printing" : "Cutting";
    case "READY":
      return "Ready";
    case "COLLECTED":
      return "Collected";
    case "CANCELLED":
      return "Cancelled";
    case "TURNED_DOWN":
      return "Turned down";
    default:
      return status;
  }
}

export const STATUS_TONE: Record<string, string> = { QUOTED: "tone-neutral", APPROVED: "tone-work", WORKING: "tone-work", READY: "tone-ready", COLLECTED: "tone-done", CANCELLED: "tone-bad", TURNED_DOWN: "tone-bad" };

export const OPEN_MAKE: MakeStatus[] = ["QUOTED", "APPROVED", "WORKING", "READY"];

/** The steps a job may take by hand (collecting is the register's; turning down has its own button). */
export const MAKE_MOVES: Record<string, MakeStatus[]> = {
  QUOTED: ["APPROVED", "CANCELLED"],
  APPROVED: ["WORKING", "QUOTED", "CANCELLED"],
  WORKING: ["READY", "APPROVED"],
  READY: ["WORKING"],
};

/** Which supplies fit a kind of job (the material list on the form). */
export const MATERIAL_TYPES: Record<MakeKind, string[]> = { PRINT: ["filament"], RESIN: ["resin"], LASER: ["laser-material"], CUT: ["vinyl", "mat"] };

/**
 * How a material is measured and what one unit costs the customer: filament by the gram (its price over the spool's
 * grams), resin by the ml (over the bottle's volume), anything else by the sheet (its own price). Null price: the item
 * has none (it can't be quoted).
 */
export function materialMeasure(p: { kind: string; itemType?: string | null; priceCents: number | null; specs?: unknown }): { unit: "g" | "ml" | "sheet"; unitCents: number | null } {
  const t = typeOf(p);
  const s = specsOf(p.specs);
  const size = (text: string | undefined, big: RegExp, bigFactor: number) => {
    if (!text) return null;
    const n = Number(/(\d+(?:\.\d+)?)/.exec(text)?.[1] ?? NaN);
    if (!Number.isFinite(n) || n <= 0) return null;
    return big.test(text) ? n * bigFactor : n;
  };
  if (t === "filament") {
    const grams = size(s.spool, /kg/i, 1000) ?? 1000;
    return { unit: "g", unitCents: p.priceCents == null ? null : p.priceCents / grams };
  }
  if (t === "resin") {
    const ml = size(s.volume, /\bl\b|litre|liter/i, 1000) ?? 1000;
    return { unit: "ml", unitCents: p.priceCents == null ? null : p.priceCents / ml };
  }
  return { unit: "sheet", unitCents: p.priceCents };
}

export type MakePrice = { machineCents: number; materialCents: number; setupCents: number; totalCents: number };

/** The price: machine time x the hourly rate + material used x its unit price + the set-up fee, each rounded to the cent. */
export function makePrice(o: { minutes: number; rateCents: number; materialQty: number; materialUnitCents: number | null; setupCents: number }): MakePrice {
  const machineCents = roundCents((Math.max(0, o.minutes) / 60) * Math.max(0, o.rateCents));
  const materialCents = o.materialUnitCents == null ? 0 : roundCents(Math.max(0, o.materialQty) * o.materialUnitCents);
  const setupCents = Math.max(0, o.setupCents);
  return { machineCents, materialCents, setupCents, totalCents: machineCents + materialCents + setupCents };
}

/** "PVC, vinyl" -> ["pvc", "vinyl"]. */
export const neverCutWords = (list: string) =>
  list
    .split(/[,;\n]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2);

/** The never-cut word a laser job's material matches (in its description, material or name), or null. */
export function neverCutHit(list: string, material: { description?: string | null; material?: string | null; name?: string | null }): string | null {
  const text = [material.description, material.material, material.name].filter(Boolean).join(" ").toLowerCase();
  return neverCutWords(list).find((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(text)) ?? null;
}

export const FILE_KEEP_DAYS = 30;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
