import "server-only";
// Layaway's part in the register's own sale and void (tax-machine-sales-layaway-design.md section 4), kept apart from
// src/lib/layaway.ts (which calls completeSaleAs) so the register's code doesn't import it back: holding and releasing
// the items, and what a pick-up, a cancel or a void of either does to the layaway. Every write by shopId.
import type { Prisma } from "@/generated/prisma/client";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { pushEvent, unitDescription } from "@/lib/units/units";

type Tx = Prisma.TransactionClient;

/** Takes the items off sale for the layaway: its machines HELD, its stock items' quantity off the shelf. */
export async function holdItems(tx: Tx, shopId: string, l: { id: string; number: number; lines: { partId: string | null; stockUnitId: string | null; qty: number }[] }, user: Pick<CurrentUser, "id" | "name">, at: Date): Promise<void> {
  for (const x of l.lines) {
    if (x.stockUnitId) {
      const u = await tx.stockUnit.findFirst({ where: { id: x.stockUnitId, shopId }, include: { machine: true } });
      const r = await tx.stockUnit.updateMany({ where: { id: x.stockUnitId, shopId, status: "IN_STOCK" }, data: { status: "HELD", layawayId: l.id, events: pushEvent(u?.events, { at: at.toISOString(), note: `Held for layaway #${l.number} (${user.name})` }) } });
      if (!r.count) throw new UserError(`${u ? unitDescription(u) : "A machine"} was just sold or held. Take it off this layaway.`);
    } else if (x.partId) {
      await tx.part.update({ where: { id: x.partId }, data: { qtyOnHand: { decrement: x.qty } } });
      await tx.stockMove.create({ data: { shopId, partId: x.partId, qty: -x.qty, reason: "HELD", userId: user.id, note: `Layaway #${l.number}`, createdAt: at } });
    }
  }
}

/** Puts the layaway's items back: its machines in stock, its stock items' quantity on the shelf. */
export async function releaseItems(tx: Tx, shopId: string, l: { id: string; number: number; lines: { partId: string | null; stockUnitId: string | null; qty: number }[] }, user: Pick<CurrentUser, "id" | "name">, at: Date, why: string): Promise<void> {
  for (const x of l.lines) {
    if (x.stockUnitId) {
      const u = await tx.stockUnit.findFirst({ where: { id: x.stockUnitId, shopId, status: "HELD", layawayId: l.id } });
      if (u) await tx.stockUnit.updateMany({ where: { id: u.id, shopId, status: "HELD", layawayId: l.id }, data: { status: "IN_STOCK", layawayId: null, events: pushEvent(u.events, { at: at.toISOString(), note: `Layaway #${l.number}: ${why}` }) } });
    } else if (x.partId) {
      await tx.part.updateMany({ where: { id: x.partId, shopId }, data: { qtyOnHand: { increment: x.qty } } });
      await tx.stockMove.create({ data: { shopId, partId: x.partId, qty: x.qty, reason: "HELD", userId: user.id, note: `Layaway #${l.number}: ${why}`, createdAt: at } });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The register's hooks (inside completeSaleAs and voidSaleAs)

export type LayawayHook = { id: string; mode: "pay" | "pickup" | "cancel"; feeCents?: number };

/** Inside the sale's transaction, before its lines are written: a pick-up or cancel puts the held items back first. */
export async function beforeLayawayLines(tx: Tx, a: { shopId: string; hook: LayawayHook; user: CurrentUser; at: Date }): Promise<void> {
  if (a.hook.mode === "pay") {
    // Only while it is open (another register may have just picked it up).
    const l = await tx.layaway.findFirst({ where: { id: a.hook.id, shopId: a.shopId }, select: { status: true, number: true } });
    if (!l || l.status !== "OPEN") throw new UserError(`Layaway #${l?.number ?? ""} isn't open any more.`);
    return;
  }
  const l = await tx.layaway.findFirst({ where: { id: a.hook.id, shopId: a.shopId }, include: { lines: true } });
  if (!l) throw new UserError("Layaway not found.");
  const done = await tx.layaway.updateMany({
    where: { id: l.id, shopId: a.shopId, status: "OPEN" },
    data: a.hook.mode === "pickup" ? { status: "COMPLETED", completedAt: a.at } : { status: "CANCELLED", cancelledAt: a.at, cancelFeeCents: a.hook.feeCents ?? 0 },
  });
  if (!done.count) throw new UserError(`Layaway #${l.number} just changed. Look again.`);
  await releaseItems(tx, a.shopId, l, a.user, a.at, a.hook.mode === "pickup" ? "picked up" : "cancelled");
}

/** After the sale is written: the layaway names it. */
export async function afterLayawaySale(tx: Tx, a: { shopId: string; hook: LayawayHook; saleId: string }): Promise<void> {
  if (a.hook.mode !== "pay") await tx.layaway.updateMany({ where: { id: a.hook.id, shopId: a.shopId }, data: { saleId: a.saleId } });
}

/**
 * Voiding a layaway's sale. A payment: refused once the layaway is finished (void its pick-up or cancel first). A pick-up
 * or cancel: the layaway is open again and its items held again (after the void put them back on the shelf).
 */
export async function voidLayawaySale(tx: Tx, a: { shopId: string; saleId: string; lines: { layawayId: string | null; kind: string | null }[]; user: CurrentUser; at: Date }): Promise<void> {
  const ids = [...new Set(a.lines.map((l) => l.layawayId).filter((x): x is string => !!x))];
  for (const id of ids) {
    const l = await tx.layaway.findFirst({ where: { id, shopId: a.shopId }, include: { lines: true } });
    if (!l) continue;
    if (l.saleId === a.saleId && l.status !== "OPEN") {
      await tx.layaway.updateMany({ where: { id: l.id, shopId: a.shopId }, data: { status: "OPEN", saleId: null, completedAt: null, cancelledAt: null, cancelFeeCents: null } });
      await holdItems(tx, a.shopId, l, a.user, a.at);
    } else if (l.status !== "OPEN") {
      throw new UserError(`Layaway #${l.number} is ${l.status === "COMPLETED" ? "picked up" : "cancelled"}: void that sale first.`);
    }
  }
}
