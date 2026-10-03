"use server";

// Partner orders (a sewing shop buying parts, notions and accessories from its repair shop) and consignment stock
// (the repair shop's items on the sewing shop's shelf, paid for as they sell).
import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError, isUserError } from "@/lib/action";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireAdmin, requireUser } from "@/lib/session";
import { str, toCents } from "@/lib/format";
import { numberKey, partKeys, partNumberClash, stockFor } from "@/lib/parts";
import { asCondition, asOrigin, labelFields } from "@/lib/part-labels";
import { answerConsignReturn, consignReturned, MAX_MONEY, MAX_QTY, orderTotal, partnerLink, sendToPartner, type CatalogItem, type JobEvent, type OrderLine } from "@/lib/partners";
import type { Prisma } from "@/generated/prisma/client";
import type { PartKind } from "@/generated/prisma/enums";

type Json = Prisma.InputJsonValue;
const KINDS = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"];

function refresh(linkId: string) {
  revalidatePath(`/partners/${linkId}`, "layout");
  revalidatePath("/parts", "layout");
}

// ---------- orders ----------

/** Sewing shop: order from the repair shop's catalog. */
export async function placePartnerOrder(linkId: string, wanted: { itemKey: string; qty: number }[], note: string | null): Promise<{ id: string } | { error: string }> {
  try {
    const user = await requireUser();
    await requireBaseWritable(user); // a new order: refused while the program is read-only
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
      lines.push({ itemKey: c.itemKey, partNumber: c.partNumber, description: c.description, qty, unitCents: c.wholesaleCents, ...labelFields(c) });
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

export const partnerOrderAction = safe.whileLapsed("partnerOrderAction")(async function partnerOrderAction(orderId: string, action: OrderAction, formData: FormData) {
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
    // First claim the change: only while the order still stands as it was read. Two clicks at once (two tabs, two
    // people) would otherwise both pass the checks below and both move the stock.
    const claim = async () => {
      const r = await tx.partnerOrder.updateMany({ where: { shopId, id: o.id, status: o.status }, data: { status } });
      if (!r.count) throw new UserError("This order changed meanwhile. Reload and try again.");
    };
    if (o.side === "seller" && action === "accept") {
      if (o.status !== "PLACED") throw new UserError("Only a new order can be accepted.");
      status = "ACCEPTED";
      await claim();
    } else if (o.side === "seller" && action === "deliver") {
      if (!["PLACED", "ACCEPTED"].includes(o.status)) throw new UserError("This order was already delivered or cancelled.");
      status = "DELIVERED";
      await claim();
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
      await claim();
    } else if (o.side === "buyer" && action === "receive") {
      if (o.status !== "DELIVERED") throw new UserError("Receive it once the repair shop marks it delivered.");
      status = "RECEIVED";
      await claim();
      // Onto this shop's shelf: the same item if it's stocked already, else a new one.
      const catalog = new Map(((link.catalog as CatalogItem[] | null) ?? []).map((c) => [c.itemKey, c]));
      for (const l of lines) {
        const key = numberKey(l.partNumber);
        // What was sold, as the repair shop has it (a line from before that was sent says nothing: New, Genuine). Units
        // of a used part don't go into the count of a new one.
        const condition = asCondition(l.condition) ?? "NEW";
        const origin = asOrigin(l.origin) ?? "GENUINE";
        const stock = await stockFor(tx, shopId, l.partNumber, condition);
        let part =
          stock.existing ??
          (key.length >= 3 ? await tx.part.findFirst({ where: { shopId, numberKeys: { has: key }, consignLinkId: null, condition }, select: { id: true } }) : null);
        if (!part) {
          const c = catalog.get(l.itemKey);
          const kind = (c && KINDS.includes(c.kind) ? c.kind : "PART") as PartKind;
          // The number may already be the partner's consigned item on this shelf, or this shop's own stock in another
          // condition; this stock is kept apart.
          part = await tx.part.create({
            data: {
              shopId,
              partNumber: stock.partNumber,
              altNumbers: stock.altNumbers,
              description: l.description,
              kind,
              condition,
              origin,
              brand: c?.brand ?? null,
              unit: c?.unit ?? null,
              priceCents: c?.retailCents ?? null,
              costCents: l.unitCents,
              supplier: link.partnerName,
              numberKeys: partKeys(stock.partNumber, [l.partNumber]),
            },
          }).catch(async (e) => {
            // The same number added (in any case) at the same moment hits the case-insensitive index: say so.
            throw await partNumberClash(e, shopId, stock.partNumber);
          });
        }
        await tx.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: l.qty }, costCents: l.unitCents, costTenThou: null } });
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
    // The seller's lines and total go along, so the buyer's copy matches what the seller delivers and bills.
    const copy = o.side === "seller" ? { lines, totalCents: o.totalCents } : {};
    await sendToPartner(
      shopId,
      o.linkId,
      "order.update",
      { id: o.id, status, ...extra, ...copy, ...(o.side === "seller" && note ? { sellerNote: note } : {}), eventNote: note, at: at.toISOString() },
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
  const raw = Number(str(formData.get("qty")) ?? "0");
  const qty = part.unit === "yd" ? Math.round(raw * 1000) / 1000 : Math.round(raw);
  if (!(qty > 0)) throw new UserError("Enter how many you're leaving there.");
  // The same limits the sewing shop's install holds a placement to: past them it would refuse it, after this shop had
  // already taken the stock off its shelf.
  if (qty > MAX_QTY) throw new UserError(`At most ${MAX_QTY.toLocaleString("en-US")} at a time.`);
  const price = toCents(formData.get("price")) ?? part.priceCents;
  if (price == null || !(price > 0) || price > MAX_MONEY) throw new UserError("Set the shelf price (what the customer pays).");
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
        items: [{ itemKey: part.id, partNumber: part.partNumber, description: part.description, kind: part.kind, brand: part.brand, unit: part.unit, priceCents: price, qty, ...labelFields(part) }],
        at: at.toISOString(),
      },
      tx,
    );
  });
  refresh(linkId);
});

/** Consigned stock going back to the repair shop (either shop records it; the other hears about it). */
export const returnConsigned = safe(async function returnConsigned(linkId: string, itemKey: string, formData: FormData) {
  const user = await requireUser();
  const link = await partnerLink(user.shopId, linkId);
  // The sewing shop records a return (it hands the stock over), so one hand-off is never counted by both shops.
  if (link.side !== "retail") throw new UserError(`${link.partnerName} records stock going back when they hand it to you.`);
  const item = await db.consignItem.findUnique({ where: { shopId_linkId_itemKey: { shopId: user.shopId, linkId, itemKey } } });
  if (!item) throw new UserError("That item isn't on consignment here.");
  const onShelf = item.placed - item.sold - item.returned;
  // Whole pieces, or yards to the thousandth: the same as when it was placed, and as the repair shop reads it.
  const yards = (item.partId ? await db.part.findFirst({ where: { id: item.partId, shopId: user.shopId }, select: { unit: true } }) : null)?.unit === "yd";
  const raw = Number(str(formData.get("qty")) ?? "0");
  const qty = yards ? Math.round(raw * 1000) / 1000 : raw;
  if (!(qty > 0) || qty > onShelf + 1e-9) throw new UserError(yards ? `Up to ${onShelf} yards can go back.` : `Between 1 and ${onShelf} can go back.`);
  if (!yards && !Number.isInteger(qty)) throw new UserError("This item goes back in whole pieces. Enter a whole number.");
  const at = new Date();
  // The shelf change and the message to the repair shop are one transaction: neither happens without the other.
  const back = await db.$transaction(async (tx) => {
    const n = await consignReturned(user.shopId, link, itemKey, qty, at, tx);
    if (n) await sendToPartner(user.shopId, linkId, "consign.return", { id: crypto.randomUUID(), items: [{ itemKey, qty: n }], at: at.toISOString() }, tx);
    return n;
  });
  if (!back) throw new UserError("Nothing went back: the shelf count changed meanwhile. Reload and try again.");
  refresh(linkId);
});

/** Repair shop: the sewing shop's hand-off arrived, so it goes back on the shelf (like confirming a settlement payment). */
export const confirmConsignReturn = safe(async function confirmConsignReturn(linkId: string, itemKey: string) {
  const user = await requireAdmin();
  const link = await partnerLink(user.shopId, linkId);
  if (link.side !== "repair") throw new UserError("The repair shop confirms stock coming back.");
  if (!(await answerConsignReturn(user.shopId, link, itemKey, true, new Date()))) throw new UserError("Nothing is waiting to be confirmed for that item.");
  refresh(linkId);
});

/** Repair shop: it didn't arrive. The claim is dropped and nothing goes on the shelf. */
export const refuseConsignReturn = safe(async function refuseConsignReturn(linkId: string, itemKey: string) {
  const user = await requireAdmin();
  const link = await partnerLink(user.shopId, linkId);
  if (link.side !== "repair") throw new UserError("The repair shop confirms stock coming back.");
  if (!(await answerConsignReturn(user.shopId, link, itemKey, false, new Date()))) throw new UserError("Nothing is waiting to be confirmed for that item.");
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
      // Whole pieces, or yards to the thousandth.
      const yards = part?.unit === "yd";
      const n = yards ? Math.round(Number(v) * 1000) / 1000 : Number(v);
      if (!Number.isFinite(n) || n < 0 || n > MAX_QTY || (!yards && !Number.isInteger(n))) throw new UserError(`Check the count for ${it.partNumber}${yards ? "" : ": whole pieces only"}.`);
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
