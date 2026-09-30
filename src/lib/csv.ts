// One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @, tab or return first; some of it can come
// from partner shops or the hub) gets a leading apostrophe; plain numbers, negative ones too, stay numbers.
export function csvCell(v: unknown): string {
  let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A CSV download. The byte order mark tells Excel on Windows the file is UTF-8 (without it, a file opened by double-click
 * shows accents and fractions garbled), and rows end in CRLF as Excel writes them.
 */
export function csvResponse(rows: unknown[][], filename: string): Response {
  const body = rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  return new Response("\uFEFF" + body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` },
  });
}
