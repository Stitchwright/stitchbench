// What may leave the shop in an Assistant request (ai-assistant-scope.md 2.4). Pure: no "server-only", no database, safe in
// client components and the check scripts (scripts/checks/assistant.check.ts holds a dozen shapes).
//
// Structured customer fields are never read into a request at all; this scrubs the free text a tech typed (the problem,
// the shorthand, a note), where a name or a phone number can slip in: email addresses, phone numbers, the ticket's
// customer, the trade account, the shop's known customers (whole names) and a machine's serial become placeholders.

export type Redaction = {
  /** Names to blank out wherever they appear as whole words: the ticket's customer and trade account, and every customer's full name. */
  names?: readonly string[];
  /** Serial numbers that must not travel (a plate photo is the only way one goes). */
  serials?: readonly string[];
};

export const CUSTOMER_MARK = "[customer]";
export const SERIAL_MARK = "[serial]";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const EMAIL = /[^\s@<>"',;()[\]]+@[^\s@<>"',;()[\]]+\.[A-Za-z]{2,}/g;
// 7+ digits with separators between them (spaces, dashes, dots, brackets, a leading +), as a phone number is written ...
const PHONE_SEPARATED = /(?<![\w.])\+?\(?\d[\d\s().-]{5,}\d(?![\w])/g;
// ... or a bare run of 10 or 11 digits (a shorter bare number is a part or model number).
const PHONE_BARE = /(?<![\w.])\d{10,11}(?![\w])/g;

const digits = (s: string) => s.replace(/\D/g, "").length;

export function redact(text: string | null | undefined, r: Redaction = {}): string {
  let out = String(text ?? "");
  if (!out) return out;
  out = out.replace(EMAIL, CUSTOMER_MARK);
  out = out.replace(PHONE_SEPARATED, (m) => (digits(m) >= 7 && digits(m) <= 15 && /[\s().+-]/.test(m.trim()) ? CUSTOMER_MARK : m));
  out = out.replace(PHONE_BARE, CUSTOMER_MARK);
  for (const n of uniqueLongestFirst(r.names)) {
    // Whole words only, spaces in the name matching any run of spaces; a name with punctuation still matches itself.
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n).replace(/\\? +/g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, CUSTOMER_MARK);
  }
  for (const s of uniqueLongestFirst(r.serials)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, SERIAL_MARK);
  }
  return out;
}

function uniqueLongestFirst(list: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const t = String(raw ?? "").trim().replace(/\s+/g, " ");
    // Under 3 characters would blank half the sentence ("Li", "Jo" are real names, but "a" and "to" are words).
    if (t.length >= 3) seen.add(t);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/**
 * The names to blank for one ticket: its customer (full name, first and last words on their own when long enough to be
 * names rather than words) and trade account, plus every customer's full name in the company.
 */
export function namesToBlank(o: { customer?: string | null; account?: string | null; allCustomers?: readonly string[] }): string[] {
  const out: string[] = [];
  for (const full of [o.customer, o.account]) {
    const t = String(full ?? "").trim();
    if (!t) continue;
    out.push(t);
    if (full === o.customer) for (const w of t.split(/\s+/)) if (w.length >= 3) out.push(w);
  }
  for (const n of o.allCustomers ?? []) if (String(n ?? "").trim().includes(" ")) out.push(n);
  return out;
}

/** The answer as logged: a serial replaced by [serial] wherever it appears (design 1.3 and decision 4). */
export function maskSerials(text: string, serials: readonly (string | null | undefined)[]): string {
  let out = String(text ?? "");
  for (const s of uniqueLongestFirst(serials.filter((x): x is string => !!x))) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, "giu"), SERIAL_MARK);
  }
  return out;
}
