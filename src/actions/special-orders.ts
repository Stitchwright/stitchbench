"use server";

// Special orders and pre-orders (shop-features-round-2-design.md 1.2): the register's "Take the order" and a payment
// (they return what the receipt link needs, or an error), the customer's waiting orders for the register, and the
// special order page's buttons. Bodies in src/lib/special-orders.ts.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isUserError, noted, safe, UserError } from "@/lib/action";
import { str } from "@/lib/format";
import { requireUser } from "@/lib/session";
import type { Tender } from "@/lib/register-math";
import { parseYmd } from "@/lib/zoned";
import {
  askForBalancesAs,
  cancelSpecialOrderAs,
  markCalledFor,
  markHereFor,
  notHereAfterAllFor,
  orderThemFor,
  payTowardAs,
  saveSpecialOrderSettingsFor,
  sendBalanceLinkAs,
  takeSpecialOrderAs,
  undoCancelFor,
  waitingForCustomer,
  type DepositRule,
  type TakeInput,
} from "@/lib/special-orders";

function refresh(id?: string) {
  revalidatePath("/special-orders", "layout");
  revalidatePath("/register", "layout");
  revalidatePath("/parts", "layout");
  revalidatePath("/customers", "layout");
  if (id) revalidatePath(`/special-orders/${id}`);
  revalidatePath("/");
}

type Done = { saleId: string | null; number: number | null; orderId?: string; orderNumber?: number } | { error: string };

async function attempt(fn: () => Promise<Done>): Promise<Done> {
  try {
    return await fn();
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

/** The register's (or a page's) "Take the order": the order made and its deposit rung up. */
export async function takeSpecialOrder(input: TakeInput): Promise<Done> {
  return attempt(async () => {
    const r = await takeSpecialOrderAs(await requireUser(), input);
    refresh(r.id);
    return { saleId: r.saleId, number: r.saleNumber, orderId: r.id, orderNumber: r.number };
  });
}

/** A payment toward an order at the counter. */
export async function paySpecialOrder(id: string, amountCents: number, tender: Tender, clientKey: string | null): Promise<Done> {
  return attempt(async () => {
    const r = await payTowardAs(await requireUser(), { id, amountCents, tender, clientKey });
    refresh(id);
    return { saleId: r.saleId, number: r.number };
  });
}

/** The register's "Jane has a special order waiting": her orders here, with what was paid. */
export async function waitingSpecialOrders(customerId: string | null) {
  const user = await requireUser();
  if (!customerId) return [];
  return (await waitingForCustomer(user.shopId, String(customerId))).map((o) => ({
    id: o.id,
    number: o.number,
    partId: o.partId,
    description: o.description,
    qty: o.qty,
    unit: o.unit,
    priceCents: o.priceCents,
    paidCents: o.paidCents,
  }));
}

export const saveSpecialOrderSettings = safe(async function saveSpecialOrderSettings(formData: FormData) {
  await saveSpecialOrderSettingsFor(await requireUser(), formData);
  revalidatePath("/settings/sales");
});

export const orderSpecialOrders = safe(async function orderSpecialOrders(formData: FormData) {
  const ids = formData.getAll("id").map(String);
  const words = await orderThemFor(await requireUser(), ids);
  refresh();
  revalidatePath("/parts/orders", "layout");
  return noted(words);
});

export const markSpecialOrderHere = safe(async function markSpecialOrderHere(id: string) {
  const words = await markHereFor(await requireUser(), id);
  refresh(id);
  return noted(words);
});

export const specialOrderNotHere = safe(async function specialOrderNotHere(id: string) {
  await notHereAfterAllFor(await requireUser(), id);
  refresh(id);
});

export const markSpecialOrderCalled = safe(async function markSpecialOrderCalled(id: string) {
  await markCalledFor(await requireUser(), id);
  refresh(id);
});

export const cancelSpecialOrder = safe(async function cancelSpecialOrder(id: string, formData: FormData) {
  const rule = str(formData.get("rule")) as DepositRule | null;
  const r = await cancelSpecialOrderAs(await requireUser(), { id, rule, method: str(formData.get("method")), reason: str(formData.get("reason")) });
  refresh(id);
  return noted(
    r.keptCents ? `Cancelled. The deposit of $${(r.keptCents / 100).toFixed(2)} is kept.` : r.backCents ? `Cancelled. $${(r.backCents / 100).toFixed(2)} given back.` : "Cancelled.",
  );
});

export const undoSpecialOrderCancel = safe(async function undoSpecialOrderCancel(id: string) {
  await undoCancelFor(await requireUser(), id);
  refresh(id);
  return noted("Open again, as it was.");
});

export const sendSpecialOrderBalance = safe(async function sendSpecialOrderBalance(id: string) {
  const words = await sendBalanceLinkAs(await requireUser(), id);
  refresh(id);
  return noted(words);
});

export const askForPreorderBalances = safe(async function askForPreorderBalances(partId: string) {
  const words = await askForBalancesAs(await requireUser(), partId);
  refresh();
  return noted(words);
});

/** An item's "Coming soon" date and whether a special order's deposit for it is kept on a cancel (owner or admin). */
export const saveComingSoon = safe(async function saveComingSoon(partId: string, formData: FormData) {
  const user = await requireUser();
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  const raw = str(formData.get("comingSoonOn"));
  const day = raw ? parseYmd(raw) : null;
  if (raw && !day) throw new UserError("Coming soon: pick a date, or leave it blank.");
  const r = await db.part.updateMany({ where: { id: partId, shopId: user.shopId }, data: { comingSoonOn: day, depositKept: formData.get("depositKept") != null } });
  if (!r.count) throw new UserError("Item not found.");
  revalidatePath(`/parts/${partId}`);
});
