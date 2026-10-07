import "server-only";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { PAYMENT_LABEL } from "@/lib/constants";
import { money, ticketNo } from "@/lib/format";
import { actorOf, audit } from "@/lib/audit";
import { requireBaseWritable } from "@/lib/base-gate";
import { applyCardTender, cardWords, reversePayment } from "@/lib/gift-cards";
import type { CurrentUser } from "@/lib/session";
import type { PaymentMethod } from "@/generated/prisma/enums";

// $100,000 in cents: far above any real payment, and well inside what the books' whole numbers hold.
const MAX_MONEY = 10_000_000;

/**
 * Takes a payment on a ticket (the Payments box on the ticket page). Taking payment closes work out, so it is allowed
 * whatever the module's state; money back (a minus amount) is the owner's or an admin's call. The payment and its audit
 * entry commit together.
 */
export async function addPaymentFor(user: CurrentUser, ticketId: string, input: { amountCents: number | null; method: PaymentMethod; note: string | null; card?: string | null }): Promise<void> {
  const ticket = await db.ticket.findFirst({ where: { id: ticketId, shopId: user.shopId }, select: { id: true, number: true, customerId: true } });
  if (!ticket) throw new UserError("Ticket not found.");
  const amount = input.amountCents;
  if (amount == null || amount === 0) throw new UserError("Enter the amount paid.");
  if (Math.abs(amount) > MAX_MONEY) throw new UserError("That's more than $100,000. Check the amount.");
  if (amount < 0 && user.role === "TECH") throw new UserError("Only the shop owner or an admin can record a refund.");
  if (!Object.hasOwn(PAYMENT_LABEL, input.method)) throw new UserError("Pick how it was paid.");
  const onCard = input.method === "GIFT" || input.method === "CREDIT";
  // Spending a gift card or store credit is a sale: refused while the program is read-only (design 2.5). Money back onto a
  // card (a refund) and taking a payment off go through, like every other payment.
  if (onCard && amount > 0) await requireBaseWritable(user);
  await db.$transaction(async (tx) => {
    let note = input.note;
    const p = await tx.payment.create({ data: { ticketId, method: input.method, amountCents: amount, note } });
    if (onCard) {
      const r = await applyCardTender(
        tx,
        actorOf(user),
        { method: input.method as "GIFT" | "CREDIT", amountCents: amount, cardNumber: input.card },
        { customerId: ticket.customerId, paymentId: p.id, ticketId, label: `Ticket #${ticketNo(ticket.number)}` },
      );
      const card = await tx.giftCard.findUniqueOrThrow({ where: { id: r.cardId }, select: { kind: true, number: true } });
      note = [note, r.issued ? `New store credit slip ${card.number}` : cardWords(card)].filter(Boolean).join(" · ").slice(0, 500);
      await tx.payment.update({ where: { id: p.id }, data: { note } });
    }
    await audit(tx, actorOf(user), {
      action: "payment.add",
      subjectType: "Ticket",
      subjectId: ticketId,
      subjectLabel: `Ticket #${ticketNo(ticket.number)}`,
      amountCents: amount,
      changes: { method: [null, input.method], payment: [null, p.id] },
      reason: input.note,
    });
  });
}

/**
 * Takes a payment off a ticket without deleting it: a negative payment of the same method, dated now, points back at it
 * (`reversesId`, unique, so a payment is removed once). The day it was taken keeps its total and today shows the money
 * going out. Balances are sums, so they come out as if the payment had never been taken. Owner or admin only; returns
 * the ticket's id.
 */
export async function removePaymentFor(user: CurrentUser, paymentId: string): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only the shop owner or an admin can change this.");
  const p = await db.payment.findFirst({ where: { id: paymentId, ticket: { shopId: user.shopId } }, include: { ticket: { select: { number: true } } } });
  if (!p) throw new UserError("Payment not found.");
  if (p.reversesId) throw new UserError("That line is itself a removal; it can't be removed.");
  const label = `${PAYMENT_LABEL[p.method]} payment of ${money(p.amountCents)}`;
  try {
    await db.$transaction(async (tx) => {
      const removal = await tx.payment.create({
        data: { ticketId: p.ticketId, method: p.method, amountCents: -p.amountCents, paidAt: new Date(), reversesId: p.id, note: `Removed: the ${label}${p.note ? ` (${p.note})` : ""}`.slice(0, 500) },
      });
      // What the payment did to a gift card or store credit comes back (or goes back off it).
      await reversePayment(tx, actorOf(user), { id: p.id, ticketId: p.ticketId }, removal.id);
      await audit(tx, actorOf(user), {
        action: "payment.remove",
        subjectType: "Ticket",
        subjectId: p.ticketId,
        subjectLabel: `Ticket #${ticketNo(p.ticket.number)}`,
        amountCents: p.amountCents,
        changes: { method: [p.method, null], payment: [p.id, null] },
      });
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new UserError("That payment was already removed.");
    throw e;
  }
  return p.ticketId;
}
