import "server-only";
// Settings -> Stores (shop-features-round-2-design.md 7.1): add a second store, each store's details, closing one, the
// staff's home stores, the store the online shop sells from, the approval limits (7.5), and the store this device is at.
// Owners add and close stores (each extra store is billed); owners and admins change the details. Every query by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { str, toCents } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { actorOf, audit } from "@/lib/audit";
import { ensureMainStore, loadStores, STORE_COOKIE, type Store } from "@/lib/stores";

/** The time zones offered (US shops; another IANA name can be typed in Settings -> Shop for the main store). */
export const STORE_ZONES: { id: string; label: string }[] = [
  { id: "America/New_York", label: "Eastern" },
  { id: "America/Chicago", label: "Central" },
  { id: "America/Denver", label: "Mountain" },
  { id: "America/Phoenix", label: "Arizona" },
  { id: "America/Los_Angeles", label: "Pacific" },
  { id: "America/Anchorage", label: "Alaska" },
  { id: "Pacific/Honolulu", label: "Hawaii" },
];

function validZone(tz: string | null): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new UserError(`"${tz}" isn't a time zone. Pick one from the list.`);
  }
}

function pct(v: FormDataEntryValue | null, label: string, max: number): number | null {
  const s = str(String(v ?? "").replace(/[%\s]/g, ""));
  if (s == null) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new UserError(`${label}: enter a number from 0 to ${max}.`);
  return n;
}

function money(v: FormDataEntryValue | null, label: string): number | null {
  const s = str(v);
  if (s == null) return null;
  const c = toCents(s);
  if (c == null || c < 0 || c > 10_000_000) throw new UserError(`${label}: enter an amount like 200.`);
  return c;
}

function hhmm(v: FormDataEntryValue | null): string | null {
  const s = str(v);
  if (s == null) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new UserError("Closing time: pick a time, like 17:30.");
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

const cleanName = (v: FormDataEntryValue | null, label = "Store name") => {
  const s = str(v)?.slice(0, 60) ?? null;
  if (!s) throw new UserError(`${label}: give it a short name, like "Florida".`);
  return s;
};

async function nameTaken(shopId: string, name: string, except: string | null) {
  const same = await db.location.findFirst({ where: { shopId, name: { equals: name, mode: "insensitive" }, ...(except ? { id: { not: except } } : {}) }, select: { id: true } });
  if (same) throw new UserError(`Another store is already called ${name}. Give this one another name.`);
}

/**
 * "Add a second store" (owner): the main store is made first if the company has none (its name from `mainName`), then
 * the new store with its own address, phone, time zone and tax rate (the main store's by default).
 */
export async function addStoreFor(user: CurrentUser, fd: FormData): Promise<Store> {
  if (user.role !== "OWNER") throw new UserError("Only the owner adds a store (each store is on the bill).");
  const name = cleanName(fd.get("name"));
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true, taxRatePct: true, receiptNote: true } });
  const made = await db.$transaction(async (tx) => {
    const main = await ensureMainStore(tx, user.shopId);
    const mainName = str(fd.get("mainName"))?.slice(0, 60);
    if (mainName && mainName !== main.name) await tx.location.updateMany({ where: { id: main.id, shopId: user.shopId }, data: { name: mainName } });
    const open = await tx.location.count({ where: { shopId: user.shopId } });
    if (open >= 20) throw new UserError("20 stores at most. Call us if you need more.");
    await nameTaken(user.shopId, name, null);
    if (mainName && mainName.toLowerCase() === name.toLowerCase()) throw new UserError("The two stores need different names.");
    return tx.location.create({
      data: {
        shopId: user.shopId,
        name,
        address: str(fd.get("address"))?.slice(0, 300) ?? null,
        phone: str(fd.get("phone"))?.slice(0, 40) ?? null,
        timeZone: validZone(str(fd.get("timeZone"))) ?? shop.timeZone,
        taxRatePct: pct(fd.get("taxRatePct"), "Sales tax", 30) ?? shop.taxRatePct,
        hours: str(fd.get("hours"))?.slice(0, 300) ?? null,
        receiptFooter: str(fd.get("receiptFooter"))?.slice(0, 500) ?? shop.receiptNote,
        sortOrder: open,
      },
    });
  });
  await audit(db, actorOf(user), { action: "store.add", subjectType: "Location", subjectId: made.id, subjectLabel: made.name });
  return (await loadStores(db, user.shopId)).find((s) => s.id === made.id)!;
}

/**
 * A store's details (owner or admin). The main store's address, phone, time zone, tax rate, hours and receipt line are
 * the company's own (the Shop row, as Settings -> Shop shows them); another store's are its own.
 */
export async function saveStoreFor(user: CurrentUser, id: string, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only the owner or an admin changes a store.");
  const loc = await db.location.findFirst({ where: { id: String(id), shopId: user.shopId } });
  if (!loc) throw new UserError("Store not found.");
  const name = cleanName(fd.get("name"));
  await nameTaken(user.shopId, name, loc.id);
  const limits = {
    approveRefundCents: money(fd.get("approveRefund"), "Refunds over"),
    approveDiscountPct: (() => {
      const p = pct(fd.get("approveDiscount"), "Discounts over", 100);
      return p == null ? null : Math.round(p);
    })(),
    dailyAt: hhmm(fd.get("dailyAt")),
  };
  const details = {
    address: str(fd.get("address"))?.slice(0, 300) ?? null,
    phone: str(fd.get("phone"))?.slice(0, 40) ?? null,
    timeZone: validZone(str(fd.get("timeZone"))),
    taxRatePct: pct(fd.get("taxRatePct"), "Sales tax", 30),
    hours: str(fd.get("hours"))?.slice(0, 300) ?? null,
    receiptFooter: str(fd.get("receiptFooter"))?.slice(0, 500) ?? null,
  };
  await db.$transaction(async (tx) => {
    if (loc.main) {
      const shop = await tx.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true, taxRatePct: true } });
      await tx.shop.update({
        where: { id: user.shopId },
        data: { address: details.address, phone: details.phone, timeZone: details.timeZone ?? shop.timeZone, taxRatePct: details.taxRatePct ?? shop.taxRatePct, hoursNote: details.hours, receiptNote: details.receiptFooter },
      });
      await tx.location.update({ where: { id: loc.id }, data: { name, ...limits } });
    } else {
      await tx.location.update({ where: { id: loc.id }, data: { name, ...limits, ...details, timeZone: details.timeZone ?? loc.timeZone, taxRatePct: details.taxRatePct ?? loc.taxRatePct, feedStoreCode: str(fd.get("feedStoreCode"))?.slice(0, 60) ?? null } });
    }
  });
  await audit(db, actorOf(user), { action: "store.change", subjectType: "Location", subjectId: loc.id, subjectLabel: name });
}

/**
 * Close a store (owner): refused for the main store, and while it still has stock, machines for sale or transfers on the
 * way (send them to another store first). Its records stay; it can be opened again.
 */
export async function setStoreOpenFor(user: CurrentUser, id: string, open: boolean): Promise<void> {
  if (user.role !== "OWNER") throw new UserError("Only the owner closes or opens a store.");
  const loc = await db.location.findFirst({ where: { id: String(id), shopId: user.shopId } });
  if (!loc) throw new UserError("Store not found.");
  if (loc.main && !open) throw new UserError("The main store can't be closed. Close the other store, or rename this one.");
  if (!open) {
    const [stock, units, moving] = await Promise.all([
      db.stockLevel.count({ where: { shopId: user.shopId, locationId: loc.id, qtyOnHand: { gt: 0 } } }),
      db.stockUnit.count({ where: { shopId: user.shopId, locationId: loc.id, status: { in: ["IN_STOCK", "HELD"] } } }),
      db.stockTransfer.count({ where: { shopId: user.shopId, OR: [{ fromId: loc.id }, { toId: loc.id }], status: { in: ["ASKED", "SENT"] } } }),
    ]);
    if (stock || units) throw new UserError(`${loc.name} still has ${stock ? `${stock} ${stock === 1 ? "item" : "items"} in stock` : ""}${stock && units ? " and " : ""}${units ? `${units} ${units === 1 ? "machine" : "machines"} for sale` : ""}. Send them to another store first.`);
    if (moving) throw new UserError(`${loc.name} has ${moving === 1 ? "a transfer" : `${moving} transfers`} not finished. Finish or cancel ${moving === 1 ? "it" : "them"} first.`);
    // Staff whose home it was go home to the main store; the online shop sells from the main store again.
    const main = await ensureMainStore(db, user.shopId);
    await db.user.updateMany({ where: { shopId: user.shopId, locationId: loc.id }, data: { locationId: main.id } });
    await db.shop.updateMany({ where: { id: user.shopId, onlineLocationId: loc.id }, data: { onlineLocationId: null } });
  }
  await db.location.update({ where: { id: loc.id }, data: { active: open } });
  await audit(db, actorOf(user), { action: "store.change", subjectType: "Location", subjectId: loc.id, subjectLabel: `${loc.name} ${open ? "opened again" : "closed"}` });
}

/** A person's home store (owner or admin): where they work unless the device says otherwise. */
export async function setHomeStoreFor(user: CurrentUser, userId: string, locationId: string): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only the owner or an admin changes where someone works.");
  const [person, loc] = await Promise.all([
    db.user.findFirst({ where: { id: String(userId), shopId: user.shopId }, select: { id: true } }),
    db.location.findFirst({ where: { id: String(locationId), shopId: user.shopId, active: true }, select: { id: true } }),
  ]);
  if (!person) throw new UserError("Person not found.");
  if (!loc) throw new UserError("Store not found.");
  await db.user.update({ where: { id: person.id }, data: { locationId: loc.id } });
}

/** The store whose shelves the online shop and the product feeds sell from (owner or admin). */
export async function setOnlineStoreFor(user: CurrentUser, locationId: string): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only the owner or an admin changes this.");
  const loc = await db.location.findFirst({ where: { id: String(locationId), shopId: user.shopId, active: true }, select: { id: true, main: true } });
  if (!loc) throw new UserError("Store not found.");
  await db.shop.update({ where: { id: user.shopId }, data: { onlineLocationId: loc.main ? null : loc.id } });
}

/** The owner's daily summary (7.5): on or off, by email (texts need the owner's mobile, later). */
export async function saveDailySummaryFor(user: CurrentUser, on: boolean): Promise<void> {
  if (user.role !== "OWNER") throw new UserError("Only the owner changes her daily summary.");
  await db.shop.update({ where: { id: user.shopId }, data: { dailySummaryOn: on, dailySummaryBy: "email" } });
}

/** This device is at this store (a cookie for a year; checked against the company's open stores whenever it is read). */
export async function pickStoreFor(user: CurrentUser, locationId: string): Promise<string> {
  const loc = await db.location.findFirst({ where: { id: String(locationId), shopId: user.shopId, active: true }, select: { id: true, name: true } });
  if (!loc) throw new UserError("Store not found.");
  const { cookies, headers } = await import("next/headers");
  const proto = (await headers()).get("x-forwarded-proto")?.split(",")[0]?.trim();
  (await cookies()).set(STORE_COOKIE, loc.id, { httpOnly: true, sameSite: "lax", path: "/", secure: proto === "https", maxAge: 365 * 86_400 });
  return loc.name;
}
