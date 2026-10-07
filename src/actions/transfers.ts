"use server";

// Stock between stores (shop-features-round-2-design.md 7.2, 7.3, 7.7): send, ask, send what was asked, can't this
// time, it arrived, cancel; a purchase order's share for another store.
import { revalidatePath } from "next/cache";
import { noted, safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { arrivedTransferFor, askStockFor, cancelTransferFor, declineAskedFor, sendAskedFor, sendStockFor } from "@/lib/transfers";
import { saveSplitFor, sendShareFor } from "@/lib/store-orders";
import { requireBaseWritable } from "@/lib/base-gate";
import { db } from "@/lib/db";
import { numberKey } from "@/lib/parts";
import { mainStoreId } from "@/lib/stores";

const refresh = () => {
  revalidatePath("/parts", "layout");
  revalidatePath("/today");
};

/** The quantities typed per line: fields named `<prefix>.<lineId>`. */
function perLine(fd: FormData | undefined, prefix: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!fd) return out;
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith(`${prefix}.`) || typeof v !== "string" || !v.trim()) continue;
    const n = Number(v.trim());
    if (!Number.isFinite(n)) throw new UserError("Enter numbers only.");
    out[k.slice(prefix.length + 1)] = n;
  }
  return out;
}

/** From an item's page: "Send to <store>" (how many, which store). */
export const sendItem = safe(async function sendItem(partId: string, formData: FormData) {
  const user = await requireUser();
  await requireBaseWritable(user);
  const t = await sendStockFor(user, { toId: String(formData.get("toId") ?? ""), lines: [{ partId: String(partId), qty: Number(formData.get("qty")) }], note: str(formData.get("note")) });
  refresh();
  return noted(`Sent (transfer ${t.number}). The other store taps It arrived when it's there.`);
});

/** From an item's page: "Ask <store> to send some". */
export const askItem = safe(async function askItem(partId: string, formData: FormData) {
  const user = await requireUser();
  await requireBaseWritable(user);
  const t = await askStockFor(user, { fromId: String(formData.get("fromId") ?? ""), lines: [{ partId: String(partId), qty: Number(formData.get("qty")) }], note: str(formData.get("note")), neededBy: str(formData.get("neededBy")) });
  refresh();
  return noted(`Asked (request ${t.number}). You'll see Sent when they send it.`);
});

/** A machine for sale to another store. */
export const sendUnit = safe(async function sendUnit(unitId: string, formData: FormData) {
  const user = await requireUser();
  await requireBaseWritable(user);
  // From the store the machine is at (whatever store this computer is at).
  const unit = await db.stockUnit.findFirst({ where: { id: String(unitId), shopId: user.shopId }, select: { locationId: true } });
  if (!unit) throw new UserError("That machine isn't one of yours.");
  const fromId = unit.locationId ?? (await mainStoreId(user.shopId));
  const t = await sendStockFor(user, { toId: String(formData.get("toId") ?? ""), fromId, lines: [{ unitId: String(unitId) }], note: str(formData.get("note")) });
  revalidatePath("/units", "layout");
  refresh();
  return noted(`Sent (transfer ${t.number}).`);
});

/** The Between stores page: one item by its number (any capitals, or a number it goes by). */
export const sendByNumber = safe(async function sendByNumber(formData: FormData) {
  const user = await requireUser();
  await requireBaseWritable(user);
  const number = (str(formData.get("number")) ?? "").split(" | ")[0].trim();
  if (!number) throw new UserError("Type the item's number.");
  const part = await db.part.findFirst({ where: { shopId: user.shopId, consignLinkId: null, OR: [{ partNumber: { equals: number, mode: "insensitive" } }, { numberKeys: { has: numberKey(number) } }] }, select: { id: true } });
  if (!part) throw new UserError(`No item numbered ${number}. Check the number, or open the item and send it from there.`);
  const t = await sendStockFor(user, { toId: String(formData.get("toId") ?? ""), lines: [{ partId: part.id, qty: Number(formData.get("qty")) }] });
  refresh();
  return noted(`Sent (transfer ${t.number}).`);
});

/** The Between stores page: several items at once (lines as partId:qty pairs from the form). */
export const sendMany = safe(async function sendMany(formData: FormData) {
  const user = await requireUser();
  await requireBaseWritable(user);
  const lines = formData.getAll("partId").map((p, i) => ({ partId: String(p), qty: Number(formData.getAll("qty")[i]) })).filter((l) => l.partId && l.qty > 0);
  const t = await sendStockFor(user, { toId: String(formData.get("toId") ?? ""), lines, note: str(formData.get("note")) });
  refresh();
  return noted(`Sent (transfer ${t.number}).`);
});

export const sendAsked = safe(async function sendAsked(id: string, formData?: FormData) {
  const user = await requireUser();
  await requireBaseWritable(user);
  await sendAskedFor(user, String(id), perLine(formData, "qty"));
  refresh();
  return noted("Sent. They tap It arrived when it's there.");
});

export const declineAsked = safe(async function declineAsked(id: string, formData: FormData) {
  const user = await requireUser();
  await declineAskedFor(user, String(id), str(formData.get("reason")));
  refresh();
});

export const transferArrived = safe(async function transferArrived(id: string, formData?: FormData) {
  const user = await requireUser();
  const words = await arrivedTransferFor(user, String(id), perLine(formData, "got"));
  refresh();
  revalidatePath("/special-orders");
  return noted(words);
});

export const cancelTransfer = safe(async function cancelTransfer(id: string) {
  const user = await requireUser();
  await cancelTransferFor(user, String(id));
  refresh();
});

/**
 * The register's "Bring it here for her" (7.3): her special order was just taken here (paid or a deposit); the other
 * store is asked to send it, holding it for her meanwhile, and she hears it's here when it arrives. The order counts as
 * ordered (from the other store, not a supplier).
 */
export const bringItHere = safe(async function bringItHere(orderId: string, fromId: string) {
  const user = await requireUser();
  const o = await db.specialOrder.findFirst({ where: { id: String(orderId), shopId: user.shopId }, include: { customer: { select: { name: true } } } });
  if (!o || !o.partId || !o.customerId) throw new UserError("Special order not found.");
  if (o.status !== "WAITING" && o.status !== "ORDERED") throw new UserError(`Special order ${o.number} isn't waiting any more.`);
  const t = await askStockFor(user, { fromId: String(fromId), lines: [{ partId: o.partId, qty: o.qty }], forCustomerId: o.customerId, specialOrderId: o.id, note: `For ${o.customer?.name ?? "a customer"}, special order ${o.number}` });
  await db.specialOrder.updateMany({ where: { id: o.id, shopId: user.shopId, status: "WAITING" }, data: { status: "ORDERED", note: [o.note, `Coming from another store (request ${t.number}).`].filter(Boolean).join("\n").slice(0, 500) } });
  refresh();
  revalidatePath("/special-orders");
  return noted(t.held ? `Asked the other store to send it (request ${t.number}); it's held for her there. She hears when it's here.` : `Asked the other store to send it (request ${t.number}). They don't have enough on the shelf right now, so they'll decide; she hears when it's here.`);
});

/** "Which store gets what" on a purchase order. */
export const saveSplit = safe(async function saveSplit(orderId: string, formData: FormData) {
  const user = await requireUser();
  await saveSplitFor(user, String(orderId), formData);
  revalidatePath(`/parts/orders/${orderId}`);
});

/** A purchase order received here: "Send <store>'s share" fills in the transfer from the order's split. */
export const sendShare = safe(async function sendShare(orderId: string, storeId: string) {
  const user = await requireUser();
  await requireBaseWritable(user);
  const r = await sendShareFor(user, String(orderId), String(storeId));
  refresh();
  revalidatePath("/parts/orders", "layout");
  return noted(r);
});
