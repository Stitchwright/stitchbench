import "server-only";
// Rentals, rent-to-own and trial purchases (shop-features-round-2-design.md 1.8). A rental is a machine for sale used as
// a Rental (StockUnit.use), rented out at a rate (a day, a week or a month) as a UnitLoan of kind RENTAL; rent is rung up
// at the start and each period (a RENT line naming the loan, "Rentals" income, taxed like any rental of goods), at the
// counter or by pay link. It is paid through the periods the rent covers; past that it is overdue. Rent-to-own: a percent
// of the rent paid (100% by default, for 3 months) counts toward buying it; "Buy it now" sells the unit with that credit
// off its price ("Rent credit": a discount, so the rent already counted isn't counted twice). Trial purchases: a machine
// sold while the shop's trial days are set carries "Try it for N days" (StockUnit.trialUntil, on the receipt); a return
// inside the window takes it back in full through the existing return. Every query by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { money, str } from "@/lib/format";
import { lineNet, saleTotals, TENDER_METHODS, type Tender } from "@/lib/register-math";
import { exemptCertificate } from "@/lib/tax-exempt";
import { completeSaleAs } from "@/lib/register-sale";
import { shopTimeZone } from "@/lib/shop-zone";
import { addDays, addMonths, ymdOf } from "@/lib/zoned";
import { pushEvent, unitDescription } from "@/lib/units/units";
import { makePayLinkFor } from "@/lib/pay-links";
import { currentStoreId } from "@/lib/stores";

export const RATE_PERS = ["day", "week", "month"] as const;
export type RatePer = (typeof RATE_PERS)[number];
const isPer = (s: unknown): s is RatePer => (RATE_PERS as readonly string[]).includes(s as string);

/** The day `n` periods after a day. */
export function periodsAfter(ymd: string, per: RatePer, n: number): string {
  if (per === "day") return addDays(ymd, n);
  if (per === "week") return addDays(ymd, 7 * n);
  return addMonths(ymd, n) ?? addDays(ymd, 30 * n);
}

function tenderOf(t: Tender | null | undefined, amountCents: number): Tender[] {
  if (!amountCents) return [];
  const method = t && TENDER_METHODS.includes(t.method) ? t.method : null;
  if (!method) throw new UserError("Pick how she's paying.");
  return [{ method, amountCents, note: typeof t?.note === "string" ? t.note.slice(0, 100) || null : null, cardNumber: typeof t?.cardNumber === "string" ? t.cardNumber.slice(0, 40) : null }];
}

/** Rent paid on each rental (its RENT lines on sales that stand), before tax. */
export async function rentPaid(shopId: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await db.saleLine.findMany({ where: { unitLoanId: { in: ids }, kind: "RENT", sale: { shopId, status: "COMPLETED" } }, select: { unitLoanId: true, qty: true, unitPriceCents: true, discountCents: true } });
  for (const r of rows) out.set(r.unitLoanId!, (out.get(r.unitLoanId!) ?? 0) + lineNet({ ...r, taxable: false }));
  return out;
}

export type RentalView = {
  id: string;
  unitId: string;
  machine: string;
  priceCents: number | null;
  customer: { id: string; name: string } | null;
  rateCents: number;
  ratePer: RatePer;
  startOn: string;
  /** Paid through this day (the periods the rent covers). */
  paidThrough: string;
  overdue: boolean;
  paidCents: number;
  ownPct: number;
  ownUntil: string | null;
  /** What "Buy it now" takes off the price today (0 once the window is past). */
  creditCents: number;
  backAt: Date | null;
};

/** Rentals out now (overdue first), or one customer's. */
export async function rentalsFor(shopId: string, o: { customerId?: string; id?: string; all?: boolean } = {}): Promise<RentalView[]> {
  const rows = await db.unitLoan.findMany({
    where: { shopId, kind: "RENTAL", ...(o.all || o.id ? {} : { backAt: null }), ...(o.customerId ? { customerId: o.customerId } : {}), ...(o.id ? { id: o.id } : {}) },
    include: { customer: { select: { id: true, name: true } } },
    orderBy: { outAt: "desc" },
    take: 200,
  });
  if (!rows.length) return [];
  const [units, paid, tz] = await Promise.all([
    db.stockUnit.findMany({ where: { shopId, id: { in: rows.map((r) => r.unitId) } }, include: { machine: true } }),
    rentPaid(
      shopId,
      rows.map((r) => r.id),
    ),
    shopTimeZone(shopId),
  ]);
  const today = ymdOf(new Date(), tz);
  const byId = new Map(units.map((u) => [u.id, u]));
  return rows
    .map((r) => {
      const u = byId.get(r.unitId);
      const per = isPer(r.ratePer) ? r.ratePer : "month";
      const rate = r.rateCents ?? 0;
      const p = paid.get(r.id) ?? 0;
      const start = ymdOf(r.outAt, tz);
      const periods = rate > 0 ? Math.floor(p / rate) : 0;
      const through = addDays(periodsAfter(start, per, periods), -1);
      const credit = r.ownUntil && today <= r.ownUntil ? Math.min(u?.priceCents ?? 0, Math.round((p * (r.ownPct ?? 0)) / 100)) : 0;
      return {
        id: r.id,
        unitId: r.unitId,
        machine: u ? unitDescription(u) : "A machine",
        priceCents: u?.priceCents ?? null,
        customer: r.customer,
        rateCents: rate,
        ratePer: per,
        startOn: start,
        paidThrough: through,
        overdue: !r.backAt && through < today,
        paidCents: p,
        ownPct: r.ownPct ?? 0,
        ownUntil: r.ownUntil,
        creditCents: credit,
        backAt: r.backAt,
      };
    })
    .sort((a, b) => Number(b.overdue) - Number(a.overdue));
}

/** Rentals that are in (the Rent it out list). */
export async function rentalsIn(shopId: string): Promise<{ id: string; description: string; priceCents: number | null }[]> {
  const out = await db.unitLoan.findMany({ where: { shopId, backAt: null }, select: { unitId: true } });
  const units = await db.stockUnit.findMany({ where: { shopId, use: "RENTAL", status: "IN_STOCK", id: { notIn: out.map((o) => o.unitId) } }, include: { machine: true } });
  return units.map((u) => ({ id: u.id, description: unitDescription(u), priceCents: u.priceCents }));
}

export type RentInput = { unitId: string; customerId: string | null; rateCents: number; ratePer: string; periods?: number; ownPct?: number | null; ownMonths?: number | null; tender?: Tender | null; clientKey?: string | null };

/** "Rent it out": a rental that's in, to a customer, at a rate; the first periods' rent rung up now. Owner or admin set the rate. */
export async function rentOutFor(user: CurrentUser, input: RentInput): Promise<{ loanId: string; saleId: string; saleNumber: number }> {
  const shopId = user.shopId;
  await requireBaseWritable(user);
  if (user.role === "TECH") throw new UserError("Only an owner or admin can set a rental's rate.");
  const unit = typeof input.unitId === "string" ? await db.stockUnit.findFirst({ where: { id: input.unitId, shopId }, include: { machine: true } }) : null;
  if (!unit) throw new UserError("Machine not found.");
  if (unit.use !== "RENTAL" || unit.status !== "IN_STOCK") throw new UserError(`${unitDescription(unit)} isn't a rental in the shop. Set what it's for on its page.`);
  const customer = input.customerId ? await db.customer.findFirst({ where: { id: input.customerId, shopId }, select: { id: true } }) : null;
  if (!customer) throw new UserError(input.customerId ? "Customer not found." : "Pick who's renting it.");
  if (!isPer(input.ratePer)) throw new UserError("Rent a day, a week or a month?");
  const rate = Math.round(Number(input.rateCents));
  if (!Number.isFinite(rate) || rate < 100 || rate > 500_000) throw new UserError("The rate: $1 to $5,000.");
  const periods = Math.max(1, Math.min(24, Math.round(Number(input.periods ?? 1)) || 1));
  const ownPct = input.ownPct == null ? 100 : Math.round(Number(input.ownPct));
  if (!Number.isFinite(ownPct) || ownPct < 0 || ownPct > 100) throw new UserError("Rent-to-own percent: 0 to 100.");
  const ownMonths = input.ownMonths == null ? 3 : Math.round(Number(input.ownMonths));
  if (!Number.isFinite(ownMonths) || ownMonths < 0 || ownMonths > 36) throw new UserError("Rent-to-own for: 0 to 36 months.");
  const today = ymdOf(new Date(), await shopTimeZone(shopId));
  // Rented from this store (7.1).
  const here = await currentStoreId(user);
  const loan = await db.$transaction(async (tx) => {
    if (await tx.unitLoan.count({ where: { shopId, unitId: unit.id, backAt: null } })) throw new UserError(`${unitDescription(unit)} is out already.`);
    const made = await tx.unitLoan.create({
      data: { shopId, locationId: here, unitId: unit.id, kind: "RENTAL", customerId: customer.id, rateCents: rate, ratePer: input.ratePer, ownPct, ownUntil: ownPct && ownMonths ? addMonths(today, ownMonths) : null, dueOn: periodsAfter(today, input.ratePer as RatePer, periods), conditionOut: "Good", createdById: user.id },
    });
    await tx.stockUnit.update({ where: { id: unit.id }, data: { events: pushEvent(unit.events, { at: new Date().toISOString(), note: `Rented out at ${money(rate)} a ${input.ratePer} (${user.name})` }) } });
    return made;
  });
  try {
    const sale = await payRentAs(user, { loanId: loan.id, periods, tender: input.tender ?? null, clientKey: input.clientKey ?? null });
    return { loanId: loan.id, saleId: sale.saleId, saleNumber: sale.number };
  } catch (e) {
    await db.unitLoan.deleteMany({ where: { id: loan.id, shopId } });
    throw e;
  }
}

async function openRental(shopId: string, id: string) {
  const r = typeof id === "string" ? await db.unitLoan.findFirst({ where: { id, shopId, kind: "RENTAL" } }) : null;
  if (!r) throw new UserError("Rental not found.");
  if (r.backAt) throw new UserError("That rental has ended.");
  return r;
}

/** What one taxed line comes to with the shop's tax (none for a tax-exempt customer), as the register works it out. */
async function totalWithTax(shopId: string, customerId: string | null, l: { qty: number; unitPriceCents: number; discountCents: number }): Promise<number> {
  const [shop, c] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxRatePct: true } }),
    customerId ? db.customer.findFirst({ where: { id: customerId, shopId }, select: { taxExemptId: true, taxExemptUntil: true } }) : null,
  ]);
  return saleTotals([{ ...l, taxable: true }], 0, exemptCertificate(c) ? 0 : shop.taxRatePct).total;
}

/** Rent for some periods at the counter (taxed as a rental). */
export async function payRentAs(user: CurrentUser, a: { loanId: string; periods: number; tender: Tender | null; clientKey?: string | null }): Promise<{ saleId: string; number: number }> {
  const r = await openRental(user.shopId, a.loanId);
  const periods = Math.max(1, Math.min(24, Math.round(Number(a.periods)) || 1));
  const unit = await db.stockUnit.findFirst({ where: { id: r.unitId, shopId: user.shopId }, include: { machine: true } });
  const total = await totalWithTax(user.shopId, r.customerId, { qty: periods, unitPriceCents: r.rateCents ?? 0, discountCents: 0 });
  const sale = await completeSaleAs(
    user,
    {
      customerId: r.customerId,
      lines: [{ description: `Rent: ${unit ? unitDescription(unit) : "machine"}, ${periods} ${r.ratePer}${periods === 1 ? "" : "s"}`, qty: periods, unitPriceCents: r.rateCents ?? 0, taxable: true, unitLoanId: r.id, rentKind: "RENT" }],
      tenders: tenderOf(a.tender, total),
      clientKey: a.clientKey ?? null,
    },
    { internal: true },
  );
  return { saleId: sale.saleId, number: sale.number };
}

/** The next period's rent as a pay link (1.3). */
export async function sendRentLinkAs(user: CurrentUser, loanId: string, periods = 1): Promise<string> {
  const r = await openRental(user.shopId, loanId);
  const unit = await db.stockUnit.findFirst({ where: { id: r.unitId, shopId: user.shopId }, include: { machine: true } });
  const n = Math.max(1, Math.min(12, Math.round(periods) || 1));
  const link = await makePayLinkFor(user, { customerId: r.customerId, lines: [{ description: `Rent: ${unit ? unitDescription(unit) : "machine"}, ${n} ${r.ratePer}${n === 1 ? "" : "s"}`, qty: n, unitPriceCents: r.rateCents ?? 0, loanId: r.id }] }, { trusted: true });
  return `Pay link #${link.number}. ${link.told}`;
}

/** "Buy it now": the rental ends and the machine is sold to her with the rent credit off its price. */
export async function buyRentalAs(user: CurrentUser, a: { loanId: string; tender: Tender | null; clientKey?: string | null }): Promise<{ saleId: string; number: number; creditCents: number }> {
  const r = await openRental(user.shopId, a.loanId);
  const v = (await rentalsFor(user.shopId, { id: r.id }))[0];
  if (v.priceCents == null) throw new UserError("Set its price first (its page), then sell it.");
  const unit = await db.stockUnit.findFirstOrThrow({ where: { id: r.unitId, shopId: user.shopId } });
  const now = new Date();
  // For sale for this sale; put back as a rental (and the rental open again) if the sale doesn't go through.
  await db.$transaction([
    db.stockUnit.update({ where: { id: unit.id }, data: { use: "SALE" } }),
    db.unitLoan.update({ where: { id: r.id }, data: { backAt: now, conditionBack: "Bought" } }),
  ]);
  try {
    const total = await totalWithTax(user.shopId, r.customerId, { qty: 1, unitPriceCents: v.priceCents, discountCents: v.creditCents });
    const sale = await completeSaleAs(
      user,
      { customerId: r.customerId, lines: [{ description: "", qty: 1, unitPriceCents: v.priceCents, discountCents: v.creditCents, taxable: true, stockUnitId: unit.id, unitLoanId: r.id }], tenders: tenderOf(a.tender, total), clientKey: a.clientKey ?? null },
      { internal: true },
    );
    return { saleId: sale.saleId, number: sale.number, creditCents: v.creditCents };
  } catch (e) {
    await db.$transaction([db.stockUnit.update({ where: { id: unit.id }, data: { use: "RENTAL" } }), db.unitLoan.update({ where: { id: r.id }, data: { backAt: null, conditionBack: null } })]);
    throw e;
  }
}

/** Overdue rentals (the dashboard). */
export async function rentalsOverdue(shopId: string): Promise<number> {
  if (!(await db.unitLoan.count({ where: { shopId, kind: "RENTAL", backAt: null } }))) return 0;
  return (await rentalsFor(shopId)).filter((r) => r.overdue).length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Trial purchases

/** Settings: the trial days machines are sold with (0: off). Owner or admin. */
export async function saveTrialDaysFor(user: CurrentUser, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  const days = Number(str(fd.get("trialDays")) ?? "0");
  if (!Number.isInteger(days) || days < 0 || days > 90) throw new UserError("Trial days: 0 (off) to 90.");
  await db.shop.update({ where: { id: user.shopId }, data: { trialDays: days } });
}
