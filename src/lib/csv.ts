// One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @, tab or return first; some of it can come
// from partner shops or the hub) gets a leading apostrophe; plain numbers, negative ones too, stay numbers.
export function csvCell(v: unknown): string {
  let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
