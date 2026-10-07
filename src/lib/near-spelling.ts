// Near spellings for the customer search (ease-of-use.md 6: "dorthy" finds Dorothy). Pure, so the unit tests and the
// server share it; src/lib/customer-search.ts asks the database for the candidates.

/** Edit distance with a swap of two neighbouring letters counted as one edit ("dorthy" / "dorohty"). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** The words of a name or a search, lower case, letters and digits only. */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/'/g, ""))
    .filter(Boolean);
}

/** How many slips a typed word may have: none for 1-3 letters, one for 4-5, two from 6. */
function slips(word: string) {
  return word.length <= 3 ? 0 : word.length <= 5 ? 1 : 2;
}

/** A typed word is close to a word of the name: the same give or take a slip or two, or the start of it ("dor" / "dorothy"). */
function wordNear(typed: string, nameWord: string) {
  if (nameWord.startsWith(typed)) return true;
  const allowed = slips(typed);
  if (!allowed) return false;
  if (editDistance(typed, nameWord) <= allowed) return true;
  // A word typed part way, with a slip ("dorth" for "Dorothy"): the start of the name word, as long as the typed word.
  // A letter left out counts as one slip, so the start one letter longer is tried too ("dorth" / "doroth").
  return nameWord.length > typed.length && [0, 1].some((extra) => editDistance(typed, nameWord.slice(0, typed.length + extra)) <= 1);
}

/** Every word typed is near some word of the name ("dorthy mill" finds "Dorothy Miller"). */
export function nameNear(name: string, typed: string): boolean {
  const want = words(typed);
  if (!want.length || want.every((w) => w.length < 3)) return false;
  const have = words(name);
  return want.every((w) => have.some((h) => wordNear(w, h)));
}

/** The two-letter word starts the database narrows the candidates by (a slip in the first two letters is rare). */
export function searchPrefixes(typed: string): string[] {
  return [...new Set(words(typed).filter((w) => w.length >= 3).map((w) => w.slice(0, 2)))];
}

/** A name as the database narrows on it: a space, then its words with a space between ("O'Brien, Ruth" / " obrien ruth"). */
export function spacedWords(name: string): string {
  return ` ${words(name).join(" ")}`;
}

/** The LIKE patterns for the database: some word of the name starts with one of the typed words' two-letter starts. */
export function prefixPatterns(typed: string): string[] {
  return searchPrefixes(typed).map((p) => `% ${p}%`);
}
