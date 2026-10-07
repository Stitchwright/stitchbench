import "server-only";
// Gift cards and store credit (later-round-1-design.md section 2). The ledger (GiftCardEntry) is the truth;
// GiftCard.balanceCents is its sum, moved in the same transaction by one guarded updateMany (a spend only goes through
// while the balance is enough, and the row lock makes two registers take turns), and the database refuses a negative
// balance outright (migration check). Everything here runs inside the caller's transaction (the sale's, the ticket
// payment's), so a card never moves without the sale or payment that moved it, and takes the actor for the audit log.
import type { GiftCard, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { money } from "@/lib/format";
import { allow } from "@/lib/rate-limit";
import { actorOf, audit, type Actor } from "@/lib/audit";
import { GIFT_MAX_CENTS, GIFT_MIN_CENTS, lastFour, newGiftCardNumber, parseCardNumber, type Issued } from "@/lib/gift-card-number";

export type { Issued };

type Tx = Prisma.TransactionClient;
type Reader = Tx | typeof db;

export type EntryReason = "SOLD" | "LOADED" | "REDEEMED" | "REFUNDED_TO" | "CASHED_OUT" | "ADJUSTED" | "OPENING" | "VOID" | "MOVED";
export const REASON_LABEL: Record<EntryReason, string> = {
  SOLD: "Sold",
  LOADED: "Loaded",
  REDEEMED: "Spent",
  REFUNDED_TO: "Refunded onto the card",
  CASHED_OUT: "Paid out in cash",
  ADJUSTED: "Adjusted",
  OPENING: "Existing card added",
  VOID: "Undone (void or removed payment)",
  MOVED: "Moved to a new number",
};

/** What caused an entry: plain ids, kept as they were. */
export type Cause = { saleId?: string | null; saleLineId?: string | null; paymentId?: string | null; ticketId?: string | null; note?: string | null };

export const cardWords = (c: Pick<GiftCard, "kind" | "number">) => `${c.kind === "credit" ? "Store credit" : "Gift card"} ending ${lastFour(c.number)}`;

/**
 * The card with this typed or scanned number, in this company only (another company's card is "not found"). A GC number
 * with a wrong check character says so instead.
 */
export async function findCard(r: Reader, shopId: string, raw: string | null | undefined): Promise<GiftCard> {
  const p = parseCardNumber(raw);
  if (p.kind === "none") throw new UserError("Scan or type the card number.");
  if (p.kind === "gc-bad") throw new UserError("That card number isn't right. Check the last character and try again.");
  const card = await r.giftCard.findFirst({ where: { shopId, number: p.number } });
  if (!card) throw new UserError("Gift card not found.");
  return card;
}

/** Lookups are rate-limited per person: a number can't be guessed at through the register. */
export function limitLookups(userId: string): void {
  if (!allow(`gc-lookup:${userId}`, 40, 60_000)) throw new UserError("Too many card lookups. Wait a minute and try again.");
}

/**
 * Moves a card's balance and writes its ledger line. `amountCents` is + onto the card, - off it. A spend (-) is a guarded
 * update: it goes through only while the balance is enough, so two registers can't overdraw a card. `active` also
 * refuses a void card (spending, refunding onto one).
 */
export async function postEntry(tx: Tx, shopId: string, cardId: string, amountCents: number, reason: EntryReason, o: Cause & { userId?: string | null; active?: boolean; at?: Date } = {}): Promise<{ balanceCents: number }> {
  if (!Number.isInteger(amountCents) || amountCents === 0) throw new Error("A card entry needs a whole, non-zero number of cents.");
  const at = o.at ?? new Date();
  const moved = await tx.giftCard.updateMany({
    where: { id: cardId, shopId, ...(amountCents < 0 ? { balanceCents: { gte: -amountCents } } : {}), ...(o.active ? { status: "active" } : {}) },
    data: { balanceCents: { increment: amountCents }, lastUsedAt: at },
  });
  if (!moved.count) {
    const c = await tx.giftCard.findFirst({ where: { id: cardId, shopId } });
    if (!c) throw new UserError("Gift card not found.");
    if (o.active && c.status !== "active") throw new UserError(`${cardWords(c)} is void.`);
    throw new UserError(`${cardWords(c)} has only ${money(c.balanceCents)} left.`);
  }
  await tx.giftCardEntry.create({
    data: { shopId, cardId, at, amountCents, reason, saleId: o.saleId ?? null, saleLineId: o.saleLineId ?? null, paymentId: o.paymentId ?? null, ticketId: o.ticketId ?? null, userId: o.userId ?? null, note: o.note?.slice(0, 200) ?? null },
  });
  const now = await tx.giftCard.findUniqueOrThrow({ where: { id: cardId }, select: { balanceCents: true } });
  return { balanceCents: now.balanceCents };
}

/** A new card row (balance 0), a random number tried again on the rare clash. A given number is used as it is. */
async function createCard(tx: Tx, a: Actor, o: { kind: "gift" | "credit"; number?: string; customerId?: string | null; note?: string | null }): Promise<GiftCard> {
  for (let tries = 0; tries < 5; tries++) {
    const number = o.number ?? newGiftCardNumber();
    const clash = await tx.giftCard.findUnique({ where: { shopId_number: { shopId: a.shopId, number } }, select: { id: true } });
    if (clash) {
      if (o.number) throw new UserError("That card number is already in use.");
      continue;
    }
    try {
      return await tx.giftCard.create({ data: { shopId: a.shopId, number, kind: o.kind, customerId: o.customerId ?? null, note: o.note?.slice(0, 200) ?? null, createdById: a.id ?? null } });
    } catch (e) {
      // Another register made the same number a moment ago (the check above and this insert aren't one step).
      if ((e as { code?: string }).code === "P2002") throw new UserError("That card number is already in use.");
      throw e;
    }
  }
  throw new Error("Could not make a card number.");
}

function checkAmount(amountCents: number, what: string) {
  if (!Number.isInteger(amountCents) || amountCents < GIFT_MIN_CENTS || amountCents > GIFT_MAX_CENTS) {
    throw new UserError(`${what} must be from ${money(GIFT_MIN_CENTS)} to ${money(GIFT_MAX_CENTS)}.`);
  }
}

export type CardLine = { mode: "new" | "printed" | "load" | "cashout"; number?: string | null };

/** What the register's gift card line asked for, checked before anything is written (the server decides the amount of a payout). */
export async function prepareCardLine(shopId: string, role: "OWNER" | "ADMIN" | "TECH", line: CardLine, qty: number, unitPriceCents: number): Promise<{ description: string; unitPriceCents: number; qty: number; card: GiftCard | null }> {
  if (!line || typeof line !== "object") throw new UserError("Pick what the gift card line is.");
  if (line.mode === "cashout") {
    if (role === "TECH") throw new UserError("Only the owner or an admin can pay out a gift card balance.");
    const card = await findCard(db, shopId, line.number);
    if (card.balanceCents <= 0) throw new UserError(`${cardWords(card)} has nothing left to pay out.`);
    if (card.status !== "active") throw new UserError(`${cardWords(card)} is void.`);
    return { description: `${card.kind === "credit" ? "Store credit" : "Gift card"} balance paid out (ending ${lastFour(card.number)})`, unitPriceCents: card.balanceCents, qty: -1, card };
  }
  if (qty !== 1) throw new UserError("A gift card is sold one at a time.");
  checkAmount(unitPriceCents, "A gift card");
  if (line.mode === "load") {
    const card = await findCard(db, shopId, line.number);
    if (card.kind !== "gift") throw new UserError("Store credit is given as a refund, not loaded like a gift card.");
    if (card.status !== "active") throw new UserError(`${cardWords(card)} is void.`);
    return { description: `Gift card loaded (ending ${lastFour(card.number)})`, unitPriceCents, qty: 1, card };
  }
  if (line.mode === "printed") {
    const p = parseCardNumber(line.number);
    if (p.kind !== "printed") throw new UserError(p.kind === "none" ? "Type or scan the number printed on the card (6 to 24 letters and digits)." : "That number looks like one the program makes. Use New card, or the number printed on a blank card.");
    if (await db.giftCard.findUnique({ where: { shopId_number: { shopId, number: p.number } }, select: { id: true } })) throw new UserError("That card number is already in use.");
    return { description: `Gift card (ending ${lastFour(p.number)})`, unitPriceCents, qty: 1, card: null };
  }
  if (line.mode !== "new") throw new UserError("Pick what the gift card line is.");
  return { description: "Gift card", unitPriceCents, qty: 1, card: null };
}

/**
 * Applies a gift card sale line inside the sale's transaction: a card made and filled (SOLD), a card loaded (LOADED), or a
 * balance paid out (CASHED_OUT). Writes the audit entry and returns the card (the line keeps its id).
 */
export async function applyCardLine(tx: Tx, a: Actor, line: CardLine, amountCents: number, cause: { saleId: string; saleLineId: string; saleLabel: string }): Promise<Issued> {
  const c = { saleId: cause.saleId, saleLineId: cause.saleLineId, userId: a.id };
  if (line.mode === "cashout") {
    const card = await findCard(tx, a.shopId, line.number);
    // The server's own figure: the balance it is now, which the guarded update takes in full.
    await postEntry(tx, a.shopId, card.id, -amountCents, "CASHED_OUT", { ...c, active: true });
    await audit(tx, a, { action: "giftcard.cashout", subjectType: "GiftCard", subjectId: card.id, subjectLabel: `${cardWords(card)}, ${cause.saleLabel}`, amountCents, changes: { balanceCents: [amountCents, 0] } });
    return { cardId: card.id, number: card.number, kind: card.kind as "gift" | "credit", amountCents, what: "paid-out" };
  }
  if (line.mode === "load") {
    const card = await findCard(tx, a.shopId, line.number);
    if (card.status !== "active" || card.kind !== "gift") throw new UserError(`${cardWords(card)} can't be loaded.`);
    const { balanceCents } = await postEntry(tx, a.shopId, card.id, amountCents, "LOADED", { ...c, active: true });
    await audit(tx, a, { action: "giftcard.load", subjectType: "GiftCard", subjectId: card.id, subjectLabel: `${cardWords(card)}, ${cause.saleLabel}`, amountCents, changes: { balanceCents: [balanceCents - amountCents, balanceCents] } });
    return { cardId: card.id, number: card.number, kind: "gift", amountCents, what: "loaded" };
  }
  const printed = line.mode === "printed" ? parseCardNumber(line.number) : null;
  const card = await createCard(tx, a, { kind: "gift", number: printed?.kind === "printed" ? printed.number : undefined });
  await postEntry(tx, a.shopId, card.id, amountCents, "SOLD", c);
  await audit(tx, a, { action: "giftcard.sell", subjectType: "GiftCard", subjectId: card.id, subjectLabel: `${cardWords(card)}, ${cause.saleLabel}`, amountCents, changes: { balanceCents: [0, amountCents] } });
  return { cardId: card.id, number: card.number, kind: "gift", amountCents, what: "sold" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Paying with a card, refunding onto one

export type CardTender = { method: "GIFT" | "CREDIT"; amountCents: number; cardNumber?: string | null };
export type TenderCard = { cardId: string; last4: string; leftCents: number; issued?: Issued };

/** The customer's store credit card (they have one), or null. */
async function creditCardOf(r: Reader, shopId: string, customerId: string | null | undefined): Promise<GiftCard | null> {
  if (!customerId) return null;
  return r.giftCard.findFirst({ where: { shopId, customerId, kind: "credit", status: "active" }, orderBy: { issuedAt: "asc" } });
}

/** The card behind a tender, found by number, or (store credit) the customer's own. */
async function cardForTender(tx: Tx, shopId: string, t: CardTender, customerId: string | null | undefined): Promise<GiftCard> {
  if (t.method === "CREDIT" && !String(t.cardNumber ?? "").trim()) {
    const c = await creditCardOf(tx, shopId, customerId);
    if (!c) throw new UserError(customerId ? "This customer has no store credit." : "Pick the customer, or scan the store credit slip.");
    return c;
  }
  const c = await findCard(tx, shopId, t.cardNumber);
  if (t.method === "GIFT" && c.kind !== "gift") throw new UserError("That is a store credit number. Use Store credit to spend it.");
  if (t.method === "CREDIT" && c.kind !== "credit") throw new UserError("That is a gift card number. Use Gift card to spend it.");
  return c;
}

/**
 * A GIFT or CREDIT payment (+) takes the amount off the card, a refund (-) puts it on one: a gift card refunds onto the
 * card the number names; store credit goes on the customer's card (made when they have none) or on a new slip when
 * there is no customer, which is returned so its number can be printed.
 */
export async function applyCardTender(tx: Tx, a: Actor, t: CardTender, o: { customerId?: string | null; label: string } & Cause): Promise<TenderCard> {
  const cause = { saleId: o.saleId, saleLineId: o.saleLineId, paymentId: o.paymentId, ticketId: o.ticketId, userId: a.id };
  if (t.amountCents > 0) {
    const card = await cardForTender(tx, a.shopId, t, o.customerId);
    const { balanceCents } = await postEntry(tx, a.shopId, card.id, -t.amountCents, "REDEEMED", { ...cause, active: true, note: o.note });
    return { cardId: card.id, last4: lastFour(card.number), leftCents: balanceCents };
  }
  const amount = -t.amountCents;
  if (t.method === "GIFT") {
    const card = await cardForTender(tx, a.shopId, t, o.customerId);
    const { balanceCents } = await postEntry(tx, a.shopId, card.id, amount, "REFUNDED_TO", { ...cause, active: true, note: o.note });
    return { cardId: card.id, last4: lastFour(card.number), leftCents: balanceCents };
  }
  // Store credit given back.
  const given = String(t.cardNumber ?? "").trim() ? await cardForTender(tx, a.shopId, t, o.customerId) : null;
  const r = await giveCredit(tx, a, { card: given, customerId: o.customerId ?? null, amountCents: amount, reason: "REFUNDED_TO", cause, label: o.label, note: o.note });
  return { cardId: r.card.id, last4: lastFour(r.card.number), leftCents: r.balanceCents, issued: r.slip ? { cardId: r.card.id, number: r.card.number, kind: "credit", amountCents: amount, what: "credit" } : undefined };
}

/**
 * Puts store credit on a card: the one given, else the customer's (made when they have none; the customer's row is
 * locked so two refunds at once make one card), else a new slip with a number. Writes the audit entry.
 */
export async function giveCredit(
  tx: Tx,
  a: Actor,
  o: { card: GiftCard | null; customerId: string | null; amountCents: number; reason: EntryReason; cause: Cause & { userId?: string | null }; label: string; note?: string | null; why?: string | null },
): Promise<{ card: GiftCard; balanceCents: number; slip: boolean }> {
  let card = o.card;
  let slip = false;
  if (!card && o.customerId) {
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${o.customerId} AND "shopId" = ${a.shopId} FOR UPDATE`;
    card = await creditCardOf(tx, a.shopId, o.customerId);
    if (!card) {
      if (!(await tx.customer.findFirst({ where: { id: o.customerId, shopId: a.shopId }, select: { id: true } }))) throw new UserError("Customer not found.");
      card = await createCard(tx, a, { kind: "credit", customerId: o.customerId });
    }
  }
  if (!card) {
    card = await createCard(tx, a, { kind: "credit" });
    slip = true;
  }
  const { balanceCents } = await postEntry(tx, a.shopId, card.id, o.amountCents, o.reason, { ...o.cause, active: true, note: o.note ?? o.why });
  await audit(tx, a, {
    action: "credit.issue",
    subjectType: "GiftCard",
    subjectId: card.id,
    subjectLabel: `${cardWords(card)}, ${o.label}`,
    amountCents: o.amountCents,
    changes: { balanceCents: [balanceCents - o.amountCents, balanceCents] },
    reason: o.why ?? null,
  });
  return { card, balanceCents, slip };
}

// ---------------------------------------------------------------------------------------------------------------------
// Undoing: a void sale, a removed ticket payment

/**
 * The card a moved card's balance went to (moveCardAs: the old card's MOVED line off and the new card's MOVED line on,
 * written together, the new card's note naming the old number), or null when there is no one such card.
 */
async function successorOf(tx: Tx, shopId: string, old: GiftCard): Promise<GiftCard | null> {
  const off = await tx.giftCardEntry.findFirst({ where: { shopId, cardId: old.id, reason: "MOVED", amountCents: { lt: 0 } }, orderBy: [{ at: "desc" }, { id: "desc" }] });
  if (!off) return null;
  const near = 5_000;
  const on = await tx.giftCardEntry.findMany({
    where: { shopId, reason: "MOVED", amountCents: -off.amountCents, cardId: { not: old.id }, at: { gte: new Date(off.at.getTime() - near), lte: new Date(off.at.getTime() + near) }, card: { kind: old.kind, note: { startsWith: `Moved from ending ${lastFour(old.number)}` } } },
    select: { card: true },
    take: 2,
  });
  return on.length === 1 ? on[0].card : null;
}

/** The card `cardId`'s balance is on now: the card, or (moved since) the card its balance moved to. Void when neither is active. */
async function currentCard(tx: Tx, shopId: string, cardId: string): Promise<GiftCard> {
  let c = await tx.giftCard.findFirst({ where: { id: cardId, shopId } });
  if (!c) throw new UserError("Gift card not found.");
  for (let hops = 0; c.status !== "active" && hops < 10; hops++) {
    const next = await successorOf(tx, shopId, c);
    if (!next) break;
    c = next;
  }
  return c;
}

/** Where an amount being put back onto `cardId` goes: the card, or (moved since) the card its balance moved to. */
async function putBackCard(tx: Tx, shopId: string, cardId: string): Promise<GiftCard> {
  const c = await currentCard(tx, shopId, cardId);
  if (c.status !== "active") throw new UserError(`${cardWords(c)} is void, so the amount can't go back on it. Give it back another way (store credit, cash).`);
  return c;
}

/** Each entry in `entries` undone: its amount comes back off (or onto) the card as a VOID line, in the transaction. */
async function undo(tx: Tx, shopId: string, entries: { id: string; cardId: string; amountCents: number; reason: string }[], cause: Cause & { userId?: string | null }, words: string) {
  for (const e of entries) {
    let from: GiftCard | null = null;
    try {
      const note = `Undoes ${e.reason.toLowerCase()} ${money(Math.abs(e.amountCents))}`;
      if (e.amountCents < 0) {
        // Money going back onto a card (a spend undone): never onto a void card; a card moved since takes it on its new number.
        const to = await putBackCard(tx, shopId, e.cardId);
        await postEntry(tx, shopId, to.id, -e.amountCents, "VOID", { ...cause, active: true, note: to.id === e.cardId ? note : `${note} (moved from an older number)` });
      } else {
        // Money coming back off a card (a sale or load undone): a card moved since gives it up from its new number.
        from = await currentCard(tx, shopId, e.cardId);
        await postEntry(tx, shopId, from.id, -e.amountCents, "VOID", { ...cause, note: from.id === e.cardId ? note : `${note} (moved to a newer number)` });
      }
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      const c = await tx.giftCard.findFirst({ where: { id: from?.id ?? e.cardId, shopId } });
      if (c && -e.amountCents < 0) {
        throw new UserError(`That ${c.kind === "credit" ? "store credit" : "card"} has been used; ${money(c.balanceCents)} is left. ${words}`);
      }
      throw err;
    }
    // A card the sale made (on its new number, if moved) is void once it is back to nothing.
    if (e.reason === "SOLD") await tx.giftCard.updateMany({ where: { id: from?.id ?? e.cardId, shopId, balanceCents: 0 }, data: { status: "void" } });
  }
}

/** Everything a sale did to cards, undone (void). A sale whose card has since been spent can't be voided. */
export async function reverseSale(tx: Tx, a: Actor, saleId: string, saleNumber: number): Promise<void> {
  const entries = await tx.giftCardEntry.findMany({ where: { shopId: a.shopId, saleId, reason: { not: "VOID" } }, orderBy: [{ at: "desc" }, { id: "desc" }] });
  await undo(tx, a.shopId, entries, { saleId, userId: a.id }, `Return what's left instead (sale #${saleNumber}).`);
}

/** What a ticket payment did to a card, undone when the payment is removed (cause is the removal's own payment). */
export async function reversePayment(tx: Tx, a: Actor, original: { id: string; ticketId: string }, removalId: string): Promise<void> {
  const entries = await tx.giftCardEntry.findMany({ where: { shopId: a.shopId, paymentId: original.id, reason: { not: "VOID" } }, orderBy: [{ at: "desc" }, { id: "desc" }] });
  await undo(tx, a.shopId, entries, { paymentId: removalId, ticketId: original.ticketId, userId: a.id }, "Give the credit another way instead.");
}

// ---------------------------------------------------------------------------------------------------------------------
// The card page: add an existing card, adjust, move, give store credit

const reasonOf = (v: unknown, label: string) => {
  const s = String(v ?? "").trim().slice(0, 200);
  if (!s) throw new UserError(`${label}: say why.`);
  return s;
};

/** A paper card the shop sold before (owner, admin): its number and what is left on it. In the liability, not in sales. */
export async function addExistingCardAs(user: { shopId: string; id: string; name: string; role: "OWNER" | "ADMIN" | "TECH" }, input: { number: string; amountCents: number; customerId?: string | null }): Promise<GiftCard> {
  if (user.role === "TECH") throw new UserError("Only the owner or an admin can add an existing card.");
  const p = parseCardNumber(input.number);
  if (p.kind === "none") throw new UserError("Type the number printed on the card (6 to 24 letters and digits).");
  if (p.kind === "gc-bad") throw new UserError("That card number isn't right. Check the last character and try again.");
  const number = p.number;
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > GIFT_MAX_CENTS * 10) throw new UserError("Enter what is left on the card.");
  if (input.customerId && !(await db.customer.findFirst({ where: { id: input.customerId, shopId: user.shopId }, select: { id: true } }))) throw new UserError("Customer not found.");
  const a = actorOf(user);
  return db.$transaction(async (tx) => {
    const card = await createCard(tx, a, { kind: "gift", number, customerId: input.customerId ?? null });
    await postEntry(tx, user.shopId, card.id, input.amountCents, "OPENING", { userId: user.id });
    await audit(tx, a, { action: "giftcard.opening", subjectType: "GiftCard", subjectId: card.id, subjectLabel: cardWords(card), amountCents: input.amountCents, changes: { balanceCents: [0, input.amountCents] } });
    return card;
  });
}

/** Sets a card's balance to what it really is (owner only, a reason is required). */
export async function adjustCardAs(user: { shopId: string; id: string; name: string; role: "OWNER" | "ADMIN" | "TECH" }, cardId: string, newBalanceCents: number, why: unknown): Promise<void> {
  if (user.role !== "OWNER") throw new UserError("Only the owner can adjust a card's balance.");
  const reason = reasonOf(why, "Adjusting a balance");
  if (!Number.isInteger(newBalanceCents) || newBalanceCents < 0 || newBalanceCents > GIFT_MAX_CENTS * 10) throw new UserError("Enter the balance the card should have.");
  const a = actorOf(user);
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ balanceCents: number }[]>`SELECT "balanceCents" FROM "GiftCard" WHERE id = ${cardId} AND "shopId" = ${user.shopId} FOR UPDATE`;
    if (!rows.length) throw new UserError("Gift card not found.");
    const card = await tx.giftCard.findFirstOrThrow({ where: { id: cardId, shopId: user.shopId } });
    const delta = newBalanceCents - rows[0].balanceCents;
    if (delta === 0) return;
    await postEntry(tx, user.shopId, cardId, delta, "ADJUSTED", { userId: user.id, note: reason });
    await audit(tx, a, { action: "giftcard.adjust", subjectType: "GiftCard", subjectId: cardId, subjectLabel: cardWords(card), amountCents: delta, changes: { balanceCents: [rows[0].balanceCents, newBalanceCents] }, reason });
  });
}

/** A lost card: its balance moves to a new number (the old one is void) and stays with the same customer (owner, admin). */
export async function moveCardAs(user: { shopId: string; id: string; name: string; role: "OWNER" | "ADMIN" | "TECH" }, cardId: string, newNumber: string | null, why: unknown): Promise<GiftCard> {
  if (user.role === "TECH") throw new UserError("Only the owner or an admin can move a card.");
  const reason = reasonOf(why, "Moving a card");
  let number: string | undefined;
  if (newNumber && newNumber.trim()) {
    const p = parseCardNumber(newNumber);
    if (p.kind === "gc-bad" || p.kind === "none") throw new UserError("That card number isn't right.");
    number = p.number;
  }
  const a = actorOf(user);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ balanceCents: number }[]>`SELECT "balanceCents" FROM "GiftCard" WHERE id = ${cardId} AND "shopId" = ${user.shopId} FOR UPDATE`;
    if (!rows.length) throw new UserError("Gift card not found.");
    const old = await tx.giftCard.findFirstOrThrow({ where: { id: cardId, shopId: user.shopId } });
    if (old.status !== "active") throw new UserError("That card is already void.");
    const balance = rows[0].balanceCents;
    if (balance <= 0) throw new UserError("That card has nothing left to move.");
    // successorOf pairs the two MOVED lines by this note, amount and time.
    const fresh = await createCard(tx, a, { kind: old.kind as "gift" | "credit", number, customerId: old.customerId, note: `Moved from ending ${lastFour(old.number)}` });
    const at = new Date();
    await postEntry(tx, user.shopId, old.id, -balance, "MOVED", { userId: user.id, note: reason, at });
    await tx.giftCard.update({ where: { id: old.id }, data: { status: "void" } });
    await postEntry(tx, user.shopId, fresh.id, balance, "MOVED", { userId: user.id, note: reason, at });
    await audit(tx, a, { action: "giftcard.move", subjectType: "GiftCard", subjectId: old.id, subjectLabel: `${cardWords(old)} to ${cardWords(fresh)}`, amountCents: balance, changes: { number: [lastFour(old.number), lastFour(fresh.number)] }, reason });
    return fresh;
  });
}

/** Store credit given by an owner or admin, with a reason (not from a return). */
export async function giveStoreCreditAs(user: { shopId: string; id: string; name: string; role: "OWNER" | "ADMIN" | "TECH" }, customerId: string, amountCents: number, why: unknown): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only the owner or an admin can give store credit.");
  const reason = reasonOf(why, "Giving store credit");
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > GIFT_MAX_CENTS) throw new UserError(`Store credit must be from $0.01 to ${money(GIFT_MAX_CENTS)}.`);
  const customer = await db.customer.findFirst({ where: { id: customerId, shopId: user.shopId }, select: { id: true, name: true } });
  if (!customer) throw new UserError("Customer not found.");
  const a = actorOf(user);
  await db.$transaction((tx) => giveCredit(tx, a, { card: null, customerId, amountCents, reason: "LOADED", cause: { userId: user.id }, label: customer.name, why: reason }));
}

/** A card with its ledger, for the card page: this company's only. */
export async function cardWithEntries(shopId: string, id: string) {
  return db.giftCard.findFirst({ where: { id, shopId }, include: { entries: { orderBy: [{ at: "desc" }, { id: "desc" }], take: 200 }, customer: { select: { id: true, name: true } } } });
}

/** Active balance on cards untouched for `years` years (the accountant's unclaimed-property flag, design 2.1): the sum and how many cards. */
export async function untouchedCards(shopId: string, years = 3): Promise<{ cents: number; count: number }> {
  const before = new Date();
  before.setFullYear(before.getFullYear() - years);
  const r = await db.giftCard.aggregate({
    where: { shopId, status: "active", balanceCents: { gt: 0 }, OR: [{ lastUsedAt: { lt: before } }, { lastUsedAt: null, issuedAt: { lt: before } }] },
    _sum: { balanceCents: true },
    _count: true,
  });
  return { cents: r._sum.balanceCents ?? 0, count: r._count };
}
