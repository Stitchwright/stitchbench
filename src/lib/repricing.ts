import "server-only";
// "Raise prices", the margin floor and back orders (shop-features-round-2-design.md 4.4). Raise prices: whose (a supplier,
// a maker, a kind, a collection, or the items under the margin floor), by how much and how rounded; the page shows old
// and new for every item, "Raise them" writes them and keeps the old ones, so Undo puts them back for a day. Margin
// floor: Settings, Selling, "Tell me when an item's margin falls under 40%" (per kind under More choices); the items under
// it show on Inventory and the dashboard with Raise prices pre-filled. Back orders: a purchase order line the supplier
// says is back ordered, with the day it's expected; the Coming in list shows them with who is waiting (tickets waiting
// for the part) and "Let them know" sends the delay. Every query by shopId; owners and admins set prices.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { actorOf, audit } from "@/lib/audit";
import { KIND_LABEL } from "@/lib/parts";
import { floorFor, floorPrice, floorsOf, isRounding, isWhose, marginPct, raised, underFloor, type Floors, type RaiseRule } from "@/lib/repricing-math";

export const UNDO_HOURS = 24;
const MAX_ITEMS = 2000;

function priceSetter(user: CurrentUser) {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can change prices.");
}

/** The choices for "Whose prices": the shop's suppliers, makers, kinds and collections that have priced items. */
export async function raiseChoices(shopId: string): Promise<{ supplier: string[]; brand: string[]; kind: { value: string; label: string }[]; collection: string[]; underFloor: number }> {
  const rows = await db.part.findMany({
    where: { shopId, priceCents: { not: null }, consignLinkId: null, kind: { not: "MACHINE" } },
    select: { supplier: true, brand: true, kind: true, collection: true, priceCents: true, costCents: true },
  });
  const uniq = (xs: (string | null)[]) => [...new Set(xs.map((x) => x?.trim()).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
  const floors = await shopFloors(shopId);
  return {
    supplier: uniq(rows.map((r) => r.supplier)),
    brand: uniq(rows.map((r) => r.brand)),
    kind: [...new Set(rows.map((r) => r.kind))].map((k) => ({ value: k, label: KIND_LABEL[k] ?? k })),
    collection: uniq(rows.map((r) => r.collection)),
    underFloor: rows.filter((r) => underFloor(r, floors)).length,
  };
}

export async function shopFloors(shopId: string): Promise<Floors> {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { marginFloor: true } });
  return floorsOf(s.marginFloor);
}

/** Reads the form's rule; the percent and rounding forgiving, the rest checked. */
export function ruleFrom(a: { whose?: string | null; value?: string | null; pct?: number | null; round?: string | null }): RaiseRule {
  if (!isWhose(a.whose)) throw new UserError("Choose whose prices to raise.");
  const round = isRounding(a.round) ? a.round : "99";
  const value = a.whose === "floor" ? null : (a.value ?? "").trim().slice(0, 120);
  if (a.whose !== "floor" && !value) throw new UserError(`Choose which ${a.whose === "brand" ? "maker" : a.whose}.`);
  const pct = a.whose === "floor" ? 0 : Number(a.pct);
  if (a.whose !== "floor" && !(Number.isFinite(pct) && pct >= 0.5 && pct <= 200)) throw new UserError("Type by how much, like 10 for 10%.");
  return { whose: a.whose, value, pct, round };
}

export type RaiseLine = { partId: string; partNumber: string; description: string; unit: string | null; costCents: number | null; oldCents: number; newCents: number; marginBefore: number | null; marginAfter: number | null };

/** Every item the rule raises, with its old and new price (items whose price wouldn't change are left out). */
export async function previewRaise(shopId: string, rule: RaiseRule): Promise<RaiseLine[]> {
  const where: Prisma.PartWhereInput = { shopId, priceCents: { gt: 0 }, consignLinkId: null, kind: { not: "MACHINE" } };
  const ci = (v: string) => ({ equals: v, mode: "insensitive" as const });
  if (rule.whose === "supplier") where.supplier = ci(rule.value!);
  if (rule.whose === "brand") where.brand = ci(rule.value!);
  if (rule.whose === "collection") where.collection = ci(rule.value!);
  if (rule.whose === "kind") {
    if (!KIND_LABEL[rule.value!]) throw new UserError("Choose a kind from the list.");
    where.kind = rule.value as Prisma.PartWhereInput["kind"];
  }
  if (rule.whose === "floor") where.costCents = { not: null };
  const parts = await db.part.findMany({ where, select: { id: true, partNumber: true, description: true, unit: true, kind: true, costCents: true, priceCents: true }, orderBy: { partNumber: "asc" }, take: MAX_ITEMS + 1 });
  if (parts.length > MAX_ITEMS) throw new UserError(`That's more than ${MAX_ITEMS} items: choose a smaller group.`);
  const floors = rule.whose === "floor" ? await shopFloors(shopId) : null;
  const out: RaiseLine[] = [];
  for (const p of parts) {
    const old = p.priceCents!;
    let next: number;
    if (floors) {
      if (!underFloor(p, floors)) continue;
      next = floorPrice(old, p.costCents!, floorFor(floors, p.kind)!, rule.round);
    } else next = raised(old, rule.pct, rule.round);
    if (next === old) continue;
    out.push({ partId: p.id, partNumber: p.partNumber, description: p.description, unit: p.unit, costCents: p.costCents, oldCents: old, newCents: next, marginBefore: marginPct(old, p.costCents), marginAfter: marginPct(next, p.costCents) });
  }
  return out;
}

/** "Raise them": writes the new prices (an item changed meanwhile is left as it is) and keeps the old ones for Undo. */
export async function applyRaiseFor(user: CurrentUser, rule: RaiseRule, now = new Date()): Promise<{ id: string; count: number }> {
  priceSetter(user);
  await requireBaseWritable(user);
  const lines = await previewRaise(user.shopId, rule);
  if (!lines.length) throw new UserError("No prices to change: nothing matches, or they are already there.");
  const done: { partId: string; oldCents: number; newCents: number }[] = [];
  const change = await db.$transaction(async (tx) => {
    for (const l of lines) {
      const r = await tx.part.updateMany({ where: { id: l.partId, shopId: user.shopId, priceCents: l.oldCents }, data: { priceCents: l.newCents } });
      if (r.count) done.push({ partId: l.partId, oldCents: l.oldCents, newCents: l.newCents });
    }
    return tx.priceChange.create({ data: { shopId: user.shopId, at: now, userId: user.id, rule: rule as unknown as Prisma.InputJsonValue, items: done as unknown as Prisma.InputJsonValue } });
  });
  await audit(db, actorOf(user), { action: "prices.raise", subjectType: "PriceChange", subjectId: change.id, subjectLabel: `${done.length} prices raised` });
  return { id: change.id, count: done.length };
}

/** Undo a raise within a day: each item still at its raised price goes back; one changed since is left and counted. */
export async function undoRaiseFor(user: CurrentUser, id: string, now = new Date()): Promise<{ back: number; left: number }> {
  priceSetter(user);
  await requireBaseWritable(user);
  const c = typeof id === "string" ? await db.priceChange.findFirst({ where: { id, shopId: user.shopId } }) : null;
  if (!c) throw new UserError("Price change not found.");
  if (c.undoneAt) throw new UserError("That raise was undone already.");
  if (now.getTime() - c.at.getTime() > UNDO_HOURS * 3_600_000) throw new UserError("A raise can be undone for a day. Raise or lower those prices on the items themselves.");
  const items = c.items as unknown as { partId: string; oldCents: number; newCents: number }[];
  let back = 0;
  await db.$transaction(async (tx) => {
    const r = await tx.priceChange.updateMany({ where: { id: c.id, shopId: user.shopId, undoneAt: null }, data: { undoneAt: now } });
    if (!r.count) throw new UserError("That raise was undone already.");
    for (const i of items) {
      const u = await tx.part.updateMany({ where: { id: i.partId, shopId: user.shopId, priceCents: i.newCents }, data: { priceCents: i.oldCents } });
      back += u.count;
    }
  });
  await audit(db, actorOf(user), { action: "prices.undo", subjectType: "PriceChange", subjectId: c.id, subjectLabel: `${back} prices put back` });
  return { back, left: items.length - back };
}

/** The shop's raises, newest first, with whether Undo still works. */
export async function recentRaises(shopId: string, now = new Date()) {
  const rows = await db.priceChange.findMany({ where: { shopId }, orderBy: { at: "desc" }, take: 20 });
  return rows.map((r) => ({ id: r.id, at: r.at, rule: r.rule as unknown as RaiseRule, count: (r.items as unknown[]).length, undoneAt: r.undoneAt, canUndo: !r.undoneAt && now.getTime() - r.at.getTime() <= UNDO_HOURS * 3_600_000 }));
}

/** Saves the floors: one for every item ("" turns it off) and, under More choices, one per kind ("" uses the shop's). */
export async function saveFloorsFor(user: CurrentUser, fd: FormData): Promise<void> {
  priceSetter(user);
  const read = (k: string): number | null => {
    const raw = String(fd.get(k) ?? "").replace(/[%\s]/g, "");
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 95) throw new UserError("A margin floor is a percent from 1 to 95, like 40.");
    return Math.round(n);
  };
  const out: Record<string, number> = {};
  const all = read("floor_all");
  if (all != null) out.all = all;
  for (const k of Object.keys(KIND_LABEL)) {
    if (!fd.has(`floor_${k}`)) continue;
    const v = read(`floor_${k}`);
    if (v != null) out[k] = v;
  }
  await db.shop.update({ where: { id: user.shopId }, data: { marginFloor: Object.keys(out).length ? out : ({} as Prisma.InputJsonValue) } });
  await audit(db, actorOf(user), { action: "prices.floor", subjectType: "Shop", subjectId: user.shopId, subjectLabel: out.all != null ? `Margin floor ${out.all}%` : "Margin floor by kind" });
}

/** How many items are under their floor (the notice on Inventory and the dashboard); 0 when the floor is off. */
export async function underFloorCount(shopId: string): Promise<number> {
  const floors = await shopFloors(shopId);
  if (Object.values(floors).every((v) => v == null)) return 0;
  const rows = await db.part.findMany({ where: { shopId, priceCents: { gt: 0 }, costCents: { not: null }, consignLinkId: null, kind: { not: "MACHINE" } }, select: { priceCents: true, costCents: true, kind: true } });
  return rows.filter((r) => underFloor(r, floors)).length;
}
