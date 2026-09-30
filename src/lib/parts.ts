import "server-only";
// Parts, their numbers, and the community cross-reference (synced XPart rows).
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { modelKey, str, toCents } from "@/lib/format";
import { sameText } from "@/lib/input";
import { brandMatches } from "@/lib/model-info";
import { numberNames, shopNumberText, twinNumber } from "@/lib/part-labels";
import { appName } from "@/lib/shops";
import type { Prisma } from "@/generated/prisma/client";
import type { PartCondition } from "@/generated/prisma/enums";

export type XNumber = { brand: string; number: string };
export type XFit = { brand: string; model: string; modelKey: string; evidence: string; source?: string | null };
export type XSource = { id?: string; vendor: string; url?: string | null; priceCents?: number | null; currency?: string; note?: string | null; byShop?: string | null; updatedAt?: string };

export const EVIDENCE_LABEL: Record<string, string> = {
  tested: "Fitted by a tech",
  maker: "Maker says it fits",
  listed: "In that model's parts list",
};
export const KIND_LABEL: Record<string, string> = {
  PART: "Part",
  ACCESSORY: "Accessory",
  SUPPLY: "Supply",
  NOTION: "Notion",
  FABRIC: "Fabric",
  THREAD: "Thread",
  PATTERN: "Pattern / book",
};

/** A part number reduced to letters and digits, upper-case: "XA-1234-001" → "XA1234001". */
export const numberKey = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * One form of a barcode: UPC-A (12 digits, or 11 once a spreadsheet dropped the leading 0), EAN-13 and GTIN-14 of the
 * same item are the same 14 digits. Scanners send UPC-A as 12 digits while line sheets often carry 13 or 14.
 */
export function gtinKey(n: string) {
  const k = numberKey(n);
  return /^\d{11,14}$/.test(k) ? k.padStart(14, "0") : null;
}

/** The keys a typed or scanned code matches parts on: its letters and digits, and its barcode form. */
export function codeKeys(code: string) {
  return [...new Set([numberKey(code), gtinKey(code)].filter((k): k is string => !!k && k.length >= 3))];
}

export function partKeys(partNumber: string, altNumbers: string[]) {
  return [...new Set([partNumber, ...altNumbers].flatMap(codeKeys))];
}

// The most a stock count or a price can be. A partner shop refuses a whole catalog that has stock over 100,000 or a
// price over $100,000 (MAX_QTY and MAX_MONEY in partners.ts), so nothing above that is kept here.
export const MAX_STOCK = 100_000;
export const MAX_CENTS = 10_000_000;

/** Dollars typed for a cost or price, as cents: blank is none; a minus sign, a word or a huge number is an error. */
export function centsField(v: FormDataEntryValue | string | null | undefined, what: string): number | null {
  if (str(v) == null) return null;
  const c = toCents(v);
  if (c == null) throw new UserError(`${what}: enter dollars and cents, like 12.50.`);
  if (c < 0 || c > MAX_CENTS) throw new UserError(`${what} must be between $0 and $${(MAX_CENTS / 100).toLocaleString("en-US")}.`);
  return c;
}

/**
 * The next shop number for a stock item the maker gave no number: "SB-00001" in StitchBench, "SS-00001" in StitchShop,
 * counted per company. Taken atomically, like a ticket number, and skipping numbers already in use (typed in, imported,
 * or the counter set back). Call it in the same transaction that makes the item.
 */
export async function takeShopNumber(tx: Prisma.TransactionClient, shopId: string): Promise<string> {
  const prefix = appName() === "StitchShop" ? "SS" : "SB";
  const used = async (n: number) => (await tx.part.findFirst({ where: { shopId, partNumber: sameText(shopNumberText(prefix, n)) }, select: { id: true } })) != null;
  let n = (await tx.shop.update({ where: { id: shopId }, data: { nextPartNumber: { increment: 1 } }, select: { nextPartNumber: true } })).nextPartNumber - 1;
  if (await used(n)) {
    // The counter is behind the numbers in use: go straight past the highest instead of trying the used ones one at a time.
    const [top] = await tx.$queryRaw<{ n: number | null }[]>`
      SELECT max(substring("partNumber" from 4)::int) AS n FROM "Part" WHERE "shopId" = ${shopId} AND "partNumber" ~* ${`^${prefix}-[0-9]{1,9}$`}`;
    n = (top?.n ?? 0) + 1;
    await tx.shop.update({ where: { id: shopId }, data: { nextPartNumber: n + 1 } });
  }
  return shopNumberText(prefix, n);
}

/**
 * This shop's own item for a number in a condition (a partner's consigned stock doesn't count), and the number a new
 * one would be saved under: the number itself, or, when the shop holds it already, "<number> (used)" for the same part
 * in another condition and "<number> (own)" beside a partner's consigned stock, with the number among its other
 * numbers so a scan finds both. The same number in another case is the same number.
 */
export async function stockFor(client: Pick<Prisma.TransactionClient, "part">, shopId: string, number: string, condition: PartCondition) {
  const same = await client.part.findMany({
    where: { shopId, OR: numberNames(number).map((n) => ({ partNumber: sameText(n) })) },
    select: { id: true, partNumber: true, consignLinkId: true, condition: true },
  });
  const own = same.filter((p) => !p.consignLinkId);
  const taken = (n: string) => same.some((p) => p.partNumber.toLowerCase() === n.toLowerCase());
  const existing = own.find((p) => p.condition === condition) ?? null;
  const partNumber = taken(number) ? twinNumber(number, condition, own.length > 0) : number;
  if (!existing && partNumber !== number && taken(partNumber)) throw new UserError(`${partNumber} is already another item in inventory.`);
  return { existing, partNumber, altNumbers: partNumber === number ? [] : [number] };
}

/**
 * Set a part's stock to what was counted. The change written to the history is worked out from the stock at that
 * moment (the row is locked), so a sale that lands while the count is being saved can't leave the history off.
 * Returns the change (0 when the count matched).
 */
export async function countStock(shopId: string, partId: string, counted: number, userId: string, note: string): Promise<number> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ qtyOnHand: number }[]>`SELECT "qtyOnHand" FROM "Part" WHERE id = ${partId} AND "shopId" = ${shopId} FOR UPDATE`;
    if (!rows.length) throw new UserError("Part not found.");
    const change = Math.round((counted - rows[0].qtyOnHand) * 1000) / 1000;
    if (change === 0) return 0;
    await tx.part.update({ where: { id: partId }, data: { qtyOnHand: counted } });
    await tx.stockMove.create({ data: { shopId, partId, qty: change, reason: "ADJUSTED", userId, note } });
    return change;
  });
}

/**
 * The note on the stock move a marketplace order makes when it goes into (or out of) the parts stock. It is also how
 * an order already in the stock is recognised, so it is never put in twice.
 */
export const orderStockNote = (o: { number: string; role: string; sellerShop: string; buyerShop: string }) =>
  o.role === "seller" ? `Sold on the marketplace, order ${o.number} to ${o.buyerShop}` : `Marketplace order ${o.number} from ${o.sellerShop}`;

/** A part number without the note this program adds to tell stock apart ("X (own)", "X (Partner name)"). */
export const baseNumber = (n: string) => n.replace(/\s+\([^()]*\)$/, "").trim() || n;

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

/**
 * "Vendor, https://..., 12.50" lines → where to buy. The link is the one http(s) address (commas in it and all), the
 * vendor is what comes before it and the price what comes after ("12.50", "1,000.50" or "12.99 CAD"). With no link,
 * a last field that looks like a price is the price. A source already on the entry keeps its id, currency and note.
 */
export function parseSources(text: string | null | undefined, previous: XSource[] = []): XSource[] {
  const out: XSource[] = [];
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const link = /https?:\/\/\S+/i.exec(line);
    let vendor = line;
    let url: string | null = null;
    let price = "";
    if (link) {
      url = link[0].replace(/,+$/, "");
      vendor = line.slice(0, link.index).replace(/[,\s]+$/, "");
      price = line.slice(link.index + link[0].length).replace(/^[,\s]+/, "");
    } else {
      const i = line.lastIndexOf(",");
      const last = i > 0 ? line.slice(i + 1).trim() : "";
      if (/^\$?\s*\d[\d,]*(\.\d*)?(\s+[A-Za-z]{3})?$/.test(last)) {
        vendor = line.slice(0, i).trim();
        price = last;
      }
    }
    if (!vendor) throw new UserError(`Put the vendor's name before the link: "${line}"`);
    let priceCents: number | null = null;
    let currency: string | undefined;
    if (price) {
      const m = /^\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z]{3})?$/.exec(price);
      const amount = m?.[1].replace(/,/g, "") ?? "";
      if (!m || !/^\d+(\.\d{1,2})?$/.test(amount)) throw new UserError(`Write the price in dollars and cents, e.g. 12.50: "${line}"`);
      priceCents = Math.round(Number(amount) * 100);
      currency = m[2]?.toUpperCase();
    }
    const was = previous.find((s) => s.vendor === vendor && (s.url ?? null) === url);
    out.push({ ...(was ?? {}), vendor, url, priceCents, currency: currency ?? was?.currency ?? "USD" });
  }
  return out;
}

export const numbersText = (n: XNumber[]) => n.map((x) => `${x.brand}, ${x.number}`).join("\n");
export const fitsText = (f: XFit[]) => f.map((x) => `${x.brand}, ${x.model}`).join("\n");
export const sourcesText = (s: XSource[]) =>
  s
    .map((x) =>
      [x.vendor, x.url, x.priceCents != null ? `${(x.priceCents / 100).toFixed(2)}${x.currency && x.currency !== "USD" ? ` ${x.currency}` : ""}` : null]
        .filter(Boolean)
        .join(", "),
    )
    .join("\n");

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
