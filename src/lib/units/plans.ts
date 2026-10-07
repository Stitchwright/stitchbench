import "server-only";
// The shop's own service plans (tax-machine-sales-layaway-design.md section 3, owner's answer 9): "free cleaning yearly
// for 3 years" or an extended warranty, defined by the shop, sold as a register line for a machine (or included with a
// machine for sale), and kept on that machine as a MachinePlan. A repair ticket for the machine shows what the plan
// covers and how much is used; a line marked covered charges nothing and keeps what it would have cost (the report).
// Every query by shopId; the register hooks run inside the sale's transaction.
import type { Prisma, SaleLine } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { actorOf, audit } from "@/lib/audit";
import { requireBaseWritable } from "@/lib/base-gate";
import { str } from "@/lib/format";
import { centsField } from "@/lib/parts";
import { lineNet } from "@/lib/register-math";
import { warrantyEnd, warrantyThrough, fmtYmdLong } from "@/lib/units/units";

type Tx = Prisma.TransactionClient;

export type PlanRow = { id: string; name: string; description: string | null; visits: number | null; months: number; priceCents: number; taxable: boolean; active: boolean };

/** "3 covered visits in 36 months" / "36 months, no visit limit". */
export const planTerms = (p: { visits: number | null; months: number }) => (p.visits != null ? `${p.visits} covered visit${p.visits === 1 ? "" : "s"} in ${p.months} months` : `${p.months} months, no visit limit`);

export async function listPlans(shopId: string, activeOnly = false): Promise<PlanRow[]> {
  return db.servicePlan.findMany({
    where: { shopId, ...(activeOnly ? { active: true } : {}) },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: { id: true, name: true, description: true, visits: true, months: true, priceCents: true, taxable: true, active: true },
  });
}

function wholeField(fd: FormData, name: string, what: string, min: number, max: number, blank: number | null): number | null {
  const s = str(fd.get(name));
  if (s == null) return blank;
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${what}: a whole number from ${min} to ${max}.`);
  return n;
}

/** Adds (id null) or changes a plan; owner or admin. Machines that already have it keep what they were sold. */
export async function savePlanFor(user: CurrentUser, id: string | null, fd: FormData): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const shopId = user.shopId;
  const name = str(fd.get("name"))?.slice(0, 80);
  if (!name) throw new UserError("Name the plan, e.g. Free yearly cleaning, 3 years.");
  const data = {
    name,
    description: str(fd.get("description"))?.slice(0, 300) ?? null,
    visits: wholeField(fd, "visits", "Covered visits", 1, 50, null),
    months: wholeField(fd, "months", "Months", 1, 120, null) ?? 12,
    priceCents: centsField(fd.get("priceCents"), "Price") ?? 0,
    taxable: fd.get("taxable") === "on",
    active: id ? fd.get("active") === "on" : true,
  };
  if (!id) return (await db.servicePlan.create({ data: { shopId, ...data }, select: { id: true } })).id;
  const r = await db.servicePlan.updateMany({ where: { id, shopId }, data });
  if (!r.count) throw new UserError("Plan not found.");
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------
// Plans on a machine

export type MachinePlanView = {
  id: string;
  name: string;
  visits: number | null;
  used: number;
  startsAt: Date;
  endsAt: Date;
  through: string;
  current: boolean;
  voided: boolean;
  /** "Free yearly cleaning (1 of 3 used), through Mar 12, 2029" */
  text: string;
};

/** Tickets with a line covered by each plan (a visit is a ticket), not counting `exceptTicketId`. */
async function visitsUsed(shopId: string, planIds: string[], exceptTicketId?: string): Promise<Map<string, number>> {
  if (!planIds.length) return new Map();
  const lines = await db.ticketLine.findMany({
    where: { coveredPlanId: { in: planIds }, ticket: { shopId, ...(exceptTicketId ? { id: { not: exceptTicketId } } : {}) } },
    select: { coveredPlanId: true, ticketId: true },
  });
  const seen = new Map<string, Set<string>>();
  for (const l of lines) {
    const s = seen.get(l.coveredPlanId!) ?? new Set<string>();
    s.add(l.ticketId);
    seen.set(l.coveredPlanId!, s);
  }
  return new Map([...seen].map(([k, v]) => [k, v.size]));
}

/** The machine's plans, newest first, with visits used; `at`: the day that counts as now (a ticket's intake). */
export async function machinePlansFor(shopId: string, machineId: string, tz: string, at = new Date()): Promise<MachinePlanView[]> {
  const rows = await db.machinePlan.findMany({ where: { shopId, machineId }, orderBy: { startsAt: "desc" } });
  const used = await visitsUsed(
    shopId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const n = used.get(r.id) ?? 0;
    const through = fmtYmdLong(warrantyThrough(r.endsAt, tz));
    const current = !r.voidedAt && r.startsAt <= at && at < r.endsAt;
    const count = r.visits != null ? ` (${n} of ${r.visits} used)` : "";
    return { id: r.id, name: r.name, visits: r.visits, used: n, startsAt: r.startsAt, endsAt: r.endsAt, through, current, voided: !!r.voidedAt, text: `${r.name}${count}, through ${through}` };
  });
}

/** Inside a sale: the plan put on a machine from the day of the sale. */
export async function grantPlan(
  tx: Tx,
  a: { shopId: string; machineId: string; plan: { id: string; name: string; visits: number | null; months: number }; at: Date; timeZone: string; saleLineId: string | null; stockUnitId: string | null },
): Promise<string> {
  const { until } = warrantyEnd(a.at, a.plan.months, a.timeZone);
  const made = await tx.machinePlan.create({
    data: { shopId: a.shopId, machineId: a.machineId, planId: a.plan.id, name: a.plan.name, visits: a.plan.visits, startsAt: a.at, endsAt: until, saleLineId: a.saleLineId, stockUnitId: a.stockUnitId },
    select: { id: true },
  });
  return made.id;
}

/** Inside a void or a return: the plans that line made end now (lines already covered stay covered). */
export async function endPlansOf(tx: Tx, shopId: string, saleLineId: string, at: Date): Promise<void> {
  await tx.machinePlan.updateMany({ where: { shopId, saleLineId, voidedAt: null }, data: { voidedAt: at } });
}

/** An owner or admin ends a plan early (refunded by hand, sold by mistake). */
export async function endPlanFor(user: CurrentUser, machinePlanId: string): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const p = await db.machinePlan.findFirst({ where: { id: machinePlanId, shopId: user.shopId }, select: { id: true, machineId: true, voidedAt: true } });
  if (!p) throw new UserError("Plan not found.");
  if (p.voidedAt) throw new UserError("That plan has already ended.");
  await db.machinePlan.updateMany({ where: { id: p.id, shopId: user.shopId, voidedAt: null }, data: { voidedAt: new Date() } });
  return p.machineId;
}

// ---------------------------------------------------------------------------------------------------------------------
// The register: a plan sold as a line, for a machine on the same sale or one of the customer's machines

/** What the register sends for a plan line: the plan, and the machine it is for (a unit on this sale, or the customer's machine). */
export type PlanLineInput = { planId: string; stockUnitId?: string | null; machineId?: string | null };

export type PreparedPlan = { description: string; unitPriceCents: number; taxable: boolean; plan: { id: string; name: string; visits: number | null; months: number }; stockUnitId: string | null; machineId: string | null };

/** Before the sale: the plan is this shop's and on sale, the machine is right, the price is the plan's unless an owner or admin changed it. */
export async function preparePlanLine(
  a: { shopId: string; role: CurrentUser["role"]; customerId: string | null; unitIdsOnSale: string[] },
  input: PlanLineInput,
  qty: number,
  askedCents: number,
): Promise<PreparedPlan> {
  if (qty !== 1) throw new UserError("A service plan is one line of 1. To refund one, end it on the machine's page and refund the money as a misc line.");
  const plan = await db.servicePlan.findFirst({ where: { id: String(input?.planId ?? ""), shopId: a.shopId, active: true } });
  if (!plan) throw new UserError("That service plan isn't on sale any more.");
  let label: string;
  let stockUnitId: string | null = null;
  let machineId: string | null = null;
  if (input.stockUnitId) {
    if (!a.unitIdsOnSale.includes(input.stockUnitId)) throw new UserError(`${plan.name}: the machine it is for must be on this sale.`);
    const u = await db.stockUnit.findFirst({ where: { id: input.stockUnitId, shopId: a.shopId }, include: { machine: true } });
    if (!u) throw new UserError("That machine isn't one of this shop's.");
    stockUnitId = u.id;
    label = `${u.machine.brand} ${u.machine.model}${u.machine.serial ? ` S/N ${u.machine.serial}` : ""}`;
  } else if (input.machineId) {
    if (!a.customerId) throw new UserError("Pick the customer whose machine the plan is for.");
    const m = await db.machine.findFirst({ where: { id: input.machineId, shopId: a.shopId, customerId: a.customerId } });
    if (!m) throw new UserError("That machine isn't this customer's.");
    machineId = m.id;
    label = `${m.brand} ${m.model}${m.serial ? ` S/N ${m.serial}` : ""}`;
  } else {
    throw new UserError(`${plan.name}: say which machine the plan is for.`);
  }
  const asked = Math.round(Number(askedCents));
  if (!Number.isFinite(asked) || asked < 0) throw new UserError("Prices can't be negative.");
  if (a.role === "TECH" && asked !== plan.priceCents) throw new UserError(`Only an owner or admin can change the price of ${plan.name}.`);
  return { description: `Service plan: ${plan.name} for ${label}`.slice(0, 200), unitPriceCents: asked, taxable: plan.taxable, plan, stockUnitId, machineId };
}

/** Inside the sale's transaction, after the line (and the unit's sale) were written. */
export async function applyPlanLine(tx: Tx, a: { shopId: string; at: Date; timeZone: string; line: SaleLine; prepared: PreparedPlan }): Promise<void> {
  let machineId = a.prepared.machineId;
  if (a.prepared.stockUnitId) {
    const u = await tx.stockUnit.findFirst({ where: { id: a.prepared.stockUnitId, shopId: a.shopId }, select: { machineId: true } });
    if (!u) throw new UserError("That machine isn't one of this shop's.");
    machineId = u.machineId;
  }
  const id = await grantPlan(tx, { shopId: a.shopId, machineId: machineId!, plan: a.prepared.plan, at: a.at, timeZone: a.timeZone, saleLineId: a.line.id, stockUnitId: a.prepared.stockUnitId });
  await tx.saleLine.update({ where: { id: a.line.id }, data: { machinePlanId: id } });
}

/** The plans the register offers: active, with prices. */
export async function plansForRegister(shopId: string) {
  return (await listPlans(shopId, true)).map((p) => ({ id: p.id, name: p.name, priceCents: p.priceCents, taxable: p.taxable, terms: planTerms(p) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// A ticket's lines covered by the machine's plan

/** Marks a ticket line covered by a plan on the ticket's machine (or, planId null, charges it again). */
export async function coverLineFor(user: CurrentUser, lineId: string, machinePlanId: string | null): Promise<string> {
  await requireBaseWritable(user);
  const shopId = user.shopId;
  const line = await db.ticketLine.findFirst({ where: { id: lineId, ticket: { shopId } }, include: { ticket: { select: { id: true, number: true, machineId: true, intakeAt: true, closedAt: true } } } });
  if (!line) throw new UserError("Line not found.");
  if (line.ticket.closedAt && user.role === "TECH") throw new UserError("The ticket is closed: only the owner or an admin can change its bill.");
  const label = `Ticket #${line.ticket.number}: ${line.description}`;
  if (!machinePlanId) {
    if (!line.coveredPlanId) return line.ticket.id;
    const r = await db.$transaction(async (tx) => {
      const done = await tx.ticketLine.updateMany({ where: { id: line.id, coveredPlanId: line.coveredPlanId }, data: { coveredPlanId: null, coveredCents: null, unitPriceCents: line.coveredCents ?? 0 } });
      await audit(tx, actorOf(user), { action: "ticket.covered", subjectType: "Ticket", subjectId: line.ticket.id, subjectLabel: label, changes: { covered: [true, false] }, amountCents: line.coveredCents ?? 0 });
      return done.count;
    });
    if (!r) throw new UserError("That line just changed. Look again.");
    return line.ticket.id;
  }
  if (line.coveredPlanId) throw new UserError("That line is already covered.");
  if (line.kind === "DISCOUNT" || line.kind === "FEE") throw new UserError("Only service, labor and parts can be covered by a plan.");
  const plan = await db.machinePlan.findFirst({ where: { id: machinePlanId, shopId, machineId: line.ticket.machineId } });
  if (!plan) throw new UserError("That plan isn't on this machine.");
  if (plan.voidedAt) throw new UserError(`${plan.name} has ended.`);
  if (!(plan.startsAt <= line.ticket.intakeAt && line.ticket.intakeAt < plan.endsAt)) throw new UserError(`${plan.name} didn't cover the day this machine came in.`);
  if (plan.visits != null) {
    const others = (await visitsUsed(shopId, [plan.id], line.ticket.id)).get(plan.id) ?? 0;
    if (others >= plan.visits) throw new UserError(`${plan.name}: all ${plan.visits} covered visits are used.`);
  }
  const r = await db.$transaction(async (tx) => {
    const done = await tx.ticketLine.updateMany({ where: { id: line.id, coveredPlanId: null, unitPriceCents: line.unitPriceCents }, data: { coveredPlanId: plan.id, coveredCents: line.unitPriceCents, unitPriceCents: 0 } });
    await audit(tx, actorOf(user), { action: "ticket.covered", subjectType: "Ticket", subjectId: line.ticket.id, subjectLabel: label, changes: { covered: [false, plan.name] }, amountCents: Math.round(line.qty * line.unitPriceCents) });
    return done.count;
  });
  if (!r) throw new UserError("That line just changed. Look again.");
  return line.ticket.id;
}

/** Work given under plans in a period: each covered line's would-be charge, by plan name (the report). */
export async function coveredWork(shopId: string, start: Date, end: Date): Promise<{ plan: string; lines: number; cents: number }[]> {
  const lines = await db.ticketLine.findMany({ where: { coveredPlanId: { not: null }, ticket: { shopId, intakeAt: { gte: start, lt: end } } }, select: { coveredPlanId: true, coveredCents: true, qty: true } });
  if (!lines.length) return [];
  const names = new Map((await db.machinePlan.findMany({ where: { shopId, id: { in: [...new Set(lines.map((l) => l.coveredPlanId!))] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const out = new Map<string, { plan: string; lines: number; cents: number }>();
  for (const l of lines) {
    const name = names.get(l.coveredPlanId!) ?? "Plan";
    const row = out.get(name) ?? { plan: name, lines: 0, cents: 0 };
    row.lines++;
    row.cents += lineNet({ qty: l.qty, unitPriceCents: l.coveredCents ?? 0, taxable: false });
    out.set(name, row);
  }
  return [...out.values()].sort((x, y) => y.cents - x.cents);
}
