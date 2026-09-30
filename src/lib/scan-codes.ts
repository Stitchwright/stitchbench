// What a claim tag's barcode (T<tag>, printed by /repairs/[id]/tag), a receipt's barcode (S<number>, printed by
// /register/sales/[id]) or a bare number typed by hand means. Kept separate from the register and search pages so the
// two agree: /search already opens a claim tag typed as "101" or "T101" the same way this resolves for the register.
export type ScanCode = { kind: "tag"; tag: string } | { kind: "sale"; number: number } | { kind: "none" };

/** A receipt number reads "S1004"; a claim tag reads "T101" or, typed by hand, plain "101". */
export function parseScanCode(raw: string): ScanCode {
  const c = raw.trim();
  const sale = /^s(\d{1,10})$/i.exec(c);
  if (sale) return { kind: "sale", number: Number(sale[1]) };
  if (/^t?\d{1,10}$/i.test(c)) return { kind: "tag", tag: c.replace(/^t/i, "") };
  return { kind: "none" };
}
