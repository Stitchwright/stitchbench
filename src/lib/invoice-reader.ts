import "server-only";
// A photo of the packing slip or invoice fills in receiving (shop-features-round-2-design.md 1.10). Up to five pictures,
// one Assistant call each (feature read_invoice, the Stock helpers switch; only the picture goes out, never a customer);
// the program matches the lines to the order and the shop's items by item number (src/lib/invoice-reader-math.ts), in
// three groups: on the order (ticked), new to us (one tap makes the item), not on the order (unticked). "Receive these"
// receives the ticked order lines through the order's own receipt, the other ticked items as stock received, makes the
// new items with their stock, and updates the costs ticked (to the ten-thousandth). Every query by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireOn } from "@/lib/module-gate";
import { runAssistant, type Photo } from "@/lib/assistant/client";
import { partKeys, takeShopNumber } from "@/lib/parts";
import { receiveOrderFor } from "@/lib/fabric-orders";
import { afterArrival } from "@/lib/arrivals";
import { buildInvoiceRead, matchSlip, parseSlip, slipKey, type Matched, type SlipLine } from "@/lib/invoice-reader-math";

export const MAX_PAGES = 5;
const MAX_PHOTO_CHARS = 2_800_000;

const photoOf = (p: { data: string; mediaType: string }): Photo => {
  const mediaType = p.mediaType === "image/png" || p.mediaType === "image/webp" ? p.mediaType : "image/jpeg";
  const data = String(p.data ?? "").replace(/^data:[^,]*,/, "");
  if (!/^[A-Za-z0-9+/=]{100,}$/.test(data)) throw new UserError("Take the picture again: it didn't come through.");
  if (data.length > MAX_PHOTO_CHARS) throw new UserError("A picture is too large. Take it a little further away.");
  return { mediaType, data };
};

export type ReadRow = Matched & { name: string };

/** Read the pictures and match the lines. `orderId` null: received without an order (every line is an item or new). */
export async function readSlipFor(user: CurrentUser, a: { orderId: string | null; photos: { data: string; mediaType: string }[] }): Promise<{ rows: ReadRow[]; pages: number }> {
  await requireOn(user, "assistant");
  const photos = (Array.isArray(a.photos) ? a.photos : []).slice(0, MAX_PAGES + 1);
  if (!photos.length) throw new UserError("Take or choose a picture of the packing slip first.");
  if (photos.length > MAX_PAGES) throw new UserError(`Up to ${MAX_PAGES} pictures at a time.`);
  const po = a.orderId ? await db.purchaseOrder.findFirst({ where: { id: a.orderId, shopId: user.shopId }, include: { lines: { include: { part: { select: { numberKeys: true } } } } } }) : null;
  if (a.orderId && !po) throw new UserError("Order not found.");
  if (po && (po.status === "DRAFT" || po.status === "RECEIVED" || po.status === "CANCELLED")) throw new UserError(`Order #${po.number} isn't waiting for anything (${po.status === "DRAFT" ? "not sent yet" : po.status === "RECEIVED" ? "all in" : "cancelled"}).`);
  const slip: SlipLine[] = [];
  for (const [i, p] of photos.entries()) {
    const { text } = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildInvoiceRead(i + 1, photos.length, po?.supplierName ?? null), photo: photoOf(p), target: po ? { purchaseOrderId: po.id } : {} });
    const lines = parseSlip(text);
    if (lines) slip.push(...lines);
  }
  if (!slip.length) throw new UserError("The Assistant couldn't read any lines from that. Take the picture again, flat and in good light, or receive it by hand.");
  const keys = [...new Set(slip.map((s) => (s.itemNumber ? slipKey(s.itemNumber) : "")).filter(Boolean))];
  const items = keys.length
    ? await db.part.findMany({ where: { shopId: user.shopId, consignLinkId: null, kind: { not: "MACHINE" }, numberKeys: { hasSome: keys } }, select: { id: true, partNumber: true, description: true, numberKeys: true, costTenThou: true, costCents: true } })
    : [];
  const orderLines = (po?.lines ?? []).map((l) => ({ id: l.id, partId: l.partId, itemNumber: l.itemNumber, qty: l.qty, receivedYards: l.receivedYards, unit: l.unit, costCents: l.costCents, keys: l.part?.numberKeys ?? [] }));
  // Items on the order but not found by number among the shop's items are still known through the order lines.
  const orderItemIds = orderLines.map((l) => l.partId).filter((x): x is string => !!x && !items.some((i) => i.id === x));
  const more = orderItemIds.length ? await db.part.findMany({ where: { shopId: user.shopId, id: { in: orderItemIds } }, select: { id: true, partNumber: true, description: true, numberKeys: true, costTenThou: true, costCents: true } }) : [];
  const all = [...items, ...more].map((i) => ({ ...i, keys: i.numberKeys }));
  const matched = matchSlip(slip, orderLines, all);
  return {
    pages: photos.length,
    rows: matched.map((m) => ({ ...m, name: m.group === "new" ? m.slip.description || m.slip.itemNumber || "" : (all.find((i) => i.id === m.partId)?.description ?? m.slip.description) })),
  };
}

export type ReceiveRow = {
  group: "order" | "item" | "new";
  lineId?: string | null;
  partId?: string | null;
  qty: number;
  /** The slip's cost each, in ten-thousandths of a dollar, and whether to make it the item's cost. */
  costTenThou?: number | null;
  updateCost?: boolean;
  itemNumber?: string | null;
  description?: string | null;
};

/** "Receive these": the ticked rows received, new items made, costs updated as ticked. Returns what happened, in words. */
export async function receiveSlipFor(user: CurrentUser, a: { orderId: string | null; rows: ReceiveRow[] }): Promise<string> {
  await requireBaseWritable(user);
  const rows = (Array.isArray(a.rows) ? a.rows : []).filter((r) => r && Number(r.qty) > 0).slice(0, 300);
  if (!rows.length) throw new UserError("Tick what came.");
  if (user.role === "TECH" && rows.some((r) => r.updateCost)) throw new UserError("Only an owner or admin can change costs. Untick the new costs.");
  const po = a.orderId ? await db.purchaseOrder.findFirst({ where: { id: a.orderId, shopId: user.shopId }, include: { lines: true, supplier: true } }) : null;
  if (a.orderId && !po) throw new UserError("Order not found.");
  const words: string[] = [];
  const costOf = (r: ReceiveRow) => (r.costTenThou != null && Number.isInteger(r.costTenThou) && r.costTenThou > 0 && r.costTenThou < 1_000_000_000 ? r.costTenThou : null);

  // On the order: through the order's own receipt (stock, lead time, special orders, want lists).
  const onOrder = rows.filter((r) => r.group === "order");
  if (onOrder.length) {
    if (!po) throw new UserError("Those lines need their order.");
    const fd = new FormData();
    for (const r of onOrder) {
      const line = po.lines.find((l) => l.id === r.lineId);
      if (!line) throw new UserError("A line isn't on this order any more. Read the slip again.");
      fd.set(`yards.${line.id}`, String(r.qty));
      fd.set(`seen.${line.id}`, String(line.receivedYards));
    }
    words.push(await receiveOrderFor(user, po.id, fd));
  }

  // Our items not on the order: received by hand.
  const loose = rows.filter((r) => r.group === "item");
  if (loose.length) {
    const ids = [...new Set(loose.map((r) => r.partId).filter((x): x is string => !!x))];
    const parts = new Map((await db.part.findMany({ where: { shopId: user.shopId, id: { in: ids }, consignLinkId: null, kind: { not: "MACHINE" } } })).map((p) => [p.id, p]));
    for (const r of loose) {
      const p = r.partId ? parts.get(r.partId) : null;
      if (!p) throw new UserError("An item isn't in your inventory any more. Read the slip again.");
      const qty = p.unit === "yd" ? Math.round(r.qty * 8) / 8 : Math.round(r.qty);
      if (!(qty > 0)) continue;
      await db.$transaction([
        db.part.update({ where: { id: p.id }, data: { qtyOnHand: { increment: qty } } }),
        db.stockMove.create({ data: { shopId: user.shopId, partId: p.id, qty, reason: "RECEIVED", userId: user.id, note: `Packing slip${po ? ` (not on order #${po.number})` : ""}` } }),
      ]);
    }
    const more = await afterArrival(
      user,
      loose.filter((r) => r.partId).map((r) => ({ partId: r.partId!, qty: r.qty })),
    );
    words.push(`${loose.length} ${loose.length === 1 ? "item" : "items"} not on the order received.${more ? ` ${more}` : ""}`);
  }

  // New to us: the item made with its stock.
  const fresh = rows.filter((r) => r.group === "new");
  for (const r of fresh) {
    const description = (r.description?.trim() || r.itemNumber?.trim() || "").slice(0, 200);
    if (!description) throw new UserError("A new item needs a description.");
    const cost = user.role === "TECH" ? null : costOf(r);
    const given = po?.supplier.defaultKind ?? "";
    const kind = (["PART", "ACCESSORY", "SUPPLY", "NOTION", "THREAD", "PATTERN"] as const).find((k) => k === given) ?? "NOTION";
    const qty = Math.round(r.qty);
    await db.$transaction(async (tx) => {
      const number = r.itemNumber?.trim().slice(0, 60) || (await takeShopNumber(tx, user.shopId));
      const clash = await tx.part.findFirst({ where: { shopId: user.shopId, partNumber: { equals: number, mode: "insensitive" } }, select: { id: true } });
      if (clash) throw new UserError(`${number} is already one of your items. Read the slip again.`);
      await tx.part.create({
        data: {
          shopId: user.shopId,
          partNumber: number,
          ownNumber: !r.itemNumber?.trim(),
          numberKeys: partKeys(number, []),
          description,
          kind,
          supplier: po?.supplierName ?? null,
          qtyOnHand: qty,
          ...(cost != null ? { costTenThou: cost, costCents: Math.round(cost / 100) } : {}),
          moves: { create: { shopId: user.shopId, qty, reason: "RECEIVED", userId: user.id, note: "Packing slip: new item" } },
        },
      });
    });
  }
  if (fresh.length) words.push(`${fresh.length} new ${fresh.length === 1 ? "item" : "items"} made. Give ${fresh.length === 1 ? "it" : "them"} a price on ${fresh.length === 1 ? "its" : "their"} page.`);

  // New costs, as ticked.
  let costs = 0;
  for (const r of rows.filter((x) => x.updateCost && x.group !== "new")) {
    const cost = costOf(r);
    const partId = r.group === "order" ? po?.lines.find((l) => l.id === r.lineId)?.partId : r.partId;
    if (cost == null || !partId) continue;
    costs += (await db.part.updateMany({ where: { id: partId, shopId: user.shopId }, data: { costTenThou: cost, costCents: Math.round(cost / 100) } })).count;
    if (r.group === "order" && r.lineId) await db.purchaseOrderLine.updateMany({ where: { id: r.lineId, shopId: user.shopId }, data: { costCents: Math.round(cost / 100) } });
  }
  if (costs) words.push(`${costs} ${costs === 1 ? "cost" : "costs"} updated.`);
  return words.join(" ");
}
