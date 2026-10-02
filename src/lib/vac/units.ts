import "server-only";
// Vacuums for sale (modules-design.md section 10.c): a StockUnit plus its Machine (VACUUM, kind vacuum). Receiving,
// pricing, taking off sale, warranty registration, "put up for sale" from an abandoned ticket, the lists and the
// register's lookups, all as library bodies taking the company (and a user where it writes) so the check scripts can
// drive them. The sale, return and trade-in hooks are in ./sale-units.ts.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { UNIT_CONDITION_LABEL } from "@/lib/constants";
import { readAnswers } from "@/lib/equipment/form";
import { VACUUM_KIND } from "@/lib/equipment/vacuum";
import { modelKey, str } from "@/lib/format";
import { escapeLike } from "@/lib/input";
import { moduleState, requireModule } from "@/lib/modules";
import { centsField } from "@/lib/parts";
import { lineNet } from "@/lib/register-math";
import { shopTimeZone } from "@/lib/shop-zone";
import { ticketTotals } from "@/lib/ticket-math";
import { addDays, dayStart, parseYmd, ymdOf, ymdParts } from "@/lib/zoned";

export const UNIT_CONDITIONS = ["NEW", "OPEN_BOX", "REFURB", "USED"] as const;
export type UnitCondition = (typeof UNIT_CONDITIONS)[number];
export const isCondition = (s: unknown): s is UnitCondition => (UNIT_CONDITIONS as readonly string[]).includes(s as string);

/** Months of warranty by condition, until the shop types its own. */
export const DEFAULT_WARRANTY_MONTHS: Record<UnitCondition, number> = { NEW: 12, OPEN_BOX: 12, REFURB: 6, USED: 3 };

/** Who stands behind it: the maker for new and open-box, the shop otherwise. */
export const warrantyByDefault = (condition: string, brand: string, shopName: string) => (condition === "NEW" || condition === "OPEN_BOX" ? brand : shopName);

export type UnitEvent = { at: string; note: string; line?: string; prev?: Record<string, unknown> };

/** The events list with one more on the end (the last 200 kept). */
export function pushEvent(events: unknown, e: UnitEvent): Prisma.InputJsonValue {
  const list = Array.isArray(events) ? (events as UnitEvent[]) : [];
  return [...list, e].slice(-200) as unknown as Prisma.InputJsonValue;
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * The warranty's last day: the sale's date in the shop's zone plus `months` calendar months, the day clamped to the
 * month's end (Jan 31 + 1 month is Feb 28). `until` is the start, in shop time, of the day after it (what is stored).
 */
export function warrantyEnd(at: Date, months: number, tz: string): { lastDay: string; until: Date } {
  const { y, m, d } = ymdParts(ymdOf(at, tz));
  const total = m - 1 + Math.max(0, Math.round(months));
  const yy = y + Math.floor(total / 12);
  const mm = (total % 12) + 1;
  const dd = Math.min(d, daysIn(yy, mm));
  const lastDay = `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  return { lastDay, until: dayStart(addDays(lastDay, 1), tz) };
}

/** The last covered day (YYYY-MM-DD) from a stored `warrantyUntil`. */
export const warrantyThrough = (until: Date, tz: string) => addDays(ymdOf(until, tz), -1);

/** "Jan 31, 2027" from a YYYY-MM-DD. */
export function fmtYmdLong(ymd: string): string {
  const { y, m, d } = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

type UnitWithMachine = { condition: string; machine: { brand: string; model: string; serial: string | null } };

/** "Miele C3 (New) S/N 1234" */
export function unitDescription(u: UnitWithMachine): string {
  return `${u.machine.brand} ${u.machine.model} (${UNIT_CONDITION_LABEL[u.condition] ?? u.condition}) S/N ${u.machine.serial ?? "none"}`;
}

/** What the receipt and the register say after the name: "" for new, else the condition in words. */
export const unitDisclosure = (condition: string) => (condition === "NEW" ? "" : (UNIT_CONDITION_LABEL[condition] ?? condition).toLowerCase());

export type UnitTab = "stock" | "sold" | "off" | "register";
export const UNIT_TABS: { key: UnitTab; label: string }[] = [
  { key: "stock", label: "In stock" },
  { key: "sold", label: "Sold" },
  { key: "off", label: "Off sale" },
  { key: "register", label: "Warranty to register" },
];
export const isUnitTab = (s: unknown): s is UnitTab => UNIT_TABS.some((t) => t.key === s);

export type UnitRow = {
  id: string;
  status: string;
  condition: string;
  brand: string;
  model: string;
  serial: string | null;
  machineType: string | null;
  machineId: string;
  priceCents: number | null;
  costCents: number | null;
  soldAt: Date | null;
  buyer: { id: string; name: string } | null;
  warrantyUntil: Date | null;
  registeredAt: Date | null;
  createdAt: Date;
};

const ROW = { include: { machine: { include: { customer: { select: { id: true, name: true } } } } } } satisfies Prisma.StockUnitDefaultArgs;
type Loaded = Prisma.StockUnitGetPayload<typeof ROW>;

function toRow(u: Loaded): UnitRow {
  return {
    id: u.id,
    status: u.status,
    condition: u.condition,
    brand: u.machine.brand,
    model: u.machine.model,
    serial: u.machine.serial,
    machineType: u.machine.machineType,
    machineId: u.machineId,
    priceCents: u.priceCents,
    costCents: u.costCents,
    soldAt: u.soldAt,
    buyer: u.status === "SOLD" && u.machine.customer ? u.machine.customer : null,
    warrantyUntil: u.warrantyUntil,
    registeredAt: u.registeredAt,
    createdAt: u.createdAt,
  };
}

/** The search box: a serial, a brand or a model (words). */
function machineMatch(q: string | null): Prisma.MachineWhereInput | undefined {
  const t = q?.trim();
  if (!t) return undefined;
  const words = t.split(/\s+/).slice(0, 4);
  return {
    OR: [{ serial: { contains: escapeLike(t), mode: "insensitive" } }, { AND: words.map((w) => ({ OR: [{ brand: { contains: escapeLike(w), mode: "insensitive" as const } }, { model: { contains: escapeLike(w), mode: "insensitive" as const } }] })) }],
  };
}

/** The company's units on one tab, matching `q`; always scoped by shopId. */
export async function listUnits(shopId: string, tab: string | null, q: string | null): Promise<UnitRow[]> {
  const t: UnitTab = isUnitTab(tab) ? tab : "stock";
  const where: Prisma.StockUnitWhereInput = { shopId, machine: machineMatch(q) };
  if (t === "stock") where.status = "IN_STOCK";
  else if (t === "sold") where.status = "SOLD";
  else if (t === "off") where.status = "REMOVED";
  else Object.assign(where, { status: "SOLD", condition: { in: ["NEW", "OPEN_BOX"] }, registeredAt: null });
  const rows = await db.stockUnit.findMany({ where, ...ROW, orderBy: t === "sold" || t === "register" ? [{ soldAt: "desc" }] : [{ createdAt: "desc" }], take: 300 });
  return rows.map(toRow);
}

export type UnitDetail = UnitRow & {
  warrantyMonths: number | null;
  warrantyBy: string | null;
  registrationRef: string | null;
  note: string | null;
  soldNetCents: number | null;
  details: Record<string, unknown>;
  events: UnitEvent[];
  sale: { id: string; number: number } | null;
  tradeInSale: { id: string; number: number } | null;
};

/** One unit, or null when it isn't this company's. */
export async function unitDetail(shopId: string, id: string): Promise<UnitDetail | null> {
  const u = await db.stockUnit.findFirst({ where: { id, shopId }, ...ROW });
  if (!u) return null;
  const saleOf = async (lineId: string | null) => {
    if (!lineId) return null;
    const l = await db.saleLine.findFirst({ where: { id: lineId, sale: { shopId } }, select: { sale: { select: { id: true, number: true } } } });
    return l?.sale ?? null;
  };
  const [sale, tradeInSale] = await Promise.all([saleOf(u.soldLineId), saleOf(u.tradeInLineId)]);
  return {
    ...toRow(u),
    warrantyMonths: u.warrantyMonths,
    warrantyBy: u.warrantyBy,
    registrationRef: u.registrationRef,
    note: u.note,
    soldNetCents: u.soldNetCents,
    details: (u.machine.details ?? {}) as Record<string, unknown>,
    events: Array.isArray(u.events) ? (u.events as UnitEvent[]) : [],
    sale,
    tradeInSale,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Writes (each takes the user; the action files add requireAdmin / requireUser and the redirects)

const MAX_SERIALS = 50;

function monthsField(fd: FormData): number | null {
  const s = str(fd.get("warrantyMonths"));
  if (s == null) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 120) throw new UserError("Warranty months: a whole number from 0 to 120.");
  return n;
}

/** The "Add vacuums for sale" form: one unit per serial. Returns the new units' ids. */
export async function receiveUnitsFor(user: CurrentUser, fd: FormData): Promise<string[]> {
  const shopId = user.shopId;
  await requireModule(user, "vac");
  const brand = str(fd.get("brand"));
  const model = str(fd.get("model"));
  if (!brand || !model) throw new UserError("Enter the brand and model.");
  const condition = str(fd.get("condition")) ?? "NEW";
  if (!isCondition(condition)) throw new UserError("Pick the condition.");
  const machineType = str(fd.get("machineType"));
  if (machineType && !VACUUM_KIND.types.includes(machineType)) throw new UserError("Pick the type from the list.");
  const serials = [...new Set((str(fd.get("serials")) ?? "").split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean))];
  if (serials.length > MAX_SERIALS) throw new UserError(`Up to ${MAX_SERIALS} serial numbers at a time.`);
  if (!serials.length && condition !== "USED") throw new UserError("Enter the serial number. It's on the label; the warranty needs it.");
  if (serials.some((s) => s.length > 60)) throw new UserError("A serial number is 60 characters at most.");
  const details = readAnswers(VACUUM_KIND.intakeFields, "machine", fd, undefined, ["bagged"]);
  const costCents = centsField(fd.get("costCents"), "Cost");
  const priceCents = centsField(fd.get("priceCents"), "Price");
  const warrantyMonths = monthsField(fd) ?? DEFAULT_WARRANTY_MONTHS[condition];
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true } });
  const warrantyBy = (str(fd.get("warrantyBy")) ?? warrantyByDefault(condition, brand, shop.name)).slice(0, 80);
  const note = str(fd.get("note"))?.slice(0, 500) ?? null;
  const at = new Date();
  const list: (string | null)[] = serials.length ? serials : [null];
  const ids: string[] = [];
  await db.$transaction(async (tx) => {
    for (const serial of list) {
      let machineId: string | null = null;
      if (serial) {
        const have = await tx.machine.findFirst({ where: { shopId, equipment: "VACUUM", serial: { equals: serial, mode: "insensitive" } }, include: { stock: { select: { status: true } } } });
        if (have?.customerId) throw new UserError(`${serial} belongs to a customer's vacuum. Take it in as a trade-in instead.`);
        if (have?.stock) throw new UserError(have.stock.status === "SOLD" ? `${serial} was sold here. Take it in as a trade-in instead.` : `${serial} is already in your stock.`);
        machineId = have?.id ?? null;
        if (have) await tx.machine.updateMany({ where: { id: have.id, shopId }, data: { brand, model, modelKey: modelKey(model), machineType, details: { ...((have.details as object) ?? {}), ...details } } });
      }
      if (!machineId) {
        const m = await tx.machine.create({
          data: { shopId, brand, model, modelKey: modelKey(model), serial, machineType, equipment: VACUUM_KIND.equipment, kind: VACUUM_KIND.key, details },
          select: { id: true },
        });
        machineId = m.id;
      }
      const u = await tx.stockUnit.create({
        data: { shopId, machineId, status: "IN_STOCK", condition, costCents, priceCents, warrantyMonths, warrantyBy, note, events: [{ at: at.toISOString(), note: `Received by ${user.name}` }] },
        select: { id: true },
      });
      ids.push(u.id);
    }
  });
  return ids;
}

/** Price, condition, warranty, note, and the vacuum's brand, model, serial, type and answers. */
export async function updateUnitFor(user: CurrentUser, id: string, fd: FormData): Promise<void> {
  const shopId = user.shopId;
  await requireModule(user, "vac");
  const u = await db.stockUnit.findFirst({ where: { id, shopId }, include: { machine: true } });
  if (!u) throw new UserError("Unit not found.");
  const brand = str(fd.get("brand")) ?? u.machine.brand;
  const model = str(fd.get("model")) ?? u.machine.model;
  const condition = str(fd.get("condition")) ?? u.condition;
  if (!isCondition(condition)) throw new UserError("Pick the condition.");
  const machineType = fd.has("machineType") ? str(fd.get("machineType")) : u.machine.machineType;
  if (machineType && !VACUUM_KIND.types.includes(machineType)) throw new UserError("Pick the type from the list.");
  const serial = fd.has("serial") ? str(fd.get("serial")) : u.machine.serial;
  if (serial && serial.length > 60) throw new UserError("A serial number is 60 characters at most.");
  if (serial && serial.toLowerCase() !== (u.machine.serial ?? "").toLowerCase()) {
    const clash = await db.machine.findFirst({ where: { shopId, equipment: "VACUUM", id: { not: u.machineId }, serial: { equals: serial, mode: "insensitive" } }, select: { id: true } });
    if (clash) throw new UserError(`Another vacuum here has the serial ${serial}.`);
  }
  const details = readAnswers(VACUUM_KIND.intakeFields, "machine", fd, (u.machine.details as Record<string, unknown>) ?? {});
  const data: Prisma.StockUnitUpdateManyMutationInput = {
    condition,
    note: fd.has("note") ? (str(fd.get("note"))?.slice(0, 500) ?? null) : u.note,
    events: pushEvent(u.events, { at: new Date().toISOString(), note: `Changed by ${user.name}` }),
  };
  if (fd.has("priceCents")) data.priceCents = centsField(fd.get("priceCents"), "Price");
  if (fd.has("costCents")) data.costCents = centsField(fd.get("costCents"), "Cost");
  if (fd.has("warrantyMonths")) data.warrantyMonths = monthsField(fd);
  if (fd.has("warrantyBy")) data.warrantyBy = str(fd.get("warrantyBy"))?.slice(0, 80) ?? null;
  await db.$transaction([
    db.stockUnit.updateMany({ where: { id: u.id, shopId }, data }),
    db.machine.updateMany({ where: { id: u.machineId, shopId }, data: { brand, model, modelKey: modelKey(model), serial, machineType, details } }),
  ]);
}

/** IN_STOCK ↔ REMOVED, with the reason as an event. */
export async function setUnitOffSaleFor(user: CurrentUser, id: string, off: boolean, fd?: FormData): Promise<void> {
  const shopId = user.shopId;
  await requireModule(user, "vac");
  const u = await db.stockUnit.findFirst({ where: { id, shopId }, select: { id: true, events: true, status: true } });
  if (!u) throw new UserError("Unit not found.");
  const reason = str(fd?.get("reason") ?? null)?.slice(0, 200);
  const note = off ? `Taken off sale by ${user.name}${reason ? `: ${reason}` : ""}` : `Put back on sale by ${user.name}`;
  const r = await db.stockUnit.updateMany({
    where: { id: u.id, shopId, status: off ? "IN_STOCK" : "REMOVED" },
    data: { status: off ? "REMOVED" : "IN_STOCK", events: pushEvent(u.events, { at: new Date().toISOString(), note }) },
  });
  if (!r.count) throw new UserError(off ? "Only a vacuum in stock can be taken off sale." : "Only a vacuum that is off sale can be put back.");
}

/** The maker's registration, done on their site: the date (not in the future) and a reference. */
export async function recordRegistrationFor(user: CurrentUser, id: string, fd: FormData): Promise<void> {
  const shopId = user.shopId;
  await requireModule(user, "vac");
  const u = await db.stockUnit.findFirst({ where: { id, shopId, status: "SOLD" }, select: { id: true, events: true } });
  if (!u) throw new UserError("Unit not found, or not sold yet.");
  const tz = await shopTimeZone(shopId);
  const ymd = parseYmd(str(fd.get("registeredOn")));
  if (!ymd) throw new UserError("Enter the date it was registered.");
  if (ymd > ymdOf(new Date(), tz)) throw new UserError("That date is in the future.");
  const ref = str(fd.get("registrationRef"));
  if (ref && ref.length > 80) throw new UserError("The reference is 80 characters at most.");
  await db.stockUnit.updateMany({
    where: { id: u.id, shopId },
    data: { registeredAt: dayStart(ymd, tz), registrationRef: ref, events: pushEvent(u.events, { at: new Date().toISOString(), note: `Warranty registered${ref ? ` (${ref})` : ""} by ${user.name}` }) },
  });
}

/** An abandoned vacuum goes up for sale as Used, its cost the unpaid balance of that ticket. Returns the unit id. */
export async function unitFromAbandonedFor(user: CurrentUser, machineId: string): Promise<string> {
  const shopId = user.shopId;
  await requireModule(user, "vac");
  const m = await db.machine.findFirst({
    where: { id: machineId, shopId, equipment: "VACUUM" },
    include: { stock: { select: { id: true } }, tickets: { orderBy: { intakeAt: "desc" }, take: 1, include: { lines: true, payments: true } } },
  });
  if (!m) throw new UserError("Vacuum not found.");
  if (m.stock) throw new UserError("That vacuum is already in your stock.");
  const t = m.tickets[0];
  if (!t || t.status !== "ABANDONED") throw new UserError("Only a vacuum whose ticket was marked Abandoned can go up for sale.");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxRatePct: true, name: true } });
  const owed = Math.max(0, ticketTotals(t.lines, t.payments, shop.taxRatePct).balance);
  const at = new Date().toISOString();
  const u = await db.$transaction(async (tx) => {
    const made = await tx.stockUnit.create({
      data: { shopId, machineId: m.id, status: "IN_STOCK", condition: "USED", costCents: owed, warrantyMonths: DEFAULT_WARRANTY_MONTHS.USED, warrantyBy: shop.name, events: [{ at, note: `From abandoned ticket #${t.number} (${user.name})` }] },
      select: { id: true },
    });
    await tx.machine.updateMany({ where: { id: m.id, shopId }, data: { customerId: null } });
    return made;
  });
  return u.id;
}

// ---------------------------------------------------------------------------------------------------------------------
// The register's lookups

export type UnitForSale = { id: string; description: string; priceCents: number | null; serial: string | null; condition: string };
export type UnitToReturn = { id: string; description: string; refundCents: number; buyer: string | null; soldAt: Date | null };

/** Up to 20 in-stock units matching `q` (serial, brand or model); [] unless Vac Shop is active. */
export async function unitsForSaleFor(shopId: string, q: string | null): Promise<UnitForSale[]> {
  if (!(await moduleState(shopId, "vac")).active) return [];
  const rows = await db.stockUnit.findMany({ where: { shopId, status: "IN_STOCK", machine: machineMatch(q) }, include: { machine: true }, orderBy: { createdAt: "desc" }, take: 20 });
  return rows.map((u) => ({ id: u.id, description: unitDescription(u), priceCents: u.priceCents, serial: u.machine.serial, condition: u.condition }));
}

/** Sold units by serial, brand, model or buyer, with the most a return refunds; any module state (money already owed). */
export async function unitsToReturnFor(shopId: string, q: string | null): Promise<UnitToReturn[]> {
  const t = q?.trim();
  const by = machineMatch(q);
  const where: Prisma.StockUnitWhereInput = { shopId, status: "SOLD", soldLineId: { not: null } };
  if (by && t) where.machine = { OR: [by, { customer: { name: { contains: escapeLike(t), mode: "insensitive" } } }] };
  const rows = await db.stockUnit.findMany({ where, ...ROW, orderBy: { soldAt: "desc" }, take: 20 });
  const out: UnitToReturn[] = [];
  for (const u of rows) {
    let refund = u.soldNetCents;
    if (refund == null && u.soldLineId) {
      const l = await db.saleLine.findFirst({ where: { id: u.soldLineId, sale: { shopId, status: "COMPLETED" } } });
      refund = l ? lineNet(l) : 0;
    }
    out.push({ id: u.id, description: unitDescription(u), refundCents: refund ?? 0, buyer: u.machine.customer?.name ?? null, soldAt: u.soldAt });
  }
  return out;
}
