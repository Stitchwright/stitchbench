// The catalogue a shop publishes to MakerFoundry (docs/plans/makerfoundry-orders-plan.md 3.4 and 3.5), built from the shop's online
// products (a blank garment and its price) and its decoration offers (a flat price per piece by quantity, plus a set-up fee).
// Pure. A customer is charged only prices from a catalogue the shop published, so the figures here are exactly what is sent:
// a piece costs the garment's own price (`cents`) plus the decoration at its quantity break (`price_breaks`), as MakerFoundry's contract says; shipping
// is by the piece; the pick-up address is where customers collect (sales tax on a pick-up order is worked out from it). Sales tax itself is MakerFoundry's.
import { parseBody, METHODS, type CatalogBody, type Method } from "@/lib/shop-orders/contract";

export type ProductIn = { sku: string; name: string; kind: string; colours: string; sizes: string; blankCents: number };
export type OfferIn = { method: string; placement: string; breaks: { min: number; cents: number }[]; setupCents: number };
export type PickupAddress = { line1: string; line2?: string; city: string; region?: string; postcode: string; country: string };
export type CatalogIn = {
  shopName: string;
  ships: boolean;
  /** Shipping: the price for one piece, then so much for each piece after the first, free when goods and set-up reach freeOverCents (0 = never). */
  shippingCents: number;
  perExtraPieceCents?: number;
  freeOverCents?: number;
  pickup?: boolean;
  pickupAddress?: PickupAddress | null;
  /** The shop's Foundry Account (the owner's linked one): MakerFoundry pays the shop through it, and does not offer a shop without one. */
  account?: number | null;
  products: ProductIn[];
  offers: OfferIn[];
};

export const METHOD_WORDS: Record<Method, string> = { embroidery: "Embroidery", screen_print: "Screen print" };
export const isMethod = (v: unknown): v is Method => typeof v === "string" && (METHODS as readonly string[]).includes(v);

/** "Black, Navy" or one a line, to a clean list (empty and repeated entries dropped). */
export function splitList(text: string, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(text ?? "").split(/[\n,;]+/)) {
    const t = part.replace(/\s+/g, " ").trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** "1: 12.00" and "12: 10.50", one a line: the price each piece costs from that many pieces (dollars), as price breaks in cents. */
export function parsePriceBreaks(text: string): { breaks: { min: number; cents: number }[] } | { error: string } {
  const breaks: { min: number; cents: number }[] = [];
  for (const raw of String(text ?? "").split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d{1,6})\s*[:=]\s*\$?\s*(\d{1,6}(?:\.\d{1,2})?)$/.exec(line);
    if (!m) return { error: `"${line.slice(0, 40)}": write pieces, a colon, then dollars each. Like 12: 10.50` };
    const min = Number(m[1]);
    const cents = Math.round(Number(m[2]) * 100);
    if (min < 1 || cents < 0) return { error: `"${line.slice(0, 40)}": pieces from 1, a price of 0 or more.` };
    if (breaks.some((b) => b.min === min)) return { error: `Pieces "${min}" appears twice.` };
    breaks.push({ min, cents });
  }
  if (!breaks.length) return { error: "Give at least one price, like 1: 12.00" };
  if (breaks.length > 10) return { error: "At most 10 quantity breaks." };
  breaks.sort((a, b) => a.min - b.min);
  if (breaks[0].min !== 1) return { error: "The first line has to start at 1 piece, so every order has a price." };
  return { breaks };
}
export const breaksText = (b: { min: number; cents: number }[]): string => b.map((x) => `${x.min}: ${(x.cents / 100).toFixed(2)}`).join("\n");

/**
 * The catalogue body. Offers with the same method, the same prices and the same set-up fee share one entry (its placements listed
 * together). A product with no offer is left out, and so is an offer no product can use; null (with the reason) when nothing is left to
 * sell. The body is checked against the same rules the hub applies, so what is built is what will be accepted.
 */
export function buildCatalog(c: CatalogIn): { ok: true; body: CatalogBody } | { ok: false; why: string } {
  const offers = c.offers.filter((o) => isMethod(o.method) && o.breaks.length > 0);
  if (!offers.length) return { ok: false, why: "Add at least one decoration with its prices first." };
  const groups = new Map<string, { method: Method; placements: string[]; breaks: { min: number; cents: number }[]; setupCents: number }>();
  for (const o of [...offers].sort((a, b) => a.method.localeCompare(b.method) || a.placement.localeCompare(b.placement))) {
    const key = `${o.method}|${o.setupCents}|${o.breaks.map((b) => `${b.min}:${b.cents}`).join(",")}`;
    const g = groups.get(key) ?? { method: o.method as Method, placements: [], breaks: o.breaks, setupCents: o.setupCents };
    if (g.placements.length < 10) g.placements.push(o.placement);
    groups.set(key, g);
  }
  const products = c.products
    .map((p) => ({
      sku: p.sku,
      name: p.name,
      kind: p.kind,
      colours: splitList(p.colours, 50),
      sizes: splitList(p.sizes, 20),
      // The garment's own price per piece; each method's price breaks are the decoration alone (the customer pays both).
      cents: p.blankCents,
      methods: [...groups.values()].slice(0, 6).map((g) => ({
        method: g.method,
        placements: g.placements,
        price_breaks: g.breaks,
        setup_cents: g.setupCents,
      })),
    }))
    .filter((p) => p.colours.length > 0 && p.sizes.length > 0)
    .slice(0, 200);
  if (!products.length) return { ok: false, why: "Add at least one garment, with its colours and sizes, first." };
  const pickup = c.pickup ?? true;
  if (!c.ships && !pickup) return { ok: false, why: "Turn on shipping or pick-up, so customers have a way to get their order." };
  const a = c.pickupAddress;
  const shipping = c.ships ? { flat_cents: c.shippingCents, per_extra_piece_cents: c.perExtraPieceCents ?? 0, free_over_cents: c.freeOverCents ?? 0 } : { flat_cents: 0 };
  // Without a pick-up address MakerFoundry offers only shipping while it collects sales tax: say pick-up only when it can be used.
  const body = {
    shop: { name: c.shopName, ships: c.ships, pickup, ...(c.account ? { account: c.account } : {}), ...(pickup && a ? { address: { line1: a.line1, ...(a.line2 ? { line2: a.line2 } : {}), city: a.city, ...(a.region ? { region: a.region } : {}), postcode: a.postcode, country: a.country } } : {}) },
    products,
    shipping,
    currency: "usd" as const,
  };
  const parsed = parseBody("catalog", 1, body, "shop");
  if (!parsed.ok) return { ok: false, why: parsed.error };
  return { ok: true, body: parsed.body as CatalogBody };
}
