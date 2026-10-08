"use server";

// The Fabric page's ordering (fabric-smarts-design.md section 5, package F3): ticking Reorder rows onto draft orders,
// suppliers' lead time, minimum and order email, and an order's lines, sending, receiving and cancelling. Bodies in
// src/lib/fabric-orders.ts. Each is refused while the program key has lapsed (safe() with no exception: new stock work).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe, UserError } from "@/lib/action";
import { db } from "@/lib/db";
import { str } from "@/lib/format";
import { requireAdmin, requireUser } from "@/lib/session";
import { numberKey } from "@/lib/parts";
import { ORDER_FIELDS, ORDER_SELECT, type OrderSettings } from "@/lib/fabric-orders-math";
import { addItemsToDraftFor, addLineFor, addToDraftFor, cancelOrderFor, closeOrderFor, createOrderFor, ensureSupplierFor, orderOneFor, receiveOrderFor, saveConnectorFor, saveOrderFor, saveSupplierFor, sendOrderFor } from "@/lib/fabric-orders";

const refresh = (id?: string) => {
  revalidatePath("/fabric");
  revalidatePath("/parts", "layout");
  if (id) revalidatePath(`/parts/orders/${id}`);
};

/** Reorder tab: the ticked rows (pick.<id> with bolts.<id>) onto draft orders, one per supplier. */
export const addReorderToDrafts = safe(async function addReorderToDrafts(formData: FormData) {
  const user = await requireUser();
  const picks: { partId: string; bolts: number }[] = [];
  for (const [k, v] of formData.entries()) {
    if (!k.startsWith("pick.") || !v) continue;
    const partId = k.slice(5);
    const bolts = Number(str(formData.get(`bolts.${partId}`)) ?? "");
    if (!Number.isFinite(bolts) || bolts <= 0) throw new UserError("Enter how many bolts for each ticked fabric.");
    picks.push({ partId, bolts });
  }
  const text = await addToDraftFor(user, picks);
  refresh();
  return noted(text);
});

/** Orders page (shop-features-round-2-design.md 1.1): the ticked items (pick.<id> with qty.<id> pieces) onto draft orders, one per supplier. */
export const addItemsToOrders = safe(async function addItemsToOrders(formData: FormData) {
  const user = await requireUser();
  const picks: { partId: string; qty: number; split?: Record<string, number> }[] = [];
  for (const [k, v] of formData.entries()) {
    if (!k.startsWith("pick.") || !v) continue;
    const partId = k.slice(5);
    const qty = Number(str(formData.get(`qty.${partId}`)) ?? "");
    if (!Number.isFinite(qty) || qty <= 0) throw new UserError("Enter how many for each ticked item.");
    // "All stores" (shop-features-round-2-design.md 7.3): each other store's share rides along, kept while it fits the amount.
    let split: Record<string, number> | undefined;
    try {
      const raw = JSON.parse(String(formData.get(`split.${partId}`) ?? "null")) as Record<string, number> | null;
      if (raw && typeof raw === "object" && Object.values(raw).reduce((a, b) => a + Number(b), 0) <= qty) split = raw;
    } catch {
      split = undefined;
    }
    picks.push({ partId, qty, ...(split ? { split } : {}) });
  }
  const text = await addItemsToDraftFor(user, picks);
  refresh();
  return noted(text);
});

/** An item's own page: "Order more" puts it on its supplier's draft order. */
export const orderMore = safe(async function orderMore(partId: string, formData: FormData) {
  const user = await requireUser();
  const qty = Number(str(formData.get("qty")) ?? "");
  if (!Number.isFinite(qty) || qty <= 0) throw new UserError("Enter how many to order.");
  const text = await orderOneFor(user, partId, qty);
  refresh();
  revalidatePath(`/parts/${partId}`);
  return noted(text);
});

export const startOrder = safe(async function startOrder(formData: FormData) {
  const user = await requireUser();
  const id = await createOrderFor(user, str(formData.get("supplier")) ?? "");
  refresh();
  redirect(`/parts/orders/${id}`);
});

/** Orders page: a supplier by name, ready for its list to be brought in (nothing else about an existing one changes). */
export const addSupplier = safe(async function addSupplier(formData: FormData) {
  const user = await requireAdmin();
  const name = str(formData.get("name")) ?? "";
  await ensureSupplierFor(user, name);
  refresh();
  return noted(`${name.trim()} is ready: open it below to bring in its list.`);
});

export const saveSupplier = safe(async function saveSupplier(formData: FormData) {
  const user = await requireUser();
  const text = await saveSupplierFor(user, formData);
  refresh();
  return noted(text);
});

export const saveConnector = safe(async function saveConnector(formData: FormData) {
  const user = await requireUser();
  const text = await saveConnectorFor(user, formData);
  refresh();
  return noted(text);
});

export const addOrderLine = safe(async function addOrderLine(orderId: string, formData: FormData) {
  const user = await requireUser();
  const text = await addLineFor(user, orderId, formData);
  refresh(orderId);
  return noted(text);
});

export const saveOrder = safe(async function saveOrder(orderId: string, formData: FormData) {
  const user = await requireUser();
  await saveOrderFor(user, orderId, formData);
  refresh(orderId);
});

/** Send uses the supplier's connector (email from the shop's own mail account, or the cart-upload file); `manual`: marked sent, the shop does the sending. */
export const sendOrder = safe(async function sendOrder(orderId: string, manual?: boolean) {
  const user = await requireUser();
  const text = await sendOrderFor(user, orderId, manual ? "manual" : "connector");
  refresh(orderId);
  return noted(text);
});

export const receiveOrder = safe(async function receiveOrder(orderId: string, formData: FormData) {
  const user = await requireUser();
  const text = await receiveOrderFor(user, orderId, formData);
  refresh(orderId);
  return noted(text);
});

export const closeOrder = safe(async function closeOrder(orderId: string) {
  const user = await requireUser();
  const text = await closeOrderFor(user, orderId);
  refresh(orderId);
  return noted(text);
});

export const cancelOrder = safe(async function cancelOrder(orderId: string) {
  const user = await requireUser();
  const text = await cancelOrderFor(user, orderId);
  refresh(orderId);
  return noted(text);
});

/** Suggestions for the "add a line" box: the shop's own items (any kind since package po-any-item) by number or words (25 at most). */
export async function findFabricItems(q: string): Promise<string[]> {
  const user = await requireUser();
  const t = String(q ?? "").trim().slice(0, 60);
  if (t.length < 2) return [];
  const words = t.split(/\s+/).slice(0, 5);
  const parts = await db.part.findMany({
    where: {
      shopId: user.shopId,
      consignLinkId: null,
      OR: [{ partNumber: { contains: t, mode: "insensitive" } }, { numberKeys: { has: numberKey(t) } }, { AND: words.map((w) => ({ description: { contains: w, mode: "insensitive" as const } })) }],
    },
    orderBy: { partNumber: "asc" },
    take: 25,
    select: { partNumber: true, description: true },
  });
  return parts.map((p) => `${p.partNumber} | ${p.description}`);
}

/** Settings -> Fabric: the ordering numbers (review weeks, safety stock, default lead time, Reorder now). A blank box keeps what is saved. */
export const saveOrderSettings = safe(async function saveOrderSettings(formData: FormData) {
  const user = await requireAdmin();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: ORDER_SELECT });
  const next = { ...shop } as OrderSettings;
  for (const f of ORDER_FIELDS) {
    const label = f.label.replace(/ \(.*$/, "");
    const raw = str(String(formData.get(f.key) ?? "").replace(/[%,]/g, ""));
    if (raw == null) continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < f.min || v > f.max) throw new UserError(`${label}: enter a number from ${f.min} to ${f.max}.`);
    if (f.kind === "int" && !Number.isInteger(v)) throw new UserError(`${label}: enter a whole number.`);
    next[f.key] = v;
  }
  await db.shop.update({ where: { id: user.shopId }, data: next });
  revalidatePath("/fabric");
  revalidatePath("/settings");
});
