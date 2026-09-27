import "server-only";
import { db } from "@/lib/db";
import { zonedMidnight, zonedParts } from "@/lib/partners";

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
  return iso(zonedParts(new Date(), timeZone));
}

/**
 * Payments taken in [start, end) with their ticket, for the sales log. A bill put on a trade account ("Invoice (on
 * account)") isn't money taken: it stays owed under Unpaid invoices until the account pays it.
 */
export async function paymentsBetween(shopId: string, start: Date, end: Date) {
  return db.payment.findMany({
    where: { paidAt: { gte: start, lt: end }, ticket: { shopId }, method: { not: "INVOICE" } },
    include: { ticket: { include: { customer: true, machine: true, viaAccount: true } } },
    orderBy: { paidAt: "asc" },
  });
}
