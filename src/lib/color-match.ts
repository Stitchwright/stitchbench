// Color lookup at the counter (shop-features-round-2-design.md 2.2 and 6.2): a maker and number in any shape ("isa 15",
// "0015", "ISA-5005", "Aurifil 2024"), a color name ("navy"), or a supply in words ("PLA black 1.75", "matte red PETG")
// scored against an item's details. Pure: the server lookup (src/lib/colors.ts) and the check script share it. Every
// word typed has to match something on the item; the score orders the hits (an exact color number first).
import { ITEM_TYPES, specsOf, typeOf } from "@/lib/item-details";

export type ColorCandidate = {
  partNumber: string;
  description: string;
  brand: string | null;
  kind: string;
  itemType: string | null;
  colorNumber: string | null;
  colorName: string | null;
  material: string | null;
  specs: unknown;
};

/** "ISA-5005" -> ["isa", "5005"]; "PLA black 1.75" -> ["pla", "black", "1.75"]; letters and digits run together are split. */
export function colorTokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .flatMap((w) => w.match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [])
    .filter((w) => w.length > 0)
    .slice(0, 8);
}

const digitsOf = (s: string) => s.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, "");
const words = (s: string | null | undefined) => (s ?? "").toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

/** What one typed word scores against an item (0: it matches nothing on it). */
function tokenScore(c: ColorCandidate, tok: string): number {
  const specs = Object.values(specsOf(c.specs)).map((v) => v.toLowerCase());
  if (/^\d/.test(tok)) {
    let best = 0;
    if (c.colorNumber) {
      const cn = digitsOf(c.colorNumber);
      const t = digitsOf(tok);
      if (cn && cn === t) best = 10;
      else if (cn && t.length >= 2 && cn.startsWith(t)) best = 3;
    }
    if (specs.some((v) => words(v).includes(tok))) best = Math.max(best, 5);
    if (squash(c.partNumber).includes(tok)) best = Math.max(best, 2);
    return best;
  }
  let best = 0;
  if (tok.length >= 2 && c.brand && words(c.brand).some((w) => w.startsWith(tok))) best = Math.max(best, 6);
  if (tok.length >= 3 && words(c.colorName).some((w) => w.startsWith(tok))) best = Math.max(best, 8);
  if (tok.length >= 2 && c.material && squash(c.material).startsWith(tok)) best = Math.max(best, 6);
  if (tok.length >= 3 && specs.some((v) => words(v).some((w) => w.startsWith(tok)))) best = Math.max(best, 4);
  const t = typeOf(c);
  if (t && tok.length >= 4 && (t.startsWith(tok) || words(ITEM_TYPES[t].label).some((w) => w.startsWith(tok)))) best = Math.max(best, 2);
  if (tok.length >= 3 && words(c.description).some((w) => w.startsWith(tok))) best = Math.max(best, 1);
  if (squash(c.partNumber).includes(tok) && tok.length >= 3) best = Math.max(best, 2);
  return best;
}

/** The item's score for the words typed, or null when a word matches nothing on it (every word has to match). */
export function colorScore(c: ColorCandidate, tokens: string[]): number | null {
  if (!tokens.length) return null;
  let total = 0;
  for (const tok of tokens) {
    const s = tokenScore(c, tok);
    if (s <= 0) return null;
    total += s;
  }
  // A hit on the details (not only the description or number) is what makes it a color hit.
  const onDetails = tokens.some((tok) => tokenScore({ ...c, description: "", partNumber: "" }, tok) > 0);
  return onDetails ? total : null;
}

/** Whether the words look like a color lookup at all (so the register's plain search can put color hits first). */
export const looksLikeColor = (q: string) => colorTokens(q).length > 0 && q.trim().length >= 2;
