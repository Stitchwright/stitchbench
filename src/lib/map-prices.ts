import "server-only";
// Minimum advertised prices (shop-features-round-2-design.md 9.3, package map-prices). A maker's MAP is the lowest price
// a dealer may advertise (online, in a sale flyer or an email); the price paid in the shop or in the cart can be lower.
// An item or a machine for sale gets its MAP; the online shop then never shows a lower price (it shows the MAP and "Add
// to cart to see our price"; the cart shows the real one), and the checks below name every price that would advertise
// below it: the item's own price online, and each promotion that is on or coming (sale flyers and campaign emails
// advertise those). Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str, toCents } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
import { belowMap } from "@/lib/map-math";
import { bestDiscount, readScope, type Promo, type PromoEffect } from "@/lib/promo-math";
import type { CurrentUser } from "@/lib/session";

const MAX_CENTS = 10_000_000;


/** Sets (or, blank, clears) an item's or a machine's minimum advertised price. Owner or admin, like any price. */
export async function setMapFor(user: CurrentUser, what: "part" | "unit", id: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  if (user.role === "TECH") throw new UserError("Only an owner or admin can change prices.");
  const raw = str(fd.get("map"));
  const cents = raw ? toCents(raw) : null;
  if (raw && (cents == null || cents <= 0 || cents > MAX_CENTS)) throw new UserError("The minimum advertised price: dollars, like 499.00 (blank for none).");
  const where = { id: assertId(id), shopId: user.shopId };
  const r = what === "part" ? await db.part.updateMany({ where, data: { mapCents: cents } }) : await db.stockUnit.updateMany({ where, data: { mapCents: cents } });
  if (!r.count) throw new UserError(what === "part" ? "Item not found." : "Machine not found.");
  return cents == null ? "No minimum advertised price." : `Minimum advertised price $${(cents / 100).toFixed(2)}.`;
}

export type MapProblem = { key: string; href: string; what: string; mapCents: number; priceCents: number; where: string };

/**
 * Every price that would advertise below a MAP: an item listed online for less (the shop shows the MAP there, so it is
 * only a note), any item or machine whose own price is under it, and each promotion on today or later that brings one
 * under it (don't put that price in a flyer or a campaign email).
 */
export async function mapProblems(shopId: string, now = new Date()): Promise<MapProblem[]> {
  const today = ymdOf(now, await shopTimeZone(shopId));
  const [parts, units, promos] = await Promise.all([
    db.part.findMany({ where: { shopId, mapCents: { not: null } }, select: { id: true, partNumber: true, description: true, kind: true, brand: true, priceCents: true, mapCents: true, online: true }, take: 2000 }),
    db.stockUnit.findMany({ where: { shopId, mapCents: { not: null }, status: { in: ["IN_STOCK", "HELD"] } }, select: { id: true, priceCents: true, mapCents: true, machine: { select: { brand: true, model: true } } }, take: 2000 }),
    db.promotion.findMany({ where: { shopId, active: true, lastDay: { gte: today }, effect: { in: ["PERCENT", "AMOUNT"] } }, orderBy: { firstDay: "asc" } }),
  ]);
  const out: MapProblem[] = [];
  const things = [
    ...parts.map((p) => ({ key: `part:${p.id}`, href: `/parts/${p.id}`, what: `${p.partNumber} ${p.description}`, kind: p.kind as string, brand: p.brand, partId: p.id as string | null, priceCents: p.priceCents, mapCents: p.mapCents!, online: p.online })),
    ...units.map((u) => ({ key: `unit:${u.id}`, href: `/units/${u.id}`, what: `${u.machine.brand} ${u.machine.model}`, kind: "UNIT", brand: u.machine.brand, partId: null, priceCents: u.priceCents, mapCents: u.mapCents!, online: false })),
  ];
  for (const t of things) {
    if (t.priceCents == null) continue;
    if (belowMap(t.priceCents, t.mapCents)) out.push({ key: `${t.key}:price`, href: t.href, what: t.what, mapCents: t.mapCents, priceCents: t.priceCents, where: t.online ? 'its price (online it shows the minimum and "Add to cart to see our price")' : "its price: don't advertise it" });
    for (const r of promos) {
      const p: Promo = { id: r.id, name: r.name, effect: r.effect as PromoEffect, value: r.value, scope: readScope(r.scope) };
      const d = bestDiscount([p], { qty: 1, unitPriceCents: t.priceCents, kind: t.kind, brand: t.brand, partId: t.partId });
      if (d && belowMap(t.priceCents - d.cents, t.mapCents)) out.push({ key: `${t.key}:${r.id}`, href: t.href, what: t.what, mapCents: t.mapCents, priceCents: t.priceCents - d.cents, where: `the sale "${r.name}" (${r.firstDay} to ${r.lastDay}): don't put that price in a flyer or an email` });
    }
  }
  return out.slice(0, 200);
}
