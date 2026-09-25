import "server-only";
// Parts, their numbers, and the community cross-reference (synced XPart rows).
import { db } from "@/lib/db";
import { modelKey } from "@/lib/format";
import { brandMatches } from "@/lib/model-info";

export type XNumber = { brand: string; number: string };
export type XFit = { brand: string; model: string; modelKey: string; evidence: string; source?: string | null };
export type XSource = { id?: string; vendor: string; url?: string | null; priceCents?: number | null; currency?: string; note?: string | null; byShop?: string | null; updatedAt?: string };

export const EVIDENCE_LABEL: Record<string, string> = {
  tested: "Fitted by a tech",
  maker: "Maker says it fits",
  listed: "In that model's parts list",
};
export const KIND_LABEL: Record<string, string> = { PART: "Part", ACCESSORY: "Accessory", SUPPLY: "Supply" };

/** A part number reduced to letters and digits, upper-case: "XA-1234-001" → "XA1234001". */
export const numberKey = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function partKeys(partNumber: string, altNumbers: string[]) {
  return [...new Set([partNumber, ...altNumbers].map(numberKey).filter((k) => k.length >= 3))];
}

/** "a, b; c" or one per line → trimmed list. */
export function splitList(v: string | null | undefined) {
  return (v ?? "")
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Cross-reference entries that share a number with this part. */
export async function xrefForKeys(keys: string[]) {
  if (!keys.length) return [];
  return db.xPart.findMany({ where: { numberKeys: { hasSome: keys } }, orderBy: { name: "asc" }, take: 20 });
}

/** Community cross-reference parts that fit a machine (best evidence first), and this shop's stock of them. */
export async function partsFittingModel(shopId: string, brand: string, model: string, take = 400) {
  const key = modelKey(model);
  if (!key) return { xparts: [], stocked: new Map<string, { id: string; qtyOnHand: number; location: string | null }>() };
  const rows = await db.xPart.findMany({ where: { fitKeys: { has: key } }, take });
  const rank = (x: (typeof rows)[number]) => {
    const fits = (x.fits as XFit[]).filter((f) => f.modelKey === key && brandMatches(f.brand, brand));
    return fits.some((f) => f.evidence === "tested") ? 3 : fits.some((f) => f.evidence === "maker") ? 2 : fits.length ? 1 : 0;
  };
  const xparts = rows
    .map((x) => ({ x, r: rank(x) }))
    .filter((e) => e.r > 0)
    .sort((a, b) => b.r - a.r || a.x.name.localeCompare(b.x.name))
    .map((e) => e.x);
  const keys = [...new Set(xparts.flatMap((x) => x.numberKeys))];
  const stock = keys.length
    ? await db.part.findMany({ where: { shopId, numberKeys: { hasSome: keys } }, select: { id: true, qtyOnHand: true, location: true, numberKeys: true } })
    : [];
  const stocked = new Map<string, { id: string; qtyOnHand: number; location: string | null }>();
  for (const x of xparts) {
    const hit = stock.find((p) => p.numberKeys.some((k) => x.numberKeys.includes(k)));
    if (hit) stocked.set(x.id, { id: hit.id, qtyOnHand: hit.qtyOnHand, location: hit.location });
  }
  return { xparts, stocked };
}

/** "Brother, XA1234-001" lines → numbers. */
export function parseNumbers(text: string | null | undefined, defaultBrand?: string | null): XNumber[] {
  const out: XNumber[] = [];
  for (const line of (text ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(",");
    const brand = i > 0 ? t.slice(0, i).trim() : (defaultBrand ?? "Generic");
    const number = (i > 0 ? t.slice(i + 1) : t).trim();
    if (number) out.push({ brand, number });
  }
  return out;
}

/** "Janome, MC6700P" lines → fits (new lines count as fitted by a tech; lines that were already there keep their evidence). */
export function parseFits(text: string | null | undefined, previous: XFit[] = []): XFit[] {
  const out: XFit[] = [];
  for (const line of (text ?? "").split("\n")) {
    const t = line.trim();
    const i = t.indexOf(",");
    if (i <= 0) continue;
    const brand = t.slice(0, i).trim();
    const model = t.slice(i + 1).trim();
    if (!brand || !model) continue;
    const key = modelKey(model);
    const was = previous.find((f) => f.modelKey === key && f.brand.toLowerCase() === brand.toLowerCase());
    out.push(was ?? { brand, model, modelKey: key, evidence: "tested", source: null });
  }
  return out;
}

/** "Vendor, https://..., 12.50" lines → where to buy. */
export function parseSources(text: string | null | undefined, previous: XSource[] = []): XSource[] {
  const out: XSource[] = [];
  for (const line of (text ?? "").split("\n")) {
    const parts = line.split(",").map((s) => s.trim());
    if (!parts[0]) continue;
    const url = parts.find((p) => /^https?:\/\//i.test(p)) ?? null;
    const priceText = parts.find((p) => /^\$?\d+(\.\d{1,2})?$/.test(p));
    const priceCents = priceText ? Math.round(Number(priceText.replace("$", "")) * 100) : null;
    const was = previous.find((s) => s.vendor === parts[0] && (s.url ?? null) === url);
    out.push({ ...(was ?? {}), vendor: parts[0], url, priceCents, currency: "USD" });
  }
  return out;
}

export const numbersText = (n: XNumber[]) => n.map((x) => `${x.brand}, ${x.number}`).join("\n");
export const fitsText = (f: XFit[]) => f.map((x) => `${x.brand}, ${x.model}`).join("\n");
export const sourcesText = (s: XSource[]) =>
  s.map((x) => [x.vendor, x.url, x.priceCents != null ? (x.priceCents / 100).toFixed(2) : null].filter(Boolean).join(", ")).join("\n");

/** Supplier site searches for a part number: always there, no scraping. Suppliers are added as their search pages are verified. */
// Search pages checked 2026-09-25 (they're for people to click; the scraper never fetches them).
export const SEARCH_SITES: { name: string; url: (q: string) => string }[] = [
  { name: "Sewing Parts Online", url: (q) => `https://www.sewingpartsonline.com/search?q=${encodeURIComponent(q.replace(/-/g, ""))}` },
  { name: "AllBrands", url: (q) => `https://www.allbrands.com/search?search=${encodeURIComponent(q)}` },
  { name: "Sewing Machines Plus", url: (q) => `https://www.sewingmachinesplus.com/search?q=${encodeURIComponent(q)}` },
  { name: "Premier Stitching", url: (q) => `https://www.premierstitching.com/search.php?search_query=${encodeURIComponent(q.replace(/-/g, ""))}` },
  { name: "Grome's", url: (q) => `https://www.gromes.com/search?q=${encodeURIComponent(q)}` },
  { name: "eBay", url: (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}` },
  { name: "Amazon", url: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}` },
  { name: "Google", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(`"${q}" sewing machine part`)}` },
];
