import "server-only";
// Customers' used machines on consignment (shop-features-round-2-design.md 9.6, package consign-machines). A machine for
// sale can belong to a consignor (one of the shop's customers): the price on it is hers, the shop keeps a commission
// (25% unless typed), and a day comes to give it back or mark it down. When it sells, what she is owed (the price it
// sold for before tax, less the commission) is written as a ConsignPayout; "Pay her" by check, cash or store credit. A
// return before she was paid, or the sale's void, takes the payout back. A consignor statement lists her machines and
// payments. Owners and admins set consignments and pay out; every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { money, str } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { actorOf } from "@/lib/audit";
import { giveCredit } from "@/lib/gift-cards";
import { parseYmd } from "@/lib/zoned";
import { pushEvent, unitDescription } from "@/lib/units/units";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";

type Tx = Prisma.TransactionClient;
export const PAYOUT_METHODS = ["CHECK", "CASH", "CREDIT"] as const;
export const PAYOUT_LABEL: Record<string, string> = { CHECK: "Check", CASH: "Cash", CREDIT: "Store credit" };

/** What the consignor gets of a sale: the price before tax less the shop's commission (to the cent, rounded half up). */
export const consignorShare = (soldCents: number, pct: number) => Math.max(0, Math.round((soldCents * (100 - Math.max(0, Math.min(100, pct)))) / 100));

const ownerOnly = (user: CurrentUser) => {
  if (user.role === "TECH") throw new UserError("Only an owner or admin handles consignments.");
};

// ---------------------------------------------------------------------------------------------------------------
// The sale's hooks (inside its transaction; called by src/lib/units/sale-units.ts)

/** A consigned machine sold: what she is owed. soldCents: the line's price less its discounts (before tax). */
export async function payoutOnSale(tx: Tx, a: { shopId: string; unit: { id: string; consignorId: string | null; consignPct: number | null }; saleLineId: string; soldCents: number; at: Date }) {
  if (!a.unit.consignorId) return;
  const pct = a.unit.consignPct ?? (await tx.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { consignDefaultPct: true } })).consignDefaultPct;
  await tx.consignPayout.create({
    data: { shopId: a.shopId, unitId: a.unit.id, customerId: a.unit.consignorId, saleLineId: a.saleLineId, soldCents: a.soldCents, pct, amountCents: consignorShare(a.soldCents, pct), createdAt: a.at },
  });
}

/** The machine came back (a return): a payout not made yet is taken back; one already made stays (the shop paid her). */
export async function payoutOnReturn(tx: Tx, a: { shopId: string; soldLineId: string | null; at: Date }) {
  if (!a.soldLineId) return;
  await tx.consignPayout.updateMany({ where: { shopId: a.shopId, saleLineId: a.soldLineId, paidAt: null, voidedAt: null }, data: { voidedAt: a.at } });
}

/** The sale that sold it is voided: its payout goes too, unless she has been paid (then the void waits for the payout's undo). */
export async function payoutOnVoidSale(tx: Tx, a: { shopId: string; saleLineId: string; at: Date }) {
  const paid = await tx.consignPayout.findFirst({ where: { shopId: a.shopId, saleLineId: a.saleLineId, voidedAt: null, paidAt: { not: null } }, select: { id: true } });
  if (paid) throw new UserError("The consignor has been paid for this machine. Undo her payment first (Paperwork, Consigned machines).");
  await tx.consignPayout.updateMany({ where: { shopId: a.shopId, saleLineId: a.saleLineId, voidedAt: null }, data: { voidedAt: a.at } });
}

/** A return is voided (the machine is sold again): the payout it took back (at the return's moment) is owed again. */
export async function payoutOnVoidReturn(tx: Tx, a: { shopId: string; soldLineId: string | null; returnedAt: Date | undefined }) {
  if (!a.soldLineId || !a.returnedAt) return;
  await tx.consignPayout.updateMany({ where: { shopId: a.shopId, saleLineId: a.soldLineId, paidAt: null, voidedAt: a.returnedAt }, data: { voidedAt: null } });
}

// ---------------------------------------------------------------------------------------------------------------
// Setting a consignment

/** Makes a machine in stock a consignor's (customer, the shop's commission, the day to give it back), or (blank customer) the shop's own again. */
export async function setConsignFor(user: CurrentUser, unitId: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  ownerOnly(user);
  const shopId = user.shopId;
  const u = await db.stockUnit.findFirst({ where: { id: assertId(unitId), shopId }, include: { machine: true } });
  if (!u) throw new UserError("Machine not found.");
  if (u.status !== "IN_STOCK" && u.status !== "REMOVED") throw new UserError("Only a machine in stock or off sale can change hands.");
  const customerId = str(fd.get("customerId"));
  if (!customerId) {
    if (!u.consignorId) return "It is the shop's own.";
    await db.stockUnit.updateMany({ where: { id: u.id, shopId }, data: { consignorId: null, consignPct: null, consignUntil: null, events: pushEvent(u.events, { at: new Date().toISOString(), note: `No longer on consignment (${user.name})` }) } });
    return "It is the shop's own now.";
  }
  const c = await db.customer.findFirst({ where: { id: assertId(customerId), shopId }, select: { id: true, name: true } });
  if (!c) throw new UserError("Customer not found.");
  const pctRaw = str(fd.get("pct"))?.replace(/%$/, "");
  const pct = pctRaw ? Number(pctRaw) : (await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { consignDefaultPct: true } })).consignDefaultPct;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new UserError("The shop's commission: a percent from 0 to 100, like 25.");
  const untilRaw = str(fd.get("until"));
  const until = untilRaw ? parseYmd(untilRaw) : null;
  if (untilRaw && !until) throw new UserError("The day to give it back or mark it down: enter it as a date.");
  await db.stockUnit.updateMany({
    where: { id: u.id, shopId },
    data: { consignorId: c.id, consignPct: pct, consignUntil: until, costCents: u.consignorId ? u.costCents : null, events: pushEvent(u.events, { at: new Date().toISOString(), note: `On consignment for ${c.name}, the shop keeps ${pct}% (${user.name})` }) },
  });
  return `${unitDescription(u)} is ${c.name}'s, on consignment.`;
}

/** Her machine goes back to her (unsold): off sale, and hers again in Machines. */
export async function giveBackFor(user: CurrentUser, unitId: string): Promise<string> {
  await requireBaseWritable(user);
  ownerOnly(user);
  const shopId = user.shopId;
  const u = await db.stockUnit.findFirst({ where: { id: assertId(unitId), shopId }, include: { machine: true } });
  if (!u) throw new UserError("Machine not found.");
  if (!u.consignorId) throw new UserError("That machine isn't on consignment.");
  const c = await db.customer.findFirst({ where: { id: u.consignorId, shopId }, select: { id: true, name: true } });
  return db.$transaction(async (tx) => {
    const r = await tx.stockUnit.updateMany({ where: { id: u.id, shopId, status: { in: ["IN_STOCK", "REMOVED"] } }, data: { status: "REMOVED", events: pushEvent(u.events, { at: new Date().toISOString(), note: `Given back to ${c?.name ?? "the consignor"} unsold (${user.name})` }) } });
    if (!r.count) throw new UserError("Only a machine in stock or off sale can be given back.");
    if (c) await tx.machine.updateMany({ where: { id: u.machineId, shopId }, data: { customerId: c.id } });
    return `${unitDescription(u)} is given back to ${c?.name ?? "the consignor"}.`;
  });
}

/** The shop's commission when none is typed (Settings). */
export async function saveConsignDefaultFor(user: CurrentUser, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  ownerOnly(user);
  const pct = Number(str(fd.get("pct"))?.replace(/%$/, ""));
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new UserError("A percent from 0 to 100, like 25.");
  await db.shop.update({ where: { id: user.shopId }, data: { consignDefaultPct: pct } });
  return `The shop keeps ${pct}% unless you type another.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Paying her

/** "Pay her": by check (its number in the note), cash, or store credit on her card. */
export async function payOutFor(user: CurrentUser, payoutId: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  ownerOnly(user);
  const shopId = user.shopId;
  const p = await db.consignPayout.findFirst({ where: { id: assertId(payoutId), shopId } });
  if (!p) throw new UserError("Payout not found.");
  if (p.voidedAt) throw new UserError("That sale was taken back: nothing is owed.");
  if (p.paidAt) throw new UserError("She has been paid for this one.");
  const method = str(fd.get("method")) ?? "CHECK";
  if (!(PAYOUT_METHODS as readonly string[]).includes(method)) throw new UserError("Pay by check, cash or store credit.");
  const note = str(fd.get("note"))?.slice(0, 120) ?? null;
  if (method === "CHECK" && !note) throw new UserError("Type the check number.");
  const c = await db.customer.findFirst({ where: { id: p.customerId, shopId }, select: { id: true, name: true } });
  if (!c) throw new UserError("The consignor isn't in your customers any more. Add her again to pay her.");
  const at = new Date();
  await db.$transaction(async (tx) => {
    let giftCardId: string | null = null;
    if (method === "CREDIT") {
      const r = await giveCredit(tx, actorOf(user), { card: null, customerId: c.id, amountCents: p.amountCents, reason: "LOADED", cause: { userId: user.id }, label: c.name, why: "Consignment payout" });
      giftCardId = r.card.id;
    }
    const r = await tx.consignPayout.updateMany({ where: { id: p.id, shopId, paidAt: null, voidedAt: null }, data: { paidAt: at, method, note, giftCardId, paidById: user.id } });
    if (!r.count) throw new UserError("That payout just changed. Reload and try again.");
  });
  return `${c.name} is paid ${money(p.amountCents)} by ${PAYOUT_LABEL[method].toLowerCase()}.`;
}

/** Undo a payment made by mistake (check or cash; store credit is taken back by adjusting her card). */
export async function undoPayoutFor(user: CurrentUser, payoutId: string): Promise<string> {
  await requireBaseWritable(user);
  ownerOnly(user);
  const p = await db.consignPayout.findFirst({ where: { id: assertId(payoutId), shopId: user.shopId } });
  if (!p) throw new UserError("Payout not found.");
  if (!p.paidAt) throw new UserError("That one isn't paid yet.");
  if (p.method === "CREDIT") throw new UserError("Paid in store credit: take it back by adjusting her store credit card, then this stays as paid.");
  const r = await db.consignPayout.updateMany({ where: { id: p.id, shopId: user.shopId, paidAt: p.paidAt }, data: { paidAt: null, method: null, note: null, paidById: null } });
  if (!r.count) throw new UserError("That payout just changed. Reload and try again.");
  return "Not paid yet.";
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

/** Machines on consignment in stock or off sale, the give-back day first. */
export async function consignedUnits(shopId: string) {
  const units = await db.stockUnit.findMany({
    where: { shopId, consignorId: { not: null }, status: { in: ["IN_STOCK", "REMOVED", "HELD"] } },
    select: { id: true, status: true, priceCents: true, consignorId: true, consignPct: true, consignUntil: true, machine: { select: { brand: true, model: true, serial: true, customerId: true } } },
    take: 500,
  });
  const names = await customerNames(shopId, units.map((u) => u.consignorId!));
  // Given back: off sale and hers again.
  return units
    .filter((u) => !(u.status === "REMOVED" && u.machine.customerId === u.consignorId))
    .map((u) => ({ ...u, consignor: names.get(u.consignorId!) ?? "Deleted customer" }))
    .sort((a, b) => (a.consignUntil ?? "9999").localeCompare(b.consignUntil ?? "9999"));
}

async function customerNames(shopId: string, ids: string[]) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map<string, string>();
  return new Map((await db.customer.findMany({ where: { shopId, id: { in: uniq } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
}

export type PayoutRow = Awaited<ReturnType<typeof payoutsFor>>[number];

/** Payouts: owed (not paid), or paid lately; one consignor's or everyone's. */
export async function payoutsFor(shopId: string, o: { customerId?: string; paid?: boolean; take?: number } = {}) {
  const rows = await db.consignPayout.findMany({
    where: { shopId, voidedAt: null, ...(o.customerId ? { customerId: o.customerId } : {}), ...(o.paid == null ? {} : o.paid ? { paidAt: { not: null } } : { paidAt: null }) },
    orderBy: o.paid ? { paidAt: "desc" } : { createdAt: "asc" },
    take: o.take ?? 300,
  });
  const [names, units] = await Promise.all([
    customerNames(shopId, rows.map((r) => r.customerId)),
    db.stockUnit.findMany({ where: { shopId, id: { in: [...new Set(rows.map((r) => r.unitId))] } }, select: { id: true, machine: { select: { brand: true, model: true, serial: true } } } }),
  ]);
  const unitName = new Map(units.map((u) => [u.id, `${u.machine.brand} ${u.machine.model}${u.machine.serial ? ` S/N ${u.machine.serial}` : ""}`]));
  return rows.map((r) => ({ ...r, consignor: names.get(r.customerId) ?? "Deleted customer", machine: unitName.get(r.unitId) ?? "Machine" }));
}

/** A consignor's statement: her machines (in stock, sold, given back) and what was paid, with what is still owed. */
export async function consignorStatement(shopId: string, customerId: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(customerId)) return null;
  const c = await db.customer.findFirst({ where: { id: customerId, shopId }, select: { id: true, name: true, phone: true, email: true, address: true } });
  if (!c) return null;
  const [units, payouts] = await Promise.all([
    db.stockUnit.findMany({ where: { shopId, consignorId: c.id }, select: { id: true, status: true, priceCents: true, consignPct: true, consignUntil: true, soldAt: true, createdAt: true, machine: { select: { brand: true, model: true, serial: true, customerId: true } } }, orderBy: { createdAt: "asc" } }),
    payoutsFor(shopId, { customerId: c.id }),
  ]);
  const owedCents = payouts.filter((p) => !p.paidAt).reduce((a, p) => a + p.amountCents, 0);
  const paidCents = payouts.filter((p) => p.paidAt).reduce((a, p) => a + p.amountCents, 0);
  return { customer: c, units, payouts, owedCents, paidCents };
}

/** What the shop owes a customer for her consigned machines (her page). */
export async function owedToConsignor(shopId: string, customerId: string) {
  return payoutsFor(shopId, { customerId, paid: false });
}
