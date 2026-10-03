import "server-only";
// Central vac installs (modules-design.md section 10.d): a SITE ticket plus its TicketSite (where and when), whose
// machine is the installed power unit (a placeholder until it is chosen). Money, status and the checklist are the
// ticket's own. The bodies take the company or a user so the check script can drive them; src/actions/vac-installs.ts
// wraps them.
import type { Prisma } from "@/generated/prisma/client";
import type { TicketStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { CLOSING_STATUSES } from "@/lib/constants";
import { requireEquipment } from "@/lib/equipment/gate";
import { VACUUM_KIND } from "@/lib/equipment/vacuum";
import { modelKey, str } from "@/lib/format";
import { getModules, requireModule } from "@/lib/modules";
import type { CurrentUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { takeTicketNumber } from "@/lib/ticket-number";
import { rangeFromForm } from "@/lib/zoned";

export const INSTALL_CHECKLIST: string[] = [
  "Power unit spot agreed with the customer",
  "Inlets placed and marked",
  "Pipe run planned (attic, basement, crawl space)",
  "Pipe glued and strapped, no leaks",
  "Low-voltage wire run to every inlet",
  "Power unit mounted, on its own outlet",
  "Exhaust vented outside",
  "Every inlet tested (suction and switch)",
  "Hose and tools shown to the customer",
  "Site cleaned up",
];

/** The placeholder power unit until the real one is chosen. */
export const UNIT_TBD = { brand: "Central vac", model: "Power unit to be chosen" };
export const INSTALL_SERVICE = "Central vac install";
export const INSTALL_HOURS = 2;

export type SiteJob = {
  ticketId: string;
  number: number;
  address: string;
  startsAt: Date | null;
  endsAt: Date | null;
  status: TicketStatus;
  customerName: string | null;
  customerId: string | null;
  unit: string | null;
  contactName: string | null;
  contactPhone: string | null;
  accessNotes: string | null;
};

const SITE = { include: { ticket: { select: { id: true, number: true, status: true, customerId: true, customer: { select: { name: true } }, machine: { select: { brand: true, model: true, serial: true } } } } } } satisfies Prisma.TicketSiteDefaultArgs;
type SiteRow = Prisma.TicketSiteGetPayload<typeof SITE>;

function toJob(s: SiteRow): SiteJob {
  const m = s.ticket.machine;
  const placeholder = m.brand === UNIT_TBD.brand && m.model === UNIT_TBD.model;
  return {
    ticketId: s.ticketId,
    number: s.ticket.number,
    address: s.address,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    status: s.ticket.status,
    customerName: s.ticket.customer?.name ?? null,
    customerId: s.ticket.customerId,
    unit: placeholder ? null : `${m.brand} ${m.model}${m.serial ? ` S/N ${m.serial}` : ""}`,
    contactName: s.contactName,
    contactPhone: s.contactPhone,
    accessNotes: s.accessNotes,
  };
}

/** Installs with a start inside [from, to) for the calendar: none unless Vac Shop is active or lapsed (its records still show). */
export async function siteJobsBetween(shopId: string, from: Date, to: Date): Promise<SiteJob[]> {
  const s = (await getModules(shopId)).states.vac;
  if (!s.active && s.status !== "lapsed") return [];
  const rows = await db.ticketSite.findMany({ where: { shopId, startsAt: { gte: from, lt: to } }, ...SITE, orderBy: { startsAt: "asc" }, take: 500 });
  return rows.map(toJob);
}

export type InstallTab = "upcoming" | "done" | "all";
export const isInstallTab = (s: unknown): s is InstallTab => s === "upcoming" || s === "done" || s === "all";

/** The company's installs: upcoming (open, soonest first, unscheduled last), done (closed, latest first) or all. */
export async function listInstalls(shopId: string, tab: string | null = "upcoming"): Promise<SiteJob[]> {
  const t: InstallTab = isInstallTab(tab) ? tab : "upcoming";
  const where: Prisma.TicketSiteWhereInput = { shopId };
  if (t === "upcoming") where.ticket = { status: { notIn: CLOSING_STATUSES } };
  if (t === "done") where.ticket = { status: { in: CLOSING_STATUSES } };
  const rows = await db.ticketSite.findMany({ where, ...SITE, orderBy: t === "done" ? [{ updatedAt: "desc" }] : [{ startsAt: { sort: "asc", nulls: "last" } }], take: 300 });
  return rows.map(toJob);
}

/** One install (the site and its ticket) by { ticketId, shopId }, or null. */
export async function siteOf(shopId: string, ticketId: string): Promise<SiteJob | null> {
  const s = await db.ticketSite.findFirst({ where: { ticketId, shopId }, ...SITE });
  return s ? toJob(s) : null;
}

export type SiteJobInput = {
  shopId: string;
  userId: string;
  customerId: string;
  address: string;
  startsAt: Date | null;
  endsAt: Date | null;
  contactName: string | null;
  contactPhone: string | null;
  accessNotes: string | null;
  quoteFirst: boolean;
  unit: { brand: string; model: string; serial: string | null } | null;
  serviceItemId: string | null;
  notes: string | null;
};

/** Makes the power unit's Machine (or the placeholder), the SITE ticket and the TicketSite, inside the caller's transaction. */
export async function createSiteJob(tx: Prisma.TransactionClient, a: SiteJobInput): Promise<{ ticketId: string; number: number }> {
  const shop = await tx.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { taxRatePct: true } });
  const unit = a.unit ?? { ...UNIT_TBD, serial: null };
  // The same power unit checked in before (by serial) is reused, never one that is in stock or off sale.
  const existing = unit.serial
    ? await tx.machine.findFirst({ where: { shopId: a.shopId, equipment: "VACUUM", serial: { equals: unit.serial, mode: "insensitive" }, modelKey: modelKey(unit.model), OR: [{ stock: { is: null } }, { stock: { is: { status: "SOLD" } } }] }, select: { id: true } })
    : null;
  const machineId = existing
    ? (await tx.machine.updateMany({ where: { id: existing.id, shopId: a.shopId }, data: { customerId: a.customerId } }), existing.id)
    : (
        await tx.machine.create({
          data: { shopId: a.shopId, brand: unit.brand, model: unit.model, modelKey: modelKey(unit.model), serial: unit.serial, machineType: "Central", customerId: a.customerId, equipment: VACUUM_KIND.equipment, kind: VACUUM_KIND.key, details: {} },
          select: { id: true },
        })
      ).id;
  const service = a.serviceItemId ? await tx.serviceItem.findFirst({ where: { id: a.serviceItemId, shopId: a.shopId, OR: [{ equipmentKind: null }, { equipmentKind: VACUUM_KIND.key }] } }) : null;
  if (a.serviceItemId && !service) throw new UserError("That service isn't on the Vacuum menu.");
  const number = await takeTicketNumber(tx, a.shopId, null);
  const t = await tx.ticket.create({
    data: {
      shopId: a.shopId,
      number,
      machineId,
      customerId: a.customerId,
      status: a.quoteFirst ? "WAITING_CUSTOMER_OK" : "AT_SHOP_AWAITING_PICKUP",
      jobType: "SITE",
      serviceRequested: service?.name ?? INSTALL_SERVICE,
      notes: a.notes,
      taxRatePct: shop.taxRatePct,
      openedById: a.userId,
      techId: a.userId,
      intake: {},
      lines: service ? { create: { kind: "SERVICE", description: service.name, qty: 1, unitPriceCents: service.priceCents } } : undefined,
    },
    select: { id: true, number: true },
  });
  await tx.ticketSite.create({ data: { ticketId: t.id, shopId: a.shopId, address: a.address, startsAt: a.startsAt, endsAt: a.endsAt, contactName: a.contactName, contactPhone: a.contactPhone, accessNotes: a.accessNotes } });
  return { ticketId: t.id, number: t.number };
}

/** The site fields of a form: the address (required), the window (optional: no date = not scheduled yet), contact and access notes. */
function siteFields(fd: FormData, tz: string, fallbackAddress: string | null) {
  const address = (str(fd.get("address")) ?? fallbackAddress ?? "").slice(0, 300);
  if (!address) throw new UserError("Enter where the install is.");
  const scheduled = !!str(fd.get("date"));
  const range = scheduled ? rangeFromForm(fd, tz) : { startsAt: null, endsAt: null };
  return {
    address,
    startsAt: range.startsAt,
    endsAt: range.endsAt,
    contactName: str(fd.get("contactName"))?.slice(0, 120) ?? null,
    contactPhone: str(fd.get("contactPhone"))?.slice(0, 40) ?? null,
    accessNotes: str(fd.get("accessNotes"))?.slice(0, 500) ?? null,
  };
}

/** The power unit typed on a form, or null when the brand and model are blank. */
function unitFields(fd: FormData): { brand: string; model: string; serial: string | null } | null {
  const brand = str(fd.get("unitBrand"));
  const model = str(fd.get("unitModel"));
  if (!brand && !model) return null;
  if (!brand || !model) throw new UserError("Enter the power unit's brand and model, or leave both blank for now.");
  return { brand: brand.slice(0, 80), model: model.slice(0, 80), serial: str(fd.get("unitSerial"))?.slice(0, 60) ?? null };
}

/** The "New install" form: a picked or new customer, the site, the window, the unit, "quote first", the service item. */
export async function createInstallFor(user: CurrentUser, fd: FormData): Promise<{ ticketId: string; number: number }> {
  const shopId = user.shopId;
  await requireModule(user, "vac");
  const tz = await shopTimeZone(shopId);
  const pickedId = str(fd.get("customerId"));
  const picked = pickedId ? await db.customer.findFirst({ where: { id: pickedId, shopId }, select: { id: true, address: true } }) : null;
  if (pickedId && !picked) throw new UserError("Customer not found.");
  const newName = str(fd.get("customerName"));
  const newPhone = str(fd.get("customerPhone"));
  const newEmail = str(fd.get("customerEmail"));
  if (!picked && !(newName && (newPhone || newEmail))) throw new UserError("Enter the customer's name and a phone or email.");
  const site = siteFields(fd, tz, picked?.address ?? str(fd.get("customerAddress")));
  const unit = unitFields(fd);
  const quoteFirst = fd.get("quoteFirst") != null && String(fd.get("quoteFirst")) !== "false";
  const notes = str(fd.get("notes"))?.slice(0, 2000) ?? null;
  const serviceItemId = str(fd.get("serviceItemId"));
  return db.$transaction(async (tx) => {
    const customerId =
      picked?.id ??
      (
        await tx.customer.create({
          data: { shopId, kind: "RETAIL", name: newName!.slice(0, 120), phone: newPhone?.slice(0, 40) ?? null, email: newEmail?.slice(0, 120) ?? null, address: str(fd.get("customerAddress"))?.slice(0, 300) ?? site.address },
          select: { id: true },
        })
      ).id;
    return createSiteJob(tx, { shopId, userId: user.id, customerId, ...site, quoteFirst, unit, serviceItemId, notes });
  });
}

/** The install by { id, shopId, jobType: "SITE" } and the ticket "work" check (a lapsed module still finishes work that came in before it ended). */
async function workInstall(user: CurrentUser, ticketId: string) {
  const t = await db.ticket.findFirst({ where: { id: ticketId, shopId: user.shopId, jobType: "SITE" }, select: { id: true, machineId: true, intakeAt: true, status: true, machine: { select: { equipment: true } } } });
  if (!t) throw new UserError("Install not found.");
  await requireEquipment(user, t.machine.equipment, { ticket: { intakeAt: t.intakeAt, status: t.status } });
  return t;
}

export async function saveSiteFor(user: CurrentUser, ticketId: string, fd: FormData): Promise<void> {
  const t = await workInstall(user, ticketId);
  const tz = await shopTimeZone(user.shopId);
  const have = await db.ticketSite.findFirst({ where: { ticketId: t.id, shopId: user.shopId }, select: { address: true } });
  const site = siteFields(fd, tz, have?.address ?? null);
  await db.ticketSite.upsert({ where: { ticketId: t.id }, create: { ticketId: t.id, shopId: user.shopId, ...site }, update: site });
}

export async function setPowerUnitFor(user: CurrentUser, ticketId: string, fd: FormData): Promise<void> {
  const t = await workInstall(user, ticketId);
  const unit = unitFields(fd);
  if (!unit) throw new UserError("Enter the power unit's brand and model.");
  const r = await db.machine.updateMany({ where: { id: t.machineId, shopId: user.shopId }, data: { brand: unit.brand, model: unit.model, modelKey: modelKey(unit.model), serial: unit.serial, machineType: "Central" } });
  if (!r.count) throw new UserError("Install not found.");
}
