import "server-only";
// The register's sale (completeSaleAs) and void (voidSaleAs), callable with a user so the check scripts can drive them;
// src/actions/register.ts wraps them. Notions, fabric by the yard, consigned stock, repair pickups, machines for sale and
// trade-ins, service plans (tax-machine-sales-layaway-design.md section 3), and (scheduling-messaging-design.md 12.3)
// class seats and appointments paid or refunded here.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { requireBaseWritable } from "@/lib/base-gate";
import { fineCost } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { withDisclosure } from "@/lib/part-labels";
import { sendToPartner } from "@/lib/partners";
import { normalizeTerms } from "@/lib/partner-terms";
import { discountShares, inEighths, lineNet, orderDiscountShares, qtyText, roundCents, saleTotals, tenderProblem, ALL_TENDER_METHODS, type Tender } from "@/lib/register-math";
import { applyUnitLine, prepareUnitLines, voidUnitLines } from "@/lib/units/sale-units";
import { applyPlanLine, endPlansOf, preparePlanLine, type PlanLineInput, type PreparedPlan } from "@/lib/units/plans";
import { afterLayawaySale, beforeLayawayLines, voidLayawaySale, type LayawayHook } from "@/lib/layaway-hooks";
import type { TradeInInput } from "@/lib/units/types";
import type { Prisma } from "@/generated/prisma/client";
import { classLine } from "@/lib/classes";
import { actorOf, audit } from "@/lib/audit";
import { applyCardLine, applyCardTender, prepareCardLine, reverseSale, type CardLine, type Issued } from "@/lib/gift-cards";
import { fmtWhen, ymdOf } from "@/lib/zoned";
import { exemptCertificate } from "@/lib/tax-exempt";
import { saleLineKind } from "@/lib/sale-kind";
import { holidaysOn } from "@/lib/tax-holidays";
import { prepareFinanced, recordFinanced, voidFinanced } from "@/lib/financing";
import { promotionsOn } from "@/lib/promotions";
import { bestDiscount, includedPromo, priceBeforeTax } from "@/lib/promo-math";
import { holidayCovers } from "@/lib/tax-holiday-math";

/** A repair the customer can take home: the repair shop has sent it back. */
export const BACK_FROM_REPAIR = ["READY_IN_TRUCK", "READY_FOR_PICKUP", "RETURNED_UNREPAIRED"];

/** What the customer still owes on a repair: the bill, less anything already paid to either shop. */
export function repairDue(j: { totalCents: number | null; repairPaidCents: number | null; paidCents: number | null }) {
  return Math.max(0, (j.totalCents ?? 0) - (j.repairPaidCents ?? 0) - (j.paidCents ?? 0));
}

export type SaleLineInput = {
  partId?: string | null;
  repairJobId?: string | null;
  pickedUp?: boolean;
  description: string;
  qty: number;
  unitPriceCents: number;
  discountCents?: number;
  taxable: boolean;
  /** Vac Shop: the customer's vacuum this bag, belt or filter is for. Any shop: a machine sold from stock; a trade-in taken as credit. */
  machineId?: string | null;
  stockUnitId?: string | null;
  tradeIn?: TradeInInput | null;
  /** A class seat or an appointment paid (qty 1) or refunded (qty -1) here. */
  enrollmentId?: string | null;
  appointmentId?: string | null;
  /** A gift card sold ("new" or a pre-printed "printed" blank), loaded, or its balance paid out (negative): later-round-1-design.md 2.3. */
  giftCard?: CardLine | null;
  /** The shop's service plan sold for a machine on this sale or one of the customer's. */
  servicePlan?: PlanLineInput | null;
  /** A tax holiday covers this line but the cashier charges tax anyway (an item the state leaves out that its kind didn't catch). */
  taxAnyway?: boolean;
  /** Layaway money (src/lib/layaway.ts only, with opts.layaway): a payment or the payments used up / given back, or its cancel fee. */
  layawayKind?: "LAYAWAY" | "LAYAWAY_FEE" | null;
  /**
   * Special orders (shop-features-round-2-design.md 1.2), from the program only (opts.internal), never the browser: a
   * deposit or balance paid toward one (DEPOSIT, money held for the customer), the deposits used up at pick-up or given
   * back (DEPOSIT, qty -1), or a kept non-refundable deposit (DEPOSIT_KEPT, income).
   */
  specialOrderId?: string | null;
  depositKind?: "DEPOSIT" | "DEPOSIT_KEPT" | null;
  /** Rentals (1.8), from the program only: rent paid on a machine out on rental (RENT, income). */
  unitLoanId?: string | null;
  rentKind?: "RENT" | null;
};

export type SaleInput = {
  customerId?: string | null;
  lines: SaleLineInput[];
  orderDiscountCents?: number;
  tenders: Tender[];
  note?: string | null;
  /** The register's own name for this sale, the same on every try: a sale sent again isn't made twice. */
  clientKey?: string | null;
  /** The online shop with Stripe Tax: the tax as the processor worked it out, recorded in place of the shop's rate (owner's calls only). */
  taxCents?: number | null;
  /** The customer is tax exempt but the cashier says charge tax anyway (no certificate is recorded then). */
  chargeTax?: boolean;
  /** The sale a scanned receipt brought back as this return (saleForReturn): a return-only cart is taxed at its rate and exemption. */
  returnOfSaleId?: string | null;
};

// $100,000 in cents: far above any real line, payment or sale, and well inside what the books' whole numbers hold.
const MAX_MONEY = 10_000_000;

/** The rate (to a hundredth of a percent) that gives `taxCents` on the taxable lines; 0 when nothing is taxable. */
function effectiveRate(lines: { qty: number; unitPriceCents: number; discountCents?: number; taxable: boolean }[], taxCents: number): number {
  const taxable = lines.filter((l) => l.taxable).reduce((a, l) => a + lineNet(l), 0);
  return taxable > 0 ? Math.round((taxCents / taxable) * 10_000) / 100 : 0;
}

/** Totals with the tax replaced by a given amount. */
function withTax(t: ReturnType<typeof saleTotals>, taxCents: number): ReturnType<typeof saleTotals> {
  const total = t.subtotal - t.orderDiscount + taxCents;
  const change = total >= 0 ? Math.max(0, t.paid - total) : 0;
  return { ...t, tax: taxCents, total, change, due: Math.max(0, total - t.paid) };
}

/** The sale already made under this key, if any. */
function saleByKey(shopId: string, clientKey: string | null) {
  return clientKey ? db.sale.findUnique({ where: { shopId_clientKey: { shopId, clientKey } }, select: { id: true, number: true, changeCents: true } }) : null;
}

/**
 * `paidOnline`: the books write for an online order the customer has already paid (online-shop.ts only, never an
 * action). Money taken is always booked, so the lapsed / moving gate is skipped for it.
 */
export async function completeSaleAs(
  user: CurrentUser,
  input: SaleInput,
  opts: { paidOnline?: boolean; layaway?: LayawayHook; internal?: boolean } = {},
): Promise<{ saleId: string; number: number; changeCents: number; cards?: Issued[] }> {
  {
    const shopId = user.shopId;
    // Layaway money and its held items come only from src/lib/layaway.ts; the items' prices were settled when it began.
    const lay = opts.layaway ?? null;
    if (!lay && input.lines.some((l) => l.layawayKind)) throw new UserError("A line can only be one thing.");
    // Deposits and rent are written by the program (special orders, pay links, rentals), never sent from a browser.
    if (!opts.internal && input.lines.some((l) => l.depositKind || l.rentKind)) throw new UserError("A line can only be one thing.");
    const priceRole: CurrentUser["role"] = lay ? "OWNER" : user.role;
    // Sent again after the answer to the first try was lost (a dropped connection): that sale, not a second one.
    const clientKey = typeof input.clientKey === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(input.clientKey) ? input.clientKey : null;
    const made = await saleByKey(shopId, clientKey);
    if (made) return { saleId: made.id, number: made.number, changeCents: made.changeCents };
    const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });
    if (!input.lines.length) throw new UserError("Nothing to sell yet. Scan or search for an item.");
    if (input.lines.length > 300) throw new UserError("That's too many lines for one sale.");
    // While the program is read-only (hub-accounts-billing-design.md 3.5): a return (every line money back) still goes
    // through, a sale doesn't.
    if (!opts.paidOnline && !input.lines.every((l) => Number(l.qty) < 0)) await requireBaseWritable(user);
    const rawTenders = Array.isArray(input.tenders) ? input.tenders : [];
    if (rawTenders.length > 20) throw new UserError("That's too many payments for one sale.");

    // Every item must be this shop's; repairs must be this shop's unpaid partner jobs.
    const partIds = [...new Set(input.lines.map((l) => l.partId).filter(Boolean) as string[])];
    const parts = new Map((await db.part.findMany({ where: { shopId, id: { in: partIds } } })).map((p) => [p.id, p]));
    if (parts.size !== partIds.length) throw new UserError("An item on this sale isn't in your inventory any more. Remove it and scan it again.");
    const jobIds = [...new Set(input.lines.map((l) => l.repairJobId).filter(Boolean) as string[])];
    const jobs = new Map((await db.repairJob.findMany({ where: { shopId, side: "retail", id: { in: jobIds } } })).map((j) => [j.id, j]));
    for (const id of jobIds) {
      const j = jobs.get(id);
      if (!j) throw new UserError("That repair isn't one of this shop's.");
      // Paid, unless the bill went up after it was paid here: then the rest is paid the same way.
      if (j.paidAt && repairDue(j) <= 0) throw new UserError(`Repair tag ${j.tag} is already paid.`);
    }
    // Class seats and appointments: this shop's, each once per sale.
    const bookings = await loadBookings(shopId, input.lines);
    // A supply bought for a customer's vacuum names one of this shop's vacuums.
    const machineIds = [...new Set(input.lines.map((l) => l.machineId).filter(Boolean) as string[])];
    if (machineIds.length && (await db.machine.count({ where: { shopId, id: { in: machineIds }, equipment: "VACUUM" } })) !== machineIds.length) {
      throw new UserError("That vacuum isn't one of this shop's.");
    }
    if (input.customerId && !(await db.customer.findFirst({ where: { id: input.customerId, shopId } }))) throw new UserError("Customer not found.");
    // Machines sold from stock and trade-ins, checked and worded by the unit hooks (by line index).
    const units = await prepareUnitLines({
      shopId,
      role: priceRole,
      heldFor: lay?.mode === "pickup" ? lay.id : null,
      customerId: input.customerId ?? null,
      lines: input.lines.map((l) => ({
        stockUnitId: l.stockUnitId ?? null,
        tradeIn: l.tradeIn ?? null,
        qty: Number(l.qty),
        unitPriceCents: Math.round(Number(l.unitPriceCents)),
        taxable: Boolean(l.taxable),
      })),
    });

    // Service plans, checked and priced by the server (by line index): the machine is a unit on this sale or the customer's.
    const planLines = new Map<number, PreparedPlan>();
    const unitIdsOnSale = input.lines.filter((l) => l.stockUnitId && Number(l.qty) > 0).map((l) => l.stockUnitId!);
    for (const [i, l] of input.lines.entries()) {
      if (!l.servicePlan) continue;
      if ([l.partId, l.repairJobId, l.stockUnitId, l.tradeIn, l.enrollmentId, l.appointmentId, l.giftCard].some(Boolean)) throw new UserError("A line can only be one thing.");
      planLines.set(i, await preparePlanLine({ shopId, role: user.role, customerId: input.customerId ?? null, unitIdsOnSale }, l.servicePlan, Number(l.qty), Number(l.unitPriceCents)));
    }

    // Gift card lines (sold, loaded, paid out), checked and priced by the server (by line index).
    const giftLines = new Map<number, Awaited<ReturnType<typeof prepareCardLine>>>();
    for (const [i, l] of input.lines.entries()) {
      if (!l.giftCard) continue;
      if ([l.partId, l.repairJobId, l.stockUnitId, l.tradeIn, l.enrollmentId, l.appointmentId, l.servicePlan].some(Boolean)) throw new UserError("A line can only be one thing.");
      giftLines.set(i, await prepareCardLine(shopId, user.role, l.giftCard, Number(l.qty), Math.round(Number(l.unitPriceCents))));
    }
    if ([...giftLines.values()].some((g) => g.qty < 0) && rawTenders.some((t) => t?.method !== "CASH" && Number(t?.amountCents))) {
      throw new UserError("A gift card balance is paid out in cash. Use Cash for the payout.");
    }

    const lines = input.lines.map((l, i) => {
      const plan = planLines.get(i);
      if (plan) {
        let disc = Math.max(0, Math.round(Number(l.discountCents ?? 0)));
        if (user.role === "TECH" && disc) throw new UserError("Only an owner or admin can give a discount.");
        disc = Math.min(disc, plan.unitPriceCents);
        return {
          partId: null,
          repairJobId: null,
          pickedUp: false,
          description: plan.description,
          partNumber: null,
          qty: 1,
          unit: null,
          unitPriceCents: plan.unitPriceCents,
          discountCents: disc,
          taxable: plan.taxable,
          discountable: true,
          costCents: null,
          costTenThou: null,
          consignLinkId: null,
          consignItemKey: null,
          machineId: null,
          stockUnitId: null,
          tradeIn: null,
          enrollmentId: null,
          appointmentId: null,
        };
      }
      const gift = giftLines.get(i);
      if (gift) {
        // Selling or loading a card isn't a sale of goods: untaxed, never discounted (and the tax reports leave it out).
        return {
          partId: null,
          repairJobId: null,
          pickedUp: false,
          description: gift.description,
          partNumber: null,
          qty: gift.qty,
          unit: null,
          unitPriceCents: gift.unitPriceCents,
          discountCents: 0,
          taxable: false,
          discountable: false,
          costCents: null,
          costTenThou: null,
          consignLinkId: null,
          consignItemKey: null,
          machineId: null,
          stockUnitId: null,
          tradeIn: null,
          enrollmentId: null,
          appointmentId: null,
        };
      }
      const things = [l.partId, l.repairJobId, l.stockUnitId, l.tradeIn, l.enrollmentId, l.appointmentId].filter(Boolean).length;
      if (things > 1) throw new UserError("A line can only be one thing.");
      if (l.enrollmentId || l.appointmentId) return bookingLine(user.role, l, bookings, shop.timeZone);
      const unitLine = units.get(i);
      if (unitLine) {
        const total = Math.abs(roundCents(unitLine.qty * unitLine.unitPriceCents));
        if (unitLine.unitPriceCents > MAX_MONEY || total > MAX_MONEY) throw new UserError(`${unitLine.description} comes to more than $100,000. Check the price.`);
        let disc = Math.max(0, Math.round(Number(l.discountCents ?? 0)));
        if (priceRole === "TECH" && disc) throw new UserError("Only an owner or admin can give a discount.");
        disc = unitLine.discountable ? Math.min(disc, total) : 0;
        return {
          partId: null,
          repairJobId: null,
          pickedUp: false,
          description: unitLine.description.slice(0, 200),
          partNumber: null,
          qty: unitLine.qty,
          unit: null,
          unitPriceCents: unitLine.unitPriceCents,
          discountCents: disc,
          taxable: unitLine.taxable,
          discountable: unitLine.discountable,
          costCents: unitLine.costCents,
          consignLinkId: null,
          consignItemKey: null,
          machineId: null,
          stockUnitId: unitLine.stockUnitId,
          tradeIn: l.tradeIn ?? null,
          enrollmentId: null,
          appointmentId: null,
        };
      }
      const part = l.partId ? parts.get(l.partId)! : null;
      const job = l.repairJobId ? jobs.get(l.repairJobId)! : null;
      let qty = Number(l.qty);
      // Fabric is cut in eighths, and an eighth is exact in binary: counts and sums never drift, and the repair shop
      // (which rounds to thousandths) records the same number. Anything that is not an eighth is refused below.
      if (part?.unit === "yd" && Number.isFinite(qty) && inEighths(qty)) qty = Math.round(qty * 8) / 8;
      if (!Number.isFinite(qty) || qty === 0 || Math.abs(qty) > 10000) throw new UserError("Each line needs a quantity.");
      let unit = Math.round(Number(l.unitPriceCents));
      if (!Number.isFinite(unit) || unit < 0) throw new UserError("Prices can't be negative. For a return, use Return mode (negative quantity).");
      let disc = Math.max(0, Math.round(Number(l.discountCents ?? 0)));
      if (job) {
        if (qty !== 1) throw new UserError("A repair is one line of 1.");
        if (disc) throw new UserError("A repair is paid as the repair shop billed it; it can't be discounted here.");
        // The balance as we know it now, not what the page had when it was opened.
        unit = repairDue(job);
        if (unit <= 0) throw new UserError(`Repair tag ${job.tag} has nothing left to pay.`);
        // The machine goes home only if the repair shop has sent it back (the pickup list may be out of date).
        if (l.pickedUp !== false && !job.pickedUpAt && !BACK_FROM_REPAIR.includes(job.status)) {
          throw new UserError(`Repair tag ${job.tag} isn't back from the repair shop yet. Untick "taking the machine home" to take the payment only.`);
        }
      }
      if (part) {
        // A machine model is ordered, not sold: what arrives is a machine for sale (shop-features-round-2-design.md 2.3).
        if (part.kind === "MACHINE") throw new UserError(`${part.partNumber} is a machine model to order. Sell the machine itself under Machine for sale.`);
        if (part.unit !== "yd" && !Number.isInteger(qty)) throw new UserError(`${part.partNumber} is sold each: use a whole number.`);
        if (part.unit === "yd" && !inEighths(qty)) throw new UserError(`Check the yardage of ${part.partNumber}: fabric is cut in eighths of a yard (2 3/8 is 2.375).`);
        if (priceRole === "TECH" && part.priceCents != null && unit !== part.priceCents) throw new UserError(`Only an owner or admin can change the price of ${part.partNumber}.`);
        // A tech can type the price of an item that has none, but not leave it free.
        if (priceRole === "TECH" && part.priceCents == null && unit === 0) throw new UserError(`${part.partNumber} has no price yet. Type the price on the line.`);
      }
      // A discount is a price change too.
      if (priceRole === "TECH" && disc) throw new UserError("Only an owner or admin can give a discount.");
      if (unit > MAX_MONEY || Math.abs(qty * unit) > MAX_MONEY) {
        throw new UserError(`${part?.partNumber ?? (l.description || "A line")} comes to more than $100,000. Check the price and quantity.`);
      }
      // A discount can take a line to zero, never below.
      disc = Math.min(disc, Math.abs(roundCents(qty * unit)));
      const text = (l.description || part?.description || "Item").slice(0, 200);
      return {
        partId: part?.id ?? null,
        repairJobId: job?.id ?? null,
        pickedUp: l.pickedUp !== false,
        // A used, refurbished, compatible or 3D printed item says so on the receipt: written now, so the receipt stays
        // right if the item is changed later.
        description: part ? withDisclosure(text, part) : text,
        partNumber: part?.partNumber ?? null,
        qty,
        unit: part?.unit ?? null,
        unitPriceCents: unit,
        discountCents: disc,
        // The server has no tax setting per item, so stocked items are always taxed; the browser's flag counts for a misc
        // line only. Layaway money is never taxed nor discounted (it isn't a sale).
        taxable: job || l.layawayKind ? false : part ? true : Boolean(l.taxable),
        discountable: !job && !l.layawayKind,
        costCents: part?.costCents ?? null,
        costTenThou: part ? fineCost(part.costCents, part.costTenThou) : null,
        consignLinkId: part?.consignLinkId ?? null,
        consignItemKey: part?.consignItemKey ?? null,
        machineId: l.machineId ?? null,
        stockUnitId: null,
        tradeIn: null,
        enrollmentId: null,
        appointmentId: null,
      };
    });

    const tenders = rawTenders
      .map((t) => ({
        method: ALL_TENDER_METHODS.includes(t?.method) ? t.method : "OTHER",
        amountCents: Math.round(Number(t?.amountCents) || 0),
        note: typeof t?.note === "string" ? t.note.slice(0, 100) || null : null,
        cardNumber: typeof t?.cardNumber === "string" ? t.cardNumber.slice(0, 40) : null,
        ...(t?.method === "FINANCED" ? { lenderId: typeof t.lenderId === "string" ? t.lenderId : "" } : {}),
      }))
      .filter((t) => t.amountCents !== 0);
    if (tenders.some((t) => Math.abs(t.amountCents) > MAX_MONEY)) throw new UserError("A payment can't be more than $100,000. Check the amount.");
    // A Financing payment names one of this shop's lenders and its approval number (the lender's name is kept with it).
    await prepareFinanced(shopId, tenders);
    const orderDiscountCents = Math.max(0, Math.round(Number(input.orderDiscountCents) || 0));
    if (user.role === "TECH" && orderDiscountCents) throw new UserError("Only an owner or admin can give a discount.");
    // A tax amount the processor worked out (Stripe Tax) stands in for the rate; the rate recorded is the effective one,
    // so a return mirrors the sale's tax as closely as a rate can.
    const givenTax = input.taxCents != null && user.role !== "TECH" ? Math.max(0, Math.round(Number(input.taxCents))) : null;
    // A tax-exempt customer's sale charges no tax (their certificate number is kept on it), unless the cashier ticks
    // "Charge tax anyway" (chargeTax). A processor's tax amount (online shop) is never overridden here.
    const customerId = input.customerId || firstBookingCustomer(lines, bookings);
    // A return scanned in from a receipt (every line a return) gives back the tax as that sale charged it: its rate and
    // exemption, not the customer's or the shop's today.
    const fromReceipt = givenTax == null && typeof input.returnOfSaleId === "string" && input.returnOfSaleId !== "" && lines.every((l) => l.qty < 0);
    const original = fromReceipt
      ? await db.sale.findFirst({ where: { id: input.returnOfSaleId!, shopId }, select: { taxRatePct: true, taxExemptId: true, lines: { select: { partId: true, taxable: true, taxNote: true } } } })
      : null;
    if (fromReceipt && !original) throw new UserError("The sale being returned wasn't found.");
    const exemptId = original
      ? original.taxExemptId
      : givenTax == null && customerId && input.chargeTax !== true
        ? exemptCertificate(await db.customer.findFirst({ where: { id: customerId, shopId }, select: { taxExemptId: true, taxExemptUntil: true } }))
        : null;
    // Each line's category (written on it below), and why a line that could be taxed wasn't (SaleLine.taxNote).
    const lineKinds = lines.map((l, i) =>
      saleLineKind({
        ...l,
        kind: input.lines[i].layawayKind ?? null,
        giftCardId: input.lines[i].giftCard ? "pending" : null,
        tradeInUnitId: l.tradeIn ? "pending" : null,
        machinePlanId: planLines.has(i) ? "pending" : null,
        partKind: l.partId ? parts.get(l.partId)?.kind : null,
      }),
    );
    const taxNotes: (string | null)[] = lines.map(() => null);
    // Promotions in force today (tax-machine-sales-layaway-design.md section 2): the best percent or amount off that
    // covers an item being bought becomes its own discount (a bigger one an owner typed stands). Not for a return, a
    // layaway (its prices were settled when it began), the online shop (priced at checkout) or a given tax amount.
    const promoIds: (string | null)[] = lines.map(() => null);
    const promos = lay || original || givenTax != null || opts.paidOnline ? [] : await promotionsOn(shopId, ymdOf(new Date(), shop.timeZone));
    const unitBrands = new Map<string, string>();
    if (promos.length) {
      const ids = lines.map((l) => l.stockUnitId).filter((x): x is string => !!x);
      if (ids.length) for (const u of await db.stockUnit.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, machine: { select: { brand: true } } } })) unitBrands.set(u.id, u.machine.brand);
    }
    const promoLine = (l: (typeof lines)[number], i: number) => ({ ...l, kind: lineKinds[i], brand: l.partId ? parts.get(l.partId)?.brand : l.stockUnitId ? unitBrands.get(l.stockUnitId) : null });
    for (const [i, l] of lines.entries()) {
      if (l.qty <= 0 || !(l.partId || l.stockUnitId) || input.lines[i].layawayKind) continue;
      const best = bestDiscount(promos, promoLine(l, i));
      if (best && best.cents > l.discountCents) {
        l.discountCents = best.cents;
        promoIds[i] = best.promo.id;
      }
    }
    if (original) {
      // A return from a receipt gives each item back as it was taxed: one bought on a tax holiday comes back tax free.
      for (const [i, l] of lines.entries()) {
        const o = l.partId ? original.lines.find((x) => x.partId === l.partId) : null;
        if (o) {
          l.taxable = o.taxable;
          taxNotes[i] = o.taxNote;
        }
      }
    } else if (givenTax == null && exemptId) {
      for (const [i, l] of lines.entries()) if (l.taxable) taxNotes[i] = "exempt";
    } else if (givenTax == null) {
      // A sales tax holiday in force today (tax-machine-sales-layaway-design.md section 1), or for a layaway's pick-up
      // on the day it began, takes the tax off the lines it covers, unless the cashier charged it anyway on that line.
      const days = [ymdOf(new Date(), shop.timeZone)];
      if (lay?.mode === "pickup") {
        const began = await db.layaway.findFirst({ where: { id: lay.id, shopId }, select: { startedAt: true } });
        if (began) days.push(ymdOf(began.startedAt, shop.timeZone));
      }
      const holidays = await holidaysOn(shopId, days);
      for (const [i, l] of lines.entries()) {
        if (l.qty <= 0 || input.lines[i].taxAnyway) continue;
        const h = holidays.find((x) => holidayCovers(x, { ...l, kind: lineKinds[i] }));
        if (h) {
          l.taxable = false;
          taxNotes[i] = `holiday:${h.id}`;
        }
      }
      // "Price includes the tax" (off unless the owner turned it on): the sticker price is the most the customer pays;
      // the line keeps the price before tax, worked out at the shop's rate, so the books and the tax report show the real tax.
      for (const [i, l] of lines.entries()) {
        if (l.qty <= 0 || !l.taxable || taxNotes[i] || l.discountCents || !(l.partId || l.stockUnitId)) continue;
        const p = includedPromo(promos, promoLine(l, i));
        if (!p) continue;
        l.unitPriceCents = priceBeforeTax(l.unitPriceCents, shop.taxRatePct);
        taxNotes[i] = "included";
        promoIds[i] = p.id;
      }
    }
    const taxRatePct = original ? original.taxRatePct : givenTax != null ? effectiveRate(lines, givenTax) : exemptId ? 0 : shop.taxRatePct;
    const totals = givenTax != null ? withTax(saleTotals(lines, orderDiscountCents, 0, tenders), givenTax) : saleTotals(lines, orderDiscountCents, taxRatePct, tenders);
    if (Math.abs(totals.subtotal) > MAX_MONEY) throw new UserError("A sale can't be more than $100,000. Check the prices and quantities.");
    const problem = tenderProblem(totals, tenders);
    if (problem) throw new UserError(problem);
    // Each line's share of the whole-sale discount as the tax was worked out (what a machine really sold for).
    const shares = discountShares(lines, totals.orderDiscount);

    // The sewing shop's share of consigned sales, as the partnership stands today (kept with each sale).
    const consignShares = new Map<string, number>();
    for (const linkId of new Set(lines.map((l) => l.consignLinkId).filter(Boolean) as string[])) {
      const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: linkId } }, select: { terms: true } });
      consignShares.set(linkId, normalizeTerms(link?.terms).consignSharePct);
    }

    // Each line's part of the whole-sale discount, adding up to it exactly (what a consigned item really sold for).
    const orderShares = orderDiscountShares(lines, totals.orderDiscount);

    const at = new Date();
    const result = await db
      .$transaction(async (tx) => {
        const sh = await tx.shop.update({ where: { id: shopId }, data: { nextSaleNumber: { increment: 1 } }, select: { nextSaleNumber: true } });
        const number = sh.nextSaleNumber - 1;
        const actor = actorOf(user);
        const cards: Issued[] = [];
        // A pick-up or a cancel: the layaway is finished and its held items back on the shelf, so the lines can sell them.
        if (lay) await beforeLayawayLines(tx, { shopId, hook: lay, user, at });
        const sale = await tx.sale.create({
          data: {
            shopId,
            number,
            customerId,
            userId: user.id,
            subtotalCents: totals.subtotal,
            discountCents: totals.orderDiscount,
            taxCents: totals.tax,
            totalCents: totals.total,
            taxRatePct,
            taxExemptId: exemptId,
            // The card number typed for a gift card or store credit isn't kept here; the card itself is (below).
            tenders: tenders.map(({ cardNumber, ...t }) => (void cardNumber, t)) as Prisma.InputJsonValue,
            changeCents: totals.change,
            note: input.note?.slice(0, 500) || null,
            clientKey,
            createdAt: at,
          },
        });
        for (const [i, l] of lines.entries()) {
          // tradeIn isn't a column: the unit hooks make the trade-in's own rows and sets tradeInUnitId on the line.
          const { pickedUp, discountable, tradeIn, ...row } = l;
          void discountable;
          const line = await tx.saleLine.create({ data: { saleId: sale.id, ...row, kind: lineKinds[i], taxNote: taxNotes[i], promotionId: promoIds[i], layawayId: lay?.id ?? null } });
          const gift = giftLines.get(i);
          if (gift) {
            const issued = await applyCardLine(tx, actor, input.lines[i].giftCard!, gift.unitPriceCents, { saleId: sale.id, saleLineId: line.id, saleLabel: `Sale #${number}` });
            cards.push(issued);
            await tx.saleLine.update({ where: { id: line.id }, data: { giftCardId: issued.cardId } });
          }
          if (l.stockUnitId || tradeIn) {
            await applyUnitLine(tx, { shopId, saleNumber: number, customerId, at, timeZone: shop.timeZone, line, tradeIn, discountShareCents: shares[i] });
          }
          const plan = planLines.get(i);
          if (plan) await applyPlanLine(tx, { shopId, at, timeZone: shop.timeZone, line, prepared: plan });
          if (l.enrollmentId || l.appointmentId) await settleBooking(tx, shopId, l, line.id, at);
          if (l.partId) {
            await tx.part.update({ where: { id: l.partId }, data: { qtyOnHand: { decrement: l.qty } } });
            await tx.stockMove.create({
              data: { shopId, partId: l.partId, qty: -l.qty, reason: "SOLD", userId: user.id, note: `Sale #${number}`, createdAt: at },
            });
          }
          if (l.consignLinkId && l.consignItemKey) {
            // Consigned stock: the owner hears about every sale; the net price after the line discount and the line's part
            // of any whole-sale discount is what counts.
            const net = Math.round((lineNet(l) - orderShares[i]) / l.qty);
            const gross = Math.round(l.qty * net);
            await tx.consignSale.create({
              data: {
                id: line.id,
                shopId,
                linkId: l.consignLinkId,
                itemKey: l.consignItemKey,
                qty: l.qty,
                priceCents: net,
                saleNumber: number,
                soldAt: at,
                shopKeepsCents: Math.round((gross * (consignShares.get(l.consignLinkId) ?? 0)) / 100),
              },
            });
            // A sale sells only what is still on the shelf and a return takes back only what was sold (the repair shop
            // applies the same rules, so both books agree). Quantities are floats: a millionth of slack.
            const key = { shopId, linkId: l.consignLinkId, itemKey: l.consignItemKey };
            if (l.qty > 0) {
              const item = await tx.consignItem.findUnique({ where: { shopId_linkId_itemKey: key } });
              const onShelf = item ? item.placed - item.sold - item.returned : 0;
              if (!item || l.qty > onShelf + 1e-6) {
                throw new UserError(`${l.description}: ${onShelf > 1e-6 ? `only ${qtyText(onShelf, l.unit)}` : "none"} left on the shelf on consignment.`);
              }
              // Only if nobody sold it meanwhile (another register).
              const took = await tx.consignItem.updateMany({ where: { id: item.id, sold: item.sold }, data: { sold: { increment: l.qty } } });
              if (!took.count) throw new UserError(`${l.description} was just sold at another register. Ring it up again.`);
            } else {
              const took = await tx.consignItem.updateMany({ where: { ...key, sold: { gte: -l.qty - 1e-6 } }, data: { sold: { increment: l.qty } } });
              if (!took.count) throw new UserError(`More of ${l.description} is being returned than was sold on consignment.`);
            }
            await sendToPartner(shopId, l.consignLinkId, "consign.sale", { id: line.id, itemKey: l.consignItemKey, qty: l.qty, priceCents: net, saleNumber: number, at: at.toISOString() }, tx, false);
          }
          if (l.repairJobId) {
            const job = jobs.get(l.repairJobId)!;
            const amount = lineNet(l);
            // Adds to anything paid here before (the rest of a bill that went up after it was paid).
            const paidHere = (job.paidCents ?? 0) + amount;
            // A machine already handed over isn't handed over again.
            const handOver = pickedUp && !job.pickedUpAt;
            const events = [
              ...((job.events as { at: string; note?: string; status?: string }[]) ?? []),
              { at: at.toISOString(), note: `Paid $${(amount / 100).toFixed(2)} at the counter, sale #${number}` },
            ].slice(-200);
            // Only if nobody paid it and the bill didn't change meanwhile (another register, a second click, an update).
            const paid = await tx.repairJob.updateMany({
              where: { shopId, id: job.id, paidCents: job.paidCents, repairPaidCents: job.repairPaidCents, totalCents: job.totalCents, ...(handOver ? { status: job.status } : {}) },
              data: {
                paidCents: paidHere,
                paidAt: job.paidAt ?? at,
                paidWhere: job.repairPaidCents ? "split" : "shop",
                // A machine sent back unrepaired stays that way in the record (as on the repair shop's side).
                ...(handOver ? { pickedUpAt: at, status: job.status === "RETURNED_UNREPAIRED" ? job.status : "COLLECTED" } : {}),
                events: (handOver ? [...events, { at: at.toISOString(), status: "COLLECTED" }] : events) as Prisma.InputJsonValue,
              },
            });
            if (!paid.count) throw new UserError(`Repair tag ${job.tag} was just paid, or its bill or status changed. Take it off this sale and add it again.`);
            // amountCents is this payment; paidCents is everything paid here so far (a repeat of a message adds nothing).
            await sendToPartner(shopId, job.linkId, "job.paid", { id: job.id, amountCents: amount, paidCents: paidHere, saleNumber: number, at: at.toISOString() }, tx, false);
            if (handOver) await sendToPartner(shopId, job.linkId, "job.pickedup", { id: job.id, at: at.toISOString() }, tx, false);
          }
        }
        // Gift card and store credit payments (and store credit given back) move their cards in this transaction too: a
        // card that can't cover its amount fails the whole sale.
        if (tenders.some((t) => t.method === "GIFT" || t.method === "CREDIT")) {
          const stored: Tender[] = [];
          for (const { cardNumber, ...t } of tenders) {
            if (t.method !== "GIFT" && t.method !== "CREDIT") {
              stored.push(t);
              continue;
            }
            const r = await applyCardTender(tx, actor, { method: t.method, amountCents: t.amountCents, cardNumber }, { customerId, saleId: sale.id, label: `Sale #${number}` });
            stored.push({ ...t, cardId: r.cardId, last4: r.last4, leftCents: r.leftCents });
            if (r.issued) cards.push(r.issued);
          }
          await tx.sale.update({ where: { id: sale.id }, data: { tenders: stored as Prisma.InputJsonValue } });
        }
        // What each lender now owes the shop (Financing payments).
        await recordFinanced(tx, { shopId, saleId: sale.id, tenders, at });
        if (lay) await afterLayawaySale(tx, { shopId, hook: lay, saleId: sale.id });
        // The exceptions go in the audit log (design 4.1: the sale is its own record, what is unusual about it is not).
        const label = `Sale #${number}`;
        if (lines.some((l, i) => l.qty < 0 && !input.lines[i].layawayKind)) {
          await audit(tx, actor, { action: "sale.return", subjectType: "Sale", subjectId: sale.id, subjectLabel: label, amountCents: totals.total, reason: input.note?.slice(0, 200) || null });
        }
        const lineDiscounts = lines.reduce((a, l) => a + (l.discountCents > 0 ? l.discountCents : 0), 0);
        if (lineDiscounts > 0 || totals.orderDiscount > 0) {
          await audit(tx, actor, {
            action: "sale.discount",
            subjectType: "Sale",
            subjectId: sale.id,
            subjectLabel: label,
            amountCents: lineDiscounts + totals.orderDiscount,
            changes: { lineDiscountCents: [0, lineDiscounts], saleDiscountCents: [0, totals.orderDiscount] },
          });
        }
        const overrides: Record<string, [unknown, unknown]> = {};
        for (const l of lines) {
          const part = l.partId ? parts.get(l.partId) : null;
          if (part && part.priceCents != null && l.unitPriceCents !== part.priceCents && l.qty > 0) overrides[part.partNumber] = [part.priceCents, l.unitPriceCents];
        }
        if (Object.keys(overrides).length) {
          await audit(tx, actor, { action: "sale.price_override", subjectType: "Sale", subjectId: sale.id, subjectLabel: label, changes: overrides });
        }
        return { sale, cards };
      })
      .catch(async (e: unknown) => {
        // The same sale sent twice at once: the other try made it.
        const made = (e as { code?: string })?.code === "P2002" ? await saleByKey(shopId, clientKey) : null;
        if (made) return { sale: made, cards: [] as Issued[] };
        throw e;
      });
    return { saleId: result.sale.id, number: result.sale.number, changeCents: result.sale.changeCents, cards: result.cards };
  }
}

/** Undo a sale that was rung up by mistake: stock goes back, consigned sales are reversed with the owner. */
export async function voidSaleAs(user: CurrentUser, saleId: string, reason: string): Promise<void> {
  const shopId = user.shopId;
  const sale = await db.sale.findFirst({ where: { id: saleId, shopId }, include: { lines: true } });
  if (!sale) throw new UserError("Sale not found.");
  if (sale.status === "VOIDED") throw new UserError("That sale is already void.");
  if (sale.lines.some((l) => l.repairJobId)) {
    throw new UserError("This sale paid for a repair. Ring up a return for the items instead, and sort the repair payment out with the repair shop.");
  }
  const at = new Date();
  await db.$transaction(async (tx) => {
    // Only a sale that is still complete (two voids at once must not put the stock back twice).
    const done = await tx.sale.updateMany({
      where: { id: sale.id, shopId, status: "COMPLETED" },
      data: { status: "VOIDED", voidedAt: at, note: [sale.note, `Void: ${reason || "no reason given"} (${user.name})`].filter(Boolean).join("\n") },
    });
    if (!done.count) throw new UserError("That sale is already void.");
    await audit(tx, actorOf(user), {
      action: "sale.void",
      subjectType: "Sale",
      subjectId: sale.id,
      subjectLabel: `Sale #${sale.number}`,
      amountCents: sale.totalCents,
      changes: { status: ["COMPLETED", "VOIDED"] },
      reason: reason || null,
    });
    // Gift cards and store credit the sale used come back; a card it sold goes void, unless it has been spent since
    // (then the void is refused and nothing changes).
    await reverseSale(tx, actorOf(user), sale.id, sale.number);
    // Financing on it is voided too (refused once the lender has paid).
    await voidFinanced(tx, { shopId, saleId: sale.id, at });
    // Machines sold go back in stock (their plans end); trade-ins taken come back out.
    await voidUnitLines(tx, { shopId, saleNumber: sale.number, customerId: sale.customerId, lines: sale.lines, at, saleAt: sale.createdAt });
    // A club month paid here: the payment is voided with the sale and the member's paid month goes back.
    await unpayClubSale(tx, shopId, sale.id, at);
    // A layaway's pick-up or cancel voided: the layaway is open again and its items held again (after the lines below
    // put them back on the shelf); a payment can't be voided once the layaway is finished.
    const layawayVoid = sale.lines.some((l) => l.layawayId);
    // A quilt collected on this sale is back on the shelf (ready, not collected).
    await tx.longarmOrder.updateMany({ where: { shopId, saleId: sale.id, status: "COLLECTED" }, data: { status: "READY", collectedAt: null, saleId: null } });
    for (const l of sale.lines) {
      // A service plan sold here ends (lines it already covered stay covered).
      if (l.machinePlanId) await endPlansOf(tx, shopId, l.id, at);
      if (l.enrollmentId || l.appointmentId) await unsettleBooking(tx, shopId, l);
      if (l.partId) {
        const part = await tx.part.findFirst({ where: { id: l.partId, shopId } });
        if (part) {
          await tx.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: l.qty } } });
          await tx.stockMove.create({ data: { shopId, partId: part.id, qty: l.qty, reason: "SOLD", userId: user.id, note: `Sale #${sale.number} void`, createdAt: at } });
        }
      }
      if (l.consignLinkId && l.consignItemKey) {
        const id = `${l.id}-void`;
        const original = await tx.consignSale.findUnique({ where: { shopId_id: { shopId, id: l.id } }, select: { priceCents: true, shopKeepsCents: true } });
        // Undone at the price it was paid out at (after any whole-sale discount).
        const net = original?.priceCents ?? Math.round(lineNet(l) / l.qty);
        await tx.consignSale.create({
          data: {
            id,
            shopId,
            linkId: l.consignLinkId,
            itemKey: l.consignItemKey,
            qty: -l.qty,
            priceCents: net,
            saleNumber: sale.number,
            soldAt: at,
            shopKeepsCents: original?.shopKeepsCents != null ? -original.shopKeepsCents : null,
          },
        });
        const undone = await tx.consignItem.updateMany({
          where: { shopId, linkId: l.consignLinkId, itemKey: l.consignItemKey, ...(l.qty > 0 ? { sold: { gte: l.qty - 1e-6 } } : {}) },
          data: { sold: { decrement: l.qty } },
        });
        if (!undone.count) throw new UserError(`${l.description} was returned since this sale; void that return first.`);
        await sendToPartner(shopId, l.consignLinkId, "consign.sale", { id, itemKey: l.consignItemKey, qty: -l.qty, priceCents: net, saleNumber: sale.number, at: at.toISOString() }, tx, false);
      }
    }
    if (layawayVoid) await voidLayawaySale(tx, { shopId, saleId: sale.id, lines: sale.lines, user, at });
  });
}

type Tx = Prisma.TransactionClient;

/** Inside a void: the club payments this sale posted are voided, and a member whose paid month it was goes back to the one before. */
async function unpayClubSale(tx: Tx, shopId: string, saleId: string, at: Date) {
  const pays = await tx.clubPayment.findMany({ where: { shopId, saleId, voidedAt: null } });
  for (const p of pays) {
    await tx.clubPayment.update({ where: { id: p.id }, data: { voidedAt: at } });
    const m = await tx.clubMember.findFirst({ where: { id: p.memberId, shopId }, select: { id: true, paidMonth: true } });
    if (!m || m.paidMonth !== p.month) continue;
    const prev = await tx.clubPayment.findFirst({ where: { shopId, memberId: m.id, voidedAt: null, id: { not: p.id }, month: { lt: p.month } }, orderBy: [{ month: "desc" }, { createdAt: "desc" }] });
    await tx.clubMember.update({ where: { id: m.id }, data: { paidMonth: prev?.month ?? null, lastPaidAt: prev?.createdAt ?? null } });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Class seats and appointments at the register (design 12.3)

type Bookings = { enrollments: Map<string, Prisma.EnrollmentGetPayload<{ include: { shopClass: true; eventPayments: true } }>>; appointments: Map<string, Prisma.AppointmentGetPayload<object>> };

/** The bookings a sale names, this shop's only, each once. */
async function loadBookings(shopId: string, lines: SaleLineInput[]): Promise<Bookings> {
  const eIds = lines.map((l) => l.enrollmentId).filter((x): x is string => !!x);
  const aIds = lines.map((l) => l.appointmentId).filter((x): x is string => !!x);
  const [enrollments, appointments] = await Promise.all([
    eIds.length ? db.enrollment.findMany({ where: { shopId, id: { in: [...new Set(eIds)] } }, include: { shopClass: true, eventPayments: true } }) : [],
    aIds.length ? db.appointment.findMany({ where: { shopId, id: { in: [...new Set(aIds)] } } }) : [],
  ]);
  const out: Bookings = { enrollments: new Map(enrollments.map((e) => [e.id, e])), appointments: new Map(appointments.map((a) => [a.id, a])) };
  for (const id of eIds) if (!out.enrollments.has(id)) throw new UserError("That class sign-up isn't in this shop.");
  for (const id of aIds) if (!out.appointments.has(id)) throw new UserError("That appointment isn't in this shop.");
  const seen = new Set<string>();
  for (const l of lines) {
    const k = l.enrollmentId ? `e:${l.enrollmentId}` : l.appointmentId ? `a:${l.appointmentId}` : null;
    if (!k) continue;
    if (seen.has(k)) throw new UserError(`${bookingWords(l, out, "UTC")} is on this sale twice.`);
    seen.add(k);
  }
  return out;
}

/** "Class: Beginning Quilting, Tue, Oct 7 at 6:00 pm for Sam" / "Longarm rental, Tue, Oct 7 at 10:00 am". */
function bookingWords(l: Pick<SaleLineInput, "enrollmentId" | "appointmentId">, b: Bookings, tz: string): string {
  if (l.enrollmentId) {
    const e = b.enrollments.get(l.enrollmentId)!;
    return `${classLine(e.shopClass, tz)}${e.attendee ? ` for ${e.attendee}` : ""}`;
  }
  const a = b.appointments.get(l.appointmentId!)!;
  return `${a.title}, ${fmtWhen(a.startsAt, tz)}`;
}

/** The line as the server builds it: one each, no line discount, the booking's price and tax, the words from the booking. */
function bookingLine(role: CurrentUser["role"], l: SaleLineInput, b: Bookings, tz: string) {
  const qty = Number(l.qty);
  const description = bookingWords(l, b, tz).slice(0, 200);
  if (Math.abs(qty) !== 1) throw new UserError("A class or appointment is one at a time.");
  if (Math.round(Number(l.discountCents ?? 0)) > 0) throw new UserError("Change the price for this person on the class instead.");
  const e = l.enrollmentId ? b.enrollments.get(l.enrollmentId)! : null;
  const a = l.appointmentId ? b.appointments.get(l.appointmentId)! : null;
  const paidAt = e ? e.paidAt : a!.paidAt;
  const paidCents = e ? e.paidCents : a!.paidCents;
  const refundedAt = e ? e.refundedAt : a!.refundedAt;
  const feeCents = e ? e.feeCents : a!.feeCents;
  const taxable = e ? e.taxable : a!.taxable;
  let unit: number;
  if (qty === 1) {
    if (e) {
      if (e.status !== "ENROLLED") throw new UserError(`${e.attendee ?? e.name} is on the waiting list or cancelled. Sign them up first.`);
      if (e.shopClass.status === "CANCELLED") throw new UserError(`${e.shopClass.title} was cancelled. Nothing to pay.`);
      // An event paid in parts (shop-features-round-2-design.md 4.5): the rest is taken on the event's page.
      if (e.eventPayments.some((p) => p.paidAt && !p.cancelledAt)) throw new UserError(`Part of ${description} is paid: take the rest on the event's page.`);
    } else if (a!.status === "CANCELLED" || a!.blocked) throw new UserError("That appointment was cancelled.");
    if (paidAt) throw new UserError(`${description} is already paid.`);
    if (feeCents <= 0) throw new UserError(`Nothing to pay for ${description}.`);
    unit = feeCents;
  } else {
    if (!paidAt || refundedAt) throw new UserError(`${description} hasn't been paid here, or was refunded.`);
    const paid = paidCents ?? feeCents;
    const asked = Math.round(Number(l.unitPriceCents));
    // An owner or admin may keep part of it (a cancellation fee), never give back more; a tech refunds what was paid.
    if (role !== "TECH" && Number.isFinite(asked) && asked >= 0 && asked < paid) unit = asked;
    else if (role !== "TECH" && Number.isFinite(asked) && asked > paid) throw new UserError(`You can refund at most $${(paid / 100).toFixed(2)}.`);
    else unit = paid;
  }
  return {
    partId: null,
    repairJobId: null,
    pickedUp: false,
    description,
    partNumber: null,
    qty,
    unit: null,
    unitPriceCents: unit,
    discountCents: 0,
    taxable,
    discountable: false,
    costCents: null,
    consignLinkId: null,
    consignItemKey: null,
    machineId: null,
    stockUnitId: null,
    tradeIn: null as TradeInInput | null,
    enrollmentId: e?.id ?? null,
    appointmentId: a?.id ?? null,
  };
}

/** A sale with no customer of its own belongs to whoever the first booking is for. */
function firstBookingCustomer(lines: { enrollmentId: string | null; appointmentId: string | null }[], b: Bookings): string | null {
  for (const l of lines) {
    if (l.enrollmentId) return b.enrollments.get(l.enrollmentId)?.customerId ?? null;
    if (l.appointmentId) return b.appointments.get(l.appointmentId)?.customerId ?? null;
  }
  return null;
}

/** Inside the sale's transaction: the guarded payment (qty 1) or refund (qty -1) written on the booking. */
async function settleBooking(
  tx: Tx,
  shopId: string,
  l: { enrollmentId: string | null; appointmentId: string | null; qty: number; unitPriceCents: number; discountCents: number; taxable: boolean; description: string },
  lineId: string,
  at: Date,
) {
  const net = lineNet(l);
  const pay = l.qty > 0;
  const table = l.enrollmentId ? tx.enrollment : tx.appointment;
  const id = l.enrollmentId ?? l.appointmentId!;
  const r = pay
    ? await (table as typeof tx.enrollment).updateMany({ where: { shopId, id, paidAt: null }, data: { paidCents: net, paidAt: at, paidLineId: lineId } })
    : await (table as typeof tx.enrollment).updateMany({ where: { shopId, id, paidAt: { not: null }, refundedAt: null }, data: { refundedCents: -net, refundedAt: at, refundLineId: lineId } });
  if (!r.count) throw new UserError(`${l.description} was just ${pay ? "paid" : "refunded"}. Take it off this sale.`);
}

/** Voiding a sale: its payment or refund comes off the booking (a payment refunded since can't be voided first). */
async function unsettleBooking(tx: Tx, shopId: string, l: { id: string; enrollmentId: string | null; appointmentId: string | null; qty: number; description: string }) {
  const table = (l.enrollmentId ? tx.enrollment : tx.appointment) as typeof tx.enrollment;
  if (l.qty > 0) {
    const r = await table.updateMany({ where: { shopId, paidLineId: l.id, refundedAt: null }, data: { paidAt: null, paidCents: null, paidLineId: null } });
    if (!r.count) throw new UserError(`${l.description} was refunded since this sale; void that refund first.`);
  } else {
    await table.updateMany({ where: { shopId, refundLineId: l.id }, data: { refundedAt: null, refundedCents: null, refundLineId: null } });
  }
}

export type BookingDue = import("@/lib/booking-types").BookingDue;

/** What a customer (or anyone) owes for classes and appointments, soonest first; `refunds`: what was paid and can be refunded. */
export async function bookingsDueFor(shopId: string, tz: string, customerId: string | null, refunds = false): Promise<BookingDue[]> {
  const paid = refunds ? { paidAt: { not: null }, refundedAt: null } : { paidAt: null, feeCents: { gt: 0 } };
  const cust = customerId ? { customerId } : {};
  const [enrollments, appointments] = await Promise.all([
    db.enrollment.findMany({
      where: { shopId, ...cust, ...paid, ...(refunds ? {} : { status: "ENROLLED", shopClass: { status: { not: "CANCELLED" } }, eventPayments: { none: { paidAt: { not: null }, cancelledAt: null } } }) },
      include: { shopClass: true, customer: { select: { name: true } } },
      take: 100,
    }),
    db.appointment.findMany({
      where: { shopId, ...cust, ...paid, blocked: false, ...(refunds ? {} : { status: { in: ["BOOKED", "DONE", "NO_SHOW"] } }) },
      include: { customer: { select: { name: true } } },
      take: 100,
    }),
  ]);
  const out: BookingDue[] = [
    ...enrollments.map((e) => ({
      kind: "enrollment" as const,
      id: e.id,
      description: `${classLine(e.shopClass, tz)}${e.attendee ? ` for ${e.attendee}` : ""}`,
      dueCents: refunds ? (e.paidCents ?? e.feeCents) : e.feeCents,
      taxable: e.taxable,
      customerId: e.customerId,
      customerName: e.customer?.name ?? e.name,
      startsAt: e.shopClass.firstAt ?? e.createdAt,
    })),
    ...appointments.map((a) => ({
      kind: "appointment" as const,
      id: a.id,
      description: `${a.title}, ${fmtWhen(a.startsAt, tz)}`,
      dueCents: refunds ? (a.paidCents ?? a.feeCents) : a.feeCents,
      taxable: a.taxable,
      customerId: a.customerId,
      customerName: a.customer?.name ?? a.name,
      startsAt: a.startsAt,
    })),
  ];
  return out.sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime()).slice(0, 100);
}
