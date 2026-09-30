import "server-only";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

/**
 * Ways a ticket gets paid that put nothing in this shop's drawer or card reader: a partner sewing shop took it at its
 * counter (it comes on the monthly statement, less commission), or it's billed on account and not paid yet.
 */
export const PAID_ELSEWHERE: PaymentMethod[] = ["SHOP_COLLECTED", "INVOICE"];

// Day and month ranges in the shop's time zone (kept importable from here).
export { dateIn, monthRange, startOfToday, todayIn } from "@/lib/time-zone";

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
