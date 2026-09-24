// Shared formatting and normalization helpers (safe on server and client).

export function money(cents: number | null | undefined): string {
  if (cents == null) return "";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** "12.50" -> 1250. Returns null for blank or invalid input. */
export function toCents(v: FormDataEntryValue | string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).replace(/[$,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function ticketNo(n: number): string {
  return String(n).padStart(4, "0");
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
