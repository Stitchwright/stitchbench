import "server-only";
// Ordering and stock across stores (shop-features-round-2-design.md 7.3): a purchase order's share for another store
// ("Send Florida's share"), reorder suggestions per store or for every store (a combined order keeps each store's
// share), and "Sells faster at Florida": stock that sits here while it sells at another store (a suggestion only;
// nothing moves by itself). Every query by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { activeStores, currentStore, type Store } from "@/lib/stores";
import { otherStoreLevels, qtyAt } from "@/lib/stock";
import { sendStockFor } from "@/lib/transfers";
import { cleanSplit } from "@/lib/fabric-orders";
import { eachSuggestion } from "@/lib/fabric-orders-math";
import { qtyText } from "@/lib/register-math";

/**
 * "Send <store>'s share": the order was received here (the whole box); the lines' shares for that store go on a transfer
 * (as much as came and is on this shelf). Once per order and store (a second one is refused while the first stands).
 */
export async function sendShareFor(user: CurrentUser, orderId: string, storeId: string): Promise<string> {
  const po = await db.purchaseOrder.findFirst({ where: { id: String(orderId), shopId: user.shopId }, include: { lines: true } });
  if (!po) throw new UserError("Order not found.");
  if (po.status !== "RECEIVED" && po.status !== "PARTLY_RECEIVED") throw new UserError(`Order #${po.number} hasn't come in yet.`);
  const stores = await activeStores(user.shopId);
  const to = stores.find((s) => s.id === storeId);
  if (!to) throw new UserError("Store not found.");
  const before = await db.stockTransfer.findFirst({ where: { shopId: user.shopId, poId: po.id, toId: to.id, status: { in: ["SENT", "ARRIVED"] } }, select: { number: true } });
  if (before) throw new UserError(`${to.name}'s share went on transfer ${before.number} already.`);
  const lines = po.lines
    .map((l) => {
      const share = cleanSplit(l.split, Number.MAX_SAFE_INTEGER)[to.id] ?? 0;
      // Fabric ordered in bolts: the share is in the line's unit; bolts become yards.
      const qty = l.unit === "BOLT" ? share * l.boltYards : share;
      return { partId: l.partId, qty: Math.min(qty, l.receivedYards) };
    })
    .filter((l) => l.partId && l.qty > 0);
  if (!lines.length) throw new UserError(`Nothing on order #${po.number} is for ${to.name} (or none of it has come).`);
  const t = await sendStockFor(user, { toId: to.id, lines, poId: po.id, note: `${to.name}'s share of order #${po.number}` });
  return `${to.name}'s share is on its way (transfer ${t.number}).`;
}

export type StoreReorderRow = {
  id: string;
  partNumber: string;
  description: string;
  supplier: string | null;
  unit: string | null;
  /** This store's stock and reorder point (combined: every store's together). */
  qty: number;
  reorderAt: number;
  suggest: number;
  /** Combined: each store's own suggestion. */
  split: Record<string, number>;
};

/**
 * Items sold each at or below their reorder point at one store ("This store") or at any store ("All stores": the
 * suggestions added up, each store's share kept for the order). The main store's reorder point is the item's own; another
 * store's is its own level's. Kits and fabric by the yard aren't here (as on the Reorder tab).
 */
export async function reorderByStore(shopId: string, here: Store, mode: "here" | "all", take = 300): Promise<StoreReorderRow[]> {
  const stores = await activeStores(shopId);
  const parts = await db.part.findMany({
    where: { shopId, consignLinkId: null, kind: { not: "MACHINE" }, OR: [{ unit: null }, { unit: { not: "yd" } }], kitStock: { none: {} } },
    select: { id: true, partNumber: true, description: true, supplier: true, unit: true, qtyOnHand: true, reorderAt: true },
    orderBy: { partNumber: "asc" },
    take: 5000,
  });
  const levels = await otherStoreLevels(shopId, parts.map((p) => p.id));
  const points = await db.stockLevel.findMany({ where: { shopId, reorderAt: { gt: 0 } }, select: { partId: true, locationId: true, reorderAt: true } });
  const pointOf = new Map(points.map((p) => [`${p.partId}|${p.locationId}`, p.reorderAt]));
  const rows: StoreReorderRow[] = [];
  for (const p of parts) {
    const per = (mode === "here" ? [here] : stores).map((s) => {
      const qty = qtyAt(p.qtyOnHand, levels.get(p.id), s);
      const reorderAt = s.main ? p.reorderAt : (pointOf.get(`${p.id}|${s.id}`) ?? 0);
      return { s, qty, reorderAt, suggest: eachSuggestion({ reorderAt, onHand: qty, onOrder: 0 }) };
    });
    const suggest = per.reduce((a, x) => a + x.suggest, 0);
    if (suggest <= 0) continue;
    rows.push({
      id: p.id,
      partNumber: p.partNumber,
      description: p.description,
      supplier: p.supplier?.trim() || null,
      unit: p.unit,
      qty: per.reduce((a, x) => a + x.qty, 0),
      reorderAt: per.reduce((a, x) => a + x.reorderAt, 0),
      suggest,
      split: mode === "all" ? Object.fromEntries(per.filter((x) => x.suggest > 0 && x.s.id !== here.id).map((x) => [x.s.id, x.suggest])) : {},
    });
    if (rows.length >= take) break;
  }
  return rows.sort((a, b) => Number(!a.supplier) - Number(!b.supplier) || (a.supplier ?? "").localeCompare(b.supplier ?? "") || a.partNumber.localeCompare(b.partNumber));
}

/** A store's own bin and reorder point for an item (owner or admin; the main store's are the item's own fields). */
export async function saveStoreLevelFor(user: CurrentUser, partId: string, storeId: string, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only the owner or an admin changes reorder points.");
  const part = await db.part.findFirst({ where: { id: String(partId), shopId: user.shopId }, select: { id: true, unit: true } });
  if (!part) throw new UserError("Item not found.");
  const store = (await activeStores(user.shopId)).find((s) => s.id === storeId);
  if (!store) throw new UserError("Store not found.");
  const raw = String(fd.get("reorderAt") ?? "").trim();
  const reorderAt = raw ? Number(raw) : 0;
  if (!Number.isFinite(reorderAt) || reorderAt < 0 || reorderAt > 100_000) throw new UserError("Reorder at: enter a number, 0 for none.");
  const bin = String(fd.get("bin") ?? "").trim().slice(0, 40) || null;
  if (store.main) {
    await db.part.updateMany({ where: { id: part.id, shopId: user.shopId }, data: { reorderAt, location: bin } });
    return;
  }
  await db.stockLevel.upsert({
    where: { partId_locationId: { partId: part.id, locationId: store.id } },
    create: { shopId: user.shopId, partId: part.id, locationId: store.id, qtyOnHand: 0, reorderAt, bin },
    update: { reorderAt, bin },
  });
}

export type MoveSuggestion = {
  partId: string;
  partNumber: string;
  description: string;
  unit: string | null;
  /** On this store's shelf, and sold here in the window. */
  qtyHere: number;
  soldHere: number;
  to: { id: string; name: string; sold: number };
  weeks: number;
  words: string;
};

/**
 * "Sells faster at Florida store (6 yd in 8 weeks there, none here)": items on this store's shelf that sold more at
 * another store over the last `weeks` weeks (at least twice as much, and at least 2), the best store first. Empty with
 * one store. A suggestion only: "Send it there" fills in a transfer.
 */
export async function moveSuggestionsFor(shopId: string, here: Store | null, o: { weeks?: number; take?: number; fabricOnly?: boolean } = {}, now = new Date()): Promise<MoveSuggestion[]> {
  if (!here) return [];
  const stores = await activeStores(shopId);
  if (stores.length <= 1) return [];
  const weeks = o.weeks ?? 8;
  const since = new Date(now.getTime() - weeks * 7 * 86_400_000);
  const main = stores.find((s) => s.main) ?? stores[0];
  const sold = await db.$queryRaw<{ partId: string; loc: string; sold: number }[]>`
    SELECT m."partId", COALESCE(m."locationId", ${main.id}) AS loc, SUM(-m.qty)::float AS sold
    FROM "StockMove" m
    WHERE m."shopId" = ${shopId} AND m.reason = 'SOLD' AND m."createdAt" >= ${since}
    GROUP BY 1, 2`;
  const byPart = new Map<string, Map<string, number>>();
  for (const r of sold) {
    if (!byPart.has(r.partId)) byPart.set(r.partId, new Map());
    byPart.get(r.partId)!.set(r.loc, Number(r.sold));
  }
  if (!byPart.size) return [];
  const parts = await db.part.findMany({
    where: { shopId, id: { in: [...byPart.keys()] }, consignLinkId: null, ...(o.fabricOnly ? { kind: "FABRIC" as const } : {}) },
    select: { id: true, partNumber: true, description: true, unit: true, qtyOnHand: true },
  });
  const levels = await otherStoreLevels(shopId, parts.map((p) => p.id));
  const out: MoveSuggestion[] = [];
  for (const p of parts) {
    const qtyHere = qtyAt(p.qtyOnHand, levels.get(p.id), here);
    if (qtyHere <= 0) continue;
    const s = byPart.get(p.id)!;
    const soldHere = Math.max(0, s.get(here.id) ?? 0);
    const best = stores
      .filter((x) => x.id !== here.id)
      .map((x) => ({ id: x.id, name: x.name, sold: Math.max(0, s.get(x.id) ?? 0) }))
      .sort((a, b) => b.sold - a.sold)[0];
    if (!best || best.sold < 2 || best.sold < soldHere * 2) continue;
    const amt = (n: number) => qtyText(Math.round(n * 1000) / 1000, p.unit);
    out.push({
      partId: p.id,
      partNumber: p.partNumber,
      description: p.description,
      unit: p.unit,
      qtyHere,
      soldHere,
      to: best,
      weeks,
      words: `Sells faster at ${best.name} (${amt(best.sold)}${p.unit === "yd" ? " yd" : ""} in ${weeks} weeks there, ${soldHere > 0 ? `${amt(soldHere)} here` : "none here"})`,
    });
  }
  return out.sort((a, b) => b.to.sold - a.to.sold).slice(0, o.take ?? 50);
}

/**
 * "Which store gets what" on an order (7.3): each line's share for the other stores (fields split.<lineId>.<storeId>);
 * the rest is for the store that receives the box. Open orders only (a received order's shares are what Send its
 * share uses).
 */
export async function saveSplitFor(user: CurrentUser, orderId: string, fd: FormData): Promise<void> {
  const po = await db.purchaseOrder.findFirst({ where: { id: String(orderId), shopId: user.shopId }, include: { lines: true } });
  if (!po) throw new UserError("Order not found.");
  if (po.status === "CANCELLED") throw new UserError(`Order #${po.number} is cancelled.`);
  const stores = new Set((await activeStores(user.shopId)).map((s) => s.id));
  await db.$transaction(async (tx) => {
    for (const l of po.lines) {
      const typed: Record<string, number> = {};
      for (const [k, v] of fd.entries()) {
        if (!k.startsWith(`split.${l.id}.`) || typeof v !== "string" || !v.trim()) continue;
        const sid = k.slice(`split.${l.id}.`.length);
        if (!stores.has(sid)) throw new UserError("Store not found.");
        const n = Number(v.trim());
        if (!Number.isFinite(n) || n < 0) throw new UserError(`${l.itemNumber}: enter how many, 0 or more.`);
        typed[sid] = n;
      }
      let split: Record<string, number>;
      try {
        split = cleanSplit(typed, l.qty);
      } catch {
        throw new UserError(`${l.itemNumber}: the stores' shares add up to more than the ${l.qty} ordered.`);
      }
      await tx.purchaseOrderLine.update({ where: { id: l.id }, data: { split } });
    }
  });
}

/** The store a person works at, for pages that need one (null with one store). */
export async function hereForPage(user: CurrentUser): Promise<Store | null> {
  const stores = await activeStores(user.shopId);
  return stores.length > 1 ? await currentStore(user) : null;
}
