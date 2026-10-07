import "server-only";
// Longarm quilting (fabric-smarts-design.md 4a, package F7): quilting work orders and the "certified to rent" flag for
// longarm rental. A work order is its own small table, not a repair ticket (see the schema comment): received, on the
// frame, ready, collected; quilt size in inches; price = size x rate (or flat) + thread + batting + extras; a due date that
// shows on the calendar; photos; and collecting it bills it as a register sale. Rental is an appointment type (by the
// hour, certified customers only) booked on the calendar and paid at the register like any booking, in appointment-actions.
// Money is integer cents; every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { fmtDate, str, toCents } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { customerFromForm } from "@/lib/customer-input";
import { completeSaleAs } from "@/lib/register-sale";
import { TENDER_METHODS, saleTotals, type TenderMethod } from "@/lib/register-math";
import { shopTimeZone } from "@/lib/shop-zone";
import { parseYmd, ymdOf, zonedTime } from "@/lib/zoned";
import { DESIGN_LABEL, MAX_INCHES, MAX_LONGARM_CENTS, MOVES, OPEN_LONGARM, STATUS_LABEL, orderCents, rateTenthFrom } from "@/lib/longarm-math";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";
import type { LongarmDesign, LongarmPricing, LongarmStatus } from "@/generated/prisma/enums";

export const MAX_PHOTOS = 20;
const DESIGNS = Object.keys(DESIGN_LABEL) as LongarmDesign[];

async function requireRetail(shopId: string) {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { sellsRetail: true } });
  if (!s.sellsRetail) throw new UserError("Longarm quilting is part of the sewing-shop counter.");
}

const text = (fd: FormData, name: string, max: number, what: string): string | null => {
  const t = str(fd.get(name))?.trim() ?? "";
  if (t.length > max) throw new UserError(`${what} is too long (${max} characters at most).`);
  return t || null;
};
const moneyField = (fd: FormData, name: string, what: string): number => {
  const raw = str(fd.get(name))?.trim() ?? "";
  if (!raw) return 0;
  const c = toCents(raw);
  if (c == null || c < 0 || c > MAX_LONGARM_CENTS) throw new UserError(`${what}: enter dollars and cents, up to $100,000.`);
  return c;
};

type Fields = {
  widthIn: number;
  lengthIn: number;
  pricing: LongarmPricing;
  rateTenthCents: number;
  flatCents: number;
  design: LongarmDesign;
  designName: string | null;
  thread: string | null;
  threadCents: number;
  batting: string | null;
  battingCents: number;
  extraCents: number;
  extraNote: string | null;
  taxable: boolean;
  dueYmd: string | null;
  note: string | null;
};

/** The order form's fields, checked. The rate is cents per square inch (one decimal); money fields are dollars. */
export function fieldsFrom(fd: FormData): Fields {
  const inches = (name: string, what: string) => {
    const n = Number(str(fd.get(name))?.trim() ?? "");
    if (!Number.isInteger(n) || n < 1 || n > MAX_INCHES) throw new UserError(`${what}: whole inches, 1 to ${MAX_INCHES}.`);
    return n;
  };
  const widthIn = inches("widthIn", "The quilt's width");
  const lengthIn = inches("lengthIn", "The quilt's length");
  const pricingRaw = str(fd.get("pricing")) ?? "PER_SQIN";
  if (pricingRaw !== "PER_SQIN" && pricingRaw !== "FLAT") throw new UserError("Pick how it is priced.");
  const pricing: LongarmPricing = pricingRaw;
  let rateTenthCents = 0;
  let flatCents = 0;
  if (pricing === "PER_SQIN") {
    const r = rateTenthFrom(str(fd.get("rate")));
    if (r == null || r <= 0) throw new UserError("Enter the rate in cents per square inch, like 2.5.");
    rateTenthCents = r;
  } else {
    flatCents = moneyField(fd, "flat", "The flat price");
  }
  const design = (str(fd.get("design")) ?? "PANTOGRAPH") as LongarmDesign;
  if (!DESIGNS.includes(design)) throw new UserError("Pick pantograph or custom.");
  const dueRaw = str(fd.get("due"))?.trim() ?? "";
  const dueYmd = dueRaw ? parseYmd(dueRaw) : null;
  if (dueRaw && !dueYmd) throw new UserError("Enter the due date as a date.");
  return {
    widthIn,
    lengthIn,
    pricing,
    rateTenthCents,
    flatCents,
    design,
    designName: text(fd, "designName", 80, "The pattern"),
    thread: text(fd, "thread", 80, "The thread"),
    threadCents: moneyField(fd, "threadPrice", "The thread price"),
    batting: text(fd, "batting", 80, "The batting"),
    battingCents: moneyField(fd, "battingPrice", "The batting price"),
    extraCents: moneyField(fd, "extra", "The extras"),
    extraNote: text(fd, "extraNote", 120, "The note on the extras"),
    taxable: !fd.has("taxable") || fd.getAll("taxable").map(String).includes("on"),
    dueYmd,
    note: text(fd, "note", 1000, "The note"),
  };
}

async function dataFrom(shopId: string, f: Fields) {
  const tz = await shopTimeZone(shopId);
  const price = orderCents(f);
  if (price.totalCents > MAX_LONGARM_CENTS) throw new UserError("That comes to more than $100,000. Check the size and the rate.");
  const { dueYmd, ...rest } = f;
  return { ...rest, ...price, dueAt: dueYmd ? zonedTime(dueYmd, 12 * 60, tz) : null };
}

export async function createOrderFor(user: CurrentUser, fd: FormData): Promise<{ id: string; number: number }> {
  await requireBaseWritable(user);
  const shopId = user.shopId;
  await requireRetail(shopId);
  const data = await dataFrom(shopId, fieldsFrom(fd));
  return db.$transaction(async (tx) => {
    const customer = await customerFromForm(tx, shopId, fd, user.id, "counter");
    const sh = await tx.shop.update({ where: { id: shopId }, data: { nextLongarmNumber: { increment: 1 } }, select: { nextLongarmNumber: true } });
    const number = sh.nextLongarmNumber - 1;
    const o = await tx.longarmOrder.create({ data: { shopId, number, customerId: customer.id, name: customer.name, createdById: user.id, ...data }, select: { id: true } });
    return { id: o.id, number };
  });
}

async function ownOrder(shopId: string, id: string) {
  const o = await db.longarmOrder.findFirst({ where: { id: assertId(id), shopId } });
  if (!o) throw new UserError("Work order not found.");
  return o;
}

/** Changes an open order (size, pricing, choices, due date); a collected or cancelled one is a record. */
export async function saveOrderFor(user: CurrentUser, id: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  const o = await ownOrder(user.shopId, id);
  if (!OPEN_LONGARM.includes(o.status)) throw new UserError(`A ${STATUS_LABEL[o.status].toLowerCase()} work order can't be changed.`);
  const data = await dataFrom(user.shopId, fieldsFrom(fd));
  const r = await db.longarmOrder.updateMany({ where: { id: o.id, shopId: user.shopId, status: { in: OPEN_LONGARM } }, data });
  if (r.count !== 1) throw new UserError("The work order changed while you were looking. Reload and try again.");
  return `Saved: ${(orderCents(data).totalCents / 100).toFixed(2)} before tax.`;
}

/** Moves an order one step (see MOVES); the time of each step is kept, and a step back clears the later ones. */
export async function setStatusFor(user: CurrentUser, id: string, to: LongarmStatus): Promise<string> {
  await requireBaseWritable(user);
  const o = await ownOrder(user.shopId, id);
  if (to === "COLLECTED") throw new UserError("Collect it to take payment and hand it over.");
  if (!MOVES[o.status].includes(to)) throw new UserError(`A ${STATUS_LABEL[o.status].toLowerCase()} work order can't go to ${STATUS_LABEL[to].toLowerCase()}.`);
  const at = new Date();
  const stamps: Prisma.LongarmOrderUpdateManyMutationInput =
    to === "ON_FRAME" ? { onFrameAt: o.onFrameAt ?? at, readyAt: null } : to === "READY" ? { readyAt: at, onFrameAt: o.onFrameAt ?? at } : to === "RECEIVED" ? { onFrameAt: null, readyAt: null } : {};
  const r = await db.longarmOrder.updateMany({ where: { id: o.id, shopId: user.shopId, status: o.status }, data: { status: to, ...stamps } });
  if (r.count !== 1) throw new UserError("The work order changed while you were looking. Reload and try again.");
  return `#${o.number} is ${STATUS_LABEL[to].toLowerCase()}.`;
}

/**
 * The customer picks the quilt up and pays: the order is billed as a register sale (quilting, thread, batting and extras
 * as lines, taxed at the shop's rate if taxable) with the tender chosen, and is marked collected. Only a ready order.
 */
export async function collectFor(user: CurrentUser, id: string, fd: FormData | null): Promise<string> {
  const shopId = user.shopId;
  const o = await ownOrder(shopId, id);
  const asked = String(fd?.get("method") ?? "CASH");
  const method: TenderMethod = (TENDER_METHODS as string[]).includes(asked) ? (asked as TenderMethod) : "CASH";
  const at = new Date();
  const claimed = await db.longarmOrder.updateMany({ where: { id: o.id, shopId, status: "READY", saleId: null }, data: { status: "COLLECTED", collectedAt: at } });
  if (claimed.count !== 1) throw new UserError(o.status === "READY" ? "That quilt was just collected." : `Only a ready work order can be collected (this one is ${STATUS_LABEL[o.status].toLowerCase()}).`);
  try {
    if (o.totalCents <= 0) return `#${o.number} is collected (no charge).`;
    const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxRatePct: true } });
    const size = `${o.widthIn} x ${o.lengthIn} in`;
    const lines = [
      { description: `Quilting #${o.number}: ${size}, ${o.design === "CUSTOM" ? "custom" : "pantograph"}${o.designName ? ` (${o.designName})` : ""}`.slice(0, 200), qty: 1, unitPriceCents: o.quiltCents, taxable: o.taxable },
      ...(o.threadCents > 0 ? [{ description: `Thread${o.thread ? `: ${o.thread}` : ""}`.slice(0, 200), qty: 1, unitPriceCents: o.threadCents, taxable: o.taxable }] : []),
      ...(o.battingCents > 0 ? [{ description: `Batting${o.batting ? `: ${o.batting}` : ""}`.slice(0, 200), qty: 1, unitPriceCents: o.battingCents, taxable: o.taxable }] : []),
      ...(o.extraCents > 0 ? [{ description: (o.extraNote ? `Quilting extras: ${o.extraNote}` : "Quilting extras").slice(0, 200), qty: 1, unitPriceCents: o.extraCents, taxable: o.taxable }] : []),
    ];
    const total = saleTotals(lines, 0, shop.taxRatePct, []).total;
    const sale = await completeSaleAs(user, {
      customerId: o.customerId,
      lines,
      tenders: [{ method, amountCents: total, note: null }],
      note: `Longarm quilting #${o.number}`,
      clientKey: `longarm-${o.id}-${at.getTime()}`,
    });
    await db.longarmOrder.updateMany({ where: { id: o.id, shopId }, data: { saleId: sale.saleId } });
    return `#${o.number} is collected: sale #${sale.number} in the register.`;
  } catch (e) {
    // Nothing was billed: it is still waiting on the shelf.
    await db.longarmOrder.updateMany({ where: { id: o.id, shopId, status: "COLLECTED", saleId: null }, data: { status: "READY", collectedAt: null } });
    throw e;
  }
}

export async function deletePhotoFor(user: CurrentUser, photoId: string): Promise<void> {
  await requireBaseWritable(user);
  const r = await db.longarmPhoto.deleteMany({ where: { id: assertId(photoId), shopId: user.shopId } });
  if (r.count !== 1) throw new UserError("Photo not found.");
}

/** Certifies a customer to rent the longarm (after the orientation), or takes it away. Owner or admin. */
export async function setCertifiedFor(user: CurrentUser, customerId: string, on: boolean): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only the shop owner or an admin can certify someone to rent.");
  await requireBaseWritable(user);
  const c = await db.customer.findFirst({ where: { id: assertId(customerId), shopId: user.shopId }, select: { id: true, name: true } });
  if (!c) throw new UserError("Customer not found.");
  await db.customer.updateMany({ where: { id: c.id, shopId: user.shopId }, data: { longarmCertifiedAt: on ? new Date() : null } });
  return on ? `${c.name} is certified to rent the longarm.` : `${c.name} is no longer certified to rent the longarm.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

export type OrderRow = {
  id: string;
  number: number;
  name: string;
  customerId: string | null;
  status: LongarmStatus;
  widthIn: number;
  lengthIn: number;
  totalCents: number;
  dueAt: Date | null;
  overdue: boolean;
  receivedAt: Date;
};

const ROW = { id: true, number: true, name: true, customerId: true, status: true, widthIn: true, lengthIn: true, totalCents: true, dueAt: true, receivedAt: true } as const;
const toRow = (o: { id: string; number: number; name: string; customerId: string | null; status: LongarmStatus; widthIn: number; lengthIn: number; totalCents: number; dueAt: Date | null; receivedAt: Date }, now: Date): OrderRow => ({
  ...o,
  overdue: o.dueAt != null && OPEN_LONGARM.includes(o.status) && o.status !== "READY" && o.dueAt.getTime() < now.getTime(),
});

/** The shop's work orders: open ones first (by due date), then the closed ones, newest first. */
export async function ordersFor(shopId: string, o: { closed?: boolean; take?: number } = {}, now = new Date()): Promise<OrderRow[]> {
  const rows = await db.longarmOrder.findMany({
    where: { shopId, status: o.closed ? { in: ["COLLECTED", "CANCELLED"] } : { in: OPEN_LONGARM } },
    select: ROW,
    orderBy: o.closed ? [{ number: "desc" }] : [{ dueAt: { sort: "asc", nulls: "last" } }, { number: "asc" }],
    take: o.take ?? 200,
  });
  return rows.map((r) => toRow(r, now));
}

/** A customer's work orders, newest first (their history). */
export async function ordersOfCustomer(shopId: string, customerId: string, now = new Date()): Promise<OrderRow[]> {
  const rows = await db.longarmOrder.findMany({ where: { shopId, customerId }, select: ROW, orderBy: { number: "desc" }, take: 100 });
  return rows.map((r) => toRow(r, now));
}

export async function orderView(shopId: string, id: string) {
  const o = await db.longarmOrder.findFirst({ where: { id, shopId }, include: { photos: { select: { id: true, caption: true, createdAt: true }, orderBy: { createdAt: "asc" } } } });
  if (!o) return null;
  const tz = await shopTimeZone(shopId);
  const sale = o.saleId ? await db.sale.findFirst({ where: { id: o.saleId, shopId }, select: { id: true, number: true, status: true } }) : null;
  return { ...o, timeZone: tz, dueYmd: o.dueAt ? ymdOf(o.dueAt, tz) : null, dueText: o.dueAt ? fmtDate(o.dueAt, tz) : null, sale };
}
