// A stock item's condition (new, used, refurbished) and who made it (genuine, compatible, 3D printed): the names for
// them, and the words the customer's invoice uses. Safe on the server and in the browser.
import type { PartCondition, PartOrigin } from "@/generated/prisma/enums";

export const CONDITIONS: PartCondition[] = ["NEW", "USED", "REFURB"];
export const ORIGINS: PartOrigin[] = ["GENUINE", "COMPATIBLE", "PRINTED"];

export const CONDITION_NAME: Record<PartCondition, string> = { NEW: "New", USED: "Used", REFURB: "Refurbished" };
export const ORIGIN_NAME: Record<PartOrigin, string> = { GENUINE: "Genuine", COMPATIBLE: "Compatible", PRINTED: "3D printed" };

/** The choices in the forms. */
export const CONDITION_OPTION: Record<PartCondition, string> = { NEW: "New", USED: "Used", REFURB: "Refurbished (cleaned and tested)" };
export const ORIGIN_OPTION: Record<PartOrigin, string> = {
  GENUINE: "Genuine (the machine maker's part)",
  COMPATIBLE: "Compatible (a replacement that isn't the maker's)",
  PRINTED: "3D printed",
};

type Labels = { condition: PartCondition; origin: PartOrigin };

/** A condition / made-by value that came from a partner shop, a spreadsheet or the hub: the value if it is one we know, else null. */
export const asCondition = (v: unknown): PartCondition | null => CONDITIONS.find((c) => c === v) ?? null;
export const asOrigin = (v: unknown): PartOrigin | null => ORIGINS.find((o) => o === v) ?? null;

/** The small tags on the parts list and the part page: none for a new, genuine part (or when nothing is said). */
export function partTags(p: { condition?: unknown; origin?: unknown }): string[] {
  const condition = asCondition(p.condition);
  const origin = asOrigin(p.origin);
  return [...(condition && condition !== "NEW" ? [CONDITION_NAME[condition]] : []), ...(origin && origin !== "GENUINE" ? [ORIGIN_NAME[origin]] : [])];
}

/**
 * A part's condition and who made it as a partner shop is sent them. Only what isn't New / Genuine is sent: an install
 * that doesn't know these fields means New / Genuine by leaving them out, and a catalog of new genuine parts is unchanged.
 */
export function labelFields(p: { condition?: unknown; origin?: unknown }): { condition?: PartCondition; origin?: PartOrigin } {
  const condition = asCondition(p.condition);
  const origin = asOrigin(p.origin);
  return { ...(condition && condition !== "NEW" ? { condition } : {}), ...(origin && origin !== "GENUINE" ? { origin } : {}) };
}

const LABEL_TAG: Record<string, string> = { USED: "USED", REFURB: "REFURB", COMPATIBLE: "COMPATIBLE", PRINTED: "3D PRINTED" };

/** The short tag printed under the description on a label: "USED", "REFURB", "COMPATIBLE", "3D PRINTED" (both: "USED · COMPATIBLE"). */
export function labelTag(p: Labels): string {
  return [LABEL_TAG[p.condition], LABEL_TAG[p.origin]].filter(Boolean).join(" · ");
}

/**
 * What the customer's invoice or receipt says about a part that is used, refurbished, compatible or 3D printed:
 * "used", "compatible, not genuine Brother", "3D printed", "used, compatible". Empty for a new, genuine part.
 */
export function disclosure(p: Labels & { brand?: string | null }): string {
  const words: string[] = [];
  if (p.condition === "USED") words.push("used");
  else if (p.condition === "REFURB") words.push("refurbished");
  if (p.origin === "COMPATIBLE") words.push(p.brand?.trim() ? `compatible, not genuine ${p.brand.trim()}` : "compatible");
  else if (p.origin === "PRINTED") words.push("3D printed");
  return words.join(", ");
}

/** A line's description with the disclosure after it, written when the line is made so the bill stays right if the part changes: "Bobbin case (used)". */
export function withDisclosure(text: string, p: Labels & { brand?: string | null }): string {
  const d = disclosure(p);
  return d ? `${text} (${d})` : text;
}

const CONDITION_WORD: Record<PartCondition, string> = { NEW: "new", USED: "used", REFURB: "refurbished" };

/** Every name one number can be stocked under: itself, "X (own)" beside a partner's consigned X, "X (used)" for another condition of it. */
export const numberNames = (n: string) => [n, `${n} (own)`, ...CONDITIONS.map((c) => `${n} (${CONDITION_WORD[c]})`)];

/**
 * The number a new stock item is saved under when the shop already has the number: "X (used)" for the same part in
 * another condition (the maker's number stays among its other numbers, so a scan finds both), "X (own)" when the
 * number is only a partner's consigned stock.
 */
export const twinNumber = (n: string, condition: PartCondition, ownStock: boolean) => `${n} (${ownStock ? CONDITION_WORD[condition] : "own"})`;

/** SB-00001: the prefix is the product's ("SB" StitchBench, "SS" StitchShop). */
export const shopNumberText = (prefix: string, n: number) => `${prefix}-${String(n).padStart(5, "0")}`;

/** "Used", "pre-owned" → USED, and so on for a spreadsheet's cell; null when it says nothing we know. */
export function conditionFromText(t: string | null | undefined): PartCondition | null {
  const s = (t ?? "").trim().toLowerCase();
  if (s === "new") return "NEW";
  if (s === "used" || s === "pre-owned" || s === "preowned") return "USED";
  if (s === "refurbished" || s === "refurb" || s === "reconditioned") return "REFURB";
  return null;
}

/** "Genuine" or "OEM", "Compatible", "aftermarket" or "generic", "3D printed" or "printed" → the value; null when it says nothing we know. */
export function originFromText(t: string | null | undefined): PartOrigin | null {
  const s = (t ?? "").trim().toLowerCase().replace(/[\s-]+/g, " ");
  if (s === "genuine" || s === "oem") return "GENUINE";
  if (s === "compatible" || s === "aftermarket" || s === "generic") return "COMPATIBLE";
  if (s === "3d printed" || s === "printed" || s === "3d") return "PRINTED";
  return null;
}
