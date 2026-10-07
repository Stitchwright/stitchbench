// Thread match from a photo (shop-features-round-2-design.md 9.10): how close two colors look (CIE76 in Lab), and the
// shop's threads ranked against a color the Assistant read off the photo. Pure. The program does the matching; the model
// only reads the picture.

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToLab([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  // D65
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** How different two colors look: 0 the same, about 2 just noticeable, 10 clearly different. Null for a bad value. */
export function colorDistance(a: string, b: string): number | null {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return null;
  const [l1, a1, b1] = rgbToLab(x);
  const [l2, a2, b2] = rgbToLab(y);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/** The words for a distance, for the screen. */
export const closeness = (d: number) => (d < 5 ? "very close" : d < 12 ? "close" : d < 22 ? "near" : "the nearest we have");

/**
 * The closest candidates to a color: on the shelf first unless one out of stock is much closer, at most `take`. Each
 * candidate carries its swatch color (Part.colorHex); one without a swatch can't be matched.
 */
export function rankByColor<T extends { colorHex: string | null; qtyOnHand: number }>(hex: string, items: T[], take = 5): (T & { distance: number })[] {
  return items
    .map((i) => ({ ...i, distance: i.colorHex ? colorDistance(hex, i.colorHex) : null }))
    .filter((i): i is T & { distance: number } => i.distance != null)
    .sort((a, b) => a.distance + (a.qtyOnHand > 0 ? 0 : 6) - (b.distance + (b.qtyOnHand > 0 ? 0 : 6)))
    .slice(0, take);
}
