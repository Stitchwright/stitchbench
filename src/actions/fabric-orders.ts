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
import { addLineFor, addToDraftFor, cancelOrderFor, closeOrderFor, createOrderFor, receiveOrderFor, saveConnectorFor, saveOrderFor, saveSupplierFor, sendOrderFor } from "@/lib/fabric-orders";

const refresh = (id?: string) => {
  revalidatePath("/fabric");
  revalidatePath("/parts");
  if (id) revalidatePath(`/fabric/orders/${id}`);
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

export const startOrder = safe(async function startOrder(formData: FormData) {
  const user = await requireUser();
  const id = await createOrderFor(user, str(formData.get("supplier")) ?? "");
  refresh();
  redirect(`/fabric/orders/${id}`);
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

/** Suggestions for the "add a line" box: the shop's own fabric by number or words (25 at most). */
export async function findFabricItems(q: string): Promise<string[]> {
  const user = await requireUser();
  const t = String(q ?? "").trim().slice(0, 60);
  if (t.length < 2) return [];
  const words = t.split(/\s+/).slice(0, 5);
  const parts = await db.part.findMany({
    where: {
      shopId: user.shopId,
      kind: "FABRIC",
      unit: "yd",
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
