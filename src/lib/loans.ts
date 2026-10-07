import "server-only";
// Loaner and demo machines (shop-features-round-2-design.md 1.7), on the machines-for-sale units: a unit's use (for
// sale, loaner, demo, rental); "Lend a machine" on a repair ticket or a customer's page (only loaners that are in, a due
// day, a deposit or a "card on file" note, the condition going out); "It's back" (the condition coming back, the deposit
// refunded, or kept for a lost or damaged loaner as "Loaner charges"); a demo taken to a class, a show or a home the same
// way. A deposit is money held for the customer (a DEPOSIT line naming the loan) until refunded or kept. Every query by
// shopId; bodies take the user so the check script can drive them.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { str, toCents } from "@/lib/format";
import { lineNet, TENDER_METHODS, type Tender } from "@/lib/register-math";
import { completeSaleAs } from "@/lib/register-sale";
import { shopTimeZone } from "@/lib/shop-zone";
import { addDays, parseYmd, ymdOf } from "@/lib/zoned";
import { pushEvent, unitDescription } from "@/lib/units/units";
import { actorOf, audit } from "@/lib/audit";

export const USES = ["SALE", "LOANER", "DEMO", "RENTAL"] as const;
export type UnitUse = (typeof USES)[number];
export const USE_LABEL: Record<UnitUse, string> = { SALE: "For sale", LOANER: "Loaner", DEMO: "Demo", RENTAL: "Rental" };
export const isUse = (s: unknown): s is UnitUse => (USES as readonly string[]).includes(s as string);
export const LOAN_KIND_LABEL: Record<string, string> = { LOAN: "Loaner", DEMO: "Demo", RENTAL: "Rental" };

// ---------------------------------------------------------------------------------------------------------------------
// A unit's use

/**
 * What a machine is used for (owner or admin), while it's in the shop. "Sell this one" makes a loaner, demo or rental
 * for sale again, with its condition (a demo becomes open box, a loaner or rental used, unless chosen).
 */
export async function setUnitUseFor(user: CurrentUser, unitId: string, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const use = str(fd.get("use"));
  if (!isUse(use)) throw new UserError("Pick what it's for.");
  const u = await db.stockUnit.findFirst({ where: { id: unitId, shopId: user.shopId }, include: { machine: true } });
  if (!u) throw new UserError("Machine not found.");
  if (u.status !== "IN_STOCK") throw new UserError(`${unitDescription(u)} isn't in the shop (sold, held or off sale).`);
  if (await db.unitLoan.count({ where: { shopId: user.shopId, unitId: u.id, backAt: null } })) throw new UserError(`${unitDescription(u)} is out right now. Mark it back first.`);
  const condition = use === "SALE" && u.use !== "SALE" ? (str(fd.get("condition")) ?? (u.use === "DEMO" ? "OPEN_BOX" : "USED")) : u.condition;
  if (!["NEW", "OPEN_BOX", "REFURB", "USED"].includes(condition)) throw new UserError("Pick the condition.");
  await db.stockUnit.update({
    where: { id: u.id },
    data: { use, condition, events: pushEvent(u.events, { at: new Date().toISOString(), note: `Now ${USE_LABEL[use].toLowerCase()} (${user.name})` }) },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading

export type LoanView = {
  id: string;
  kind: string;
  unitId: string;
  machine: string;
  customer: { id: string; name: string; phone: string | null } | null;
  ticketId: string | null;
  outAt: Date;
  dueOn: string | null;
  backAt: Date | null;
  overdue: boolean;
  depositCents: number;
  /** What was paid toward its deposit and is still held. */
  heldCents: number;
  cardNote: string | null;
  conditionOut: string | null;
  conditionBack: string | null;
  note: string | null;
};

type LoanRow = Awaited<ReturnType<typeof loanRows>>[number];
const loanRows = (shopId: string, where: object, take = 200) =>
  db.unitLoan.findMany({ where: { shopId, ...where }, include: { customer: { select: { id: true, name: true, phone: true } } }, orderBy: { outAt: "desc" }, take });

/** Money held for each loan: its DEPOSIT lines on sales that stand. */
export async function heldForLoans(shopId: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await db.saleLine.findMany({ where: { unitLoanId: { in: ids }, kind: "DEPOSIT", sale: { shopId, status: "COMPLETED" } }, select: { unitLoanId: true, qty: true, unitPriceCents: true, discountCents: true } });
  for (const r of rows) out.set(r.unitLoanId!, (out.get(r.unitLoanId!) ?? 0) + lineNet({ ...r, taxable: false }));
  return out;
}

async function views(shopId: string, rows: LoanRow[]): Promise<LoanView[]> {
  if (!rows.length) return [];
  const [units, held, tz] = await Promise.all([
    db.stockUnit.findMany({ where: { shopId, id: { in: rows.map((r) => r.unitId) } }, include: { machine: true } }),
    heldForLoans(
      shopId,
      rows.map((r) => r.id),
    ),
    shopTimeZone(shopId),
  ]);
  const today = ymdOf(new Date(), tz);
  const byId = new Map(units.map((u) => [u.id, u]));
  return rows.map((r) => {
    const u = byId.get(r.unitId);
    return {
      id: r.id,
      kind: r.kind,
      unitId: r.unitId,
      machine: u ? unitDescription(u) : "A machine",
      customer: r.customer,
      ticketId: r.ticketId,
      outAt: r.outAt,
      dueOn: r.dueOn,
      backAt: r.backAt,
      overdue: !r.backAt && !!r.dueOn && r.dueOn < today,
      depositCents: r.depositCents,
      heldCents: held.get(r.id) ?? 0,
      cardNote: r.cardNote,
      conditionOut: r.conditionOut,
      conditionBack: r.conditionBack,
      note: r.note,
    };
  });
}

/** Machines out now (overdue first), or one customer's, one ticket's or one unit's loans. */
export async function loansFor(shopId: string, o: { out?: boolean; customerId?: string; ticketId?: string; unitId?: string; kinds?: string[]; take?: number } = {}): Promise<LoanView[]> {
  const rows = await loanRows(
    shopId,
    {
      ...(o.out ? { backAt: null } : {}),
      ...(o.customerId ? { customerId: o.customerId } : {}),
      ...(o.ticketId ? { ticketId: o.ticketId } : {}),
      ...(o.unitId ? { unitId: o.unitId } : {}),
      ...(o.kinds ? { kind: { in: o.kinds } } : {}),
    },
    o.take,
  );
  const v = await views(shopId, rows);
  return v.sort((a, b) => Number(b.overdue) - Number(a.overdue));
}

/** Loaners (or demos) that are in: the "Lend a machine" list shows only these. */
export async function unitsToLend(shopId: string, use: "LOANER" | "DEMO" | "RENTAL"): Promise<{ id: string; description: string }[]> {
  const out = await db.unitLoan.findMany({ where: { shopId, backAt: null }, select: { unitId: true } });
  const units = await db.stockUnit.findMany({ where: { shopId, use, status: "IN_STOCK", id: { notIn: out.map((o) => o.unitId) } }, include: { machine: true }, orderBy: { createdAt: "asc" } });
  return units.map((u) => ({ id: u.id, description: unitDescription(u) }));
}

/** "Out on loan: 3, 1 overdue" (the dashboard). */
export async function loanCounts(shopId: string): Promise<{ out: number; overdue: number }> {
  const today = ymdOf(new Date(), await shopTimeZone(shopId));
  const [out, overdue] = await Promise.all([
    db.unitLoan.count({ where: { shopId, backAt: null, kind: { in: ["LOAN", "DEMO"] } } }),
    db.unitLoan.count({ where: { shopId, backAt: null, kind: { in: ["LOAN", "DEMO"] }, dueOn: { lt: today } } }),
  ]);
  return { out, overdue };
}

/** The defaults the Lend form fills in: the due day and the deposit. */
export async function loanDefaults(shopId: string): Promise<{ dueOn: string; depositCents: number }> {
  const [s, tz] = await Promise.all([db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { loanerDays: true, loanerDepositCents: true } }), shopTimeZone(shopId)]);
  return { dueOn: addDays(ymdOf(new Date(), tz), s.loanerDays), depositCents: s.loanerDepositCents };
}

/** Settings: the loaner deposit by default (0: none) and the days a loaner is lent for. Owner or admin. */
export async function saveLoanerSettingsFor(user: CurrentUser, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  const dep = toCents(str(fd.get("deposit")) ?? "0") ?? -1;
  const days = Number(str(fd.get("days")) ?? "");
  if (dep < 0 || dep > 200_000) throw new UserError("Deposit: $0 to $2,000.");
  if (!Number.isInteger(days) || days < 1 || days > 120) throw new UserError("Days: 1 to 120.");
  await db.shop.update({ where: { id: user.shopId }, data: { loanerDepositCents: dep, loanerDays: days } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Lend and back

export type LendInput = {
  unitId: string;
  kind?: "LOAN" | "DEMO";
  customerId?: string | null;
  ticketId?: string | null;
  dueOn?: string | null;
  depositCents?: number | null;
  tender?: Tender | null;
  cardNote?: string | null;
  conditionOut?: string | null;
  note?: string | null;
  clientKey?: string | null;
};

function tenderOf(t: Tender | null | undefined, amountCents: number): Tender[] {
  if (!amountCents) return [];
  const method = t && TENDER_METHODS.includes(t.method) ? t.method : null;
  if (!method) throw new UserError("Pick how she's paying the deposit.");
  return [{ method, amountCents, note: typeof t?.note === "string" ? t.note.slice(0, 100) || null : null, cardNumber: typeof t?.cardNumber === "string" ? t.cardNumber.slice(0, 40) : null }];
}

/** "Lend a machine": a loaner that's in (or a demo), to a customer (a loaner) or anyone (a demo), with its deposit rung up. */
export async function lendFor(user: CurrentUser, input: LendInput): Promise<{ loanId: string; saleId: string | null; saleNumber: number | null }> {
  const shopId = user.shopId;
  await requireBaseWritable(user);
  const kind = input.kind === "DEMO" ? "DEMO" : "LOAN";
  const unit = typeof input.unitId === "string" ? await db.stockUnit.findFirst({ where: { id: input.unitId, shopId }, include: { machine: true } }) : null;
  if (!unit) throw new UserError("Machine not found.");
  const want = kind === "DEMO" ? "DEMO" : "LOANER";
  if (unit.use !== want && !(kind === "DEMO" && unit.use === "LOANER")) throw new UserError(`${unitDescription(unit)} isn't a ${kind === "DEMO" ? "demo" : "loaner"}. Set what it's for on its page.`);
  if (unit.status !== "IN_STOCK") throw new UserError(`${unitDescription(unit)} isn't in the shop.`);
  const customer = input.customerId ? await db.customer.findFirst({ where: { id: input.customerId, shopId }, select: { id: true } }) : null;
  if (input.customerId && !customer) throw new UserError("Customer not found.");
  if (kind === "LOAN" && !customer) throw new UserError("Pick who's borrowing it.");
  const ticket = input.ticketId ? await db.ticket.findFirst({ where: { id: input.ticketId, shopId }, select: { id: true, customerId: true } }) : null;
  if (input.ticketId && !ticket) throw new UserError("Ticket not found.");
  const defaults = await loanDefaults(shopId);
  const dueOn = input.dueOn ? parseYmd(input.dueOn) : defaults.dueOn;
  if (input.dueOn && !dueOn) throw new UserError("Due back: pick a date.");
  const deposit = Math.max(0, Math.round(Number(input.depositCents ?? 0)) || 0);
  if (deposit > 200_000) throw new UserError("Check the deposit.");
  if (deposit && !customer) throw new UserError("A deposit is held for someone: pick the customer.");
  const tenders = tenderOf(input.tender, deposit);
  const loan = await db.$transaction(async (tx) => {
    // One out at a time: the unit's open loan is the lock.
    if (await tx.unitLoan.count({ where: { shopId, unitId: unit.id, backAt: null } })) throw new UserError(`${unitDescription(unit)} is out already.`);
    const made = await tx.unitLoan.create({
      data: {
        shopId,
        unitId: unit.id,
        kind,
        customerId: customer?.id ?? null,
        ticketId: ticket?.id ?? null,
        dueOn,
        depositCents: deposit,
        cardNote: input.cardNote?.trim().slice(0, 120) || null,
        conditionOut: input.conditionOut?.trim().slice(0, 200) || "Good",
        note: input.note?.trim().slice(0, 300) || null,
        createdById: user.id,
      },
    });
    await tx.stockUnit.update({ where: { id: unit.id }, data: { events: pushEvent(unit.events, { at: new Date().toISOString(), note: `${kind === "DEMO" ? "Demo out" : "Lent"}${dueOn ? `, due ${dueOn}` : ""} (${user.name})` }) } });
    return made;
  });
  if (!deposit) return { loanId: loan.id, saleId: null, saleNumber: null };
  try {
    const sale = await completeSaleAs(
      user,
      { customerId: customer!.id, lines: [{ description: `Loaner deposit: ${unitDescription(unit)}`, qty: 1, unitPriceCents: deposit, taxable: false, unitLoanId: loan.id, depositKind: "DEPOSIT" }], tenders, clientKey: input.clientKey ?? null },
      { internal: true },
    );
    return { loanId: loan.id, saleId: sale.saleId, saleNumber: sale.number };
  } catch (e) {
    await db.unitLoan.deleteMany({ where: { id: loan.id, shopId } });
    throw e;
  }
}

/**
 * "It's back": the condition coming back; the deposit given back the way chosen (cash, card, check or store credit), or
 * part or all of it kept ("Loaner charges", owner or admin) for a lost or damaged loaner.
 */
export async function backFor(user: CurrentUser, loanId: string, a: { conditionBack?: string | null; keepCents?: number | null; method?: string | null; clientKey?: string | null } = {}, now = new Date()): Promise<{ saleId: string | null; backCents: number; keptCents: number }> {
  const shopId = user.shopId;
  const loan = typeof loanId === "string" ? await db.unitLoan.findFirst({ where: { id: loanId, shopId } }) : null;
  if (!loan) throw new UserError("Loan not found.");
  if (loan.backAt) throw new UserError("It's marked back already.");
  const held = (await heldForLoans(shopId, [loan.id])).get(loan.id) ?? 0;
  const keep = Math.max(0, Math.min(held, Math.round(Number(a.keepCents ?? 0)) || 0));
  if (keep && user.role === "TECH") throw new UserError("Only an owner or admin can keep a deposit.");
  const unit = await db.stockUnit.findFirst({ where: { id: loan.unitId, shopId }, include: { machine: true } });
  const mark = async () => {
    const r = await db.unitLoan.updateMany({ where: { id: loan.id, shopId, backAt: null }, data: { backAt: now, conditionBack: a.conditionBack?.trim().slice(0, 200) || "Good" } });
    if (!r.count) throw new UserError("It was just marked back. Look again.");
    if (unit) await db.stockUnit.update({ where: { id: unit.id }, data: { events: pushEvent(unit.events, { at: now.toISOString(), note: `Back${a.conditionBack ? `: ${a.conditionBack.slice(0, 100)}` : ""} (${user.name})` }) } });
  };
  if (!held) {
    await mark();
    return { saleId: null, backCents: 0, keptCents: 0 };
  }
  const back = held - keep;
  const method = a.method === "CREDIT" || a.method === "CARD" || a.method === "CHECK" ? a.method : "CASH";
  const desc = unit ? unitDescription(unit) : "loaner";
  const sale = await completeSaleAs(
    user,
    {
      customerId: loan.customerId,
      lines: [
        { description: `Loaner deposit back: ${desc}`, qty: -1, unitPriceCents: held, taxable: false, unitLoanId: loan.id, depositKind: "DEPOSIT" },
        ...(keep ? [{ description: `Loaner charge: ${desc}`, qty: 1, unitPriceCents: keep, taxable: false, unitLoanId: loan.id, rentKind: "LOAN_FEE" as const }] : []),
      ],
      tenders: back ? [{ method, amountCents: -back }] : [],
      clientKey: a.clientKey ?? null,
    },
    { internal: true },
  );
  await mark();
  if (keep) await audit(db, actorOf(user), { action: "loan.keep", subjectType: "UnitLoan", subjectId: loan.id, subjectLabel: desc, amountCents: keep, reason: a.conditionBack ?? null });
  return { saleId: sale.saleId, backCents: back, keptCents: keep };
}

/** Words for a ticket: "Loaner out: Brother CS6000i, due Oct 14". */
export const loanWords = (l: Pick<LoanView, "machine" | "dueOn" | "kind">, fmt: (ymd: string) => string) => `${LOAN_KIND_LABEL[l.kind] ?? "Loaner"} out: ${l.machine}${l.dueOn ? `, due ${fmt(l.dueOn)}` : ""}`;

