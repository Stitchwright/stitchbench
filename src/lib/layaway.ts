import "server-only";
// Layaway (tax-machine-sales-layaway-design.md section 4). The items are held for the customer (a machine for sale goes
// HELD, a stock item's quantity comes off the shelf with a HELD stock move); every bit of money goes through the
// register as a sale whose lines carry the layaway's id (completeSaleAs with opts.layaway, never from the browser):
// - a payment (the deposit too) is a line of kind LAYAWAY (+): money held for the customer, not a sale yet;
// - the pick-up sells the items at that day's tax and uses the payments up (a LAYAWAY line, -), the rest paid then;
// - a cancel gives the payments back (LAYAWAY, -) less the shop's fee (LAYAWAY_FEE), as store credit or money.
// What was paid is the LAYAWAY lines of completed sales, so a voided sale takes its money out by itself. Every query by
// shopId; library bodies take the user so the check script can drive them.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { money, str } from "@/lib/format";
import { moduleOn } from "@/lib/module-gate";
import { queueToCustomer } from "@/lib/messaging/queue";
import { lineNet, saleTotals, TENDER_METHODS, type Tender } from "@/lib/register-math";
import { completeSaleAs } from "@/lib/register-sale";
import { shopTimeZone } from "@/lib/shop-zone";
import { exemptCertificate } from "@/lib/tax-exempt";
import { fmtYmdLong, isSellableMachine, unitDescription } from "@/lib/units/units";
import { holdItems, releaseItems } from "@/lib/layaway-hooks";
import { currentStore, storeDetails, storeOfRow } from "@/lib/stores";
import { behind, cancelSplit, DEFAULT_LAYAWAY_TERMS, dueByOf, isEvery, layawayPlan, minDeposit, type LayawayEvery, type PlanPayment } from "@/lib/layaway-math";
import { ymdOf } from "@/lib/zoned";
import { holidaysOn } from "@/lib/tax-holidays";
import { holidayCovers } from "@/lib/tax-holiday-math";

const MAX_MONEY = 10_000_000;

// ---------------------------------------------------------------------------------------------------------------------
// Settings

export type LayawaySettings = { depositPct: number; days: number; every: LayawayEvery; feeCents: number; feePct: number; refund: "credit" | "money"; terms: string; termsTyped: boolean };

export async function layawaySettings(shopId: string): Promise<LayawaySettings> {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { layawayDepositPct: true, layawayDays: true, layawayEvery: true, layawayFeeCents: true, layawayFeePct: true, layawayRefund: true, layawayTerms: true } });
  return {
    depositPct: s.layawayDepositPct,
    days: s.layawayDays,
    every: isEvery(s.layawayEvery) ? s.layawayEvery : "2w",
    feeCents: s.layawayFeeCents,
    feePct: s.layawayFeePct,
    refund: s.layawayRefund === "money" ? "money" : "credit",
    terms: s.layawayTerms?.trim() || DEFAULT_LAYAWAY_TERMS,
    termsTyped: !!s.layawayTerms?.trim(),
  };
}

function wholeIn(fd: FormData, name: string, what: string, min: number, max: number, fallback: number): number {
  const s = str(fd.get(name));
  if (s == null) return fallback;
  const n = Number(s.replace(/%$/, ""));
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${what}: a whole number from ${min} to ${max}.`);
  return n;
}

/** Settings → Layaway (owner or admin). Blank terms go back to the program's wording. */
export async function saveLayawaySettingsFor(user: CurrentUser, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const every = str(fd.get("every")) ?? "2w";
  if (!isEvery(every)) throw new UserError("Pick how often they pay.");
  const fee = str(fd.get("feeCents"));
  const feeCents = fee == null ? 0 : Math.round(Number(fee.replace(/[$,\s]/g, "")) * 100);
  if (!Number.isFinite(feeCents) || feeCents < 0 || feeCents > 100_000) throw new UserError("Cancel fee: an amount from $0 to $1,000.");
  const terms = str(fd.get("terms"))?.slice(0, 4000) ?? null;
  await db.shop.update({
    where: { id: user.shopId },
    data: {
      layawayDepositPct: wholeIn(fd, "depositPct", "Deposit", 0, 100, 10),
      layawayDays: wholeIn(fd, "days", "Days to pay", 7, 730, 90),
      layawayEvery: every,
      layawayFeeCents: feeCents,
      layawayFeePct: wholeIn(fd, "feePct", "Cancel fee percent", 0, 100, 0),
      layawayRefund: str(fd.get("refund")) === "money" ? "money" : "credit",
      layawayTerms: terms && terms.trim() !== DEFAULT_LAYAWAY_TERMS ? terms : null,
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading

type LayawayRow = Prisma.LayawayGetPayload<{ include: { lines: true; customer: { select: { id: true; name: true; phone: true; taxExemptId: true; taxExemptUntil: true } } } }>;

export type LayawayView = {
  id: string;
  number: number;
  status: string;
  customer: { id: string; name: string; phone: string | null } | null;
  startedAt: Date;
  dueBy: string;
  every: LayawayEvery;
  plan: PlanPayment[];
  depositMinCents: number;
  terms: string;
  note: string | null;
  lines: { id: string; description: string; qty: number; unitPriceCents: number; discountCents: number; taxable: boolean; stockUnitId: string | null; partId: string | null }[];
  /** The items' price after their discounts, the tax on it today, and the two together. */
  priceCents: number;
  taxCents: number;
  owedCents: number;
  paidCents: number;
  leftCents: number;
  /** Less paid than the plan asked for by today (0 when on time). */
  behindCents: number;
  payments: { saleId: string; number: number; at: Date; cents: number; kind: string }[];
  saleId: string | null;
  cancelFeeCents: number | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
};

/** What was paid toward each layaway: its LAYAWAY lines on sales that stand. */
async function paidFor(shopId: string, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db.saleLine.findMany({ where: { layawayId: { in: ids }, kind: "LAYAWAY", qty: { gt: 0 }, sale: { shopId, status: "COMPLETED" } }, select: { layawayId: true, qty: true, unitPriceCents: true, discountCents: true } });
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.layawayId!, (out.get(r.layawayId!) ?? 0) + lineNet({ ...r, taxable: false }));
  return out;
}

/** The tax the items would carry today: the customer's exemption counts, as it would at the register. */
async function taxToday(shopId: string, l: LayawayRow): Promise<{ price: number; tax: number }> {
  // The layaway's store's rate (7.1; the main store's is the company's own).
  const shop = storeDetails(await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxRatePct: true, timeZone: true } }), await storeOfRow(shopId, l.locationId));
  const exempt = exemptCertificate(l.customer);
  // A tax holiday today, or on the day the layaway began, takes the tax off what it covers (as the pick-up sale will).
  const holidays = exempt ? [] : await holidaysOn(shopId, [ymdOf(new Date(), shop.timeZone), ymdOf(l.startedAt, shop.timeZone)]);
  const partIds = l.lines.map((x) => x.partId).filter((x): x is string => !!x);
  const kinds = new Map(holidays.length && partIds.length ? (await db.part.findMany({ where: { shopId, id: { in: partIds } }, select: { id: true, kind: true } })).map((p) => [p.id, p.kind as string]) : []);
  const lines = l.lines.map((x) => {
    const kind = x.stockUnitId ? "UNIT" : x.partId ? (kinds.get(x.partId) ?? "MISC") : "MISC";
    return { ...x, taxable: x.taxable && !holidays.some((h) => holidayCovers(h, { ...x, kind })) };
  });
  const t = saleTotals(lines, 0, exempt ? 0 : shop.taxRatePct);
  return { price: t.subtotal, tax: t.tax };
}

const INCLUDE = { lines: true, customer: { select: { id: true, name: true, phone: true, taxExemptId: true, taxExemptUntil: true } } } as const;

async function toView(shopId: string, l: LayawayRow, tz: string, paid: number): Promise<LayawayView> {
  const { price, tax } = await taxToday(shopId, l);
  const owed = price + tax;
  const plan = (Array.isArray(l.plan) ? l.plan : []) as PlanPayment[];
  const pays = await db.saleLine.findMany({
    where: { layawayId: l.id, kind: { in: ["LAYAWAY", "LAYAWAY_FEE"] }, sale: { shopId, status: "COMPLETED" } },
    select: { qty: true, unitPriceCents: true, discountCents: true, kind: true, sale: { select: { id: true, number: true, createdAt: true } } },
    orderBy: { sale: { createdAt: "asc" } },
  });
  return {
    id: l.id,
    number: l.number,
    status: l.status,
    customer: l.customer ? { id: l.customer.id, name: l.customer.name, phone: l.customer.phone } : null,
    startedAt: l.startedAt,
    dueBy: l.dueBy,
    every: isEvery(l.every) ? l.every : "2w",
    plan,
    depositMinCents: l.depositMinCents,
    terms: l.terms,
    note: l.note,
    lines: l.lines.map((x) => ({ id: x.id, description: x.description, qty: x.qty, unitPriceCents: x.unitPriceCents, discountCents: x.discountCents, taxable: x.taxable, stockUnitId: x.stockUnitId, partId: x.partId })),
    priceCents: price,
    taxCents: tax,
    owedCents: owed,
    paidCents: paid,
    leftCents: Math.max(0, owed - paid),
    behindCents: l.status === "OPEN" ? behind({ plan, depositMinCents: l.depositMinCents, dueBy: l.dueBy, paidCents: paid, owedCents: owed }, ymdOf(new Date(), tz)) : 0,
    payments: pays.map((p) => ({ saleId: p.sale.id, number: p.sale.number, at: p.sale.createdAt, cents: lineNet({ ...p, taxable: false }), kind: p.kind ?? "LAYAWAY" })),
    saleId: l.saleId,
    cancelFeeCents: l.cancelFeeCents,
    completedAt: l.completedAt,
    cancelledAt: l.cancelledAt,
  };
}

export async function layawayView(shopId: string, id: string): Promise<LayawayView | null> {
  const l = await db.layaway.findFirst({ where: { id, shopId }, include: INCLUDE });
  if (!l) return null;
  return toView(shopId, l, await shopTimeZone(shopId), (await paidFor(shopId, [l.id])).get(l.id) ?? 0);
}

/** The list (newest first) on one tab; `customerId` narrows it to one customer. */
export async function listLayaways(shopId: string, status: "OPEN" | "COMPLETED" | "CANCELLED", customerId?: string | null): Promise<LayawayView[]> {
  const rows = await db.layaway.findMany({ where: { shopId, status, ...(customerId ? { customerId } : {}) }, include: INCLUDE, orderBy: { number: "desc" }, take: 200 });
  const [paid, tz] = await Promise.all([
    paidFor(
      shopId,
      rows.map((r) => r.id),
    ),
    shopTimeZone(shopId),
  ]);
  return Promise.all(rows.map((r) => toView(shopId, r, tz, paid.get(r.id) ?? 0)));
}

/** Money held for customers: every LAYAWAY line of a sale that stands (payments in, used up or given back out). */
export async function depositsHeld(shopId: string, before?: Date): Promise<number> {
  const rows = await db.saleLine.findMany({ where: { kind: "LAYAWAY", sale: { shopId, status: "COMPLETED", ...(before ? { createdAt: { lt: before } } : {}) } }, select: { qty: true, unitPriceCents: true, discountCents: true } });
  return rows.reduce((a, r) => a + lineNet({ ...r, taxable: false }), 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Starting one

export type LayawayItemIn = { partId?: string | null; stockUnitId?: string | null; description?: string; qty: number; unitPriceCents: number; discountCents?: number };
export type StartInput = { customerId: string | null; lines: LayawayItemIn[]; depositCents: number; every?: string | null; days?: number | null; tender: Tender; clientKey?: string | null; note?: string | null };

/** One payment's tender, checked: a counter method, the amount the line pays. */
function tenderOf(t: Tender | null | undefined, amountCents: number): Tender[] {
  if (!amountCents) return [];
  const method = t && TENDER_METHODS.includes(t.method) ? t.method : null;
  if (!method) throw new UserError("Pick how they're paying.");
  return [{ method, amountCents, note: typeof t?.note === "string" ? t.note.slice(0, 100) || null : null, cardNumber: typeof t?.cardNumber === "string" ? t.cardNumber.slice(0, 40) : null }];
}

/** The register's "Layaway" button: holds the cart's items for the customer and takes the deposit. */
export async function startLayawayAs(user: CurrentUser, input: StartInput): Promise<{ layawayId: string; number: number; saleId: string; saleNumber: number }> {
  const shopId = user.shopId;
  await requireBaseWritable(user);
  const clientKey = typeof input.clientKey === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(input.clientKey) ? input.clientKey : null;
  // Sent again after a lost answer: the layaway its deposit made, not a second one.
  if (clientKey) {
    const made = await db.sale.findUnique({ where: { shopId_clientKey: { shopId, clientKey } }, select: { id: true, number: true, lines: { select: { layawayId: true }, take: 1 } } });
    const lid = made?.lines[0]?.layawayId;
    if (made && lid) {
      const l = await db.layaway.findFirstOrThrow({ where: { id: lid, shopId }, select: { id: true, number: true } });
      return { layawayId: l.id, number: l.number, saleId: made.id, saleNumber: made.number };
    }
  }
  const customer = input.customerId ? await db.customer.findFirst({ where: { id: input.customerId, shopId } }) : null;
  if (!customer) throw new UserError("Pick the customer first: a layaway is held for someone.");
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) throw new UserError("Add the items to hold first.");
  if (lines.length > 50) throw new UserError("That's too many items for one layaway.");
  const settings = await layawaySettings(shopId);
  const rows: Omit<Prisma.LayawayLineCreateManyInput, "layawayId">[] = [];
  const rowKinds: string[] = [];
  const unitIds = new Set<string>();
  for (const l of lines) {
    const qty = Number(l.qty);
    const price = Math.round(Number(l.unitPriceCents));
    const disc = Math.max(0, Math.round(Number(l.discountCents ?? 0)));
    if (!Number.isFinite(price) || price < 0 || price > MAX_MONEY) throw new UserError("Check the prices.");
    if (user.role === "TECH" && disc) throw new UserError("Only an owner or admin can give a discount.");
    if (l.stockUnitId) {
      const u = await db.stockUnit.findFirst({ where: { id: l.stockUnitId, shopId }, include: { machine: true } });
      if (!u || u.status !== "IN_STOCK" || !(await isSellableMachine(shopId, u.machine))) throw new UserError(`${u ? unitDescription(u) : "That machine"} isn't in stock any more.`);
      if (unitIds.has(u.id)) throw new UserError(`${unitDescription(u)} is on the list twice.`);
      if (u.priceCents == null) throw new UserError(`Set a price for ${unitDescription(u)} first (Machines for sale).`);
      if (user.role === "TECH" && price !== u.priceCents) throw new UserError(`Only an owner or admin can change the price of ${unitDescription(u)}.`);
      unitIds.add(u.id);
      rows.push({ stockUnitId: u.id, description: unitDescription(u), qty: 1, unitPriceCents: price, discountCents: Math.min(disc, price), taxable: true });
      rowKinds.push("UNIT");
    } else if (l.partId) {
      const p = await db.part.findFirst({ where: { id: l.partId, shopId } });
      if (!p) throw new UserError("An item isn't in your inventory any more.");
      if (p.consignLinkId) throw new UserError(`${p.partNumber} is a partner's consigned item: it can't be held on layaway.`);
      if (!(qty > 0) || qty > 10_000 || (p.unit !== "yd" && !Number.isInteger(qty))) throw new UserError(`Check the quantity of ${p.partNumber}.`);
      if (user.role === "TECH" && p.priceCents != null && price !== p.priceCents) throw new UserError(`Only an owner or admin can change the price of ${p.partNumber}.`);
      rows.push({ partId: p.id, description: (l.description || p.description).slice(0, 200), partNumber: p.partNumber, unit: p.unit, qty, unitPriceCents: price, discountCents: Math.min(disc, Math.round(qty * price)), taxable: true });
      rowKinds.push(p.kind);
    } else {
      throw new UserError("A layaway holds stock items and machines for sale. Ring up anything else as a sale.");
    }
  }
  const tz = await shopTimeZone(shopId);
  const today = ymdOf(new Date(), tz);
  const every = isEvery(input.every) ? input.every : settings.every;
  const days = Number.isInteger(Number(input.days)) && Number(input.days) >= 7 && Number(input.days) <= 730 ? Number(input.days) : settings.days;
  const dueBy = dueByOf(today, days);
  const exempt = exemptCertificate(customer);
  // Made at this store (7.1): its tax rate, and its shelf holds the items.
  const here = await currentStore(user);
  const shop = storeDetails(await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxRatePct: true } }), here);
  // The total the plan splits: today's tax, less what a tax holiday today takes off.
  const holidays = exempt ? [] : await holidaysOn(shopId, [today]);
  const t = saleTotals(
    rows.map((r, i) => {
      const line = { qty: r.qty as number, unitPriceCents: r.unitPriceCents as number, discountCents: r.discountCents as number, taxable: true };
      return { ...line, taxable: !holidays.some((h) => holidayCovers(h, { ...line, kind: rowKinds[i] })) };
    }),
    0,
    exempt ? 0 : shop.taxRatePct,
  );
  const deposit = Math.round(Number(input.depositCents));
  const least = minDeposit(t.subtotal, settings.depositPct);
  if (!Number.isFinite(deposit) || deposit < least) throw new UserError(`The deposit is at least $${(least / 100).toFixed(2)} (${settings.depositPct}% of the price).`);
  if (deposit > t.total) throw new UserError("The deposit is more than the whole price. Ring it up as a sale instead.");
  const plan = layawayPlan(today, dueBy, every, t.total - deposit);
  const tenders = tenderOf(input.tender, deposit);

  // Hold the items, then take the deposit through the register; if the deposit fails, the hold is undone.
  const layaway = await db.$transaction(async (tx) => {
    const sh = await tx.shop.update({ where: { id: shopId }, data: { nextLayawayNumber: { increment: 1 } }, select: { nextLayawayNumber: true } });
    const made = await tx.layaway.create({
      data: { shopId, number: sh.nextLayawayNumber - 1, customerId: customer.id, dueBy, every, plan: plan as unknown as Prisma.InputJsonValue, depositMinCents: deposit, terms: settings.terms, note: input.note?.slice(0, 500) || null, createdById: user.id, locationId: here?.id ?? null, lines: { create: rows } },
      include: { lines: true },
    });
    await holdItems(tx, shopId, made, user, new Date());
    return made;
  });
  try {
    const sale = await completeSaleAs(
      user,
      { customerId: customer.id, lines: [{ description: `Layaway #${layaway.number}: deposit`, qty: 1, unitPriceCents: deposit, taxable: false, layawayKind: "LAYAWAY" }], tenders, clientKey },
      { layaway: { id: layaway.id, mode: "pay" } },
    );
    return { layawayId: layaway.id, number: layaway.number, saleId: sale.saleId, saleNumber: sale.number };
  } catch (e) {
    await db.$transaction(async (tx) => {
      await releaseItems(tx, shopId, layaway, user, new Date(), "deposit not taken");
      await tx.layaway.deleteMany({ where: { id: layaway.id, shopId } });
    });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Payments, pick-up, cancel

async function openLayaway(shopId: string, id: string) {
  const l = await db.layaway.findFirst({ where: { id, shopId }, include: INCLUDE });
  if (!l) throw new UserError("Layaway not found.");
  if (l.status !== "OPEN") throw new UserError(`Layaway #${l.number} is ${l.status === "COMPLETED" ? "picked up" : "cancelled"} already.`);
  return l;
}

/** A payment toward it: any amount up to what is left (today's tax counted). */
export async function payLayawayAs(user: CurrentUser, a: { layawayId: string; amountCents: number; tender: Tender; clientKey?: string | null }): Promise<{ saleId: string; number: number; changeCents: number }> {
  const l = await openLayaway(user.shopId, a.layawayId);
  const v = await toView(user.shopId, l, await shopTimeZone(user.shopId), (await paidFor(user.shopId, [l.id])).get(l.id) ?? 0);
  const amount = Math.round(Number(a.amountCents));
  if (!Number.isFinite(amount) || amount <= 0) throw new UserError("Enter the amount they're paying.");
  if (amount > v.leftCents) throw new UserError(`Only $${(v.leftCents / 100).toFixed(2)} is left to pay. To take it home, use Pick up.`);
  const sale = await completeSaleAs(
    user,
    { customerId: l.customerId, lines: [{ description: `Layaway #${l.number}: payment`, qty: 1, unitPriceCents: amount, taxable: false, layawayKind: "LAYAWAY" }], tenders: tenderOf(a.tender, amount), clientKey: a.clientKey ?? null },
    { layaway: { id: l.id, mode: "pay" } },
  );
  return { saleId: sale.saleId, number: sale.number, changeCents: sale.changeCents };
}

/** The pick-up's lines: the items as held, and the payments used up. */
function pickUpLines(l: LayawayRow, paid: number) {
  return [
    ...l.lines.map((x) => ({ partId: x.partId, stockUnitId: x.stockUnitId, description: x.description, qty: x.qty, unitPriceCents: x.unitPriceCents, discountCents: x.discountCents, taxable: x.taxable })),
    ...(paid > 0 ? [{ description: `Layaway #${l.number}: paid so far`, qty: -1, unitPriceCents: paid, taxable: false, layawayKind: "LAYAWAY" as const }] : []),
  ];
}

/** What the pick-up comes to today: the items, the tax at today's rate, what was paid, and what is still due. */
export async function pickUpQuote(shopId: string, id: string) {
  const l = await openLayaway(shopId, id);
  const paid = (await paidFor(shopId, [l.id])).get(l.id) ?? 0;
  const { price, tax } = await taxToday(shopId, l);
  return { number: l.number, priceCents: price, taxCents: tax, paidCents: paid, dueCents: price + tax - paid };
}

/** The last visit: the items are sold today (today's tax), the payments pay for them, the rest is paid now. */
export async function pickUpLayawayAs(user: CurrentUser, a: { layawayId: string; tender?: Tender | null; clientKey?: string | null }): Promise<{ saleId: string; number: number; changeCents: number }> {
  const l = await openLayaway(user.shopId, a.layawayId);
  const q = await pickUpQuote(user.shopId, l.id);
  if (q.dueCents < 0) throw new UserError(`More was paid than it comes to today ($${(-q.dueCents / 100).toFixed(2)} over). An owner can cancel it and ring the items up again.`);
  const sale = await completeSaleAs(user, { customerId: l.customerId, lines: pickUpLines(l, q.paidCents), tenders: tenderOf(a.tender, q.dueCents), clientKey: a.clientKey ?? null }, { layaway: { id: l.id, mode: "pickup" }, locationId: l.locationId });
  // (Picked up at the layaway's own store: its items are on that shelf and the quote used that store's tax rate.)
  return { saleId: sale.saleId, number: sale.number, changeCents: sale.changeCents };
}

/**
 * Cancels it by the shop's rule: the fee kept (never more than was paid), the rest back as store credit or money (the
 * way picked); the items go back on sale. Owner or admin.
 */
export async function cancelLayawayAs(user: CurrentUser, a: { layawayId: string; refund?: "credit" | "money" | null; method?: string | null; clientKey?: string | null; reason?: string | null }): Promise<{ saleId: string | null; feeCents: number; backCents: number }> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can cancel a layaway.");
  const l = await openLayaway(user.shopId, a.layawayId);
  const s = await layawaySettings(user.shopId);
  const paid = (await paidFor(user.shopId, [l.id])).get(l.id) ?? 0;
  const { fee, back } = cancelSplit(paid, s.feeCents, s.feePct);
  const refund = a.refund === "money" || a.refund === "credit" ? a.refund : s.refund;
  const method = refund === "credit" ? "CREDIT" : a.method === "CARD" || a.method === "CHECK" ? a.method : "CASH";
  const lines = [
    ...(paid > 0 ? [{ description: `Layaway #${l.number}: cancelled, payments given back`, qty: -1, unitPriceCents: paid, taxable: false, layawayKind: "LAYAWAY" as const }] : []),
    ...(fee > 0 ? [{ description: `Layaway #${l.number}: cancel fee`, qty: 1, unitPriceCents: fee, taxable: false, layawayKind: "LAYAWAY_FEE" as const }] : []),
  ];
  if (!lines.length) {
    // Nothing was paid: the items just go back.
    await db.$transaction(async (tx) => {
      const r = await tx.layaway.updateMany({ where: { id: l.id, shopId: user.shopId, status: "OPEN" }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelFeeCents: 0, note: noteWith(l.note, a.reason) } });
      if (!r.count) throw new UserError("That layaway just changed. Look again.");
      await releaseItems(tx, user.shopId, l, user, new Date(), "cancelled");
    });
    return { saleId: null, feeCents: 0, backCents: 0 };
  }
  const sale = await completeSaleAs(
    user,
    { customerId: l.customerId, lines, tenders: back ? [{ method, amountCents: -back }] : [], clientKey: a.clientKey ?? null, note: a.reason?.slice(0, 200) || null },
    { layaway: { id: l.id, mode: "cancel", feeCents: fee } },
  );
  return { saleId: sale.saleId, feeCents: fee, backCents: back };
}

const noteWith = (note: string | null, reason: string | null | undefined) => [note, reason ? `Cancelled: ${reason.slice(0, 200)}` : null].filter(Boolean).join("\n") || null;

/** A friendly reminder about the next payment, by the customer's usual way (email or text), once a day at most. Needs Marketing. */
export async function remindLayawayAs(user: CurrentUser, id: string): Promise<void> {
  await requireBaseWritable(user);
  const v = await layawayView(user.shopId, id);
  if (!v || v.status !== "OPEN") throw new UserError("Layaway not found, or not open.");
  if (!v.customer) throw new UserError("This layaway has no customer to tell.");
  if (!(await moduleOn(user.shopId, "marketing"))) throw new UserError("Messages are off: Marketing isn't on. Call them instead.");
  const tz = await shopTimeZone(user.shopId);
  const today = ymdOf(new Date(), tz);
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true } });
  const next = v.plan.find((p) => p.due >= today);
  const owed = v.behindCents > 0 ? v.behindCents : (next?.cents ?? v.leftCents);
  const when = v.behindCents > 0 ? "now" : next ? `by ${fmtYmdLong(next.due)}` : `by ${fmtYmdLong(v.dueBy)}`;
  const body = `Hello from ${shop.name}! A friendly reminder about your layaway #${v.number}: a payment of ${money(owed)} is due ${when}. $${(v.leftCents / 100).toFixed(2)} is left in all. We're holding your items for you.${shop.phone ? ` Questions? Call ${shop.phone}.` : ""}`;
  await db.$transaction((tx) =>
    queueToCustomer(tx, {
      shopId: user.shopId,
      customerId: v.customer!.id,
      kind: "order_notice",
      channels: "preferred",
      content: (ch) => (ch === "email" ? { subject: `Your layaway #${v.number} at ${shop.name}`, body } : { body }),
      dedupeKey: `layaway:${v.id}:remind:${today}`,
      refType: "layaway",
      refId: v.id,
      byUserId: user.id,
    }),
  );
}
