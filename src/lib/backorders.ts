import "server-only";
// Back orders (shop-features-round-2-design.md 4.4): a purchase order line the supplier says is back ordered gets "Back
// ordered, expected 20 Nov" (one tap on the order's line). The Coming in list shows every line still to come on sent
// orders, back orders first, with who is waiting for the item (repair tickets waiting for the part); "Let them know"
// texts or emails each of them "your order is delayed until about 20 Nov" (message wording order_delay, never twice for
// the same day) and moves the ticket's expected day. Every query by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { moduleOn } from "@/lib/module-gate";
import { queueToCustomer } from "@/lib/messaging/queue";
import { messagingView } from "@/lib/messaging/settings";
import { plainText, renderKind } from "@/lib/messaging/templates";
import { OPEN_STATUSES, amountText, measureText, outstandingYards } from "@/lib/fabric-orders-math";
import { fmtYmdLong } from "@/lib/units/units";
import { ticketNo } from "@/lib/format";
import { customerVars } from "@/lib/messaging/customer-vars";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

async function openLine(user: CurrentUser, lineId: string) {
  const l = typeof lineId === "string" ? await db.purchaseOrderLine.findFirst({ where: { id: lineId, shopId: user.shopId }, include: { order: { select: { status: true, number: true } } } }) : null;
  if (!l) throw new UserError("Order line not found.");
  if (!(OPEN_STATUSES as string[]).includes(l.order.status)) throw new UserError("Only a line on a sent order can be back ordered.");
  if (outstandingYards(l) <= 1e-9) throw new UserError("That line has all come in.");
  return l;
}

/** "Back ordered": marks the line, with the day it's expected (YYYY-MM-DD, or none). Again: changes the day. */
export async function markBackorderFor(user: CurrentUser, lineId: string, expectedOn: string | null, now = new Date()): Promise<void> {
  await requireBaseWritable(user);
  const l = await openLine(user, lineId);
  const ymd = expectedOn?.trim() || null;
  if (ymd && !YMD.test(ymd)) throw new UserError("Pick the day it's expected, or leave it empty.");
  await db.purchaseOrderLine.updateMany({ where: { id: l.id, shopId: user.shopId }, data: { backorderedOn: l.backorderedOn ?? now, expectedOn: ymd } });
}

/** Takes the back-order mark off (the supplier found it). */
export async function clearBackorderFor(user: CurrentUser, lineId: string): Promise<void> {
  await requireBaseWritable(user);
  const r = await db.purchaseOrderLine.updateMany({ where: { id: lineId, shopId: user.shopId }, data: { backorderedOn: null, expectedOn: null } });
  if (!r.count) throw new UserError("Order line not found.");
}

export type ComingInRow = {
  lineId: string;
  orderId: string;
  orderNumber: number;
  supplier: string;
  partId: string | null;
  itemNumber: string;
  description: string;
  stillToCome: string;
  ordered: string;
  backordered: boolean;
  expectedOn: string | null;
  waiting: { ticketId: string; ticketNumber: string; customerId: string | null; name: string }[];
};

/** Every line still to come on a sent order: back orders first (soonest expected first), then by supplier. */
export async function comingIn(shopId: string): Promise<ComingInRow[]> {
  const lines = await db.purchaseOrderLine.findMany({
    where: { shopId, order: { status: { in: OPEN_STATUSES } } },
    include: { order: { select: { id: true, number: true, supplierName: true } } },
  });
  const open = lines.filter((l) => outstandingYards(l) > 1e-9);
  const partIds = [...new Set(open.map((l) => l.partId).filter((x): x is string => !!x))];
  const waits = partIds.length
    ? await db.partWait.findMany({ where: { shopId, partId: { in: partIds }, receivedAt: null, cancelledAt: null }, include: { ticket: { select: { id: true, number: true, customerId: true, customer: { select: { name: true } } } } } })
    : [];
  const byPart = new Map<string, ComingInRow["waiting"]>();
  for (const w of waits) {
    const list = byPart.get(w.partId!) ?? [];
    if (!list.some((x) => x.ticketId === w.ticketId)) list.push({ ticketId: w.ticket.id, ticketNumber: ticketNo(w.ticket.number), customerId: w.ticket.customerId, name: w.ticket.customer?.name ?? "Customer" });
    byPart.set(w.partId!, list);
  }
  return open
    .map((l) => ({
      lineId: l.id,
      orderId: l.order.id,
      orderNumber: l.order.number,
      supplier: l.order.supplierName,
      partId: l.partId,
      itemNumber: l.itemNumber,
      description: l.description,
      stillToCome: measureText(l, outstandingYards(l)),
      ordered: amountText(l),
      backordered: !!l.backorderedOn,
      expectedOn: l.expectedOn,
      waiting: l.partId ? (byPart.get(l.partId) ?? []) : [],
    }))
    .sort((a, b) => Number(b.backordered) - Number(a.backordered) || (a.expectedOn ?? "9").localeCompare(b.expectedOn ?? "9") || a.supplier.localeCompare(b.supplier) || a.orderNumber - b.orderNumber);
}

/**
 * "Let them know": each customer waiting for a back-ordered line's item hears it's delayed until about the expected day
 * (their usual way; never twice for the same line and day), and their ticket's wait moves to that day. Returns words.
 */
export async function letThemKnowFor(user: CurrentUser, lineId: string, now = new Date()): Promise<string> {
  await requireBaseWritable(user);
  const l = await openLine(user, lineId);
  if (!l.backorderedOn) throw new UserError("Mark the line back ordered first.");
  if (!l.expectedOn) throw new UserError("Add the day it's expected first, so they know when.");
  if (!l.partId) return "Nobody is waiting for that item.";
  const waits = await db.partWait.findMany({ where: { shopId: user.shopId, partId: l.partId, receivedAt: null, cancelledAt: null }, include: { ticket: { select: { customerId: true, customer: { select: { name: true } } } } } });
  if (!waits.length) return "Nobody is waiting for that item.";
  await db.partWait.updateMany({ where: { id: { in: waits.map((w) => w.id) }, shopId: user.shopId }, data: { expectedOn: l.expectedOn } });
  if (!(await moduleOn(user.shopId, "marketing"))) return `Their tickets now expect it ${fmtYmdLong(l.expectedOn)}. Messages are off (Marketing isn't on): call them.`;
  const ms = await messagingView(user.shopId);
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true } });
  const until = fmtYmdLong(l.expectedOn);
  let sent = 0;
  let none = 0;
  const seen = new Set<string>();
  for (const w of waits) {
    const cid = w.ticket.customerId;
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    const q = await queueToCustomer(db, {
      shopId: user.shopId,
      customerId: cid,
      kind: "parts_in",
      channels: "preferred",
      dedupeKey: `delay:${l.id}:${cid}:${l.expectedOn}`,
      // Not "wait": the worker would hold a parts_in message for a wait that hasn't come in.
      refType: "po_line",
      refId: l.id,
      sendAfter: now,
      byUserId: user.id,
      ms,
      content: (ch) => {
        const c = renderKind(ms, "order_delay", ch, { ...customerVars(w.ticket.customer?.name ?? "", shop), what: w.description, until });
        return { subject: c.subject, body: ch === "email" ? c.body : plainText(c.body).text };
      },
    });
    if (q.queued.length || q.duplicate.length) sent += 1;
    else none += 1;
  }
  return `${sent ? `Told ${sent} customer${sent === 1 ? "" : "s"} it's delayed until about ${until}.` : ""}${none ? ` ${none} can't get messages: call ${none === 1 ? "her" : "them"}.` : ""}`.trim();
}
