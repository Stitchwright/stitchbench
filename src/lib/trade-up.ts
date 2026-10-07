import "server-only";
// Trade-up credit and the trade-in value rule (shop-features-round-2-design.md 1.9). With the shop's setting on (off by
// default; 30 days when turned on), a repair's charges are taken off a machine the customer buys within the days after
// the repair was done: the invoice prints "If you'd rather buy a new machine by 12 Nov, we'll take $89 off", and the
// register, selling a machine to her, shows "Repair credit $89 (until 12 Nov)" with one tap to use it. The credit is a
// discount on the machine line ("Trade-up credit"), not money owed: she can't cash it. Each ticket's credit is used once
// (TradeUpOffer); a void gives it back. The trade-in value rule: what the shop expects to sell it for, less a percent
// (30 by default), is the number the trade-in step starts from. Every query by shopId.
import type { Prisma } from "@/generated/prisma/client";
import type { TicketStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { str } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { ticketTotals } from "@/lib/ticket-math";
import { addDays, ymdOf } from "@/lib/zoned";

export type TradeUpCredit = { ticketId: string; number: number; machine: string; amountCents: number; until: string };

const DONE: TicketStatus[] = ["READY_FOR_PICKUP", "READY_IN_TRUCK", "COLLECTED"];

/** The shop's settings: the days (0: off) and the trade-in rule's percent. */
export async function tradeUpSettings(shopId: string): Promise<{ days: number; lessPct: number }> {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { tradeUpDays: true, tradeInLessPct: true } });
  return { days: s.tradeUpDays, lessPct: s.tradeInLessPct };
}

/** Settings: trade-up credit on (with its days) or off, and the trade-in rule's percent. Owner or admin. */
export async function saveTradeUpSettingsFor(user: CurrentUser, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  const on = fd.get("on") != null;
  const days = Number(str(fd.get("days")) ?? "30");
  const less = Number(str(fd.get("lessPct"))?.replace(/%$/, "") ?? "30");
  if (on && (!Number.isInteger(days) || days < 1 || days > 180)) throw new UserError("Days: 1 to 180.");
  if (!Number.isInteger(less) || less < 0 || less > 90) throw new UserError("Trade-in rule: a percent from 0 to 90.");
  await db.shop.update({ where: { id: user.shopId }, data: { tradeUpDays: on ? days : 0, tradeInLessPct: less } });
}

/** The day a ticket's work was done (ready, else closed), in the shop's zone. */
const doneDay = (t: { readyAt: Date | null; closedAt: Date | null }, tz: string) => {
  const d = t.readyAt ?? t.closedAt;
  return d ? ymdOf(d, tz) : null;
};

/** One ticket's credit, if the setting is on and the ticket has charges (for the invoice and the register). */
export async function creditForTicket(shopId: string, ticketId: string): Promise<TradeUpCredit | null> {
  const { days } = await tradeUpSettings(shopId);
  if (!days) return null;
  const t = await db.ticket.findFirst({ where: { id: ticketId, shopId }, include: { lines: true, payments: true, machine: { select: { brand: true, model: true } } } });
  if (!t || !t.customerId || !DONE.includes(t.status)) return null;
  const tz = await shopTimeZone(shopId);
  const day = doneDay(t, tz);
  if (!day) return null;
  const amount = Math.max(0, ticketTotals(t.lines, t.payments, t.taxRatePct).subtotal);
  if (!amount) return null;
  return { ticketId: t.id, number: t.number, machine: `${t.machine.brand} ${t.machine.model}`, amountCents: amount, until: addDays(day, days) };
}

/** A customer's credits she can use today: repairs done within the days, with charges, not used yet. */
export async function creditsFor(shopId: string, customerId: string, today?: string): Promise<TradeUpCredit[]> {
  const { days } = await tradeUpSettings(shopId);
  if (!days) return [];
  const tz = await shopTimeZone(shopId);
  const day = today ?? ymdOf(new Date(), tz);
  const since = new Date(Date.now() - (days + 2) * 86_400_000);
  const tickets = await db.ticket.findMany({
    where: { shopId, customerId, status: { in: DONE }, OR: [{ readyAt: { gte: since } }, { closedAt: { gte: since } }] },
    include: { lines: true, payments: true, machine: { select: { brand: true, model: true } } },
    orderBy: { number: "desc" },
    take: 20,
  });
  if (!tickets.length) return [];
  const used = new Set((await db.tradeUpOffer.findMany({ where: { shopId, ticketId: { in: tickets.map((t) => t.id) } }, select: { ticketId: true } })).map((u) => u.ticketId));
  const out: TradeUpCredit[] = [];
  for (const t of tickets) {
    if (used.has(t.id)) continue;
    const d = doneDay(t, tz);
    if (!d) continue;
    const until = addDays(d, days);
    if (until < day) continue;
    const amount = Math.max(0, ticketTotals(t.lines, t.payments, t.taxRatePct).subtotal);
    if (amount > 0) out.push({ ticketId: t.id, number: t.number, machine: `${t.machine.brand} ${t.machine.model}`, amountCents: amount, until });
  }
  return out;
}

type Tx = Prisma.TransactionClient;

/**
 * Inside the register's sale: a machine line using a ticket's credit. Checked (this customer's, in time, not used), and
 * recorded once (a second sale using it at the same moment is refused). Returns the credit in cents.
 */
export async function spendCredit(tx: Tx, a: { shopId: string; customerId: string | null; ticketId: string; lineId: string; today: string }): Promise<number> {
  if (!a.customerId) throw new UserError("Pick the customer first: a repair credit is hers.");
  const c = (await creditsFor(a.shopId, a.customerId, a.today)).find((x) => x.ticketId === a.ticketId);
  if (!c) throw new UserError("That repair credit isn't there any more (used, past its day, or not hers).");
  try {
    await tx.tradeUpOffer.create({ data: { shopId: a.shopId, customerId: a.customerId, ticketId: c.ticketId, amountCents: c.amountCents, until: c.until, usedLineId: a.lineId } });
  } catch {
    throw new UserError("That repair credit was just used. Take it off this sale.");
  }
  return c.amountCents;
}

/** What a credit can take off a line (never below zero), worked out before the sale is written. */
export async function creditCents(shopId: string, customerId: string | null, ticketId: string, today: string): Promise<number> {
  if (!customerId) throw new UserError("Pick the customer first: a repair credit is hers.");
  const c = (await creditsFor(shopId, customerId, today)).find((x) => x.ticketId === ticketId);
  if (!c) throw new UserError("That repair credit isn't there any more (used, past its day, or not hers).");
  return c.amountCents;
}

/** Voiding a sale: its credits are there again. */
export async function unuseCredits(tx: Tx, shopId: string, lineIds: string[]): Promise<void> {
  if (lineIds.length) await tx.tradeUpOffer.deleteMany({ where: { shopId, usedLineId: { in: lineIds } } });
}

/** The trade-in rule's starting number: what the shop expects to sell it for, less its percent. Pure. */
export const tradeInStart = (expectCents: number, lessPct: number) => Math.max(0, Math.round((expectCents * (100 - lessPct)) / 100));
