import "server-only";
// The quilt planner (shop-features-round-2-design.md 5.3): a pattern's yardage per size and role ("typed once from the
// back of the pattern"), what the planner page needs (patterns with their yardage, fabrics in stock), and the pull
// list's checks. Yards are worked out by the program (src/lib/fabric-math.ts), never by the model. Every query filters by
// the company; a pattern or fabric of another company is "not found".
import { db } from "@/lib/db";
import { parsePatternNeeds, type PatternNeedLine } from "@/lib/fabric-math";
import type { CurrentUser } from "@/lib/session";
import { UserError } from "@/lib/user-error";

export const MAX_NEEDS = 80;
export const MAX_PLANNER_FABRICS = 1500;

export async function patternNeedsFor(shopId: string, patternPartId: string): Promise<PatternNeedLine[]> {
  const rows = await db.patternNeed.findMany({ where: { shopId, patternPartId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { size: true, role: true, yards: true } });
  return rows;
}

/** "Yardage on the back" saved: the lines typed replace the pattern's yardage (an empty box clears it). */
export async function savePatternNeedsFor(user: Pick<CurrentUser, "shopId">, patternPartId: string, text: string): Promise<number> {
  const part = await db.part.findFirst({ where: { id: String(patternPartId), shopId: user.shopId }, select: { id: true, kind: true } });
  if (!part) throw new UserError("Pattern not found.");
  if (part.kind !== "PATTERN") throw new UserError("Yardage is kept on a pattern. Set this item's kind to Pattern first.");
  const { lines, problems } = parsePatternNeeds(String(text ?? "").slice(0, 4000));
  if (problems.length) throw new UserError(`These couldn't be read: ${problems.slice(0, 3).join("; ")}. Write each as a role and yards, like "background 2 1/4 yd".`);
  if (lines.length > MAX_NEEDS) throw new UserError(`At most ${MAX_NEEDS} lines of yardage.`);
  await db.$transaction([
    db.patternNeed.deleteMany({ where: { shopId: user.shopId, patternPartId: part.id } }),
    db.patternNeed.createMany({ data: lines.map((l, i) => ({ shopId: user.shopId, patternPartId: part.id, size: l.size, role: l.role, yards: l.yards, sortOrder: i })) }),
  ]);
  return lines.length;
}

export type PlannerPattern = { id: string; partNumber: string; name: string; priceCents: number | null; sizes: { size: string; roles: { role: string; yards: number }[] }[] };
export type PlannerFabric = {
  id: string;
  partNumber: string;
  name: string;
  collection: string | null;
  brand: string | null;
  tags: string[];
  colorHex: string | null;
  yards: number;
  priceCents: number | null;
  photoId: string | null;
};

/** The planner's lists: the company's patterns that have yardage typed in, and its fabric by the yard in stock (own, not consigned). */
export async function plannerData(shopId: string): Promise<{ patterns: PlannerPattern[]; fabrics: PlannerFabric[]; more: boolean }> {
  const needs = await db.patternNeed.findMany({ where: { shopId }, orderBy: [{ patternPartId: "asc" }, { sortOrder: "asc" }] });
  const patternIds = [...new Set(needs.map((n) => n.patternPartId))];
  const [patterns, fabrics] = await Promise.all([
    patternIds.length ? db.part.findMany({ where: { shopId, id: { in: patternIds }, kind: "PATTERN" }, select: { id: true, partNumber: true, description: true, priceCents: true }, orderBy: { description: "asc" } }) : [],
    db.part.findMany({
      where: { shopId, kind: "FABRIC", unit: "yd", consignLinkId: null, qtyOnHand: { gt: 0 } },
      select: { id: true, partNumber: true, description: true, collection: true, brand: true, colorTags: true, colorHex: true, qtyOnHand: true, priceCents: true, photos: { select: { id: true }, orderBy: { sortOrder: "asc" }, take: 1 } },
      orderBy: { description: "asc" },
      take: MAX_PLANNER_FABRICS + 1,
    }),
  ]);
  return {
    patterns: patterns.map((p) => {
      const sizes = new Map<string, { role: string; yards: number }[]>();
      for (const n of needs.filter((x) => x.patternPartId === p.id)) sizes.set(n.size, [...(sizes.get(n.size) ?? []), { role: n.role, yards: n.yards }]);
      return { id: p.id, partNumber: p.partNumber, name: p.description, priceCents: p.priceCents, sizes: [...sizes].map(([size, roles]) => ({ size, roles })) };
    }),
    fabrics: fabrics.slice(0, MAX_PLANNER_FABRICS).map((f) => ({
      id: f.id,
      partNumber: f.partNumber,
      name: f.description,
      collection: f.collection,
      brand: f.brand,
      tags: f.colorTags,
      colorHex: f.colorHex,
      yards: f.qtyOnHand,
      priceCents: f.priceCents,
      photoId: f.photos[0]?.id ?? null,
    })),
    more: fabrics.length > MAX_PLANNER_FABRICS,
  };
}

/** "Add all to the sale" from a pull list (`id:qty,id:qty`): the company's own items, quantities 0-200 (fabric in eighths). */
export function pullListItems(raw: string | null | undefined): { id: string; qty: number }[] {
  const out: { id: string; qty: number }[] = [];
  for (const bit of String(raw ?? "").split(",").slice(0, 60)) {
    const m = /^([a-z0-9]{10,40}):(\d+(?:\.\d+)?)$/i.exec(bit.trim());
    if (!m) continue;
    const qty = Math.ceil(Number(m[2]) * 8 - 1e-9) / 8;
    if (qty > 0 && qty <= 200 && !out.some((o) => o.id === m[1])) out.push({ id: m[1], qty });
  }
  return out;
}
