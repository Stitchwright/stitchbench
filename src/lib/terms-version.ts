// Versions of StitchHub's Terms of Service and Privacy Policy (the hub's src/terms.mjs; docs/legal/README.md section 1):
// YYYY-MM-DD, the day a version comes into force, YYYY-MM-DD.2 for a second one that day, with "-draft" on the end while
// it is a draft for the lawyer. Compared the way the hub compares them.
const VERSION = /^(\d{4}-\d{2}-\d{2})(?:\.(\d{1,2}))?(-draft)?$/;

function rank(v: unknown): [string, number, number] | null {
  const m = VERSION.exec(typeof v === "string" ? v : "");
  if (!m) return null;
  const at = new Date(`${m[1]}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== m[1]) return null;
  return [m[1], Number(m[2] ?? 1), m[3] ? 0 : 1];
}

/** A version string as the hub names one. */
export function validTermsVersion(v: unknown): v is string {
  return rank(v) !== null;
}

/** -1, 0 or 1. Something that isn't a version (null, an old word) is older than any version. */
export function compareTermsVersions(a: unknown, b: unknown): number {
  const x = rank(a);
  const y = rank(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** A draft, not yet in force: the hub's pages say so in a banner. */
export function isDraftTerms(v: string | null | undefined): boolean {
  return typeof v === "string" && v.endsWith("-draft");
}
