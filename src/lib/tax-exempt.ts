// Tax-exempt customers (later-round-1-design.md 3.3): a customer with a certificate number whose date (if any) has not
// passed. Pure: no database, so the register (browser), the actions and the checks share one rule.

export type ExemptFields = { taxExemptId: string | null; taxExemptUntil: Date | string | null };

/** The certificate number that applies now, or null: none on file, or it ran out before today (end of that day counts). */
export function exemptCertificate(c: Partial<ExemptFields> | null | undefined, now: Date = new Date()): string | null {
  const id = c?.taxExemptId?.trim();
  if (!id) return null;
  if (c?.taxExemptUntil) {
    const until = new Date(c.taxExemptUntil);
    // The certificate is good through its last day.
    if (until.getTime() + 24 * 3600 * 1000 <= now.getTime()) return null;
  }
  return id;
}

/** The date typed on the customer form ("2027-06-30") as a date, blank as none; anything else is an error message. */
export function parseExemptUntil(text: string | null): { date: Date | null } | { error: string } {
  const t = (text ?? "").trim();
  if (!t) return { date: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return { error: "Enter the certificate's last day as a date." };
  const d = new Date(`${t}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return { error: "Enter the certificate's last day as a date." };
  return { date: d };
}
