import "server-only";
// What a retail barcode (UPC / EAN) is, from UPCitemdb: the free plan needs no sign-up and allows 100 lookups a day per
// internet address (UPCITEMDB_KEY uses a paid plan instead; UPC_LOOKUP=off turns lookups off). Only the name and brand
// are used, to fill in a new inventory item; nothing is sent but the barcode number.

export type BarcodeInfo = { title: string; brand: string | null; model: string | null; category: string | null };

// The lookup's daily allowance is the install's, not a company's: on a hosted install every company shares one internet
// address (or one paid key). So a barcode looked up before is answered from memory (found or not, for a week) at no
// cost, and each company gets a share of the day's lookups. Kept per server process, like the partner message limits.
const PER_COMPANY_PER_DAY = Number(process.env.UPC_LOOKUPS_PER_COMPANY) || 40;
const KEEP_MS = 7 * 24 * 3600_000;
const memory = globalThis as unknown as { __upcLookups?: { known: Map<string, { info: BarcodeInfo | null; at: number }>; used: Map<string, { day: string; n: number }> } };
const lookups = () => (memory.__upcLookups ??= { known: new Map(), used: new Map() });

function takeShare(shopId: string) {
  const day = new Date().toISOString().slice(0, 10);
  const { used } = lookups();
  for (const [k, u] of used) if (u.day !== day) used.delete(k);
  const u = used.get(shopId) ?? { day, n: 0 };
  if (u.n >= PER_COMPANY_PER_DAY) throw new Error(`This company has used its ${PER_COMPANY_PER_DAY} online barcode lookups for today. Type the details in, or try again tomorrow.`);
  u.n++;
  used.set(shopId, u);
}

export async function lookupBarcode(code: string, shopId: string): Promise<BarcodeInfo | null> {
  const digits = code.replace(/\D/g, "");
  if (!/^\d{8}$|^\d{12,14}$/.test(digits) || digits.length !== code.trim().length) {
    throw new Error("Online lookup works for store barcodes (UPC or EAN, 8, 12 or 13 digits).");
  }
  if (process.env.UPC_LOOKUP === "off") throw new Error("Barcode lookup is turned off on this install.");
  const { known } = lookups();
  const had = known.get(digits);
  if (had && Date.now() - had.at < KEEP_MS) return had.info;
  takeShare(shopId);
  const key = process.env.UPCITEMDB_KEY;
  const url = key ? `https://api.upcitemdb.com/prod/v1/lookup?upc=${digits}` : `https://api.upcitemdb.com/prod/trial/lookup?upc=${digits}`;
  let r: Response;
  try {
    r = await fetch(url, {
      headers: { Accept: "application/json", ...(key ? { user_key: key, key_type: "3scale" } : {}) },
      signal: AbortSignal.timeout(8000), // a scan mustn't wait long when the internet is down
    });
  } catch {
    throw new Error("Couldn't reach the barcode lookup (no internet?). Type the details in.");
  }
  if (r.status === 429) throw new Error("Today's free barcode lookups are used up (100 a day). Type the details in.");
  // Kept for next time; the oldest go first when there are many.
  const keep = (info: BarcodeInfo | null) => {
    known.set(digits, { info, at: Date.now() });
    if (known.size > 2000) for (const k of known.keys()) { known.delete(k); break; }
    return info;
  };
  if (r.status === 404) return keep(null);
  if (!r.ok) throw new Error(`The barcode lookup answered ${r.status}. Type the details in.`);
  const j = (await r.json()) as { items?: { title?: string; brand?: string; model?: string; category?: string }[] };
  const it = j.items?.[0];
  if (!it?.title) return keep(null);
  return keep({ title: it.title.slice(0, 200), brand: it.brand?.slice(0, 80) || null, model: it.model?.slice(0, 80) || null, category: it.category?.slice(0, 200) || null });
}
