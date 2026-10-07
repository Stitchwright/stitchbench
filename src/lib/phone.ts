// Phone numbers and email addresses as messages need them (scheduling-messaging-design.md section 4.1). Pure.

/**
 * E.164 for a typed number: a NANP number (10 digits, or 1 + 10, area and exchange starting 2-9) becomes +1...; a number
 * typed with "+" and 8-15 digits is kept; anything else is null.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/[\s().-]/g, "");
    if (!/^\d{8,15}$/.test(digits)) return null;
    if (digits.startsWith("1") && digits.length === 11 && !/^1[2-9]\d\d[2-9]\d{6}$/.test(digits)) return null;
    return `+${digits}`;
  }
  const digits = s.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10 || !/^[2-9]\d\d[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

/**
 * What was typed in a customer search, as the new customer's name or phone: a phone when it is only digits and the
 * marks a phone number is written with ("555-0142", "(555) 123 4567", "+1 555..."), at least 4 digits; otherwise a name
 * ("Apt 4 Smith", "Ruth 2nd" stay names).
 */
export function nameOrPhone(typed: string): { name: string; phone: string } {
  const t = typed.trim();
  return /^\+?[\d\s().-]+$/.test(t) && t.replace(/\D/g, "").length >= 4 ? { name: "", phone: t } : { name: t, phone: "" };
}

/** "+15551234567" -> "(555) 123-4567"; other numbers as they are. */
export function fmtPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

const EMAIL = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A single, plain address: trimmed, lower-cased, at most 254 characters, no commas, quotes, angle brackets, spaces or CR/LF. */
export function validEmail(s: string | null | undefined): string | null {
  if (!s) return null;
  const v = String(s).trim().toLowerCase();
  if (!v || v.length > 254 || !EMAIL.test(v)) return null;
  return v;
}

// Canada, then the Caribbean and Bermuda (NANPA; check the current list and add new overlay codes for these regions).
export const NON_US_NANP: ReadonlySet<string> = new Set([
  ...["204", "226", "236", "249", "250", "257", "263", "289", "306", "343", "354", "365", "367", "368", "382", "403", "416", "418", "428", "431", "437", "438", "450", "460", "468", "474", "506"],
  ...["514", "519", "548", "579", "581", "584", "587", "600", "604", "613", "622", "639", "647", "672", "683", "705", "709", "742", "753", "778", "780", "782", "807", "819", "825", "867", "873", "879", "902"],
  ...["905", "942"],
  ...["242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664", "721", "758", "767", "784", "809", "829", "849", "868", "869", "876"],
]);

/** A US mobile-shaped number marketing texts may go to: +1 and ten digits, with an area code that isn't Canadian or Caribbean. */
export function usMarketingNumber(e164: string): boolean {
  const m = /^\+1(\d{3})\d{7}$/.exec(e164);
  return !!m && !NON_US_NANP.has(m[1]);
}

export const MAINLAND_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles"];

/** The zones a marketing text must fit quiet hours in: 907 Alaska, 808 Hawaii, any other US number every mainland zone, else none. */
export function recipientZones(e164: string): string[] {
  const m = /^\+1(\d{3})\d{7}$/.exec(e164);
  if (!m || NON_US_NANP.has(m[1])) return [];
  if (m[1] === "907") return ["America/Anchorage"];
  if (m[1] === "808") return ["Pacific/Honolulu"];
  return MAINLAND_ZONES;
}
