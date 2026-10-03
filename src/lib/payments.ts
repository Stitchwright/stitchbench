import "server-only";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { PAYMENT_LABEL } from "@/lib/constants";
import { money } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";

/**
 * Takes a payment off a ticket without deleting it: a negative payment of the same method, dated now, points back at it
 * (`reversesId`, unique, so a payment is removed once). The day it was taken keeps its total and today shows the money
 * going out. Balances are sums, so they come out as if the payment had never been taken. Owner or admin only; returns
 * the ticket's id.
 */
export async function removePaymentFor(user: CurrentUser, paymentId: string): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only the shop owner or an admin can change this.");
  const p = await db.payment.findFirst({ where: { id: paymentId, ticket: { shopId: user.shopId } } });
  if (!p) throw new UserError("Payment not found.");
  if (p.reversesId) throw new UserError("That line is itself a removal; it can't be removed.");
  const label = `${PAYMENT_LABEL[p.method]} payment of ${money(p.amountCents)}`;
  try {
    await db.payment.create({
      data: { ticketId: p.ticketId, method: p.method, amountCents: -p.amountCents, paidAt: new Date(), reversesId: p.id, note: `Removed: the ${label}${p.note ? ` (${p.note})` : ""}`.slice(0, 500) },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new UserError("That payment was already removed.");
    throw e;
  }
  return p.ticketId;
}
