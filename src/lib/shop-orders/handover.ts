import "server-only";
// Handing over an order paid on MakerFoundry (docs/plans/makerfoundry-orders-plan.md package 4): the customer already paid, so nothing is
// taken at the register. The order is collected (pickup) or shipped, the sale is booked the way the shop's own online orders are
// (one "Paid online" payment for exactly the total, no tax worked out here), and MakerFoundry is told in the same transaction that
// the order is collected or shipped. The shipping address is cleared a while after it ships. Tax and shipping stay open questions: only the
// goods and set-up the customer paid are booked.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireModule } from "@/lib/modules";
import { completeSaleAs } from "@/lib/register-sale";
import { enqueue } from "@/lib/shop-orders/outbox";
import { Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/lib/session";

/** Days after an order ships that the customer's address is kept (the owner may change it; the hub keeps message bodies 30 days too). */
export const SHIP_ADDRESS_DAYS = 30;

/** What MakerFoundry is told for each step of an order here. */
export const ONLINE_STATUS: Record<string, "received" | "approved" | "in_production" | "ready"> = { QUOTED: "received", APPROVED: "approved", IN_PRODUCTION: "in_production", READY: "ready" };

/** What MakerFoundry is told when an order is back at "quoted": a proof is out (and not answered), or just received. */
export const quotedWord = (o: { proofNo: number; proofAnswer: string | null }): "received" | "proof_sent" => (o.proofNo > 0 && o.proofAnswer === null ? "proof_sent" : "received");

export async function handOverOnlineOrderFor(user: CurrentUser, id: string, tracking: string | null): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const shopId = user.shopId;
  const o = await db.decorOrder.findFirst({ where: { id: assertId(id), shopId }, omit: { mockupData: true }, include: { lines: { orderBy: { sortOrder: "asc" } } } });
  if (!o) throw new UserError("Order not found.");
  if (o.source !== "MAKERFOUNDRY" || !o.onlineRef) throw new UserError("This order wasn't paid on MakerFoundry: take the payment at the register.");
  if (o.status !== "READY") throw new UserError(o.status === "COLLECTED" ? "That order was already handed over." : `Only a ready order can be handed over (this one is ${o.status.toLowerCase().replace("_", " ")}).`);
  const ship = o.fulfilment === "SHIP";
  const track = (tracking ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const at = new Date();
  const claimed = await db.decorOrder.updateMany({ where: { id: o.id, shopId, status: "READY", saleId: null }, data: { status: "COLLECTED", collectedAt: at, closedAt: at, ...(ship ? { shippedAt: at, tracking: track || null } : {}) } });
  if (claimed.count !== 1) throw new UserError("That order was just handed over.");
  try {
    let saleId: string | null = null;
    let saleNo = 0;
    if (o.quoteCents > 0) {
      const lines = [
        { description: `MakerFoundry order #${o.number}: goods${o.lines.length ? ` (${o.lines.reduce((s, l) => s + l.qty, 0)} pieces)` : ""}`.slice(0, 200), qty: 1, unitPriceCents: o.quoteCents - o.setupCents, taxable: false },
        ...(o.setupCents > 0 ? [{ description: `Set-up, MakerFoundry order #${o.number}`, qty: 1, unitPriceCents: o.setupCents, taxable: false }] : []),
      ].filter((l) => l.unitPriceCents > 0);
      const sale = await completeSaleAs(
        user,
        { customerId: null, lines, tenders: [], note: `MakerFoundry order #${o.number}, paid online (${o.onlineRef})`, clientKey: `mf-${o.id}`, taxCents: 0 },
        { paidOnline: true, internal: true, tenderExact: { method: "ONLINE", amountCents: 0, note: `MakerFoundry order #${o.number}` } },
      );
      saleId = sale.saleId;
      saleNo = sale.number;
    }
    // The sale, the note to MakerFoundry and the order's link to the sale stand or fall together.
    await db.$transaction(async (tx) => {
      await tx.decorOrder.updateMany({ where: { id: o.id, shopId }, data: { saleId } });
      await enqueue(tx, shopId, { conversation: o.onlineRef!, type: "order.status", body: { status: ship ? "shipped" : "collected", ...(ship && track ? { tracking: track } : {}) } });
    });
    return ship ? `Order #${o.number} is shipped${track ? ` (${track})` : ""}; MakerFoundry will tell the customer.${saleNo ? ` Booked as sale #${saleNo}, paid online.` : ""}` : `Order #${o.number} is handed over; MakerFoundry will tell the customer.${saleNo ? ` Booked as sale #${saleNo}, paid online.` : ""}`;
  } catch (e) {
    // Nothing was booked or told: it is still ready on the shelf.
    await db.decorOrder.updateMany({ where: { id: o.id, shopId, status: "COLLECTED", saleId: null }, data: { status: "READY", collectedAt: null, closedAt: null, shippedAt: null, tracking: null } });
    throw e;
  }
}

/** Wipes the customer's address from orders that shipped more than SHIP_ADDRESS_DAYS ago (called on every sync round). Returns how many. */
export async function clearShippedAddresses(shopId: string, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SHIP_ADDRESS_DAYS * 86_400_000);
  const r = await db.decorOrder.updateMany({ where: { shopId, source: "MAKERFOUNDRY", shipTo: { not: Prisma.DbNull }, shippedAt: { lt: cutoff } }, data: { shipTo: Prisma.DbNull } });
  return r.count;
}
