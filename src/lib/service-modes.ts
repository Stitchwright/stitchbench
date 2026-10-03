import "server-only";
import type { ServiceMode } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { brandKey, modelKey } from "@/lib/format";
import { brandMatches, lookupModel, withFigures } from "@/lib/model-info";

// Test / service / diagnostic modes (handoff item 15): how to put a machine into the mode, how to leave it, and what
// the numbered tests do, from prisma/seed-data/service_modes.json. Matched to a machine by its model's key alone, since
// a row lists the twins other brands sell (an Elna 7200 is in a Janome row); the brand only orders the matches and, when
// one names the machine's brand, drops rows of other brands that merely share a bare number (a Brother and a Janome "9000").

export type ModeTest = { code: string; purpose: string };
export type ModeRow = Omit<ServiceMode, "tests"> & { tests: ModeTest[] };

function testsOf(v: unknown): ModeTest[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((t) => {
    const o = (t ?? {}) as { code?: unknown; purpose?: unknown };
    return typeof o.purpose === "string" ? [{ code: typeof o.code === "string" ? o.code : String(o.code ?? ""), purpose: o.purpose }] : [];
  });
}

function toRow(r: ServiceMode): ModeRow {
  return { ...r, tests: testsOf(r.tests) };
}

/** 2: the row's brand is the machine's; 1: the row lists a twin under the machine's brand ("Elna 7200"); 0: neither. */
function brandScore(r: { brand: string; models: string }, brand: string) {
  if (brandMatches(r.brand, brand)) return 2;
  const b = brandKey(brand);
  return b.length >= 3 && modelKey(r.models).includes(b) ? 1 : 0;
}

/** Test modes first, then service / adjusting menus, then the rest (touch panel calibration, resets). */
function kindOrder(mode: string) {
  if (/test|diagnos|self|check/i.test(mode)) return 0;
  if (/service|maintenance|factory|adjust/i.test(mode)) return 1;
  return 2;
}

const CONFIDENCE: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** The rows for a machine of `brand`, best first. Rows of other brands are kept only when none names this brand. */
export function rankModes<T extends { id: string; brand: string; models: string; mode: string; confidence: string | null }>(rows: T[], brand: string): T[] {
  const scored = rows.map((r) => ({ r, s: brandScore(r, brand) }));
  const floor = Math.min(1, Math.max(0, ...scored.map((x) => x.s)));
  return scored
    .filter((x) => x.s >= floor)
    .sort(
      (a, b) =>
        b.s - a.s ||
        kindOrder(a.r.mode) - kindOrder(b.r.mode) ||
        (CONFIDENCE[a.r.confidence ?? ""] ?? 3) - (CONFIDENCE[b.r.confidence ?? ""] ?? 3) ||
        a.r.mode.localeCompare(b.r.mode) ||
        a.r.id.localeCompare(b.r.id),
    )
    .map((x) => x.r);
}

/** Every mode for one brand + model (test mode, touch panel calibration, service program ...), with its picture. */
export async function modesLookup(brand: string, model: string) {
  const { rows, from } = await lookupModel(
    model,
    async (f) => (await db.serviceMode.findMany({ where: { modelKeys: f } })).map(toRow),
    // A base model's row counts only when it is the machine's brand or lists that brand's twin.
    (r, fallback) => rankModes(fallback ? r.filter((x) => brandScore(x, brand) > 0) : r, brand),
  );
  return { rows: await withFigures(rows), from };
}

export async function modesFor(brand: string, model: string) {
  return (await modesLookup(brand, model)).rows;
}

export type ModeCard = Awaited<ReturnType<typeof modesFor>>[number];

/** Modes that share a model key with any of `keys` (the factory settings on a page), for linking their "test mode NN". */
export async function modesSharing(keys: string[]): Promise<ModeRow[]> {
  const uniq = [...new Set(keys)].filter(Boolean);
  if (!uniq.length) return [];
  return (await db.serviceMode.findMany({ where: { modelKeys: { hasSome: uniq } } })).map(toRow);
}

/** The /specs "Test modes" list: by brand, and by model, brand, mode or manual name. */
export async function searchModes({ q, brand }: { q?: string; brand?: string }) {
  const term = q?.trim() ?? "";
  const key = modelKey(term);
  const rows = await db.serviceMode.findMany({
    where: {
      ...(brand ? { brand } : {}),
      ...(term
        ? {
            OR: [
              { brand: { contains: term, mode: "insensitive" } },
              { models: { contains: term, mode: "insensitive" } },
              ...(key.length >= 2 ? [{ modelKeys: { has: key } }] : []),
              { mode: { contains: term, mode: "insensitive" } },
              { sourceFile: { contains: term, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ brand: "asc" }, { models: "asc" }, { mode: "asc" }],
    take: 60,
  });
  return withFigures(rows.map(toRow));
}

/** The element id of a mode on the page, or of one of its tests (index in its list). */
export function modeAnchor(modeId: string, test: number | null) {
  return test == null ? `sm-${modeId}` : `sm-${modeId}-t${test}`;
}

// "test mode 36", "test mode pattern 02", 'test mode "5"', "Test mode [4]", "test mode #10", "test mode No. 3", or
// "test mode" / "service mode" with no number. The number is kept out of "3.5" (a measurement after the phrase).
const REF = /\b(?:test|service)\s+mode\b(?:\s*(?:pattern\s+)?(?:adjustment\s+)?(?:no\.?\s*|number\s+|#\s*)?["'[(]?(\d{1,3})\b(?!\.\d))?/i;

/** A test's code as a number for comparing: "02", "#2", "No.2" and "2" are the same test; "Bobbin" or "1-3" has none. */
export function codeNumber(code: string): string | null {
  const m = code.trim().match(/^(?:#|no\.?\s*)?0*(\d{1,3})$/i);
  return m ? m[1] : null;
}

export type TestLink = { start: number; end: number; modeId: string; test: number | null; key: string; title: string };

/**
 * Where `text` (a factory setting's words) says "test mode NN": the span, and the mode and test it means among `modes`
 * that share a model key with the setting. A number no list has, or no number, links to the mode itself (how to enter).
 */
export function findTestLink(text: string | null, setting: { brand: string; modelKeys: string[] }, modes: ModeRow[]): TestLink | null {
  if (!text) return null;
  const m = REF.exec(text);
  if (!m) return null;
  const shares = (r: ModeRow) => r.modelKeys.find((k) => setting.modelKeys.includes(k));
  const candidates = rankModes(
    modes.filter((r) => shares(r)),
    setting.brand,
  );
  if (!candidates.length) return null;
  const span = { start: m.index, end: m.index + m[0].length };
  const n = m[1] ? codeNumber(m[1]) : null;
  if (n) {
    for (const r of candidates) {
      const i = r.tests.findIndex((t) => codeNumber(t.code) === n);
      if (i >= 0) return { ...span, modeId: r.id, test: i, key: shares(r)!, title: `${r.mode}, ${r.tests[i].code}: ${r.tests[i].purpose}` };
    }
  }
  const r = candidates[0];
  return { ...span, modeId: r.id, test: null, key: shares(r)!, title: `How to enter: ${r.mode}` };
}

/** The factory-setting fields that can say "test mode NN", in the order they show. */
export const LINKED_FIELDS = ["label", "valueText", "conditions", "notes"] as const;
export type LinkedField = (typeof LINKED_FIELDS)[number];
export type TestLinks = Partial<Record<LinkedField, TestLink & { href: string }>>;

/** Adds `testLinks` to factory settings: each field's "test mode NN" and where it goes (`href` builds the address). */
export function withTestLinks<T extends { brand: string; modelKeys: string[] } & Record<LinkedField, string | null>>(
  settings: T[],
  modes: ModeRow[],
  href: (link: TestLink) => string,
): (T & { testLinks: TestLinks })[] {
  return settings.map((s) => {
    const testLinks: TestLinks = {};
    if (modes.length) {
      for (const f of LINKED_FIELDS) {
        const l = findTestLink(s[f], s, modes);
        if (l) testLinks[f] = { ...l, href: href(l) };
      }
    }
    return { ...s, testLinks };
  });
}
