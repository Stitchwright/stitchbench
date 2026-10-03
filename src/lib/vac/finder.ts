import "server-only";
// The bag / belt / filter finder (modules-design.md section 10.b): which community cross-reference entries fit a
// vacuum (or go by a type or number), which of this shop's parts ARE each of them (brand-aware), and the shop's own
// parts whose Fits list the model when the hub has nothing. No schema and no hub change: a supply is an XPart whose
// category is one of VAC_SUPPLY_CATEGORIES.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { VAC_SUPPLY_CATEGORIES } from "@/lib/constants";
import { brandKey, modelKey } from "@/lib/format";
import { brandMatches } from "@/lib/model-info";
import { numberKey, splitList, type XFit, type XNumber } from "@/lib/parts";
import { viewItem, type RegisterItem } from "@/lib/register-item";

export type VacSupplyCategory = (typeof VAC_SUPPLY_CATEGORIES)[number];
export type Supply = {
  xpartId: string | null;
  name: string;
  category: VacSupplyCategory | null;
  numbers: { brand: string; number: string }[];
  evidence: "tested" | "maker" | "listed" | null;
  /** Found by the model-prefix fallback: the model it lists, e.g. "UH70120PC". */
  close: string | null;
  /** This shop's stocked parts that ARE this supply (brand-aware), in stock first; [] = not stocked. */
  items: RegisterItem[];
  source: "hub" | "local";
};
/** `text` is a bag type, a part number or words; `model` needs `brand`. */
export type FinderQuery = {
  brand?: string | null;
  model?: string | null;
  text?: string | null;
};

/** The results are capped after ranking, so spam can't push real bags out. */
export const FINDER_CAP = 60;

/** eBay and Google "{q} vacuum": for a supply nobody stocks, links people click (nothing is fetched). */
export const VAC_SEARCH_SITES: { label: string; url: (q: string) => string }[] = [
  {
    label: "eBay",
    url: (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(`${q} vacuum`)}`,
  },
  {
    label: "Google",
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(`${q} vacuum`)}`,
  },
];

const CATS = [...VAC_SUPPLY_CATEGORIES] as string[];
const CAT_ORDER: Record<string, number> = {
  "Vacuum bag": 0,
  "Vacuum belt": 1,
  "Vacuum filter": 2,
};
const EVIDENCE_RANK: Record<string, number> = {
  tested: 0,
  maker: 0,
  listed: 1,
};

type Row = {
  id: string;
  name: string;
  category: string | null;
  numbers: unknown;
  numberKeys: string[];
  fits: unknown;
};
type Part = Parameters<typeof viewItem>[0] & {
  brand: string | null;
  numberKeys: string[];
  fits: string | null;
  description: string;
};

const asCategory = (c: string | null | undefined): VacSupplyCategory | null => (c && CATS.includes(c) ? (c as VacSupplyCategory) : null);

/** The category a shop part's description suggests: "Hoover Type Y bags (3)" is a bag. Null = "Other". */
export function guessCategory(description: string): VacSupplyCategory | null {
  if (/\bbags?\b/i.test(description)) return "Vacuum bag";
  if (/\bbelts?\b/i.test(description)) return "Vacuum belt";
  if (/\bfilters?\b/i.test(description)) return "Vacuum filter";
  return null;
}

/**
 * Whether a shop part IS the supply one of the entry's numbers names: the number key is in the part's keys and either
 * the brands match, or the part is brandless / Generic and the key is 5+ characters with a digit. So an Electrolux
 * "Type C" is never offered as a Kenmore "Type C", and a number "1" matches nothing.
 */
export function partIsSupply(part: { brand: string | null; numberKeys: string[] }, numbers: XNumber[]): boolean {
  const generic = !part.brand || brandKey(part.brand) === "GENERIC";
  return numbers.some((n) => {
    const k = numberKey(n.number);
    if (k.length < 3 || !part.numberKeys.includes(k)) return false;
    if (part.brand && !generic) return brandMatches(n.brand, part.brand);
    return k.length >= 5 && /\d/.test(k);
  });
}

/** The entry's fit for this vacuum, if it has one (exact model key, maker matching). */
function fitFor(fits: XFit[], key: string, brand: string): XFit | undefined {
  return fits.find((f) => f.modelKey === key && brandMatches(f.brand, brand));
}

/** The best evidence among fits: tested and maker rank the same (a maker's chart counts as a tech's fitting). */
function evidenceOf(fits: XFit[]): Supply["evidence"] {
  if (!fits.length) return null;
  if (fits.some((f) => f.evidence === "tested" || f.evidence === "maker")) return fits.find((f) => f.evidence === "tested") ? "tested" : "maker";
  return "listed";
}

function sortKey(s: Supply): [number, number, number, string] {
  return [s.category ? CAT_ORDER[s.category] : 3, s.items.length ? 0 : 1, s.evidence ? EVIDENCE_RANK[s.evidence] : 2, s.name.toLowerCase()];
}

export function compareSupplies(a: Supply, b: Supply): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
  return ka[3].localeCompare(kb[3]);
}

/** Items in stock first, then by number. */
const byStock = (a: RegisterItem, b: RegisterItem) => (b.qtyOnHand > 0 ? 1 : 0) - (a.qtyOnHand > 0 ? 1 : 0) || a.partNumber.localeCompare(b.partNumber);

/**
 * What fits (brand + model: exact fits, else close matches by model prefix), what goes by a type or number (text),
 * each with this shop's stock of it, plus the shop's own parts whose Fits name the model. Sorted by category, stocked
 * first, evidence, name; then capped at FINDER_CAP.
 */
export async function suppliesFor(shopId: string, q: FinderQuery): Promise<{ supplies: Supply[]; truncated: boolean }> {
  const brand = q.brand?.trim() ?? "";
  const model = q.model?.trim() ?? "";
  const text = q.text?.trim() ?? "";
  const key = model ? modelKey(model) : "";
  const found = new Map<string, Supply>();
  const add = (row: Row, evidence: Supply["evidence"], close: string | null) => {
    if (found.has(row.id)) return;
    found.set(row.id, {
      xpartId: row.id,
      name: row.name,
      category: asCategory(row.category),
      numbers: row.numbers as XNumber[],
      evidence,
      close,
      items: [],
      source: "hub",
    });
  };

  // 1. By model: exact fits under this maker, else the prefix fallback ("UH70120" finds "UH70120PC").
  if (brand && key) {
    const rows = await db.xPart.findMany({
      where: { category: { in: CATS }, fitKeys: { has: key } },
      take: 500,
    });
    for (const x of rows) {
      const fit = fitFor(x.fits as XFit[], key, brand);
      if (fit) add(x, evidenceOf([fit]), null);
    }
    if (!found.size && key.length >= 4) {
      const ids = await db.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM "XPart" WHERE category IN (${Prisma.join(CATS)})
          AND EXISTS (SELECT 1 FROM unnest("fitKeys") k WHERE length(k) >= 4 AND (${key} LIKE k || '%' OR k LIKE ${key} || '%'))
          LIMIT 200`,
      );
      if (ids.length) {
        const rows2 = await db.xPart.findMany({
          where: { id: { in: ids.map((r) => r.id) } },
        });
        for (const x of rows2) {
          const near = (x.fits as XFit[]).filter((f) => f.modelKey.length >= 4 && (key.startsWith(f.modelKey) || f.modelKey.startsWith(key)) && brandMatches(f.brand, brand));
          if (near.length) add(x, evidenceOf(near), near[0].model);
        }
      }
    }
  }

  // 2. By type or number ("Type Y", "4010100Y", "HEPA").
  if (text) {
    const nk = numberKey(text);
    const rows = await db.xPart.findMany({
      where: {
        category: { in: CATS },
        OR: [...(nk.length >= 3 ? [{ numberKeys: { has: nk } }] : []), { name: { contains: text, mode: "insensitive" as const } }],
      },
      take: 200,
    });
    for (const x of rows) add(x, null, null);
  }

  // 3. This shop's stock of each entry: one query over every number key of 3+ characters, then the brand-aware match.
  const keys = [...new Set([...found.values()].flatMap((s) => s.numbers.map((n) => numberKey(n.number)).filter((k) => k.length >= 3)))];
  const stock: Part[] = keys.length
    ? await db.part.findMany({
        where: { shopId, numberKeys: { hasSome: keys } },
        take: 500,
      })
    : [];
  for (const s of found.values()) {
    s.items = stock
      .filter((p) => partIsSupply(p, s.numbers))
      .map(viewItem)
      .sort(byStock);
  }

  // 4. The shop's own parts whose Fits list the model (offline, not joined, or simply not on the hub yet).
  if (brand && key) {
    const taken = new Set([...found.values()].flatMap((s) => s.items.map((i) => i.id)));
    const bk = brandKey(brand) + key;
    const local: Part[] = await db.part.findMany({
      where: { shopId, fits: { contains: model, mode: "insensitive" } },
      take: 200,
    });
    for (const p of local) {
      if (taken.has(p.id) || !p.fits) continue;
      if (!splitList(p.fits).some((e) => modelKey(e) === key || modelKey(e) === bk)) continue;
      found.set(`local:${p.id}`, {
        xpartId: null,
        name: p.description,
        category: guessCategory(p.description),
        numbers: [],
        evidence: null,
        close: null,
        items: [viewItem(p)],
        source: "local",
      });
    }
  }

  const all = [...found.values()].sort(compareSupplies);
  return {
    supplies: all.slice(0, FINDER_CAP),
    truncated: all.length > FINDER_CAP,
  };
}

export type CustomerVacuum = {
  id: string;
  brand: string;
  model: string;
  bagType: string | null;
};

/** A customer's vacuums, newest first; the customer must be this company's. */
export async function customerVacuumsFor(shopId: string, customerId: string): Promise<CustomerVacuum[]> {
  const c = await db.customer.findFirst({
    where: { id: customerId, shopId },
    select: { id: true },
  });
  if (!c) throw new UserError("Customer not found.");
  const rows = await db.machine.findMany({
    where: { shopId, customerId, equipment: "VACUUM" },
    orderBy: { createdAt: "desc" },
    select: { id: true, brand: true, model: true, details: true },
    take: 20,
  });
  return rows.map((m) => {
    const d = (m.details ?? {}) as Record<string, unknown>;
    return {
      id: m.id,
      brand: m.brand,
      model: m.model,
      bagType: typeof d.bagType === "string" && d.bagType.trim() ? d.bagType.trim() : null,
    };
  });
}

/** The finder's address for a vacuum (or a type / number), for links from the register and machine pages. */
export function finderHref(q: FinderQuery): string {
  const p = new URLSearchParams();
  if (q.brand) p.set("brand", q.brand);
  const text = q.model || q.text;
  if (text) p.set("q", text);
  const s = p.toString();
  return `/vac/finder${s ? `?${s}` : ""}`;
}

/** The add form's address with the category and the vacuum filled in. */
export function newSupplyHref(category: VacSupplyCategory, brand: string, model: string): string {
  const p = new URLSearchParams({
    category,
    kind: category === "Vacuum belt" ? "PART" : "SUPPLY",
  });
  if (brand && model) p.set("fits", `${brand}, ${model}`);
  return `/xref?${p.toString()}#add`;
}
