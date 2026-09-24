import "server-only";
import { db } from "@/lib/db";

export function monthRange(from?: string, to?: string) {
  const now = new Date();
  const start = from ? new Date(`${from}T00:00:00`) : new Date(now.getFullYear(), now.getMonth(), 1);
  const endDay = to ? new Date(`${to}T00:00:00`) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(endDay.getTime() + 86400000); // exclusive
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start, end, fromStr: iso(start), toStr: iso(endDay) };
}

/** Payments taken in [start, end) with their ticket, for the sales log. */
export async function paymentsBetween(shopId: string, start: Date, end: Date) {
  return db.payment.findMany({
    where: { paidAt: { gte: start, lt: end }, ticket: { shopId } },
    include: { ticket: { include: { customer: true, machine: true, viaAccount: true } } },
    orderBy: { paidAt: "asc" },
  });
}
