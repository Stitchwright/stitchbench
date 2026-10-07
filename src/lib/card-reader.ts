import "server-only";
// A card reader at the counter (shop-features-round-2-design.md 4.8, package card-reader): Stripe Terminal on the shop's
// own Stripe account (the online shop's secret key, sealed; or one pasted here). Off until an owner or admin turns it on
// in Settings → Card reader and pairs a reader (in test mode, Stripe's simulated reader: registration code
// "simulated-wpe"). At the register, Card reader sends the amount to the reader ("Tap, insert or swipe on the reader"),
// the register asks how it went, and an approved payment becomes a Card tender carrying its PaymentIntent; the sale is
// checked against Stripe when it is saved (approved, the amount, this shop's, used once). A return from that sale's
// receipt refunds the card. Plain fetch through src/lib/shop/stripe.ts (STRIPE_API_BASE points the checks at a mock).
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { seal, unseal } from "@/lib/messaging/secrets";
import { looksLikeSecretKey, stripeCall } from "@/lib/shop/stripe";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";
import { currentStoreId } from "@/lib/stores";

type Tx = Prisma.TransactionClient;
type Intent = {
  id: string;
  amount: number;
  amount_received?: number;
  status: string;
  metadata?: Record<string, string>;
  latest_charge?: { amount_refunded?: number; refunded?: boolean; payment_method_details?: { card_present?: { last4?: string; brand?: string } } } | string | null;
  last_payment_error?: { message?: string; code?: string } | null;
};
type Reader = { id: string; label?: string; device_type?: string; status?: string; action?: { status?: string; failure_message?: string; process_payment_intent?: { payment_intent?: string } } | null };

const adminOnly = (user: CurrentUser) => {
  if (user.role === "TECH") throw new UserError("Only an owner or admin sets up the card reader.");
};

async function keyOf(shopId: string): Promise<string> {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { stripeKeySealed: true } });
  const k = unseal(s.stripeKeySealed, shopId, "stripeKey")?.plain;
  if (!k) throw new UserError("The card reader needs your Stripe secret key first (Settings, Card reader).");
  return k;
}

export const isTestKey = (k: string) => /^(sk|rk)_test_/.test(k);

export async function readerSettings(shopId: string) {
  const [s, readers] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { cardReaderOn: true, terminalLocationId: true, stripeKeySealed: true, name: true } }),
    db.cardReader.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } }),
  ]);
  const k = unseal(s.stripeKeySealed, shopId, "stripeKey")?.plain ?? null;
  return { on: s.cardReaderOn, hasKey: !!k, testMode: !!k && isTestKey(k), locationId: s.terminalLocationId, readers };
}

/** The key (when one is pasted) and the switch. Turning it on needs a key. */
export async function saveReaderSettingsFor(user: CurrentUser, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  adminOnly(user);
  const key = str(fd.get("stripeKey"));
  if (key && !looksLikeSecretKey(key)) throw new UserError("A Stripe secret key starts with sk_live_ or sk_test_ (or a restricted rk_ key).");
  const on = fd.get("on") === "on";
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { stripeKeySealed: true } });
  if (on && !key && !shop.stripeKeySealed) throw new UserError("Paste your Stripe secret key to turn the card reader on.");
  await db.shop.update({ where: { id: user.shopId }, data: { cardReaderOn: on, ...(key ? { stripeKeySealed: seal(key, user.shopId, "stripeKey"), terminalLocationId: null } : {}) } });
  return on ? "The card reader is on." : "The card reader is off: cards are recorded as before.";
}

/** Pairs a reader by the code it shows (the simulated reader's is "simulated-wpe"), making the shop's Terminal location first. */
export async function pairReaderFor(user: CurrentUser, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  adminOnly(user);
  const code = (str(fd.get("code")) ?? "").trim();
  if (!code) throw new UserError("Type the code the reader shows.");
  const label = (str(fd.get("label")) ?? "Counter").slice(0, 40);
  const key = await keyOf(user.shopId);
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, terminalLocationId: true, address: true } });
  let location = shop.terminalLocationId;
  if (!location) {
    const loc = await stripeCall<{ id: string }>(key, "POST", "/v1/terminal/locations", { display_name: shop.name.slice(0, 100), address: { line1: (shop.address ?? "Shop").slice(0, 100), country: "US" } }, `loc-${user.shopId}`);
    location = loc.id;
    await db.shop.update({ where: { id: user.shopId }, data: { terminalLocationId: location } });
  }
  const r = await stripeCall<Reader>(key, "POST", "/v1/terminal/readers", { registration_code: code, label, location });
  await db.cardReader.upsert({ where: { shopId_readerId: { shopId: user.shopId, readerId: r.id } }, create: { shopId: user.shopId, locationId: await currentStoreId(user), readerId: r.id, label, deviceType: r.device_type ?? null }, update: { label, deviceType: r.device_type ?? null } });
  return `Paired: ${label}.`;
}

export async function removeReaderFor(user: CurrentUser, id: string): Promise<string> {
  await requireBaseWritable(user);
  adminOnly(user);
  const r = await db.cardReader.findFirst({ where: { id: assertId(id), shopId: user.shopId } });
  if (!r) throw new UserError("Reader not found.");
  try {
    await stripeCall(await keyOf(user.shopId), "DELETE", `/v1/terminal/readers/${encodeURIComponent(r.readerId)}`);
  } catch {
    // Gone at Stripe already, or the key changed: it is removed here anyway.
  }
  await db.cardReader.deleteMany({ where: { id: r.id, shopId: user.shopId } });
  return "Removed.";
}

// ---------------------------------------------------------------------------------------------------------------
// At the register

async function readerOf(shopId: string, id: string) {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { cardReaderOn: true } });
  if (!s.cardReaderOn) throw new UserError("The card reader is off (Settings, Card reader).");
  const r = await db.cardReader.findFirst({ where: { id: assertId(id), shopId } });
  if (!r) throw new UserError("Reader not found.");
  return r;
}

/** Sends the amount to the reader. The payment is remembered (PENDING) so one approved but never put on a sale shows in Settings. */
export async function startReaderPaymentFor(user: CurrentUser, readerRowId: string, amountCents: number, clientKey: string): Promise<{ paymentId: string; intentId: string }> {
  await requireBaseWritable(user);
  const r = await readerOf(user.shopId, readerRowId);
  const amount = Math.round(Number(amountCents));
  if (!Number.isInteger(amount) || amount < 50 || amount > 10_000_000) throw new UserError("A card payment on the reader is from $0.50 to $100,000.");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) throw new UserError("Try again.");
  const key = await keyOf(user.shopId);
  const pi = await stripeCall<Intent>(
    key,
    "POST",
    "/v1/payment_intents",
    { amount, currency: "usd", payment_method_types: ["card_present"], capture_method: "automatic", metadata: { shopId: user.shopId, by: user.id } },
    `rd-${user.shopId}-${clientKey}`,
  );
  await db.cardPayment.upsert({ where: { intentId: pi.id }, create: { shopId: user.shopId, intentId: pi.id, readerId: r.readerId, amountCents: amount }, update: {} });
  await stripeCall(key, "POST", `/v1/terminal/readers/${encodeURIComponent(r.readerId)}/process_payment_intent`, { payment_intent: pi.id });
  const row = await db.cardPayment.findUniqueOrThrow({ where: { intentId: pi.id }, select: { id: true } });
  return { paymentId: row.id, intentId: pi.id };
}

const last4Of = (pi: Intent) => (typeof pi.latest_charge === "object" && pi.latest_charge ? (pi.latest_charge.payment_method_details?.card_present?.last4 ?? null) : null);
const brandOf = (pi: Intent) => (typeof pi.latest_charge === "object" && pi.latest_charge ? (pi.latest_charge.payment_method_details?.card_present?.brand ?? null) : null);

/** How the payment on the reader stands: waiting, approved (with the card's last four) or not (Stripe's words). */
export async function readerPaymentStatusFor(user: CurrentUser, paymentId: string): Promise<{ status: "waiting" | "approved" | "declined" | "cancelled"; message?: string; last4?: string | null; intentId: string; amountCents: number }> {
  const p = await db.cardPayment.findFirst({ where: { id: assertId(paymentId), shopId: user.shopId } });
  if (!p) throw new UserError("Payment not found.");
  const key = await keyOf(user.shopId);
  const pi = await stripeCall<Intent>(key, "GET", `/v1/payment_intents/${encodeURIComponent(p.intentId)}?expand[]=latest_charge`);
  if (pi.metadata?.shopId !== user.shopId) throw new UserError("Payment not found.");
  if (pi.status === "succeeded") {
    await db.cardPayment.updateMany({ where: { id: p.id, shopId: user.shopId }, data: { status: "SUCCEEDED", last4: last4Of(pi), brand: brandOf(pi) } });
    return { status: "approved", last4: last4Of(pi), intentId: p.intentId, amountCents: p.amountCents };
  }
  if (pi.status === "canceled") {
    await db.cardPayment.updateMany({ where: { id: p.id, shopId: user.shopId }, data: { status: "CANCELLED" } });
    return { status: "cancelled", intentId: p.intentId, amountCents: p.amountCents };
  }
  // The reader says it failed (declined, removed too soon): the cashier can try again or take another way.
  const reader = p.readerId ? await stripeCall<Reader>(key, "GET", `/v1/terminal/readers/${encodeURIComponent(p.readerId)}`) : null;
  const act = reader?.action;
  if (act && act.process_payment_intent?.payment_intent === p.intentId && act.status === "failed") {
    return { status: "declined", message: act.failure_message ?? pi.last_payment_error?.message ?? "The card was declined.", intentId: p.intentId, amountCents: p.amountCents };
  }
  return { status: "waiting", intentId: p.intentId, amountCents: p.amountCents };
}

/** Stops the payment on the reader (the customer changed her mind). */
export async function cancelReaderPaymentFor(user: CurrentUser, paymentId: string): Promise<string> {
  const p = await db.cardPayment.findFirst({ where: { id: assertId(paymentId), shopId: user.shopId } });
  if (!p) throw new UserError("Payment not found.");
  const key = await keyOf(user.shopId);
  if (p.readerId) await stripeCall(key, "POST", `/v1/terminal/readers/${encodeURIComponent(p.readerId)}/cancel_action`, {}).catch(() => undefined);
  try {
    await stripeCall(key, "POST", `/v1/payment_intents/${encodeURIComponent(p.intentId)}/cancel`, {});
  } catch (e) {
    // Approved meanwhile: the card was charged; it stays to be put on the sale or refunded.
    const s = await readerPaymentStatusFor(user, p.id);
    if (s.status === "approved") throw new UserError("The card was approved just now. Put it on the sale, or refund it from Settings, Card reader.");
    throw e;
  }
  await db.cardPayment.updateMany({ where: { id: p.id, shopId: user.shopId }, data: { status: "CANCELLED" } });
  return "Cancelled on the reader.";
}

/** Test mode only: the simulated reader "taps" a card (4242 approves; 4000000000000002 declines). */
export async function simulateTapFor(user: CurrentUser, paymentId: string, decline = false): Promise<string> {
  const p = await db.cardPayment.findFirst({ where: { id: assertId(paymentId), shopId: user.shopId } });
  if (!p?.readerId) throw new UserError("Payment not found.");
  const key = await keyOf(user.shopId);
  if (!isTestKey(key)) throw new UserError("A tap can be simulated only in test mode.");
  await stripeCall(key, "POST", `/v1/test_helpers/terminal/readers/${encodeURIComponent(p.readerId)}/present_payment_method`, decline ? { card_present: { number: "4000000000000002" } } : {});
  return "Tapped.";
}

// ---------------------------------------------------------------------------------------------------------------
// The sale

/**
 * Before a sale: every Card tender that names a reader payment is this shop's, approved at Stripe for that amount, and
 * on no other sale. Throws UserError. Returns the payments to tie to the sale.
 */
export async function prepareReaderTenders(shopId: string, tenders: { method: string; amountCents: number; stripeIntent?: string | null; last4?: string }[]): Promise<string[]> {
  const named = tenders.filter((t) => t.method === "CARD" && t.stripeIntent);
  if (!named.length) return [];
  const out: string[] = [];
  for (const t of named) {
    const p = await db.cardPayment.findFirst({ where: { intentId: t.stripeIntent!, shopId } });
    if (!p) throw new UserError("That card payment isn't one of this shop's.");
    if (p.saleId) throw new UserError("That card payment is already on another sale.");
    if (p.refundedCents > 0) throw new UserError("That card payment was refunded. Take it on the reader again.");
    const key = await keyOf(shopId);
    const pi = await stripeCall<Intent>(key, "GET", `/v1/payment_intents/${encodeURIComponent(p.intentId)}?expand[]=latest_charge`);
    if (pi.metadata?.shopId !== shopId || pi.status !== "succeeded") throw new UserError("That card payment wasn't approved. Take it on the reader again.");
    const charge = typeof pi.latest_charge === "object" && pi.latest_charge ? pi.latest_charge : null;
    if ((charge?.amount_refunded ?? 0) > 0 || charge?.refunded) throw new UserError("That card payment was refunded. Take it on the reader again.");
    if ((pi.amount_received ?? pi.amount) - (charge?.amount_refunded ?? 0) !== t.amountCents || p.amountCents !== t.amountCents) throw new UserError("The card payment's amount doesn't match. Take it on the reader again.");
    if (out.includes(p.intentId)) throw new UserError("The same card payment is on the sale twice.");
    out.push(p.intentId);
    // The receipt says which card, as Stripe saw it.
    const l4 = last4Of(pi);
    if (l4) t.last4 = l4;
    await db.cardPayment.updateMany({ where: { id: p.id, shopId }, data: { status: "SUCCEEDED", last4: last4Of(pi), brand: brandOf(pi) } });
  }
  return out;
}

/** In the sale's transaction: the payments now belong to it (once). */
export async function tieReaderPayments(tx: Tx, shopId: string, saleId: string, intentIds: string[]) {
  for (const id of intentIds) {
    const r = await tx.cardPayment.updateMany({ where: { shopId, intentId: id, saleId: null, refundedCents: 0 }, data: { saleId } });
    if (!r.count) throw new UserError("That card payment is already on another sale.");
  }
}

/** The sale is voided: its reader payments are free again (refund them from Settings, Card reader, or put them on a new sale). */
export async function untieReaderPayments(tx: Tx, shopId: string, saleId: string) {
  await tx.cardPayment.updateMany({ where: { shopId, saleId }, data: { saleId: null } });
}

/** Refunds part or all of a reader payment to the card (once per refund key). Returns what was refunded. */
async function refundTo(shopId: string, intentId: string, cents: number, refundKey: string): Promise<number> {
  const p = await db.cardPayment.findFirst({ where: { intentId, shopId } });
  if (!p) return 0;
  const room = p.amountCents - p.refundedCents;
  const amount = Math.min(room, cents);
  if (amount <= 0) return 0;
  await stripeCall(await keyOf(shopId), "POST", "/v1/refunds", { payment_intent: intentId, amount }, refundKey);
  await db.cardPayment.updateMany({ where: { id: p.id, shopId }, data: { refundedCents: { increment: amount } } });
  return amount;
}

/**
 * After a return from a receipt is saved: what it pays back as Card goes back onto the cards that paid the original sale
 * (newest first). Returns what reached the cards; the rest (none taken on the reader, or Stripe refused) is for the
 * cashier to hand back another way, said on the sale's note.
 */
export async function refundReturnToCards(shopId: string, returnSaleId: string, originalSaleId: string | null, cardBackCents: number): Promise<{ refunded: number; problem: string | null }> {
  if (!originalSaleId || cardBackCents <= 0) return { refunded: 0, problem: null };
  const pays = await db.cardPayment.findMany({ where: { shopId, saleId: originalSaleId, status: "SUCCEEDED" }, orderBy: { createdAt: "desc" } });
  if (!pays.length) return { refunded: 0, problem: null };
  let left = cardBackCents;
  let refunded = 0;
  try {
    for (const p of pays) {
      if (left <= 0) break;
      const r = await refundTo(shopId, p.intentId, left, `rf-${returnSaleId}-${p.intentId}`);
      refunded += r;
      left -= r;
    }
    return { refunded, problem: null };
  } catch (e) {
    return { refunded, problem: e instanceof Error ? e.message : "The card refund didn't go through." };
  }
}

/** Settings: an approved payment that is on no sale (the sale was never finished, or was voided) refunded to the card. */
export async function refundLoosePaymentFor(user: CurrentUser, paymentId: string): Promise<string> {
  await requireBaseWritable(user);
  adminOnly(user);
  const p = await db.cardPayment.findFirst({ where: { id: assertId(paymentId), shopId: user.shopId } });
  if (!p) throw new UserError("Payment not found.");
  if (p.saleId) throw new UserError("That payment is on a sale: refund it by a return.");
  const r = await refundTo(user.shopId, p.intentId, p.amountCents, `loose-${p.id}`);
  return r ? `Refunded $${(r / 100).toFixed(2)} to the card.` : "Nothing left to refund.";
}

/** Approved payments on no sale (Settings shows them). */
export async function loosePayments(shopId: string) {
  const rows = await db.cardPayment.findMany({ where: { shopId, saleId: null, status: "SUCCEEDED" }, orderBy: { createdAt: "desc" }, take: 50 });
  return rows.filter((r) => r.refundedCents < r.amountCents);
}

/** The readers the register offers (on, with readers): id and label. */
export async function registerReaders(shopId: string) {
  const s = await readerSettings(shopId);
  return s.on && s.hasKey ? { readers: s.readers.map((r) => ({ id: r.id, label: r.label })), testMode: s.testMode } : null;
}
