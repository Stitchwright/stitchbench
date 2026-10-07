import "server-only";
// Tax on a ticket and tax-exempt customers (later-round-1-design.md 3.3): the rate a new ticket opens with, and the
// switch off or on afterwards. Callable with a user so the check scripts can drive it; src/actions/tickets.ts wraps it.
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { UserError } from "@/lib/user-error";
import { actorOf, audit } from "@/lib/audit";
import { ticketNo } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { exemptCertificate } from "@/lib/tax-exempt";

type Db = Prisma.TransactionClient | typeof db;

/** The rate and certificate a ticket opens with: untaxed when the customer (or the trade account it came through) is exempt now. */
export async function openingTax(tx: Db, shopId: string, shopRatePct: number, customerId: string | null, viaAccountId: string | null) {
  const ids = [customerId, viaAccountId].filter(Boolean) as string[];
  const payers = ids.length ? await tx.customer.findMany({ where: { shopId, id: { in: ids } }, select: { taxExemptId: true, taxExemptUntil: true } }) : [];
  const exemptId = payers.map((c) => exemptCertificate(c)).find(Boolean) ?? null;
  return { taxRatePct: exemptId ? 0 : shopRatePct, taxExemptId: exemptId };
}

/**
 * Tax on a ticket switched off for the customer's certificate (charge = false) or back on at the shop's rate. The caller
 * has already checked the person may work on this ticket (the action does, with the equipment gate).
 */
export async function setTicketTaxFor(user: CurrentUser, t: { id: string; number: number; taxRatePct: number; taxExemptId: string | null; customerId: string | null; viaAccountId: string | null }, charge: boolean) {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { taxRatePct: true } });
  const now = await openingTax(db, user.shopId, shop.taxRatePct, t.customerId, t.viaAccountId);
  if (!charge && !now.taxExemptId) throw new UserError("This customer has no tax-exempt certificate on file. Add it on the customer's page first.");
  const next = charge ? { taxRatePct: shop.taxRatePct, taxExemptId: null } : { taxRatePct: 0, taxExemptId: now.taxExemptId };
  await db.$transaction(async (tx) => {
    const r = await tx.ticket.updateMany({ where: { id: t.id, shopId: user.shopId }, data: next });
    if (r.count !== 1) throw new UserError("Ticket not found.");
    await audit(tx, actorOf(user), {
      action: "ticket.tax",
      subjectType: "Ticket",
      subjectId: t.id,
      subjectLabel: `Ticket #${ticketNo(t.number)}`,
      changes: { taxRatePct: [t.taxRatePct, next.taxRatePct], taxExemptId: [t.taxExemptId, next.taxExemptId] },
    });
  });
}
