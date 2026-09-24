import "server-only";
import { db } from "@/lib/db";
import { brandKey, modelKey } from "@/lib/format";

// Some brands are filed under more than one spelling, and some machines are rebadges.
const BRAND_ALIASES: Record<string, string[]> = {
  BABYLOCK: ["BABYLOCK"],
  HUSQVARNAVIKING: ["HUSQVARNAVIKING", "VIKING", "HUSQVARNA"],
  NEWHOME: ["NEWHOME", "JANOME"],
  DURKOPPADLER: ["DURKOPPADLER", "DURKOPP"],
};

function brandMatches(specBrand: string, brand: string) {
  const a = brandKey(specBrand);
  const b = brandKey(brand);
  if (a === b) return true;
  const alts = BRAND_ALIASES[b] ?? [];
  return alts.includes(a);
}

/** Factory tension specs for one brand + model, best matches first. */
export async function specsFor(brand: string, model: string) {
  const key = modelKey(model);
  if (!key) return [];
  const rows = await db.tensionSpec.findMany({ where: { modelKeys: { has: key } } });
  return rows
    .filter((r) => brandMatches(r.brand, brand))
    .sort((a, b) => rank(b) - rank(a));
}

function rank(r: { confidence: string | null; docType: string | null; upperMinG: number | null; bobbinMinG: number | null }) {
  let s = 0;
  if (r.confidence === "high") s += 4;
  else if (r.confidence === "medium") s += 2;
  if (r.docType?.startsWith("Service")) s += 2;
  if (r.upperMinG != null) s += 1;
  if (r.bobbinMinG != null) s += 1;
  return s;
}

export async function notesFor(shopId: string, brand: string, model: string) {
  return db.modelNote.findMany({
    where: { shopId, modelKey: modelKey(model), brand: { equals: brand, mode: "insensitive" } },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    include: { author: { select: { name: true } } },
  });
}

export type SpecRow = Awaited<ReturnType<typeof specsFor>>[number];

/** "65-80 g" style range for display. */
export function gRange(min: number | null, max: number | null): string {
  if (min == null) return "";
  const f = (x: number) => (Math.round(x * 10) / 10).toString();
  if (max == null) return `${f(min)}+ g`;
  if (max === min) return `${f(min)} g`;
  return `${f(min)}-${f(max)} g`;
}
