// Shared formatting and normalization helpers (safe on server and client).

export function money(cents: number | null | undefined): string {
  if (cents == null) return "";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * "12.50" -> 1250. Returns null for blank or invalid input, and for an amount that could be read two ways: commas are
 * thousands separators ("1,000.50"), so "1,50" and "1.000,50" are refused rather than turned into $150 or $1. Powers
 * ("1e3"), hex and anything too big for the books' whole numbers are refused too. Extra decimals are rounded.
 */
export function toCents(v: FormDataEntryValue | string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).replace(/[$\s]/g, "");
  if (!/^[-+]?(\d{1,3}(,\d{3})+|\d*)(\.\d*)?$/.test(s) || !/\d/.test(s)) return null;
  const cents = Math.round(Number(s.replace(/,/g, "")) * 100);
  return Number.isFinite(cents) && Math.abs(cents) <= 2_147_483_647 ? cents || 0 : null;
}

export function ticketNo(n: number): string {
  return String(n).padStart(4, "0");
}

/**
 * "Sep 30, 2026" in the shop's time zone (shopTimeZone on the server; pass it down to client components). A hosted
 * install runs on UTC, so the server's own zone would print an evening sale as the next day's date.
 */
export function fmtDate(d: Date | string | null | undefined, timeZone: string): string {
  if (!d) return "";
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
}

/**
 * "Sep 30, 2026, 9:15 PM" in the shop's time zone; `opts` picks other parts ({ month: "short", day: "numeric", hour:
 * "numeric", minute: "2-digit" }). The same text on the server and in the browser, so pages hydrate cleanly.
 */
export function fmtDateTime(d: Date | string | null | undefined, timeZone: string, opts?: Intl.DateTimeFormatOptions): string {
  if (!d) return "";
  const x = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(x.getTime())) return "";
  return x.toLocaleString("en-US", { timeZone, ...(opts ?? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) });
}

/**
 * Normalize a model name for matching across specs, notes and manual file names:
 * uppercase, letters and digits only. "BES-1216AC" -> "BES1216AC", "MC 6700P" -> "MC6700P".
 */
export function modelKey(model: string): string {
  return model.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function brandKey(brand: string): string {
  return brand.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function str(v: FormDataEntryValue | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
