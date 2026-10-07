import "server-only";
// Special orders' part in the register's own sale and void (shop-features-round-2-design.md 1.2), kept apart from
// src/lib/special-orders.ts (which calls completeSaleAs) so the register's code doesn't import it back:
// - before anything else, a pick-up line (an item line naming a special order) is priced from the order and the
//   deposits paid are taken off on a DEPOSIT line the server works out (the browser's own "deposit used" line is checked
//   against it);
// - inside the sale's transaction the held quantity goes back on the shelf, then the sale takes it again, and the order
//   is done; a cancel's sale finishes the order the same way;
// - a void puts it back as it was (here again and held, or open again after a cancel).
// Every query by shopId.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { lineNet } from "@/lib/register-math";
import type { CurrentUser } from "@/lib/session";

type Tx = Prisma.TransactionClient;

/** What was paid toward each special order: its DEPOSIT lines on sales that stand (payments in, used up or given back out). */
export async function paidTowardOrders(shopId: string, ids: string[], client: Tx | typeof db = db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await client.saleLine.findMany({ where: { specialOrderId: { in: ids }, kind: "DEPOSIT", sale: { shopId, status: "COMPLETED" } }, select: { specialOrderId: true, qty: true, unitPriceCents: true, discountCents: true } });
  for (const r of rows) out.set(r.specialOrderId!, (out.get(r.specialOrderId!) ?? 0) + lineNet({ ...r, taxable: false }));
  return out;
}

type LineIn = {
  partId?: string | null;
  description: string;
  qty: number;
  unitPriceCents: number;
  discountCents?: number;
  taxable: boolean;
  specialOrderId?: string | null;
  depositKind?: "DEPOSIT" | "DEPOSIT_KEPT" | null;
  /** The register's own "deposit used" line for a pick-up on the same sale: checked against what was paid, then replaced. */
  depositUsed?: boolean;
};

export type SpecialOrderHook = { mode: "cancel"; id: string; prevStatus: string } | null;

/**
 * Before the sale is checked: each pick-up line takes the order's item, quantity and price (a tech rings it up as the
 * order says) and its deposits come off on a DEPOSIT line. Returns the lines to sell, the pick-ups by order id, and the
 * indexes of lines priced by an order. `internal` lines (DEPOSIT, DEPOSIT_KEPT from src/lib/special-orders.ts or a pay
 * link) are checked to name an open order of this shop.
 */
export async function prepareSpecialOrderLines<L extends LineIn>(
  shopId: string,
  customerId: string | null,
  lines: L[],
): Promise<{ lines: L[]; pickups: Map<string, { number: number; heldQty: number; partId: string | null }>; priced: Set<number> }> {
  const pickups = new Map<string, { number: number; heldQty: number; partId: string | null }>();
  const priced = new Set<number>();
  const ids = [...new Set(lines.map((l) => l.specialOrderId).filter((x): x is string => !!x))];
  if (!ids.length) return { lines, pickups, priced };
  const orders = new Map((await db.specialOrder.findMany({ where: { shopId, id: { in: ids } } })).map((o) => [o.id, o]));
  for (const id of ids) if (!orders.has(id)) throw new UserError("That special order isn't one of this shop's.");
  const paid = await paidTowardOrders(shopId, ids);
  const out: L[] = [];
  const usedFromBrowser = new Map<string, number>();
  for (const l of lines) {
    if (!l.specialOrderId) {
      out.push(l);
      continue;
    }
    const o = orders.get(l.specialOrderId)!;
    if (l.depositKind) {
      if (!["WAITING", "ORDERED", "HERE"].includes(o.status) && l.qty > 0) throw new UserError(`Special order ${o.number} is ${o.status === "DONE" ? "picked up" : "cancelled"} already.`);
      out.push(l);
      continue;
    }
    if (l.depositUsed) {
      usedFromBrowser.set(o.id, Math.round(Number(l.unitPriceCents) * Math.abs(Number(l.qty))));
      continue;
    }
    // The pick-up: the item as ordered.
    if (Number(l.qty) <= 0) throw new UserError(`Special order ${o.number} is picked up, not returned here. Cancel it on its page instead.`);
    if (o.status !== "HERE") throw new UserError(`Special order ${o.number} isn't here yet. Mark it here on its page first.`);
    if (pickups.has(o.id)) throw new UserError(`Special order ${o.number} is on this sale twice.`);
    if (o.customerId && customerId && o.customerId !== customerId) throw new UserError(`Special order ${o.number} is another customer's.`);
    pickups.set(o.id, { number: o.number, heldQty: o.heldQty, partId: o.partId });
    priced.add(out.length);
    out.push({ ...l, partId: o.partId, description: o.description, qty: o.qty, unitPriceCents: o.priceCents, discountCents: Math.max(0, Math.round(Number(l.discountCents ?? 0))), taxable: true });
    const p = paid.get(o.id) ?? 0;
    if (p > 0) out.push({ description: `Special order ${o.number}: deposit paid`, qty: -1, unitPriceCents: p, taxable: false, specialOrderId: o.id, depositKind: "DEPOSIT" } as L);
  }
  for (const [id, cents] of usedFromBrowser) {
    const o = orders.get(id)!;
    if (!pickups.has(id)) throw new UserError(`Special order ${o.number}: the deposit comes off only with the item. Add the item too.`);
    if (cents !== (paid.get(id) ?? 0)) throw new UserError(`Special order ${o.number}: what was paid toward it changed. Take it off the sale and add it again.`);
  }
  return { lines: out, pickups, priced };
}

/** Inside the sale's transaction, before its lines: the held quantity back on the shelf and each order done (or cancelled). */
export async function beforeSpecialOrderLines(tx: Tx, a: { shopId: string; pickups: Map<string, { number: number; heldQty: number; partId: string | null }>; hook: SpecialOrderHook; user: Pick<CurrentUser, "id">; at: Date }): Promise<void> {
  for (const [id, p] of a.pickups) {
    const done = await tx.specialOrder.updateMany({ where: { id, shopId: a.shopId, status: "HERE" }, data: { status: "DONE", prevStatus: "HERE", heldQty: 0 } });
    if (!done.count) throw new UserError(`Special order ${p.number} just changed. Take it off this sale and add it again.`);
    await releaseHeld(tx, a.shopId, { partId: p.partId, heldQty: p.heldQty, number: p.number }, a.user.id, a.at, "picked up");
  }
  if (a.hook?.mode === "cancel") {
    const o = await tx.specialOrder.findFirst({ where: { id: a.hook.id, shopId: a.shopId } });
    if (!o) throw new UserError("Special order not found.");
    const done = await tx.specialOrder.updateMany({ where: { id: o.id, shopId: a.shopId, status: o.status, NOT: { status: { in: ["DONE", "CANCELLED"] } } }, data: { status: "CANCELLED", prevStatus: o.status, cancelledAt: a.at, heldQty: 0 } });
    if (!done.count) throw new UserError(`Special order ${o.number} just changed. Look again.`);
    await releaseHeld(tx, a.shopId, o, a.user.id, a.at, "cancelled");
  }
}

/** After the sale is written: each finished order names it. */
export async function afterSpecialOrderSale(tx: Tx, a: { shopId: string; pickups: Map<string, unknown>; hook: SpecialOrderHook; saleId: string }): Promise<void> {
  const ids = [...a.pickups.keys(), ...(a.hook ? [a.hook.id] : [])];
  if (ids.length) await tx.specialOrder.updateMany({ where: { shopId: a.shopId, id: { in: ids } }, data: { saleId: a.saleId } });
}

/** Holds the quantity off the shelf for her (a HELD stock move). */
export async function holdFor(tx: Tx, shopId: string, o: { id: string; number: number; partId: string | null; qty: number }, userId: string | null, at: Date): Promise<void> {
  if (!o.partId) return;
  await tx.part.updateMany({ where: { id: o.partId, shopId }, data: { qtyOnHand: { decrement: o.qty } } });
  await tx.stockMove.create({ data: { shopId, partId: o.partId, qty: -o.qty, reason: "HELD", userId, note: `Special order ${o.number}`, createdAt: at } });
  await tx.specialOrder.updateMany({ where: { id: o.id, shopId }, data: { heldQty: o.qty } });
}

/** Puts a held quantity back on the shelf. */
export async function releaseHeld(tx: Tx, shopId: string, o: { partId: string | null; heldQty: number; number: number }, userId: string | null, at: Date, why: string): Promise<void> {
  if (!o.partId || !(o.heldQty > 0)) return;
  await tx.part.updateMany({ where: { id: o.partId, shopId }, data: { qtyOnHand: { increment: o.heldQty } } });
  await tx.stockMove.create({ data: { shopId, partId: o.partId, qty: o.heldQty, reason: "HELD", userId, note: `Special order ${o.number}: ${why}`, createdAt: at } });
}

/**
 * Voiding a sale with special order lines. A pick-up or a cancel: the order is back as it was (here and held again, or
 * open again). A payment toward an order finished since: refused (void the pick-up or the cancel first).
 */
export async function voidSpecialOrderSale(tx: Tx, a: { shopId: string; saleId: string; lines: { specialOrderId: string | null }[]; user: Pick<CurrentUser, "id">; at: Date }): Promise<void> {
  const ids = [...new Set(a.lines.map((l) => l.specialOrderId).filter((x): x is string => !!x))];
  for (const id of ids) {
    const o = await tx.specialOrder.findFirst({ where: { id, shopId: a.shopId } });
    if (!o) continue;
    if (o.saleId === a.saleId && (o.status === "DONE" || o.status === "CANCELLED")) {
      const back = o.prevStatus && ["WAITING", "ORDERED", "HERE"].includes(o.prevStatus) ? o.prevStatus : "HERE";
      await tx.specialOrder.updateMany({ where: { id: o.id, shopId: a.shopId }, data: { status: back, saleId: null, cancelledAt: null, prevStatus: null } });
      if (back === "HERE") await holdFor(tx, a.shopId, o, a.user.id, a.at);
    } else if (o.status === "DONE" || o.status === "CANCELLED") {
      throw new UserError(`Special order ${o.number} is ${o.status === "DONE" ? "picked up" : "cancelled"}: void that sale first.`);
    }
  }
}

/** The worker's "still wanted?" for an "it's here" message: a reason to cancel, or null to send. */
export async function orderInStillWanted(row: { shopId: string; refType: string | null; refId: string | null }): Promise<string | null> {
  if (row.refType === "special_order" && row.refId) {
    const o = await db.specialOrder.findFirst({ where: { id: row.refId, shopId: row.shopId }, select: { status: true } });
    if (!o) return "The special order is gone";
    if (o.status === "DONE") return "It was picked up";
    if (o.status !== "HERE") return "It isn't here any more";
  }
  return null;
}
