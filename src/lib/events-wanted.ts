import "server-only";
// The message worker's "still wanted?" for an event's balance reminder (shop-features-round-2-design.md 4.5), apart from
// src/lib/events.ts so the worker's hooks don't load the register and pay links.
import type { OutMessage } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { paidSoFar } from "@/lib/events-math";

/** Not when she has paid in full or isn't signed up any more. */
export async function eventBalanceStillWanted(row: Pick<OutMessage, "shopId" | "refType" | "refId">): Promise<string | null> {
  if (row.refType !== "event_balance" || !row.refId) return null;
  const e = await db.enrollment.findFirst({ where: { id: row.refId, shopId: row.shopId }, include: { eventPayments: true } });
  if (!e || e.status !== "ENROLLED") return "She isn't signed up any more";
  if (paidSoFar(e, e.eventPayments) >= e.feeCents) return "Paid in full";
  return null;
}
