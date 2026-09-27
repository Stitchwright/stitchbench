// Sign-in names are email-shaped, and every account is made and signed in under the same rule, so a login that was
// created can always sign in. A shop PC's logins needn't be real mailboxes: owner@myshop is fine.

/** Trimmed and lower-case: how an email is stored and looked up. */
export function normalizeEmail(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

/** something@something, no spaces (what a browser's email field allows). */
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email);
}

export const EMAIL_HELP = "Enter the email as name@something, with no spaces.";
