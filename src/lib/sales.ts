import "server-only";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { zonedMidnight, zonedParts } from "@/lib/partners";

/**
 * Ways a ticket gets paid that put nothing in this shop's drawer or card reader: a partner sewing shop took it at its
 * counter (it comes on the monthly statement, less commission), or it's billed on account and not paid yet.
 */
export const PAID_ELSEWHERE: PaymentMethod[] = ["SHOP_COLLECTED", "INVOICE"];

const ymd = (v: string | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? "");
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
};
const iso = (p: { year: number; month: number; day: number }) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

/**
 * From..to (whole days, to included) as instants, in the shop's time zone: a day starts at the shop's midnight, not
 * the server's (UTC on a hosted install). Defaults: the 1st of this month through today.
 */
export function monthRange(from?: string, to?: string, timeZone = "America/New_York") {
  const today = zonedParts(new Date(), timeZone);
  const f = ymd(from) ?? { ...today, day: 1 };
  const t = ymd(to) ?? today;
  const start = zonedMidnight(f.year, f.month - 1, f.day, timeZone);
  const end = zonedMidnight(t.year, t.month - 1, t.day + 1, timeZone); // exclusive
  return { start, end, fromStr: iso(f), toStr: iso(t) };
}

/** When today began in the shop's time zone. */
export function startOfToday(timeZone = "America/New_York") {
  const t = zonedParts(new Date(), timeZone);
  return zonedMidnight(t.year, t.month - 1, t.day, timeZone);
}

/** Today's date in the shop's time zone, as YYYY-MM-DD. */
export function todayIn(timeZone = "America/New_York") {
  return dateIn(new Date(), timeZone);
}

/** The calendar date of a moment in the shop's time zone, as YYYY-MM-DD (for CSV rows; toISOString would give the UTC day). */
export function dateIn(d: Date, timeZone = "America/New_York") {
  return iso(zonedParts(d, timeZone));
}

/** Payments taken in [start, end) with their ticket, for the sales log. */
export async function paymentsBetween(shopId: string, start: Date, end: Date) {
  return db.payment.findMany({
    where: { paidAt: { gte: start, lt: end }, ticket: { shopId } },
    include: { ticket: { include: { customer: true, machine: true, viaAccount: true } } },
    orderBy: { paidAt: "asc" },
  });
}
