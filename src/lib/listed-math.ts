// "Listed elsewhere" and sales commissions (shop-features-round-2-design.md 9.7). Pure: the register, the pages and the
// server share it.

export type Listed = { where: string; url: string | null };
export const LISTED_PLACES = ["eBay", "Etsy", "Facebook Marketplace", "Craigslist", "Their own website"] as const;

/** The JSON column, cleaned: each place once, its link if it is a web address. */
export function readListed(raw: unknown): Listed[] {
  if (!Array.isArray(raw)) return [];
  const out: Listed[] = [];
  for (const x of raw) {
    const where = typeof (x as Listed)?.where === "string" ? (x as Listed).where.trim().slice(0, 40) : "";
    if (!where || out.some((o) => o.where.toLowerCase() === where.toLowerCase())) continue;
    const url = typeof (x as Listed)?.url === "string" && /^https:\/\/[^\s]{3,300}$/i.test((x as Listed).url!) ? (x as Listed).url : null;
    out.push({ where, url });
  }
  return out.slice(0, 6);
}

/** "eBay and Etsy". */
export function placesText(l: Listed[]): string {
  const n = l.map((x) => x.where);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

export type CommissionRule = { pct: number; on: "machines" | "all" };

/** A person's rule as saved ({} or anything unreadable: none). */
export function readCommission(raw: unknown): CommissionRule | null {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pct = Number(o.pct);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
  return { pct, on: o.on === "all" ? "all" : "machines" };
}

/** The commission on a base (cents), rounded to the cent. */
export const commissionOn = (baseCents: number, rule: CommissionRule | null) => (rule ? Math.round((baseCents * rule.pct) / 100) : 0);
