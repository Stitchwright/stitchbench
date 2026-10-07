// Thread to match a fabric (shop-features-round-2-design.md 5.3, from the 2.1 thread fields): a thread whose swatch is
// close to the fabric's, or whose color words match the fabric's color tags. Pure: no database, no model.

const HEX = /^#?([0-9a-f]{6})$/i;

function rgb(hex: string | null | undefined): [number, number, number] | null {
  const m = HEX.exec(String(hex ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** How far apart two swatches look (the "redmean" weighting of RGB): 0 the same, about 765 black to white. Null without both. */
export function colorDistance(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return null;
  const r = (x[0] + y[0]) / 2;
  const [dr, dg, db] = [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  return Math.sqrt((2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db);
}

/** Color words that count as the same for matching ("navy" fabric, "blue" thread). */
const KIN: Record<string, string[]> = {
  navy: ["blue", "navy"],
  blue: ["blue", "navy", "aqua", "teal"],
  aqua: ["aqua", "teal", "turquoise", "blue"],
  teal: ["teal", "aqua", "turquoise"],
  cream: ["cream", "ivory", "natural", "ecru", "white"],
  white: ["white", "cream", "ivory"],
  gray: ["gray", "grey", "silver", "charcoal"],
  grey: ["gray", "grey", "silver", "charcoal"],
  brown: ["brown", "tan", "beige", "chocolate"],
  pink: ["pink", "rose", "fuchsia"],
  red: ["red", "cherry", "scarlet", "burgundy"],
  green: ["green", "sage", "olive", "kelly", "lime"],
  yellow: ["yellow", "gold", "lemon"],
  orange: ["orange", "rust", "coral"],
  purple: ["purple", "violet", "lavender", "plum"],
  black: ["black", "charcoal"],
};

const wordsOf = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);

/**
 * How well a thread matches a fabric, or null for no match: a swatch within reach scores by closeness (up to 200), each
 * of the fabric's color tags found among the thread's color words adds 60.
 */
export function threadScore(fabric: { tags: string[]; colorHex: string | null }, thread: { colorHex: string | null; colorName: string | null; description: string }): number | null {
  let score = 0;
  const d = colorDistance(fabric.colorHex, thread.colorHex);
  if (d != null && d <= 120) score += Math.round(200 - d);
  const words = new Set(wordsOf(`${thread.colorName ?? ""} ${thread.description}`));
  for (const tag of fabric.tags.map((t) => t.toLowerCase())) {
    const kin = KIN[tag] ?? [tag];
    if (kin.some((k) => words.has(k))) score += 60;
  }
  return score > 0 ? score : null;
}

export type ThreadHit = { id: string; name: string; colorHex: string | null; qty: number; priceCents: number | null; score: number };

/** The best few threads for a fabric, best first (in stock only: the caller passes threads on the shelf). */
export function bestThreads<T extends { id: string; name: string; colorHex: string | null; colorName: string | null; description: string; qty: number; priceCents: number | null }>(fabric: { tags: string[]; colorHex: string | null }, threads: T[], n = 3): ThreadHit[] {
  return threads
    .map((t) => ({ t, s: threadScore(fabric, t) }))
    .filter((x): x is { t: T; s: number } => x.s != null)
    .sort((a, b) => b.s - a.s || b.t.qty - a.t.qty || a.t.name.localeCompare(b.t.name))
    .slice(0, n)
    .map(({ t, s }) => ({ id: t.id, name: t.name, colorHex: t.colorHex, qty: t.qty, priceCents: t.priceCents, score: s }));
}
