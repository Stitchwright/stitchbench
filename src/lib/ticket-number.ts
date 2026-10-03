import "server-only";
// The next ticket number for a shop, inside the check-in's transaction (createTicket and central vac installs).
import type { Prisma } from "@/generated/prisma/client";
import { UserError } from "@/lib/user-error";

/**
 * The number a new ticket gets: the typed paper number when given (refused if taken), else the counter, taken
 * atomically and skipping numbers already used (a partner job or a typed-in paper ticket may have them). A typed
 * number ahead of the counter moves the counter past it (never back).
 */
export async function takeTicketNumber(tx: Prisma.TransactionClient, shopId: string, typed: number | null): Promise<number> {
  if (typed) {
    if (await tx.ticket.findFirst({ where: { shopId, number: typed }, select: { id: true } })) {
      throw new UserError(`Ticket ${typed} already exists. Leave the number blank to use the next one.`);
    }
    await tx.$executeRaw`UPDATE "Shop" SET "nextTicketNumber" = GREATEST("nextTicketNumber", ${typed + 1}) WHERE id = ${shopId}`;
    return typed;
  }
  const next = async () => (await tx.shop.update({ where: { id: shopId }, data: { nextTicketNumber: { increment: 1 } }, select: { nextTicketNumber: true } })).nextTicketNumber - 1;
  let number = await next();
  if (await tx.ticket.findFirst({ where: { shopId, number }, select: { id: true } })) {
    // The counter is behind the tickets (set back in Settings before that was refused): go straight past the
    // highest number instead of trying the used ones one at a time.
    const top = await tx.ticket.aggregate({ where: { shopId }, _max: { number: true } });
    number = (top._max.number ?? 0) + 1;
    await tx.shop.update({ where: { id: shopId }, data: { nextTicketNumber: number + 1 } });
  }
  return number;
}

/**
 * The paper ticket number as typed on the check-in form: null for blank, the number for 1-99999999, else a UserError.
 * The column is a 32-bit integer and the counter moves past what is typed.
 */
export function typedTicketNumber(text: string | null): number | null {
  const t = text?.replace(/^#/, "").trim() ?? "";
  if (!t) return null;
  if (!/^\d{1,8}$/.test(t) || Number(t) < 1) throw new UserError("Paper ticket number: enter a whole number from 1 to 99999999, or leave it blank to use the next one.");
  return Number(t);
}
