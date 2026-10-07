"use server";

// Gift cards and store credit (later-round-1-design.md section 2): looking a card up for the register, and the card
// page's owner and admin tools. Selling, loading, spending and refunding onto cards happen inside the sale and the ticket
// payment (src/lib/register-sale.ts, src/lib/payments.ts), never here. While the program is read-only, looking up is
// allowed and every tool below is refused (safe() without whileLapsed): adjusting, moving and giving credit are new work.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { isUserError, safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str, toCents } from "@/lib/format";
import { addExistingCardAs, adjustCardAs, findCard, giveStoreCreditAs, limitLookups, moveCardAs } from "@/lib/gift-cards";
import { lastFour } from "@/lib/gift-card-number";
import { assertId } from "@/lib/input";

export type GiftCardInfo = {
  id: string;
  number: string;
  last4: string;
  kind: "gift" | "credit";
  balanceCents: number;
  status: string;
  customerName: string | null;
};

/**
 * A card by the number scanned or typed (this company's only), for the register's tender and gift card tools. For
 * store credit a blank number is the customer's own card. Lookups are rate-limited per person, so a number can't be
 * guessed at through the register. Reads only.
 */
export async function giftCardByNumber(number: string, customerId?: string | null, method?: "GIFT" | "CREDIT"): Promise<GiftCardInfo | { error: string }> {
  try {
    const user = await requireUser();
    limitLookups(user.id);
    let card;
    if (!String(number ?? "").trim() && method === "CREDIT") {
      if (!customerId) throw new UserError("Pick the customer, or scan the store credit slip.");
      card = await db.giftCard.findFirst({ where: { shopId: user.shopId, customerId, kind: "credit", status: "active" }, orderBy: { issuedAt: "asc" } });
      if (!card) throw new UserError("This customer has no store credit.");
    } else {
      card = await findCard(db, user.shopId, number);
    }
    if (method === "GIFT" && card.kind !== "gift") throw new UserError("That is a store credit number. Use Store credit to spend it.");
    if (method === "CREDIT" && card.kind !== "credit") throw new UserError("That is a gift card number. Use Gift card to spend it.");
    const customer = card.customerId ? await db.customer.findFirst({ where: { id: card.customerId, shopId: user.shopId }, select: { name: true } }) : null;
    return { id: card.id, number: card.number, last4: lastFour(card.number), kind: card.kind as "gift" | "credit", balanceCents: card.balanceCents, status: card.status, customerName: customer?.name ?? null };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

/** "Add an existing card" (owner, admin): a paper card sold before, with what is left on it. */
export const addExistingGiftCard = safe(async function addExistingGiftCard(formData: FormData) {
  const user = await requireUser();
  const amount = toCents(formData.get("amount"));
  if (amount == null) throw new UserError("Enter what is left on the card.");
  const customerId = str(formData.get("customerId"));
  const card = await addExistingCardAs(user, { number: String(formData.get("number") ?? ""), amountCents: amount, customerId: customerId ? assertId(customerId) : null });
  revalidatePath("/register/gift-cards");
  redirect(`/register/gift-cards/${card.id}`);
});

/** "Adjust the balance" (owner only, a reason is required). */
export const adjustGiftCard = safe(async function adjustGiftCard(cardId: string, formData: FormData) {
  const user = await requireUser();
  const balance = toCents(formData.get("balance"));
  if (balance == null) throw new UserError("Enter the balance the card should have.");
  await adjustCardAs(user, assertId(cardId), balance, formData.get("reason"));
  revalidatePath("/register/gift-cards", "layout");
  revalidatePath("/customers", "layout");
});

/** "Move to a new number" (owner, admin): a lost card; the balance goes to a new card and the old number is void. */
export const moveGiftCard = safe(async function moveGiftCard(cardId: string, formData: FormData) {
  const user = await requireUser();
  const fresh = await moveCardAs(user, assertId(cardId), str(formData.get("number")), formData.get("reason"));
  revalidatePath("/register/gift-cards", "layout");
  redirect(`/register/gift-cards/${fresh.id}`);
});

/** Store credit given by an owner or admin with a reason, on the customer's card (made when they have none). */
export const giveStoreCredit = safe(async function giveStoreCredit(customerId: string, formData: FormData) {
  const user = await requireUser();
  const amount = toCents(formData.get("amount"));
  if (amount == null) throw new UserError("Enter the amount.");
  await giveStoreCreditAs(user, assertId(customerId), amount, formData.get("reason"));
  revalidatePath("/customers", "layout");
  revalidatePath("/register/gift-cards", "layout");
});
