import "server-only";
// More than one store inside one company (shop-features-round-2-design.md section 7.1). The main store keeps its
// address, phone, time zone, tax rate, hours and receipt line on the Shop row, as before; every other store keeps its
// own on its Location row. A row whose locationId is null belongs to the main store, so a company with one store (and a
// company made before this, or without a Location row yet) works exactly as it did. With one store nothing here shows:
// no store pickers, no store names, no extra words.
import { cache } from "react";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";

type Db = Prisma.TransactionClient | typeof db;

export type Store = {
  id: string;
  name: string;
  main: boolean;
  active: boolean;
  address: string | null;
  phone: string | null;
  timeZone: string;
  taxRatePct: number;
  hours: string | null;
  receiptFooter: string | null;
  dailyAt: string | null;
  approveRefundCents: number | null;
  approveDiscountPct: number | null;
  sortOrder: number;
};

/** The cookie that remembers which store this device is at (picked once per device, 7.1). */
export const STORE_COOKIE = "sb_store";

const SHOP_FIELDS = { name: true, address: true, phone: true, timeZone: true, taxRatePct: true, hoursNote: true, receiptNote: true } as const;

/** Every store of the company, main first, then in order (closed ones too, marked). Read once per request. */
export const storesOf = cache(async (shopId: string): Promise<Store[]> => loadStores(db, shopId));

export async function loadStores(client: Db, shopId: string): Promise<Store[]> {
  const [rows, shop] = await Promise.all([
    client.location.findMany({ where: { shopId }, orderBy: [{ main: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }] }),
    client.shop.findUnique({ where: { id: shopId }, select: SHOP_FIELDS }),
  ]);
  if (!shop) return [];
  return rows.map((r) => {
    mainCache.set(r.id, { shopId: r.shopId, main: r.main });
    // The main store's details are the company's own (Settings -> Shop), so nothing changes for a one-store company.
    return r.main
      ? { id: r.id, name: r.name, main: true, active: true, address: shop.address, phone: shop.phone, timeZone: shop.timeZone, taxRatePct: shop.taxRatePct, hours: shop.hoursNote, receiptFooter: shop.receiptNote, dailyAt: r.dailyAt, approveRefundCents: r.approveRefundCents, approveDiscountPct: r.approveDiscountPct, sortOrder: r.sortOrder }
      : { id: r.id, name: r.name, main: false, active: r.active, address: r.address, phone: r.phone, timeZone: r.timeZone, taxRatePct: r.taxRatePct, hours: r.hours, receiptFooter: r.receiptFooter, dailyAt: r.dailyAt, approveRefundCents: r.approveRefundCents, approveDiscountPct: r.approveDiscountPct, sortOrder: r.sortOrder };
  });
}

/** The open stores, main first. */
export async function activeStores(shopId: string): Promise<Store[]> {
  return (await storesOf(shopId)).filter((s) => s.active);
}

/** More than one open store: only then do store names, pickers and per-store words show anywhere. */
export async function isMultiStore(shopId: string): Promise<boolean> {
  return (await activeStores(shopId)).length > 1;
}

// Location id -> { shop, main }: a store's main flag never changes, so it is safe to remember for the process.
const mainCache = new Map<string, { shopId: string; main: boolean }>();

/** Whether a locationId means the main store (null always does). */
export async function isMainStoreId(client: Db, shopId: string, locationId: string | null | undefined): Promise<boolean> {
  if (!locationId) return true;
  let hit = mainCache.get(locationId);
  if (!hit) {
    const row = await client.location.findUnique({ where: { id: locationId }, select: { shopId: true, main: true } });
    if (!row) return true;
    hit = { shopId: row.shopId, main: row.main };
    mainCache.set(locationId, hit);
  }
  if (hit.shopId !== shopId) throw new UserError("Store not found.");
  return hit.main;
}

/** The main store's row (made from the company's details when the company has none yet). */
export async function ensureMainStore(client: Db, shopId: string): Promise<{ id: string; name: string }> {
  const have = await client.location.findFirst({ where: { shopId, main: true }, select: { id: true, name: true } });
  if (have) return have;
  const shop = await client.shop.findUniqueOrThrow({ where: { id: shopId }, select: { address: true, phone: true, timeZone: true, taxRatePct: true, receiptNote: true } });
  const made = await client.location.create({
    data: { shopId, name: "Main store", main: true, address: shop.address, phone: shop.phone, timeZone: shop.timeZone, taxRatePct: shop.taxRatePct, receiptFooter: shop.receiptNote },
    select: { id: true, name: true },
  });
  // Rows made before the store existed belong to it (null already means the main store; this just names it).
  await client.user.updateMany({ where: { shopId, locationId: null }, data: { locationId: made.id } });
  return made;
}

/** The main store's id, or null when the company has no Location row yet (then null means it everywhere). */
export async function mainStoreId(shopId: string): Promise<string | null> {
  return (await storesOf(shopId)).find((s) => s.main)?.id ?? null;
}

/**
 * A where-fragment for rows of one store: the main store's are its id or null (rows from before stores existed, and
 * from a company with one store). Spread it into a where: { shopId, ...atStore(store) }.
 */
export type StoreWhere = { locationId?: string; AND?: { OR: ({ locationId: string } | { locationId: null })[] }[] };

export function atStore(store: { id: string; main: boolean } | null | undefined): StoreWhere {
  if (!store) return {};
  if (store.main) return { AND: [{ OR: [{ locationId: store.id }, { locationId: null }] }] };
  return { locationId: store.id };
}

/** As atStore, by id (null or the main id = the main store). */
export async function atStoreId(shopId: string, locationId: string | null | undefined) {
  if (!locationId) return atStore({ id: (await mainStoreId(shopId)) ?? "", main: true });
  const s = (await storesOf(shopId)).find((x) => x.id === locationId);
  if (!s) throw new UserError("Store not found.");
  return atStore(s);
}

/** Who is asking, as far as the store goes: the signed-in user, perhaps with the store already decided. */
export type StoreWho = { id?: string; shopId: string; locationId?: string | null };

async function cookieStoreId(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()).get(STORE_COOKIE)?.value ?? null;
  } catch {
    return null; // not in a request (a check script, a worker)
  }
}

/**
 * The store this person is working at now: a store already decided for them (a check, a worker: `locationId`), else the
 * one this device picked (the cookie), else their home store, else the main store. Null only for a company with no
 * Location row (one store, never set up): null means the main store everywhere.
 */
export async function currentStore(who: StoreWho): Promise<Store | null> {
  const stores = await storesOf(who.shopId);
  if (!stores.length) return null;
  const open = stores.filter((s) => s.active);
  const main = stores.find((s) => s.main) ?? open[0] ?? stores[0];
  if (open.length <= 1) return main;
  if (who.locationId !== undefined) return stores.find((s) => s.id === who.locationId) ?? main;
  const picked = await cookieStoreId();
  const byCookie = picked ? open.find((s) => s.id === picked) : undefined;
  if (byCookie) return byCookie;
  if (who.id) {
    const home = (await db.user.findFirst({ where: { id: who.id, shopId: who.shopId }, select: { locationId: true } }))?.locationId;
    const h = home ? open.find((s) => s.id === home) : undefined;
    if (h) return h;
  }
  return main;
}

/** The current store's id (null = the main store of a company that never set stores up). */
export async function currentStoreId(who: StoreWho): Promise<string | null> {
  return (await currentStore(who))?.id ?? null;
}

/**
 * The company's details as the current store has them: the main store's are the Shop row's (unchanged), another
 * store's address, phone, time zone, tax rate, hours and receipt line are its own. Use it wherever a sale, a receipt or
 * a day at the counter takes the shop's rate or time zone.
 */
export function storeDetails<T extends { taxRatePct?: number; timeZone?: string; address?: string | null; phone?: string | null; receiptNote?: string | null; hoursNote?: string | null }>(shop: T, store: Store | null): T {
  if (!store || store.main) return shop;
  const out: T = { ...shop };
  if ("taxRatePct" in shop) out.taxRatePct = store.taxRatePct;
  if ("timeZone" in shop) out.timeZone = store.timeZone;
  if ("address" in shop) out.address = store.address;
  if ("phone" in shop) out.phone = store.phone ?? shop.phone ?? null;
  if ("receiptNote" in shop) out.receiptNote = store.receiptFooter ?? shop.receiptNote ?? null;
  if ("hoursNote" in shop) out.hoursNote = store.hours;
  return out;
}

/** The store a row belongs to (its locationId; null = main), from the company's stores. */
export async function storeOfRow(shopId: string, locationId: string | null | undefined): Promise<Store | null> {
  const stores = await storesOf(shopId);
  if (!stores.length) return null;
  return (locationId ? stores.find((s) => s.id === locationId) : null) ?? stores.find((s) => s.main) ?? stores[0];
}

/** A store's name for words: "" for a company with one open store (nothing extra shows). */
export async function storeLabel(shopId: string, locationId: string | null | undefined): Promise<string> {
  if (!(await isMultiStore(shopId))) return "";
  return (await storeOfRow(shopId, locationId))?.name ?? "";
}

/** The store whose shelves the online shop and the product feeds sell from (Settings -> Stores; main by default). */
export async function onlineStore(shopId: string): Promise<Store | null> {
  const s = await db.shop.findUnique({ where: { id: shopId }, select: { onlineLocationId: true } });
  return storeOfRow(shopId, s?.onlineLocationId ?? null);
}
