"use server";

// Partner orders (a sewing shop buying parts, notions and accessories from its repair shop) and consignment stock
// (the repair shop's items on the sewing shop's shelf, paid for as they sell).
import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError, isUserError } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { str, toCents } from "@/lib/format";
import { numberKey, partKeys } from "@/lib/parts";
import { orderTotal, partnerLink, sendToPartner, type CatalogItem, type JobEvent, type OrderLine } from "@/lib/partners";
import type { Prisma } from "@/generated/prisma/client";
import type { PartKind } from "@/generated/prisma/enums";

type Json = Prisma.InputJsonValue;
const KINDS = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"];

function refresh(linkId: string) {
  revalidatePath(`/partners/${linkId}`, "layout");
  revalidatePath("/parts", "layout");
}

/**
 * A quantity as typed, or null when it isn't one: whole pieces for most things, yards to the thousandth for fabric,
 * never negative. A fraction of something sold each could never be sold off, on either shop's shelf.
 */
function qtyFor(raw: string | null, unit: string | null | undefined) {
  const n = Number(raw ?? "NaN");
  if (!Number.isFinite(n) || n < 0) return null;
  if (unit === "yd") return Math.round(n * 1000) / 1000;
  return Number.isInteger(n) ? n : null;
}

// ---------- orders ----------

/** Sewing shop: order from the repair shop's catalog. */
export async function placePartnerOrder(linkId: string, wanted: { itemKey: string; qty: number }[], note: string | null): Promise<{ id: string } | { error: string }> {
  try {
    const user = await requireUser();
    const link = await partnerLink(user.shopId, linkId);
    if (link.side !== "retail") throw new UserError("Orders go from the sewing shop to its repair shop.");
    if (link.status !== "ACTIVE") throw new UserError("That partnership has ended.");
    const catalog = new Map(((link.catalog as CatalogItem[] | null) ?? []).map((c) => [c.itemKey, c]));
    const lines: OrderLine[] = [];
    for (const w of wanted) {
      const c = catalog.get(w.itemKey);
      if (!c) throw new UserError("Something in the order isn't in the catalog any more. Refresh and try again.");
      // Whole pieces, or yards to the thousandth; checked after rounding so nothing becomes a line of 0.
      const raw = Number(w.qty);
      const qty = c.unit === "yd" ? Math.round(raw * 1000) / 1000 : Math.round(raw);
      if (!(qty > 0) || qty > 10000) continue;
      lines.push({ itemKey: c.itemKey, partNumber: c.partNumber, description: c.description, qty, unitCents: c.wholesaleCents });
    }
    if (!lines.length) throw new UserError("Add at least one item with a quantity.");
    const id = crypto.randomUUID();
    const at = new Date();
    await db.$transaction(async (tx) => {
      const sh = await tx.shop.update({ where: { id: user.shopId }, data: { nextOrderNumber: { increment: 1 } }, select: { nextOrderNumber: true } });
      const number = `PO-${sh.nextOrderNumber - 1}`;
      await tx.partnerOrder.create({
        data: {
          id,
          shopId: user.shopId,
          linkId,
          side: "buyer",
          number,
          lines: lines as Json,
          totalCents: orderTotal(lines),
          note: note?.slice(0, 1000) || null,
          events: [{ at: at.toISOString(), status: "PLACED", note: `by ${user.name}` }] as Json,
          createdAt: at,
        },
      });
      await sendToPartner(user.shopId, linkId, "order.new", { id, number, lines, note: note?.slice(0, 1000) || null, name: user.name, at: at.toISOString() }, tx);
    });
    refresh(linkId);
    return { id };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

type OrderAction = "accept" | "deliver" | "cancel" | "receive";

export const partnerOrderAction = safe(async function partnerOrderAction(orderId: string, action: OrderAction, formData: FormData) {
  const user = await requireUser();
  const shopId = user.shopId;
  const o = await db.partnerOrder.findUnique({ where: { shopId_id: { shopId, id: orderId } } });
  if (!o) throw new UserError("Order not found.");
  const link = await partnerLink(shopId, o.linkId);
  const lines = o.lines as OrderLine[];
  const at = new Date();
  const note = str(formData.get("note"));
  let status = o.status;
  const extra: Record<string, unknown> = {};

  await db.$transaction(async (tx) => {
    if (o.side === "seller" && action === "accept") {
      if (o.status !== "PLACED") throw new UserError("Only a new order can be accepted.");
      status = "ACCEPTED";
    } else if (o.side === "seller" && action === "deliver") {
      if (!["PLACED", "ACCEPTED"].includes(o.status)) throw new UserError("This order was already delivered or cancelled.");
      status = "DELIVERED";
      extra.carrier = str(formData.get("carrier"));
      extra.tracking = str(formData.get("tracking"));
      // Out of the repair shop's stock.
      for (const l of lines) {
        const part = await tx.part.findFirst({ where: { id: l.itemKey, shopId } });
        if (!part) continue;
        await tx.part.update({ where: { id: part.id }, data: { qtyOnHand: { decrement: l.qty } } });
        await tx.stockMove.create({ data: { shopId, partId: part.id, qty: -l.qty, reason: "SOLD", userId: user.id, note: `${o.number} to ${link.partnerName}`, createdAt: at } });
      }
    } else if (action === "cancel") {
      if (o.side === "buyer" && o.status !== "PLACED") throw new UserError("The repair shop already accepted it. Ask them to cancel.");
      if (o.side === "seller" && !["PLACED", "ACCEPTED"].includes(o.status)) throw new UserError("A delivered order can't be cancelled.");
      status = "CANCELLED";
    } else if (o.side === "buyer" && action === "receive") {
      if (o.status !== "DELIVERED") throw new UserError("Receive it once the repair shop marks it delivered.");
      status = "RECEIVED";
      // Onto this shop's shelf: the same item if it's stocked already, else a new one.
      const catalog = new Map(((link.catalog as CatalogItem[] | null) ?? []).map((c) => [c.itemKey, c]));
      for (const l of lines) {
        const key = numberKey(l.partNumber);
        let part =
          (await tx.part.findFirst({ where: { shopId, partNumber: l.partNumber, consignLinkId: null } })) ??
          (key.length >= 3 ? await tx.part.findFirst({ where: { shopId, numberKeys: { has: key }, consignLinkId: null } }) : null);
        if (!part) {
          const c = catalog.get(l.itemKey);
          const kind = (c && KINDS.includes(c.kind) ? c.kind : "PART") as PartKind;
          // The number may already be the partner's consigned item on this shelf; this shop's own stock is kept apart.
          const taken = await tx.part.findUnique({ where: { shopId_partNumber: { shopId, partNumber: l.partNumber } } });
          part = await tx.part.create({
            data: {
              shopId,
              partNumber: taken ? `${l.partNumber} (own)` : l.partNumber,
              altNumbers: taken ? [l.partNumber] : [],
              description: l.description,
              kind,
              brand: c?.brand ?? null,
              unit: c?.unit ?? null,
              priceCents: c?.retailCents ?? null,
              costCents: l.unitCents,
              supplier: link.partnerName,
              numberKeys: partKeys(taken ? `${l.partNumber} (own)` : l.partNumber, [l.partNumber]),
            },
          });
        }
        await tx.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: l.qty }, costCents: l.unitCents } });
        await tx.stockMove.create({ data: { shopId, partId: part.id, qty: l.qty, reason: "RECEIVED", userId: user.id, note: `${o.number} from ${link.partnerName}`, createdAt: at } });
      }
    } else {
      throw new UserError("That can't be done to this order.");
    }
    const events = [...((o.events as JobEvent[]) ?? []), { at: at.toISOString(), status, note: [note, `by ${user.name}`].filter(Boolean).join(" ") }];
    await tx.partnerOrder.update({
      where: { shopId_id: { shopId, id: o.id } },
      data: {
        status,
        events: events as Json,
        ...(status === "DELIVERED" ? { deliveredAt: at, carrier: extra.carrier as string | null, tracking: extra.tracking as string | null } : {}),
        ...(status === "RECEIVED" ? { receivedAt: at } : {}),
        ...(o.side === "seller" && note ? { sellerNote: note } : {}),
      },
    });
    await sendToPartner(
      shopId,
      o.linkId,
      "order.update",
      { id: o.id, status, ...extra, ...(o.side === "seller" && note ? { sellerNote: note } : {}), eventNote: note, at: at.toISOString() },
      tx,
    );
  });
  refresh(o.linkId);
});

// ---------- consignment ----------

/** Repair shop: put some of its stock on the sewing shop's shelf. */
export const placeConsignment = safe(async function placeConsignment(linkId: string, formData: FormData) {
  const admin = await requireAdmin();
  const shopId = admin.shopId;
  const link = await partnerLink(shopId, linkId);
  if (link.side !== "repair") throw new UserError("The repair shop places its stock with the sewing shop.");
  if (link.status !== "ACTIVE") throw new UserError("That partnership has ended.");
  const pn = str(formData.get("partNumber"))?.split(" | ")[0].trim();
  const part = pn
    ? ((await db.part.findFirst({ where: { shopId, partNumber: pn } })) ?? (await db.part.findFirst({ where: { shopId, numberKeys: { has: numberKey(pn) } } })))
    : null;
  if (!part) throw new UserError("Pick an item from your inventory.");
  const qty = qtyFor(str(formData.get("qty")), part.unit);
  if (!qty) throw new UserError(part.unit === "yd" ? "Enter how many yards you're leaving there." : "Enter how many you're leaving there, in whole pieces.");
  const price = toCents(formData.get("price")) ?? part.priceCents;
  if (!price) throw new UserError("Set the shelf price (what the customer pays).");
  const at = new Date();
  await db.$transaction(async (tx) => {
    await tx.part.update({ where: { id: part.id }, data: { qtyOnHand: { decrement: qty } } });
    await tx.stockMove.create({ data: { shopId, partId: part.id, qty: -qty, reason: "CONSIGNED", userId: admin.id, note: `Placed at ${link.partnerName}`, createdAt: at } });
    await tx.consignItem.upsert({
      where: { shopId_linkId_itemKey: { shopId, linkId, itemKey: part.id } },
      create: { shopId, linkId, side: "owner", itemKey: part.id, partId: part.id, partNumber: part.partNumber, description: part.description, priceCents: price, placed: qty },
      update: { placed: { increment: qty }, priceCents: price },
    });
    await sendToPartner(
      shopId,
      linkId,
      "consign.place",
      {
        id: crypto.randomUUID(),
        items: [{ itemKey: part.id, partNumber: part.partNumber, description: part.description, kind: part.kind, brand: part.brand, unit: part.unit, priceCents: price, qty }],
        at: at.toISOString(),
      },
      tx,
    );
  });
  refresh(linkId);
});

/**
 * Consigned stock going back to the repair shop. The sewing shop records it (it hands the stock over), so one hand-off
 * is never counted by both shops; the repair shop hears about it. Once the partnership has ended there's no one there
 * to record it, so the owner takes what's still out back into its own stock.
 */
export const returnConsigned = safe(async function returnConsigned(linkId: string, itemKey: string, formData: FormData) {
  const user = await requireUser();
  const shopId = user.shopId;
  const link = await partnerLink(shopId, linkId);
  if (link.side !== "retail" && link.status === "ACTIVE") throw new UserError(`${link.partnerName} records stock going back when they hand it to you.`);
  const item = await db.consignItem.findUnique({ where: { shopId_linkId_itemKey: { shopId, linkId, itemKey } } });
  if (!item) throw new UserError("That item isn't on consignment here.");
  const onShelf = item.placed - item.sold - item.returned;
  // This shop's inventory entry for it: the owner's own part, or the sewing shop's copy of it.
  const partId = link.side === "repair" ? itemKey : item.partId;
  const part = partId ? await db.part.findFirst({ where: { id: partId, shopId } }) : null;
  const qty = qtyFor(str(formData.get("qty")), part?.unit);
  if (!qty || qty > onShelf + 1e-9) throw new UserError(part?.unit === "yd" ? `Up to ${onShelf} yards can go back.` : `Between 1 and ${onShelf} whole pieces can go back.`);
  const at = new Date();
  // The shelf record, this shop's stock and the word to the partner move together or not at all: a return the
  // partner never hears of would leave its shelf count high and its stock short for good.
  const back = await db.$transaction(async (tx) => {
    // Only counts if the shelf still had it when this ran (two returns at once can't both take the same units).
    const took = await tx.consignItem.updateMany({ where: { id: item.id, returned: item.returned }, data: { returned: { increment: qty } } });
    if (!took.count) return 0;
    const sign = link.side === "repair" ? 1 : -1; // back on the repair shop's shelf; off the sewing shop's
    if (part) {
      await tx.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: sign * qty } } });
      await tx.stockMove.create({
        data: { shopId, partId: part.id, qty: sign * qty, reason: "CONSIGNED", userId: user.id, note: link.side === "repair" ? `Back from ${link.partnerName}` : `Returned to ${link.partnerName}`, createdAt: at },
      });
    }
    if (link.side === "retail") await sendToPartner(shopId, linkId, "consign.return", { id: crypto.randomUUID(), items: [{ itemKey, qty }], at: at.toISOString() }, tx);
    return qty;
  });
  if (!back) throw new UserError("Nothing went back: the shelf count changed meanwhile. Reload and try again.");
  refresh(linkId);
});

/** Sewing shop: the shelf count of the repair shop's items (sent to the repair shop; the shop's stock is corrected). */
export const countConsigned = safe(async function countConsigned(linkId: string, formData: FormData) {
  const user = await requireUser();
  const shopId = user.shopId;
  const link = await partnerLink(shopId, linkId);
  if (link.side !== "retail") throw new UserError("The sewing shop counts the shelf.");
  const items = await db.consignItem.findMany({ where: { shopId, linkId } });
  const counted: { itemKey: string; onHand: number }[] = [];
  const at = new Date();
  await db.$transaction(async (tx) => {
    for (const it of items) {
      const v = str(formData.get(`count_${it.itemKey}`));
      if (v == null) continue;
      const part = it.partId ? await tx.part.findFirst({ where: { id: it.partId, shopId } }) : null;
      const n = qtyFor(v, part?.unit);
      if (n == null) throw new UserError(`Check the count for ${it.partNumber}${part?.unit === "yd" ? "" : ": whole pieces, 0 or more"}.`);
      counted.push({ itemKey: it.itemKey, onHand: n });
      await tx.consignItem.update({ where: { id: it.id }, data: { countedQty: n, countedAt: at } });
      if (part && part.qtyOnHand !== n) {
        await tx.part.update({ where: { id: part.id }, data: { qtyOnHand: n } });
        await tx.stockMove.create({ data: { shopId, partId: part.id, qty: n - part.qtyOnHand, reason: "ADJUSTED", userId: user.id, note: "Consignment shelf count", createdAt: at } });
      }
    }
    if (!counted.length) throw new UserError("Enter at least one count.");
    await sendToPartner(shopId, linkId, "consign.count", { id: crypto.randomUUID(), items: counted, at: at.toISOString() }, tx);
  });
  refresh(linkId);
});
