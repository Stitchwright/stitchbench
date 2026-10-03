import "server-only";
// The one way code changes a direct ticket's status (scheduling-messaging-design.md section 4.1): the dates setStatus
// used to set, plus pickupReadyAt, written with a guard against a change made meanwhile, and the notices hook.
import type { Prisma } from "@/generated/prisma/client";
import type { TicketStatus } from "@/generated/prisma/enums";
import { UserError } from "@/lib/user-error";
import { OPEN_STATUSES } from "@/lib/constants";
import type { HookCtx } from "@/lib/notices/context";
import { onTicketStatus } from "@/lib/notices/hooks";

export type TicketForStatus = {
  id: string;
  shopId: string;
  status: TicketStatus;
  readyAt: Date | null;
  pickupReadyAt: Date | null;
  closedAt: Date | null;
  warrantyUntil: Date | null;
  tradeCommissionPct?: number | null;
  customerId: string | null;
  viaAccountId: string | null;
};

const ready = (s: TicketStatus) => s === "READY_IN_TRUCK" || s === "READY_FOR_PICKUP";

/**
 * What a status change writes: readyAt on the first READY_*; pickupReadyAt on every move INTO READY_FOR_PICKUP and
 * null on every move out of it; closedAt and warrantyUntil as setStatus always did. `commissionPct` is the trade
 * account's rate to pin when the ticket closes (the caller looks it up outside the transaction), undefined to leave it.
 */
export function statusData(t: TicketForStatus, status: TicketStatus, at: Date, warrantyDays: number, commissionPct?: number | null): Prisma.TicketUpdateManyMutationInput {
  const data: Prisma.TicketUpdateManyMutationInput = { status };
  const wasClosed = !OPEN_STATUSES.includes(t.status);
  if (OPEN_STATUSES.includes(status)) {
    // Open again (a mis-click, or the repair didn't hold): it hasn't left the shop, so no return date or warranty, and
    // back on the bench it isn't ready either. Ready again later, the storage-fee clock starts from that ready-call.
    data.closedAt = null;
    data.warrantyUntil = null;
    data.tradeCommissionPct = null; // open tickets follow the account's current rate
    if (!ready(status)) data.readyAt = null;
    else if (!t.readyAt || !(ready(t.status) || wasClosed)) data.readyAt = at;
  } else {
    // Collected and returned-unrepaired swapped for each other keep the day it left; closing a reopened ticket, or
    // handing back an abandoned machine, dates from now. Only a collected repair carries the warranty.
    const closedAt = wasClosed && t.closedAt && t.status !== "ABANDONED" ? t.closedAt : at;
    data.closedAt = closedAt;
    if (commissionPct !== undefined && (closedAt !== t.closedAt || t.tradeCommissionPct == null)) data.tradeCommissionPct = commissionPct;
    data.warrantyUntil = status === "COLLECTED" ? (t.status === "COLLECTED" && t.warrantyUntil ? t.warrantyUntil : new Date(at.getTime() + warrantyDays * 86400000)) : null;
  }
  // Waiting for the customer's OK again: the answer they gave last time is history (the notes keep it).
  if (status === "WAITING_CUSTOMER_OK" && t.status !== "WAITING_CUSTOMER_OK") {
    data.estimateAnswer = null;
    data.estimateAnsweredAt = null;
  }
  // The pickup shelf clock: every entry into "Ready - customer called" starts it; leaving clears it.
  if (status === "READY_FOR_PICKUP") {
    if (t.status !== "READY_FOR_PICKUP" || !t.pickupReadyAt) data.pickupReadyAt = at;
  } else data.pickupReadyAt = null;
  return data;
}

/**
 * Writes the change with a guard on the status it started from (two people changing it at once), then runs the
 * notices hook. `commissionPct` as for statusData.
 */
export async function changeTicketStatus(
  tx: Prisma.TransactionClient,
  t: TicketForStatus,
  status: TicketStatus,
  at: Date,
  warrantyDays: number,
  ctx: HookCtx,
  commissionPct?: number | null,
): Promise<{ changed: boolean; note: string | null }> {
  if (status === t.status) return { changed: false, note: null };
  const data = statusData(t, status, at, warrantyDays, commissionPct);
  const r = await tx.ticket.updateMany({ where: { id: t.id, shopId: t.shopId, status: t.status }, data });
  if (!r.count) {
    const now = await tx.ticket.findFirst({ where: { id: t.id, shopId: t.shopId }, select: { status: true } });
    if (now?.status === status) return { changed: false, note: null };
    throw new UserError("The ticket changed meanwhile. Reload the page.");
  }
  const written: TicketForStatus = {
    ...t,
    status,
    readyAt: data.readyAt === undefined ? t.readyAt : (data.readyAt as Date | null),
    pickupReadyAt: data.pickupReadyAt === undefined ? t.pickupReadyAt : (data.pickupReadyAt as Date | null),
    closedAt: data.closedAt === undefined ? t.closedAt : (data.closedAt as Date | null),
    warrantyUntil: data.warrantyUntil === undefined ? t.warrantyUntil : (data.warrantyUntil as Date | null),
  };
  const note = await onTicketStatus(tx, written, status, at, ctx);
  return { changed: true, note };
}
