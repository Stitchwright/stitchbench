import "server-only";
import { db } from "@/lib/db";
import { brandKey, modelKey } from "@/lib/format";
import { ADJ_ORDER } from "@/lib/adjustments";
import { figureId } from "@/lib/figures";
import { sameText } from "@/lib/input";

// Some brands are filed under more than one spelling, and some machines are rebadges.
const BRAND_ALIASES: Record<string, string[]> = {
  BABYLOCK: ["BABYLOCK"],
  HUSQVARNAVIKING: ["HUSQVARNAVIKING", "VIKING", "HUSQVARNA"],
  NEWHOME: ["NEWHOME", "JANOME"],
  DURKOPPADLER: ["DURKOPPADLER", "DURKOPP"],
};

export function brandMatches(specBrand: string, brand: string) {
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

/** Factory timing / adjustment standards for one brand + model, in bench order. */
export async function settingsFor(brand: string, model: string) {
  const key = modelKey(model);
  if (!key) return [];
  const rows = await db.factorySetting.findMany({ where: { modelKeys: { has: key } } });
  const matched = rows
    .filter((r) => brandMatches(r.brand, brand))
    .sort((a, b) => (ADJ_ORDER[a.adjustment] ?? 99) - (ADJ_ORDER[b.adjustment] ?? 99) || a.label.localeCompare(b.label));
  return withFigures(matched);
}

type HasFigure = { sourcePath: string | null; sourceFile: string; figurePage: number | null; figureBox: number[] };

/** Adds figureId and whether that figure is already stored online (so any device can show it). */
export async function withFigures<T extends HasFigure>(rows: T[]) {
  const withIds = rows.map((r) => ({ ...r, figureId: r.figurePage ? figureId(r.sourcePath ?? r.sourceFile, r.figurePage, r.figureBox) : null }));
  const ids = withIds.map((r) => r.figureId).filter((x): x is string => !!x);
  // Stored here, or on the community hub (fetched the first time it's shown).
  const [own, hub] = ids.length
    ? await Promise.all([
        db.figureImage.findMany({ where: { id: { in: ids } }, select: { id: true } }),
        db.hubFigure.findMany({ where: { id: { in: ids } }, select: { id: true } }),
      ])
    : [[], []];
  const stored = new Set([...own, ...hub].map((f) => f.id));
  return withIds.map((r) => ({ ...r, figureStored: !!r.figureId && stored.has(r.figureId) }));
}

export type SettingRowT = Awaited<ReturnType<typeof settingsFor>>[number];

/** A picture of this machine, cut from its own manual. */
export async function pictureFor(brand: string, model: string) {
  const key = modelKey(model);
  if (!key) return null;
  const rows = await db.modelImage.findMany({
    where: { modelKeys: { has: key } },
    select: { id: true, brand: true, models: true, sourcePath: true, page: true, width: true, height: true },
  });
  return rows.find((r) => brandMatches(r.brand, brand)) ?? null;
}

/** Pictures for many machines at once (lists). Key: `${brand}|${modelKey}`. */
export async function picturesFor(items: { brand: string; model: string }[]) {
  const keys = [...new Set(items.map((i) => modelKey(i.model)).filter(Boolean))];
  if (!keys.length) return new Map<string, string>();
  const rows = await db.modelImage.findMany({ where: { modelKeys: { hasSome: keys } }, select: { id: true, brand: true, modelKeys: true } });
  const out = new Map<string, string>();
  for (const it of items) {
    const k = modelKey(it.model);
    const hit = rows.find((r) => r.modelKeys.includes(k) && brandMatches(r.brand, it.brand));
    if (hit) out.set(`${it.brand}|${k}`, hit.id);
  }
  return out;
}

const DOC_ORDER: Record<string, number> = { ServiceManual: 0, TechnicalManual: 1, MaintenanceManual: 2, ErrorCodes: 3, OperatorManual: 4, Firmware: 5, Training: 6, Bulletin: 7, PartsList: 8 };

/** Every manual in the shop library for this brand + model. */
export async function libraryFor(brand: string, model: string) {
  const key = modelKey(model);
  if (!key) return [];
  const rows = await db.libraryDoc.findMany({ where: { modelKeys: { has: key } } });
  return rows
    .filter((r) => brandMatches(r.brand, brand))
    .sort((a, b) => (DOC_ORDER[a.docType ?? ""] ?? 9) - (DOC_ORDER[b.docType ?? ""] ?? 9) || a.file.localeCompare(b.file));
}

export async function notesFor(shopId: string, brand: string, model: string) {
  return db.modelNote.findMany({
    where: { shopId, modelKey: modelKey(model), brand: sameText(brand) },
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
