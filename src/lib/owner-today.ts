import "server-only";
// The owner's phone (shop-features-round-2-design.md 7.5): each store's day so far (takings by payment, sales, repairs
// waiting and ready, low stock, who's on shift now, approvals waiting, what to ship and to send), for the Today page
// and the daily summary email each store's closing time sends her. Every query by shopId and the store.
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { OPEN_STATUSES } from "@/lib/constants";
import { monthRange, todayIn } from "@/lib/time-zone";
import { salesReport } from "@/lib/reports/sales";
import { activeStores, atStore, type Store } from "@/lib/stores";
import { reorderByStore } from "@/lib/store-orders";
import { storeTodo } from "@/lib/transfers";
import { queueToAddress } from "@/lib/messaging/queue";
import { messagingView, publicBaseUrl } from "@/lib/messaging/settings";
import { zonedTime } from "@/lib/zoned";

export type StoreDay = {
  store: Store;
  day: string;
  /** What was taken today by payment (cash, card...), and in all (gift cards and store credit aren't new money). */
  tenders: { label: string; cents: number }[];
  takenCents: number;
  salesCents: number;
  sales: number;
  ticketsOpen: number;
  ticketsReady: number;
  lowStock: { id: string; partNumber: string; description: string; qty: number }[];
  lowCount: number;
  onShift: { name: string; until: Date }[];
  workedToday: string[];
  approvals: number;
  toShip: number;
  askedOfUs: number;
  comingHere: number;
};

/** One store's day so far, in its own time zone. */
export async function storeDay(shopId: string, store: Store, now = new Date()): Promise<StoreDay> {
  const tz = store.timeZone;
  const day = todayIn(tz);
  const { start, end } = monthRange(day, day, tz);
  const sw = atStore(store);
  const [report, sales, ticketsOpen, ticketsReady, low, shifts, approvals, toShip, todo] = await Promise.all([
    salesReport(shopId, tz, start, end, "day", store),
    db.sale.count({ where: { shopId, ...sw, status: "COMPLETED", createdAt: { gte: start, lt: end } } }),
    db.ticket.count({ where: { shopId, ...sw, jobType: "BENCH", status: { in: OPEN_STATUSES.filter((s) => s !== "READY_FOR_PICKUP") } } }),
    db.ticket.count({ where: { shopId, ...sw, jobType: "BENCH", status: "READY_FOR_PICKUP" } }),
    reorderByStore(shopId, store, "here", 50),
    db.shift.findMany({ where: { shopId, ...sw, startsAt: { lt: end }, endsAt: { gt: start } }, select: { name: true, startsAt: true, endsAt: true }, orderBy: { startsAt: "asc" } }),
    db.approval.count({ where: { shopId, ...sw, status: "ASKED", expiresAt: { gt: now } } }),
    db.webOrder.count({ where: { shopId, ...sw, fulfil: "ship", status: { in: ["PAID", "READY"] } } }),
    storeTodo(shopId, store.id),
  ]);
  const tenders = report.tenders.filter((t) => t.cents !== 0).map((t) => ({ label: t.label, cents: t.cents }));
  return {
    store,
    day,
    tenders,
    takenCents: report.totals.taken,
    salesCents: report.totals.net,
    sales,
    ticketsOpen,
    ticketsReady,
    lowStock: low.slice(0, 8).map((r) => ({ id: r.id, partNumber: r.partNumber, description: r.description, qty: r.qty })),
    lowCount: low.length,
    onShift: shifts.filter((s) => s.startsAt <= now && s.endsAt > now).map((s) => ({ name: s.name, until: s.endsAt })),
    workedToday: [...new Set(shifts.map((s) => s.name))],
    approvals,
    toShip,
    askedOfUs: todo.askedOfUs.length,
    comingHere: todo.comingHere.length,
  };
}

/** Every open store's day (Today page), main store first. */
export async function storesToday(shopId: string, now = new Date()): Promise<StoreDay[]> {
  const stores = await activeStores(shopId);
  return Promise.all(stores.map((s) => storeDay(shopId, s, now)));
}

/** The daily summary's words for one store (plain text: it goes by email). */
export function summaryText(d: StoreDay, shopName: string): { subject: string; body: string } {
  const lines = [
    `${d.store.name}, ${d.day}`,
    "",
    `Taken: ${money(d.takenCents)}${d.tenders.length ? ` (${d.tenders.map((t) => `${t.label} ${money(t.cents)}`).join(", ")})` : ""}`,
    `Sales: ${d.sales} (${money(d.salesCents)} net)`,
    `Repairs waiting: ${d.ticketsOpen}; ready for pickup: ${d.ticketsReady}`,
    `Low stock: ${d.lowCount}${d.lowStock.length ? ` (${d.lowStock.slice(0, 5).map((l) => l.partNumber).join(", ")}${d.lowCount > 5 ? "..." : ""})` : ""}`,
    `Worked today: ${d.workedToday.length ? d.workedToday.join(", ") : "no shifts scheduled"}`,
    ...(d.toShip ? [`To ship: ${d.toShip}`] : []),
    ...(d.askedOfUs || d.comingHere ? [`Between stores: ${d.askedOfUs} asked of this store, ${d.comingHere} coming here`] : []),
    ...(d.approvals ? [`Waiting for your OK: ${d.approvals}`] : []),
  ];
  const base = publicBaseUrl();
  if (base) lines.push("", `Today at every store: ${base}/today`);
  return { subject: `${shopName}: ${d.store.name}'s day (${money(d.takenCents)} taken)`, body: lines.join("\n") };
}

/**
 * The daily summary (7.5): for a company with more than one store and the summary on, each store's day goes to every
 * owner by email once its closing time (Settings -> Stores; 18:00 when none) has passed in its time zone, once a day.
 * Run by the message worker's tick; it queues the emails (kind owner_notice, in the base) and the tick sends them.
 */
export async function dailySummaries(now = new Date(), shopIds?: string[]): Promise<number> {
  const shops = await db.shop.findMany({
    where: { dailySummaryOn: true, ...(shopIds ? { id: { in: shopIds } } : {}), locations: { some: { active: true, main: false } } },
    select: { id: true, name: true },
  });
  let queued = 0;
  for (const shop of shops) {
    const stores = await activeStores(shop.id);
    if (stores.length <= 1) continue;
    const ms = await messagingView(shop.id);
    if (!ms.emailOn) continue;
    const owners = await db.user.findMany({ where: { shopId: shop.id, role: "OWNER", active: true }, select: { id: true, email: true } });
    if (!owners.length) continue;
    for (const store of stores) {
      const day = todayIn(store.timeZone);
      const [h, m] = (store.dailyAt ?? "18:00").split(":").map(Number);
      if (now < zonedTime(day, h * 60 + m, store.timeZone)) continue;
      // Once a day: the store's row says which day was last sent (taken here, so two ticks can't both send it).
      const claim = await db.location.updateMany({ where: { id: store.id, shopId: shop.id, OR: [{ dailySentOn: null }, { dailySentOn: { not: day } }] }, data: { dailySentOn: day } });
      if (!claim.count) continue;
      const text = summaryText(await storeDay(shop.id, store, now), shop.name);
      for (const o of owners) {
        if (!o.email) continue;
        const r = await queueToAddress(db, { shopId: shop.id, kind: "owner_notice", channel: "email", address: o.email, content: text, dedupeKey: `owner_daily:${store.id}:${day}:${o.id}`, refType: "owner_daily", refId: store.id }).catch(() => ({ id: null }));
        if (r.id) queued += 1;
      }
    }
  }
  return queued;
}
