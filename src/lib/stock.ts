import "server-only";
// Stock per store (shop-features-round-2-design.md 7.2). Part.qtyOnHand is the company's total, kept in the same
// transaction as every change, so every reader that wants the total keeps working. A store other than the main one has
// its own StockLevel row; the main store's stock is the total less every other store's. So for a company with one
// store nothing changes at all: these helpers only touch Part.qtyOnHand and StockMove, as before.
//
// Every write to stock goes through here with the store it happens at (null = the main store).
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isMainStoreId } from "@/lib/stores";
import { UserError } from "@/lib/user-error";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof db;
type MoveReason = "RECEIVED" | "USED" | "RETURNED" | "ADJUSTED" | "SOLD" | "CONSIGNED" | "CUT" | "HELD" | "TRANSFER";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Adds `delta` (+ in, - out) to a store's own level; the main store has none (it is the total less the others). */
async function levelDelta(tx: Db, shopId: string, partId: string, locationId: string | null | undefined, delta: number) {
  if (!delta || (await isMainStoreId(tx, shopId, locationId))) return;
  await tx.stockLevel.upsert({
    where: { partId_locationId: { partId, locationId: locationId! } },
    create: { shopId, partId, locationId: locationId!, qtyOnHand: r3(delta) },
    update: { qtyOnHand: { increment: delta } },
  });
}

/** How many a store has of an item (the main store: the total less the other stores'). */
export async function storeQty(tx: Db, shopId: string, partId: string, locationId: string | null | undefined): Promise<number> {
  if (await isMainStoreId(tx, shopId, locationId)) {
    const [part, others] = await Promise.all([
      tx.part.findFirst({ where: { id: partId, shopId }, select: { qtyOnHand: true } }),
      tx.stockLevel.aggregate({ where: { shopId, partId }, _sum: { qtyOnHand: true } }),
    ]);
    return r3((part?.qtyOnHand ?? 0) - (others._sum.qtyOnHand ?? 0));
  }
  const l = await tx.stockLevel.findUnique({ where: { partId_locationId: { partId, locationId: locationId! } }, select: { qtyOnHand: true, shopId: true } });
  return l && l.shopId === shopId ? l.qtyOnHand : 0;
}

/**
 * Stock in or out at a store: the item's total and the store's own level change together. Unguarded (a sale may take
 * the shelf below zero, as today). Use moveStock to write the history line too.
 */
export async function changeStock(tx: Db, shopId: string, partId: string, locationId: string | null | undefined, delta: number, partData: Prisma.PartUpdateManyMutationInput = {}): Promise<void> {
  await tx.part.updateMany({ where: { id: partId, shopId }, data: { ...partData, qtyOnHand: { increment: delta } } });
  await levelDelta(tx, shopId, partId, locationId, delta);
}

/**
 * Takes `qty` off a store's shelf only if the store has that many (the cut, the kit build, a transfer sent): false when
 * it hasn't. The item's row is locked first, so two takes at once can't both pass.
 */
export async function takeStockIfThere(tx: Tx, shopId: string, partId: string, locationId: string | null | undefined, qty: number): Promise<boolean> {
  const rows = await tx.$queryRaw<{ qtyOnHand: number }[]>`SELECT "qtyOnHand" FROM "Part" WHERE id = ${partId} AND "shopId" = ${shopId} FOR UPDATE`;
  if (!rows.length) return false;
  const have = await storeQty(tx, shopId, partId, locationId);
  if (have + 1e-9 < qty) return false;
  await changeStock(tx, shopId, partId, locationId, -qty);
  return true;
}

export type MoveInput = {
  shopId: string;
  partId: string;
  locationId: string | null | undefined;
  qty: number; // + in, - out
  reason: MoveReason;
  userId?: string | null;
  note?: string | null;
  ticketId?: string | null;
  otherPartId?: string | null;
  createdAt?: Date;
  partData?: Prisma.PartUpdateManyMutationInput;
};

/** Stock in or out at a store with its history line (StockMove, with the store). */
export async function moveStock(tx: Db, m: MoveInput): Promise<void> {
  await changeStock(tx, m.shopId, m.partId, m.locationId, m.qty, m.partData);
  await tx.stockMove.create({
    data: {
      shopId: m.shopId,
      partId: m.partId,
      locationId: m.locationId ?? null,
      qty: m.qty,
      reason: m.reason,
      userId: m.userId ?? null,
      note: m.note ?? null,
      ticketId: m.ticketId ?? null,
      otherPartId: m.otherPartId ?? null,
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    },
  });
}

/**
 * A new item made with stock already on a store's shelf (received, imported, cut, a trade-in): Part.qtyOnHand was set
 * to `qty` when the item was made; another store than the main one gets its level so the main store's stays 0.
 */
export async function placeNewStock(tx: Db, shopId: string, partId: string, locationId: string | null | undefined, qty: number): Promise<void> {
  await levelDelta(tx, shopId, partId, locationId, qty);
}

/**
 * Sets a store's stock to what was counted (the count screen, an adjustment): the change is worked out from the stock
 * at that moment (the item's row is locked) and written with the store. Returns the change (0 when it matched).
 */
export async function countAtStore(tx: Tx, m: { shopId: string; partId: string; locationId: string | null | undefined; counted: number; userId?: string | null; note: string; reason?: MoveReason; createdAt?: Date }): Promise<number> {
  const rows = await tx.$queryRaw<{ qtyOnHand: number }[]>`SELECT "qtyOnHand" FROM "Part" WHERE id = ${m.partId} AND "shopId" = ${m.shopId} FOR UPDATE`;
  if (!rows.length) throw new UserError("Part not found.");
  const have = await storeQty(tx, m.shopId, m.partId, m.locationId);
  const change = r3(m.counted - have);
  if (change === 0) return 0;
  await moveStock(tx, { shopId: m.shopId, partId: m.partId, locationId: m.locationId, qty: change, reason: m.reason ?? "ADJUSTED", userId: m.userId, note: m.note, createdAt: m.createdAt });
  return change;
}

export type StoreQty = { locationId: string | null; qty: number };

/**
 * Each item's stock at every store that isn't the main one (partId -> locationId -> qty), for the items asked about.
 * Empty for a company with one store (no StockLevel rows).
 */
export async function otherStoreLevels(shopId: string, partIds: string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!partIds.length) return out;
  const rows = await db.stockLevel.findMany({ where: { shopId, partId: { in: [...new Set(partIds)] } }, select: { partId: true, locationId: true, qtyOnHand: true } });
  for (const r of rows) {
    if (!out.has(r.partId)) out.set(r.partId, new Map());
    out.get(r.partId)!.set(r.locationId, r.qtyOnHand);
  }
  return out;
}

/**
 * An item's stock at one store from its total and the other stores' levels (from otherStoreLevels): the main store's
 * is the total less the others.
 */
export function qtyAt(total: number, levels: Map<string, number> | undefined, store: { id: string; main: boolean } | null | undefined): number {
  if (!store || store.main) {
    let others = 0;
    for (const q of levels?.values() ?? []) others += q;
    return r3(total - others);
  }
  return levels?.get(store.id) ?? 0;
}

/** Rewrites each item's qtyOnHand to the given store's (for screens that show "in this store" where they showed the total). */
export async function withStoreQty<T extends { id: string; qtyOnHand: number }>(shopId: string, items: T[], store: { id: string; main: boolean } | null | undefined): Promise<(T & { totalQty: number })[]> {
  if (!store) return items.map((i) => ({ ...i, totalQty: i.qtyOnHand }));
  const levels = await otherStoreLevels(shopId, items.map((i) => i.id));
  if (!levels.size && store.main) return items.map((i) => ({ ...i, totalQty: i.qtyOnHand }));
  return items.map((i) => ({ ...i, totalQty: i.qtyOnHand, qtyOnHand: qtyAt(i.qtyOnHand, levels.get(i.id), store) }));
}
