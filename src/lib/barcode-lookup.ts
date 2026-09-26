import "server-only";
// What a retail barcode (UPC / EAN) is, from UPCitemdb: the free plan needs no sign-up and allows 100 lookups a day per
// internet address (UPCITEMDB_KEY uses a paid plan instead; UPC_LOOKUP=off turns lookups off). Only the name and brand
// are used, to fill in a new inventory item; nothing is sent but the barcode number.

export type BarcodeInfo = { title: string; brand: string | null; model: string | null; category: string | null };

export async function lookupBarcode(code: string): Promise<BarcodeInfo | null> {
  const digits = code.replace(/\D/g, "");
  if (!/^\d{8}$|^\d{12,14}$/.test(digits) || digits.length !== code.trim().length) {
    throw new Error("Online lookup works for store barcodes (UPC or EAN, 8, 12 or 13 digits).");
  }
  if (process.env.UPC_LOOKUP === "off") throw new Error("Barcode lookup is turned off on this install.");
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
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`The barcode lookup answered ${r.status}. Type the details in.`);
  const j = (await r.json()) as { items?: { title?: string; brand?: string; model?: string; category?: string }[] };
  const it = j.items?.[0];
  if (!it?.title) return null;
  return { title: it.title.slice(0, 200), brand: it.brand?.slice(0, 80) || null, model: it.model?.slice(0, 80) || null, category: it.category?.slice(0, 200) || null };
}
