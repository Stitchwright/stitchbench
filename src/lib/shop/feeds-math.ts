// Product feeds for Google and Meta (shop-features-round-2-design.md 4.1, 4.2): the pure part. A barcode's check digit,
// which items go in and why one doesn't, and the three files: Google's product feed (RSS 2.0 with the g: namespace),
// Google's local inventory feed (tab separated) and Meta's catalog feed (CSV). No "server-only", no database: the check
// script and the unit test read it directly.

/** True for a GTIN-8, 12 (UPC-A), 13 (EAN) or 14 whose check digit is right. */
export function gtinOk(s: string | null | undefined): boolean {
  if (!s || !/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(s)) return false;
  if (/^0+$/.test(s)) return false;
  const d = s.split("").map(Number);
  const check = d.pop()!;
  let sum = 0;
  // From the right, the digit next to the check digit weighs 3, then 1, 3, ...
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * What the shop typed or scanned as a barcode, made into digits ("0 12345 67890 5" -> "012345678905"). Empty: null.
 * A number whose check digit is wrong: an error in words.
 */
export function gtinInput(raw: string | null | undefined): { gtin: string | null; error?: string } {
  const digits = (raw ?? "").replace(/[\s-]/g, "");
  if (!digits) return { gtin: null };
  if (!/^\d+$/.test(digits)) return { gtin: null, error: "A barcode is digits only, like 012345678905." };
  if (![8, 12, 13, 14].includes(digits.length)) return { gtin: null, error: `A barcode has 8, 12, 13 or 14 digits; this has ${digits.length}.` };
  if (!gtinOk(digits)) return { gtin: null, error: "That barcode's last digit doesn't add up: check it was typed or scanned right." };
  return { gtin: digits };
}

/** The item's barcode for the feeds: its own, else the first of its numbers that is a valid GTIN. */
export function gtinOf(p: { gtin?: string | null; partNumber: string; altNumbers: string[] }): string | null {
  if (p.gtin && gtinOk(p.gtin)) return p.gtin;
  for (const n of [p.partNumber, ...p.altNumbers]) {
    const d = n.replace(/[\s-]/g, "");
    if (gtinOk(d)) return d;
  }
  return null;
}

export type FeedPart = {
  id: string;
  partNumber: string;
  altNumbers: string[];
  gtin: string | null;
  description: string;
  onlineTitle: string | null;
  onlineText: string | null;
  brand: string | null;
  kind: string;
  unit: string | null;
  condition: string;
  qtyOnHand: number;
  priceCents: number | null;
  online: boolean;
  consignLinkId: string | null;
  photoId: string | null;
};

export type FeedRow = {
  id: string;
  title: string;
  description: string;
  brand: string | null;
  gtin: string;
  condition: "new" | "used" | "refurbished";
  priceCents: number;
  perYard: boolean;
  quantity: number;
  inStock: boolean;
  link: string;
  imageLink: string | null;
};

/** Why an item isn't in the feeds, in shop words; null when it is (Google). Meta also needs a photo (metaReason). */
export function leftOutReason(p: FeedPart): string | null {
  if (p.kind === "MACHINE") return "A machine model to order, not stock";
  if (p.consignLinkId) return "A partner's stock held here";
  if (p.priceCents == null || p.priceCents <= 0) return "No price";
  if (!gtinOf(p)) return "No barcode";
  if (!p.online) return "Not listed in your online shop";
  return null;
}

export const metaReason = (p: FeedPart): string | null => leftOutReason(p) ?? (p.photoId ? null : "No photo (Facebook needs one)");

const CONDITION: Record<string, FeedRow["condition"]> = { NEW: "new", USED: "used", REFURBISHED: "refurbished" };

/** The feed's row for an item that goes in (leftOutReason was null). `base` is the shop page's address. */
export function feedRow(p: FeedPart, a: { shopUrl: string; photoUrl: (id: string) => string }): FeedRow {
  const perYard = p.unit === "yd";
  const title = (p.onlineTitle?.trim() || p.description).slice(0, 150);
  // Whole pieces; fabric in whole yards on hand.
  const quantity = Math.floor(Math.max(0, p.qtyOnHand));
  return {
    id: p.partNumber.slice(0, 50),
    title: perYard ? `${title} (price per yard)`.slice(0, 150) : title,
    description: (p.onlineText?.trim() || p.description).slice(0, 5000),
    brand: p.brand?.trim() || null,
    gtin: gtinOf(p)!,
    condition: CONDITION[p.condition] ?? "new",
    priceCents: p.priceCents!,
    perYard,
    quantity,
    inStock: perYard ? p.qtyOnHand >= 0.125 : p.qtyOnHand >= 1,
    link: `${a.shopUrl}/i/${p.id}`,
    imageLink: p.photoId ? a.photoUrl(p.photoId) : null,
  };
}

const price = (cents: number) => `${(cents / 100).toFixed(2)} USD`;
const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters other than tab and new line aren't allowed in XML 1.0.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const tsv = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();
const csv = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Google's product feed (Merchant Center, RSS 2.0 with the g: namespace). */
export function googleProductXml(shop: { name: string; url: string }, rows: FeedRow[]): string {
  const items = rows.map((r) => {
    const f: [string, string | null][] = [
      ["g:id", r.id],
      ["g:title", r.title],
      ["g:description", r.description],
      ["g:link", r.link],
      ["g:image_link", r.imageLink],
      ["g:availability", r.inStock ? "in_stock" : "out_of_stock"],
      ["g:price", price(r.priceCents)],
      ["g:brand", r.brand],
      ["g:gtin", r.gtin],
      ["g:condition", r.condition],
      ["g:unit_pricing_measure", r.perYard ? "1yd" : null],
    ];
    return `<item>${f
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `<${k}>${xml(v!)}</${k}>`)
      .join("")}</item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">\n<channel>\n<title>${xml(shop.name)}</title>\n<link>${xml(shop.url)}</link>\n<description>${xml(`Items from ${shop.name}`)}</description>\n${items.join("\n")}\n</channel>\n</rss>\n`;
}

/** Google's local inventory feed: what is on the shelf at the store (by its Business Profile store code), tab separated. */
export function googleLocalTsv(storeCode: string, rows: FeedRow[]): string {
  const head = ["store_code", "id", "quantity", "price", "availability", "pickup_method", "pickup_sla"];
  const lines = rows.map((r) => [tsv(storeCode), tsv(r.id), String(r.quantity), price(r.priceCents), r.inStock ? "in_stock" : "out_of_stock", "buy", "same day"].join("\t"));
  return [head.join("\t"), ...lines].join("\n") + "\n";
}

/** Meta's catalog feed (Commerce Manager, CSV): each item points at its page in the shop's own online shop. */
export function metaCsv(rows: FeedRow[]): string {
  const head = ["id", "title", "description", "availability", "condition", "price", "link", "image_link", "brand", "gtin", "quantity_to_sell_on_facebook"];
  const lines = rows.map((r) =>
    [r.id, r.title, r.description, r.inStock ? "in stock" : "out of stock", r.condition, price(r.priceCents), r.link, r.imageLink ?? "", r.brand ?? "", r.gtin, String(r.quantity)].map((v) => csv(v)).join(","),
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}

/** Google asks for at least this many products with barcodes before it shows a shop's stock. */
export const GOOGLE_MIN_ITEMS = 50;
