import "server-only";
// Machines for sale (modules-design.md section 10.c, opened to every shop by tax-machine-sales-layaway-design.md
// section 3): a StockUnit plus its Machine, of any kind the shop can work on (sewing always; a vacuum or an appliance
// while its module allows new work). Receiving, pricing, what comes with it, taking off sale, warranty registration,
// "put up for sale" from an abandoned ticket, the maker's warranty terms as the shop types them, the lists and the
// register's lookups, all as library bodies taking the company (and a user where it writes) so the check scripts can
// drive them. The sale, return and trade-in hooks are in ./sale-units.ts; service plans in ./plans.ts.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { UNIT_CONDITION_LABEL } from "@/lib/constants";
import { requireBaseWritable } from "@/lib/base-gate";
import { readAnswers } from "@/lib/equipment/form";
import { canWorkOn, requireEquipment } from "@/lib/equipment/gate";
import { kindOf, sellableKind, sellsFree } from "@/lib/equipment/shop";
import { SELL_FREE_KEYS, builtInKind } from "@/lib/equipment";
import type { EquipmentKind } from "@/lib/equipment/types";
import { modelKey, str } from "@/lib/format";
import { escapeLike } from "@/lib/input";
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

/** Fields a kind's "Add for sale" form must answer (a vacuum: bags or bagless). */
export const requiredAnswers = (kind: EquipmentKind) => (kind.key === "vacuum" ? ["bagged"] : []);

/** Most owner's classes one machine can come with. */
export const MAX_CLASS_CREDITS = 20;

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

/** The bundle typed on the unit as its items, one a line, blanks dropped. */
export const bundleItems = (bundle: string | null | undefined) =>
  (bundle ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

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
  kind: string;
  equipment: string;
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
    kind: u.machine.kind,
    equipment: u.machine.equipment,
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
  if (t === "stock") where.status = { in: ["IN_STOCK", "HELD"] };
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
  bundle: string | null;
  classCredits: number;
  includedPlanId: string | null;
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
    bundle: u.bundle,
    classCredits: u.classCredits,
    includedPlanId: u.includedPlanId,
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

function creditsField(fd: FormData): number {
  const s = str(fd.get("classCredits"));
  if (s == null) return 0;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CLASS_CREDITS) throw new UserError(`Owner's classes: a whole number from 0 to ${MAX_CLASS_CREDITS}.`);
  return n;
}

const bundleField = (fd: FormData) => bundleItems(str(fd.get("bundle"))).join("\n").slice(0, 1000) || null;

/** The included plan picked on the form: one of this shop's active plans, or none. */
async function planField(shopId: string, fd: FormData): Promise<string | null> {
  const id = str(fd.get("includedPlanId"));
  if (!id) return null;
  const p = await db.servicePlan.findFirst({ where: { id, shopId, active: true }, select: { id: true } });
  if (!p) throw new UserError("Pick the service plan from the list.");
  return p.id;
}

/**
 * The kind a new unit is of, checked: one the shop can take new work for (a vacuum needs Vac Shop), or one that sells
 * with no module (printers, cutters, lasers: shop-features-round-2-design.md 6.1).
 */
async function unitKind(user: CurrentUser, key: string | null): Promise<EquipmentKind> {
  const kind = await sellableKind(user.shopId, key ?? "sewing");
  if (!kind) {
    // A vacuum while Vac Shop is off says why; anything else just isn't on the list.
    if (key === "vacuum") await requireEquipment(user, "VACUUM");
    throw new UserError("Pick what kind of machine it is.");
  }
  if (!sellsFree(kind)) await requireEquipment(user, kind.equipment);
  return kind;
}

/** A machine for sale being changed: its module allows new work, unless its kind sells with no module. */
async function requireForSale(user: CurrentUser, m: { equipment: string; kind: string }): Promise<void> {
  if (sellsFree(builtInKind(m.kind))) return;
  await requireEquipment(user, m.equipment);
}

/** The "Add machines for sale" form: one unit per serial. Returns the new units' ids. */
export async function receiveUnitsFor(user: CurrentUser, fd: FormData): Promise<string[]> {
  const shopId = user.shopId;
  await requireBaseWritable(user);
  const kind = await unitKind(user, str(fd.get("kind")));
  const brand = str(fd.get("brand"));
  const model = str(fd.get("model"));
  if (!brand || !model) throw new UserError("Enter the brand and model.");
  const condition = str(fd.get("condition")) ?? "NEW";
  if (!isCondition(condition)) throw new UserError("Pick the condition.");
  const machineType = str(fd.get("machineType"));
  if (machineType && !kind.types.includes(machineType)) throw new UserError("Pick the type from the list.");
  const serials = [
    ...new Set(
      (str(fd.get("serials")) ?? "")
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (serials.length > MAX_SERIALS) throw new UserError(`Up to ${MAX_SERIALS} serial numbers at a time.`);
  if (!serials.length && condition !== "USED" && !kind.serialOptional) throw new UserError("Enter the serial number. It's on the label; the warranty needs it.");
  if (serials.some((s) => s.length > 60)) throw new UserError("A serial number is 60 characters at most.");
  const details = readAnswers(kind.intakeFields, "machine", fd, undefined, requiredAnswers(kind));
  const costCents = centsField(fd.get("costCents"), "Cost");
  const priceCents = centsField(fd.get("priceCents"), "Price");
  const warrantyMonths = monthsField(fd) ?? DEFAULT_WARRANTY_MONTHS[condition];
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true } });
  const warrantyBy = (str(fd.get("warrantyBy")) ?? warrantyByDefault(condition, brand, shop.name)).slice(0, 80);
  const note = str(fd.get("note"))?.slice(0, 500) ?? null;
  const bundle = bundleField(fd);
  const classCredits = creditsField(fd);
  const includedPlanId = await planField(shopId, fd);
  const at = new Date();
  const list: (string | null)[] = serials.length ? serials : [null];
  const ids: string[] = [];
  await db.$transaction(async (tx) => {
    for (const serial of list) {
      let machineId: string | null = null;
      if (serial) {
        const have = await tx.machine.findFirst({ where: { shopId, equipment: kind.equipment, serial: { equals: serial, mode: "insensitive" } }, include: { stock: { select: { status: true } } } });
        if (have?.customerId) throw new UserError(`${serial} belongs to a customer's ${kind.noun}. Take it in as a trade-in instead.`);
        if (have?.stock) throw new UserError(have.stock.status === "SOLD" ? `${serial} was sold here. Take it in as a trade-in instead.` : `${serial} is already in your stock.`);
        machineId = have?.id ?? null;
        if (have) await tx.machine.updateMany({ where: { id: have.id, shopId }, data: { brand, model, modelKey: modelKey(model), machineType, kind: kind.key, details: { ...((have.details as object) ?? {}), ...details } } });
      }
      if (!machineId) {
        const m = await tx.machine.create({
          data: { shopId, brand, model, modelKey: modelKey(model), serial, machineType, equipment: kind.equipment, kind: kind.key, details },
          select: { id: true },
        });
        machineId = m.id;
      }
      const u = await tx.stockUnit.create({
        data: { shopId, machineId, status: "IN_STOCK", condition, costCents, priceCents, warrantyMonths, warrantyBy, note, bundle, classCredits, includedPlanId, events: [{ at: at.toISOString(), note: `Received by ${user.name}` }] },
        select: { id: true },
      });
      ids.push(u.id);
    }
  });
  return ids;
}

/** Price, condition, warranty, what comes with it, note, and the machine's brand, model, serial, type and answers. */
export async function updateUnitFor(user: CurrentUser, id: string, fd: FormData): Promise<void> {
  const shopId = user.shopId;
  await requireBaseWritable(user);
  const u = await db.stockUnit.findFirst({ where: { id, shopId }, include: { machine: true } });
  if (!u) throw new UserError("Unit not found.");
  await requireForSale(user, u.machine);
  const kind = await kindOf(shopId, u.machine);
  const brand = str(fd.get("brand")) ?? u.machine.brand;
  const model = str(fd.get("model")) ?? u.machine.model;
  const condition = str(fd.get("condition")) ?? u.condition;
  if (!isCondition(condition)) throw new UserError("Pick the condition.");
  const machineType = fd.has("machineType") ? str(fd.get("machineType")) : u.machine.machineType;
  if (machineType && machineType !== u.machine.machineType && !kind.types.includes(machineType)) throw new UserError("Pick the type from the list.");
  const serial = fd.has("serial") ? str(fd.get("serial")) : u.machine.serial;
  if (serial && serial.length > 60) throw new UserError("A serial number is 60 characters at most.");
  if (serial && serial.toLowerCase() !== (u.machine.serial ?? "").toLowerCase()) {
    const clash = await db.machine.findFirst({ where: { shopId, equipment: u.machine.equipment, id: { not: u.machineId }, serial: { equals: serial, mode: "insensitive" } }, select: { id: true } });
    if (clash) throw new UserError(`Another ${kind.noun} here has the serial ${serial}.`);
  }
  const details = readAnswers(kind.intakeFields, "machine", fd, (u.machine.details as Record<string, unknown>) ?? {});
  const data: Prisma.StockUnitUpdateManyMutationInput = {
    condition,
    note: fd.has("note") ? (str(fd.get("note"))?.slice(0, 500) ?? null) : u.note,
    events: pushEvent(u.events, { at: new Date().toISOString(), note: `Changed by ${user.name}` }),
  };
  if (fd.has("priceCents")) data.priceCents = centsField(fd.get("priceCents"), "Price");
  if (fd.has("costCents")) data.costCents = centsField(fd.get("costCents"), "Cost");
  if (fd.has("warrantyMonths")) data.warrantyMonths = monthsField(fd);
  if (fd.has("warrantyBy")) data.warrantyBy = str(fd.get("warrantyBy"))?.slice(0, 80) ?? null;
  if (fd.has("bundle")) data.bundle = bundleField(fd);
  // What the buyer was given is fixed once it is sold: the owner's classes and the included plan came with that sale.
  if (u.status !== "SOLD") {
    if (fd.has("classCredits")) data.classCredits = creditsField(fd);
    if (fd.has("includedPlanId")) data.includedPlanId = await planField(shopId, fd);
  }
  await db.$transaction([
    db.stockUnit.updateMany({ where: { id: u.id, shopId }, data }),
    db.machine.updateMany({ where: { id: u.machineId, shopId }, data: { brand, model, modelKey: modelKey(model), serial, machineType, details } }),
  ]);
}

/** IN_STOCK ↔ REMOVED, with the reason as an event. */
export async function setUnitOffSaleFor(user: CurrentUser, id: string, off: boolean, fd?: FormData): Promise<void> {
  const shopId = user.shopId;
  await requireBaseWritable(user);
  const u = await db.stockUnit.findFirst({ where: { id, shopId }, select: { id: true, events: true, status: true, machine: { select: { equipment: true, kind: true } } } });
  if (!u) throw new UserError("Unit not found.");
  await requireForSale(user, u.machine);
  const reason = str(fd?.get("reason") ?? null)?.slice(0, 200);
  const note = off ? `Taken off sale by ${user.name}${reason ? `: ${reason}` : ""}` : `Put back on sale by ${user.name}`;
  const r = await db.stockUnit.updateMany({
    where: { id: u.id, shopId, status: off ? "IN_STOCK" : "REMOVED" },
    data: { status: off ? "REMOVED" : "IN_STOCK", events: pushEvent(u.events, { at: new Date().toISOString(), note }) },
  });
  if (!r.count) throw new UserError(off ? "Only a machine in stock can be taken off sale." : "Only a machine that is off sale can be put back.");
}

/** The maker's registration, done on their site: the date (not in the future) and a reference. Any module state: it is the buyer's warranty. */
export async function recordRegistrationFor(user: CurrentUser, id: string, fd: FormData): Promise<void> {
  const shopId = user.shopId;
  await requireBaseWritable(user);
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

/** An abandoned machine goes up for sale as Used, its cost the unpaid balance of that ticket. Returns the unit id. */
export async function unitFromAbandonedFor(user: CurrentUser, machineId: string): Promise<string> {
  const shopId = user.shopId;
  await requireBaseWritable(user);
  const m = await db.machine.findFirst({
    where: { id: machineId, shopId },
    include: { stock: { select: { id: true } }, tickets: { orderBy: { intakeAt: "desc" }, take: 1, include: { lines: true, payments: true } } },
  });
  if (!m) throw new UserError("Machine not found.");
  await requireForSale(user, m);
  if (m.stock) throw new UserError("That machine is already in your stock.");
  const t = m.tickets[0];
  if (!t || t.status !== "ABANDONED") throw new UserError("Only a machine whose ticket was marked Abandoned can go up for sale.");
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
// The maker's warranty terms, as the shop types them (one row per brand; no built-in claims about any maker)

export type MakerTerms = { id: string; brand: string; partsYears: number | null; laborYears: number | null; electronicsYears: number | null; registerUrl: string | null; note: string | null };

export const brandKeyOf = (brand: string) => brand.trim().toLowerCase().replace(/\s+/g, " ");

/** "Parts 25 years, labor 2 years, electronics 5 years", from what the shop typed; "" when nothing was. */
export function termsText(t: Pick<MakerTerms, "partsYears" | "laborYears" | "electronicsYears">): string {
  const yrs = (n: number) => `${n} year${n === 1 ? "" : "s"}`;
  return [t.partsYears != null ? `parts ${yrs(t.partsYears)}` : null, t.laborYears != null ? `labor ${yrs(t.laborYears)}` : null, t.electronicsYears != null ? `electronics ${yrs(t.electronicsYears)}` : null]
    .filter(Boolean)
    .join(", ")
    .replace(/^./, (c) => c.toUpperCase());
}

export async function listMakerTerms(shopId: string): Promise<MakerTerms[]> {
  return db.makerWarranty.findMany({ where: { shopId }, orderBy: { brandKey: "asc" }, select: { id: true, brand: true, partsYears: true, laborYears: true, electronicsYears: true, registerUrl: true, note: true } });
}

/** The terms the shop typed for these brands, by brand key. */
export async function makerTermsFor(shopId: string, brands: string[]): Promise<Map<string, MakerTerms>> {
  const keys = [...new Set(brands.map(brandKeyOf))];
  if (!keys.length) return new Map();
  const rows = await db.makerWarranty.findMany({ where: { shopId, brandKey: { in: keys } } });
  return new Map(rows.map((r) => [r.brandKey, r]));
}
export const termsOf = (map: Map<string, MakerTerms>, brand: string) => map.get(brandKeyOf(brand)) ?? null;

function yearsField(fd: FormData, name: string, what: string): number | null {
  const s = str(fd.get(name));
  if (s == null) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 99) throw new UserError(`${what}: years from 0 to 99 (blank if the maker gives none).`);
  return Math.round(n * 10) / 10;
}

/** Adds or replaces the terms for a brand (owner or admin). */
export async function saveMakerTermsFor(user: CurrentUser, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const brand = str(fd.get("brand"))?.slice(0, 60);
  if (!brand) throw new UserError("Enter the brand.");
  const url = str(fd.get("registerUrl"));
  if (url && (!/^https?:\/\/\S+$/i.test(url) || url.length > 300)) throw new UserError("The registration page: a web address starting with https://");
  const data = {
    brand,
    partsYears: yearsField(fd, "partsYears", "Parts"),
    laborYears: yearsField(fd, "laborYears", "Labor"),
    electronicsYears: yearsField(fd, "electronicsYears", "Electronics"),
    registerUrl: url ?? null,
    note: str(fd.get("note"))?.slice(0, 300) ?? null,
  };
  const brandKey = brandKeyOf(brand);
  await db.makerWarranty.upsert({ where: { shopId_brandKey: { shopId: user.shopId, brandKey } }, create: { shopId: user.shopId, brandKey, ...data }, update: data });
}

export async function deleteMakerTermsFor(user: CurrentUser, id: string): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  await db.makerWarranty.deleteMany({ where: { id, shopId: user.shopId } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reminders, and what a customer has left

/** Days after the sale before an unregistered new machine shows on the dashboard. */
export const REGISTER_AFTER_DAYS = 7;

export type ToRegister = { id: string; description: string; soldAt: Date; buyer: { id: string; name: string } | null; registerUrl: string | null };

/** New and open-box machines sold more than a week ago that nobody has registered with the maker yet. */
export async function unitsToRegister(shopId: string, now = new Date()): Promise<ToRegister[]> {
  const rows = await db.stockUnit.findMany({
    where: { shopId, status: "SOLD", condition: { in: ["NEW", "OPEN_BOX"] }, registeredAt: null, soldAt: { lt: new Date(now.getTime() - REGISTER_AFTER_DAYS * 86_400_000) } },
    ...ROW,
    orderBy: { soldAt: "asc" },
    take: 50,
  });
  const terms = await makerTermsFor(
    shopId,
    rows.map((u) => u.machine.brand),
  );
  return rows.map((u) => ({ id: u.id, description: unitDescription(u), soldAt: u.soldAt!, buyer: u.machine.customer, registerUrl: termsOf(terms, u.machine.brand)?.registerUrl ?? null }));
}

export type ClassCredits = { unitId: string; machine: string; granted: number; used: number; left: number };

/** Owner's classes that came with the machines this customer bought here (still theirs), and how many are left. */
export async function classCreditsFor(shopId: string, customerId: string): Promise<ClassCredits[]> {
  const units = await db.stockUnit.findMany({ where: { shopId, status: "SOLD", classCredits: { gt: 0 }, machine: { customerId } }, include: { machine: true }, orderBy: { soldAt: "asc" } });
  if (!units.length) return [];
  const used = await db.enrollment.groupBy({ by: ["creditUnitId"], where: { shopId, creditUnitId: { in: units.map((u) => u.id) }, status: { not: "CANCELLED" } }, _count: { _all: true } });
  const n = new Map(used.map((g) => [g.creditUnitId, g._count._all]));
  return units.map((u) => {
    const k = n.get(u.id) ?? 0;
    return { unitId: u.id, machine: `${u.machine.brand} ${u.machine.model}`, granted: u.classCredits, used: k, left: Math.max(0, u.classCredits - k) };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The register's lookups

export type UnitForSale = { id: string; description: string; priceCents: number | null; serial: string | null; condition: string; brand: string };
export type UnitToReturn = { id: string; description: string; refundCents: number; buyer: string | null; soldAt: Date | null };

/** The equipment the shop may sell from stock now: sewing always, a vacuum or an appliance while its module allows new work. */
export async function sellableEquipment(shopId: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of ["SEWING", "VACUUM", "APPLIANCE"]) if (await canWorkOn(shopId, e)) out.push(e);
  return out;
}

/** Machines of a kind the shop may sell now: its equipment allows new work, or the kind sells with no module (6.1). */
export async function sellableMachines(shopId: string): Promise<Prisma.MachineWhereInput> {
  return { OR: [{ equipment: { in: await sellableEquipment(shopId) } }, { kind: { in: SELL_FREE_KEYS } }] };
}

/** Whether a machine is of a kind the shop may sell now. */
export async function isSellableMachine(shopId: string, m: { equipment: string; kind: string }): Promise<boolean> {
  return SELL_FREE_KEYS.includes(m.kind) || (await sellableEquipment(shopId)).includes(m.equipment);
}

/** Up to 20 in-stock units matching `q` (serial, brand or model) of a kind the shop may sell. */
export async function unitsForSaleFor(shopId: string, q: string | null): Promise<UnitForSale[]> {
  const rows = await db.stockUnit.findMany({
    where: { shopId, status: "IN_STOCK", machine: { AND: [machineMatch(q) ?? {}, await sellableMachines(shopId)] } },
    include: { machine: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map((u) => ({ id: u.id, description: unitDescription(u), priceCents: u.priceCents, serial: u.machine.serial, condition: u.condition, brand: u.machine.brand }));
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
