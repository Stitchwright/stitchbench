// Gift card numbers (later-round-1-design.md 2.4). Pure: no "server-only", no database, so the register (browser) and the
// server read a typed or scanned number the same way.
//
// A new number is "GC-" and 12 random Crockford base32 characters (no I, L, O or U; 60 bits) and one check character:
// hard to guess, easy to read over the phone, and a mistyped character is caught before anything is looked up.
// A pre-printed blank card keeps the number printed on it (6 to 24 letters and digits).

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BODY = 12;

/** Odd weights are invertible mod 32, so any single wrong character, and most swaps of two, change the check character. */
function checkChar(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += ALPHABET.indexOf(body[i]) * (2 * i + 1);
  return ALPHABET[sum % 32];
}

/** "GC-XXXX-XXXX-XXXX-C" from 12 body characters. */
function format(body: string): string {
  return `GC-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${checkChar(body)}`;
}

/** A new random number. Works in Node and in a browser (Web Crypto). */
export function newGiftCardNumber(): string {
  const bytes = new Uint8Array(BODY);
  crypto.getRandomValues(bytes);
  // 256 is a multiple of 32, so taking the low five bits is uniform.
  return format(Array.from(bytes, (b) => ALPHABET[b & 31]).join(""));
}

/** Crockford reads O as 0 and I or L as 1, so a number read over the phone still fits. */
const crockford = (s: string) => s.replace(/O/g, "0").replace(/[IL]/g, "1");

export type ParsedNumber =
  | { kind: "gc"; number: string }
  /** Looks like one of ours but a character is wrong. */
  | { kind: "gc-bad" }
  /** A pre-printed card's own number. */
  | { kind: "printed"; number: string }
  | { kind: "none" };

/**
 * What was typed or scanned. Spaces, dashes and case don't matter. A "GC" number whose check character is wrong is
 * "gc-bad" (the page says so instead of "not found"); anything else of 6 to 24 letters and digits is a printed number.
 */
export function parseCardNumber(input: string | null | undefined): ParsedNumber {
  const raw = String(input ?? "")
    .toUpperCase()
    .replace(/[\s-]+/g, "");
  if (!/^[A-Z0-9]{6,24}$/.test(raw)) return { kind: "none" };
  if (raw.startsWith("GC") && raw.length === 2 + BODY + 1) {
    const rest = crockford(raw.slice(2));
    if (![...rest].every((c) => ALPHABET.includes(c))) return { kind: "gc-bad" };
    const body = rest.slice(0, BODY);
    return checkChar(body) === rest[BODY] ? { kind: "gc", number: format(body) } : { kind: "gc-bad" };
  }
  return { kind: "printed", number: raw };
}

/** True for what the register's scan box should hand to the gift card tools instead of looking for an item. */
export const looksLikeGiftCard = (code: string) => /^GC-?[0-9A-Z]{4}-?[0-9A-Z]{4}-?[0-9A-Z]{4}-?[0-9A-Z]$/i.test(code.trim());

/** The last four characters, for lists (a full number is only shown where someone looks a card up). */
export const lastFour = (number: string) => number.replace(/-/g, "").slice(-4);

/** A card a sale made, loaded, paid out or gave as store credit: what the register offers to print. */
export type Issued = { cardId: string; number: string; kind: "gift" | "credit"; amountCents: number; what: "sold" | "loaded" | "credit" | "paid-out" };

export const GIFT_MIN_CENTS = 500;
export const GIFT_MAX_CENTS = 50_000;
