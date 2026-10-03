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

// A machine entered as "Designer Diamond deLuxe" (key DESIGNERDIAMONDDELUXE) is a variant of the "Designer Diamond"
// (DESIGNERDIAMOND). When nothing is filed under the machine's own key, every lookup falls back to the longest known key
// the machine's key starts with (at least FALLBACK_MIN characters, so "SE" never stands in for "SE600"), and says which.
export const FALLBACK_MIN = 5;

/** The base model whose data stood in for the machine's own: its key and name as filed (null when only the key is known). */
export type BaseModel = { key: string; name: string | null };
export type Lookup<R> = { rows: R[]; from: BaseModel | null };

/** Prefixes of `key` that could name a base model, longest first. */
export function prefixKeys(key: string): string[] {
  const out: string[] = [];
  for (let n = key.length - 1; n >= FALLBACK_MIN; n--) out.push(key.slice(0, n));
  return out;
}

/** The base model's name as filed: the part of `models` ("A, B (note)") whose key is `key`, else the first part. */
function baseName(models: string | undefined, key: string): string | null {
  if (!models) return null;
  const parts = models
    .split(/[,;/]/)
    .map((x) => x.replace(/\(.*?\)/g, "").trim())
    .filter(Boolean);
  return parts.find((x) => modelKey(x) === key) ?? parts.find((x) => modelKey(x).startsWith(key)) ?? parts[0] ?? null;
}

/**
 * One lookup with the fallback. `fetch` reads a table's rows by a modelKeys filter; `pick` keeps and orders the ones that
 * count for the machine (its brand ...) and is told whether they came from a fallback key. The exact key first; only when
 * it finds nothing, one query for the rows holding any prefix, then the longest prefix that `pick` accepts.
 */
export async function lookupModel<R extends { modelKeys: string[]; models?: string }>(
  model: string,
  fetch: (filter: { has: string } | { hasSome: string[] }) => Promise<R[]>,
  pick: (rows: R[], fallback: boolean) => R[],
): Promise<Lookup<R>> {
  const key = modelKey(model);
  if (!key) return { rows: [], from: null };
  const exact = pick(await fetch({ has: key }), false);
  if (exact.length) return { rows: exact, from: null };
  const prefixes = prefixKeys(key);
  if (!prefixes.length) return { rows: [], from: null };
  const found = await fetch({ hasSome: prefixes });
  for (const p of prefixes) {
    const rows = pick(
      found.filter((r) => r.modelKeys.includes(p)),
      true,
    );
    if (rows.length) return { rows, from: { key: p, name: baseName(rows[0].models, p) } };
  }
  return { rows: [], from: null };
}

/** Factory tension specs for one brand + model (or its base model), best matches first, and the base model when used. */
export function specsLookup(brand: string, model: string) {
  return lookupModel(
    model,
    (f) => db.tensionSpec.findMany({ where: { modelKeys: f } }),
    (rows) => rows.filter((r) => brandMatches(r.brand, brand)).sort((a, b) => rank(b) - rank(a)),
  );
}

export async function specsFor(brand: string, model: string) {
  return (await specsLookup(brand, model)).rows;
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
export async function settingsLookup(brand: string, model: string) {
  const { rows, from } = await lookupModel(
    model,
    (f) => db.factorySetting.findMany({ where: { modelKeys: f } }),
    (r) =>
      r
        .filter((x) => brandMatches(x.brand, brand))
        .sort((a, b) => (ADJ_ORDER[a.adjustment] ?? 99) - (ADJ_ORDER[b.adjustment] ?? 99) || a.label.localeCompare(b.label)),
  );
  return { rows: await withFigures(rows), from };
}

export async function settingsFor(brand: string, model: string) {
  return (await settingsLookup(brand, model)).rows;
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
export async function pictureLookup(brand: string, model: string) {
  const { rows, from } = await lookupModel(
    model,
    (f) => db.modelImage.findMany({ where: { modelKeys: f }, select: { id: true, brand: true, models: true, modelKeys: true, sourcePath: true, page: true, width: true, height: true } }),
    (r) => r.filter((x) => brandMatches(x.brand, brand)),
  );
  return { picture: rows[0] ?? null, from };
}

export async function pictureFor(brand: string, model: string) {
  return (await pictureLookup(brand, model)).picture;
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
export function libraryLookup(brand: string, model: string) {
  return lookupModel(
    model,
    (f) => db.libraryDoc.findMany({ where: { modelKeys: f } }),
    (rows) =>
      rows
        .filter((r) => brandMatches(r.brand, brand))
        .sort((a, b) => (DOC_ORDER[a.docType ?? ""] ?? 9) - (DOC_ORDER[b.docType ?? ""] ?? 9) || a.file.localeCompare(b.file)),
  );
}

export async function libraryFor(brand: string, model: string) {
  return (await libraryLookup(brand, model)).rows;
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
