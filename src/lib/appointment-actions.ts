import "server-only";
// The work behind src/actions/appointments.ts (scheduling-messaging-design.md 12.2), callable with a user so the check
// script can drive it. Every function needs Scheduling; the admin-only ones say so.
import type { AppointmentType, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { assertId } from "@/lib/input";
import { money, str, ticketNo, toCents } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { moduleOn, requireOn } from "@/lib/module-gate";
import { customerFromForm } from "@/lib/customer-input";
import { hoursFromForm, hoursOf, hoursText, overlapCount, poolKey, withinHours } from "@/lib/appointments";
import { lockKeys } from "@/lib/lock";
import { queueToCustomer } from "@/lib/messaging/queue";
import { messagingView } from "@/lib/messaging/settings";
import { plainText, renderKind } from "@/lib/messaging/templates";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen, parseHm, parseYmd, ymdOf, zonedTime } from "@/lib/zoned";

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;

/** A checkbox paired with a hidden "off": on when any value is "on", off when the only values say off, on when the field is missing. */
function checkbox(fd: FormData, name: string): boolean {
  const v = fd.getAll(name).map(String);
  return v.length === 0 || v.includes("on");
}

async function asUser(user: CurrentUser): Promise<void> {
  await requireOn(user, "scheduling");
}
async function asAdmin(user: CurrentUser): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireOn(user, "scheduling");
}

const limited = (v: string | null, max: number, what: string): string | null => {
  const t = v?.trim() ?? "";
  if (t.length > max) throw new UserError(`${what} is too long (${max} characters at most).`);
  return t || null;
};

async function ownType(shopId: string, id: string): Promise<AppointmentType> {
  const t = await db.appointmentType.findFirst({ where: { id: assertId(id), shopId } });
  if (!t) throw new UserError("Pick what they're booking.");
  return t;
}
async function ownAppt(shopId: string, id: string) {
  const a = await db.appointment.findFirst({ where: { id: assertId(id), shopId }, include: { type: true } });
  if (!a) throw new UserError("Appointment not found.");
  return a;
}

/** A booking notice (needs Marketing; the box is only shown then). */
async function tell(tx: Tx, user: CurrentUser, customerId: string | null, subject: string, body: string, dedupeKey: string, notAfter: Date | null) {
  if (!customerId) return;
  if (!(await moduleOn(user.shopId, "marketing"))) throw new UserError("Messages are off: Marketing isn't on. Untick 'tell them' and call them instead.");
  await queueToCustomer(tx, {
    shopId: user.shopId,
    customerId,
    kind: "booking_notice",
    channels: "preferred",
    content: (ch) => (ch === "email" ? { subject, body } : { body: plainText(body).text }),
    dedupeKey,
    notAfter,
    refType: "appointment",
    byUserId: user.id,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Types

export async function saveApptTypeAs(user: CurrentUser, typeId: string | null, fd: FormData): Promise<string> {
  await asAdmin(user);
  const shopId = user.shopId;
  const name = str(fd.get("name"))?.trim() ?? "";
  if (!name || name.length > 80) throw new UserError("Give it a name (up to 80 characters).");
  const minutes = Number(str(fd.get("minutes")) ?? "");
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 720) throw new UserError("How long: 5 to 720 minutes.");
  const fee = toCents(fd.get("fee") ?? "0");
  if (fee == null || fee < 0 || fee > 10_000_000) throw new UserError("Check the fee.");
  const capacity = Number(str(fd.get("capacity")) ?? "1");
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) throw new UserError("How many can be booked at the same time: 1 to 20.");
  let resource = limited(str(fd.get("resource")), 40, "What it uses up");
  const sortOrder = Number(str(fd.get("sortOrder")) ?? "0");
  const data = {
    name,
    minutes,
    feeCents: fee,
    taxable: fd.get("taxable") === "on",
    capacity,
    resource,
    hours: hoursFromForm(fd) as unknown as Prisma.InputJsonValue,
    location: limited(str(fd.get("location")), 120, "The location"),
    // The form sends a hidden "off" before the checkbox's "on" (the first value alone would always read off); a form
    // without the field at all means on.
    active: checkbox(fd, "active"),
    sortOrder: Number.isInteger(sortOrder) ? Math.max(-1000, Math.min(1000, sortOrder)) : 0,
  };
  if (resource) {
    const others = await db.appointmentType.findMany({ where: { shopId, active: true, resource: { equals: resource, mode: "insensitive" }, ...(typeId ? { id: { not: typeId } } : {}) }, select: { capacity: true, resource: true } });
    const other = others.find((o) => o.capacity !== capacity);
    if (other) throw new UserError(`Other types using ${other.resource} allow ${other.capacity} at once. Use the same number.`);
    if (others[0]?.resource) resource = others[0].resource; // one spelling for the thing they share
    data.resource = resource;
  }
  if (typeId) {
    const t = await ownType(shopId, typeId);
    await db.appointmentType.updateMany({ where: { id: t.id, shopId }, data });
    return t.id;
  }
  const made = await db.appointmentType.create({ data: { shopId, ...data }, select: { id: true } });
  return made.id;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bookings

/** The start and end from the form: `date` + `start`, and `end` or the type's length. */
function timesFrom(fd: FormData, minutes: number, tz: string): { startsAt: Date; endsAt: Date } {
  const ymd = parseYmd(str(fd.get("date")));
  if (!ymd) throw new UserError("Pick a date.");
  const start = parseHm(str(fd.get("start")));
  if (start == null) throw new UserError("Enter a start time like 10:00.");
  const endRaw = str(fd.get("end"));
  const end = endRaw ? parseHm(endRaw) : start + minutes;
  if (end == null) throw new UserError("Enter an end time like 12:00.");
  if (end <= start) throw new UserError("The end time must be after the start.");
  if (end - start > 16 * 60) throw new UserError("That's longer than 16 hours. Check the times.");
  return { startsAt: zonedTime(ymd, start, tz), endsAt: zonedTime(ymd, end, tz) };
}

/** The checks every booking and move share: hours, the pool's capacity, the staff member's time. */
async function checkRoom(tx: Tx, a: { shopId: string; type: AppointmentType; startsAt: Date; endsAt: Date; staffId: string | null; outsideHours: boolean; exceptId?: string; tz: string }) {
  const hours = hoursOf(a.type.hours);
  if (!a.outsideHours && !withinHours(hours, a.startsAt, a.endsAt, a.tz)) throw new UserError(`${a.type.name} can be booked ${hoursText(hours)}. Pick another time.`);
  await lockKeys(tx, [poolKey(a.shopId, a.type), ...(a.staffId ? [`staff:${a.staffId}`] : [])]);
  const taken = await overlapCount(tx, { shopId: a.shopId, resource: a.type.resource, typeId: a.type.id }, a.startsAt, a.endsAt, a.exceptId);
  if (taken >= a.type.capacity) throw new UserError(`${a.type.resource?.trim() || a.type.name} is already booked then (${taken} of ${a.type.capacity}). Pick another time.`);
  if (a.staffId) {
    const busy = await overlapCount(tx, { shopId: a.shopId, staffId: a.staffId }, a.startsAt, a.endsAt, a.exceptId);
    if (busy) {
      const who = await tx.user.findFirst({ where: { id: a.staffId, shopId: a.shopId }, select: { name: true } });
      throw new UserError(`${who?.name ?? "That staff member"} already has an appointment then.`);
    }
  }
}

async function staffFrom(shopId: string, fd: FormData): Promise<string | null> {
  const id = str(fd.get("staffId"));
  if (!id) return null;
  const u = await db.user.findFirst({ where: { id: assertId(id), shopId, active: true }, select: { id: true } });
  if (!u) throw new UserError("Pick a staff member of this shop.");
  return u.id;
}

/** "Ticket # or tag #" -> the ticket or the retail job it names. */
async function linkFrom(shopId: string, fd: FormData): Promise<{ ticketId: string | null; repairJobId: string | null }> {
  const raw = str(fd.get("ticketNo"))?.trim() ?? "";
  if (!raw) return { ticketId: null, repairJobId: null };
  const n = Number(raw.replace(/^#/, ""));
  if (Number.isInteger(n) && n > 0) {
    const t = await db.ticket.findFirst({ where: { shopId, number: n }, select: { id: true } });
    if (t) return { ticketId: t.id, repairJobId: null };
  }
  const j = await db.repairJob.findFirst({ where: { shopId, side: "retail", tag: raw.replace(/^#/, "") }, select: { id: true } });
  if (j) return { ticketId: null, repairJobId: j.id };
  throw new UserError(`No ticket ${raw}.`);
}

/** Booking merge fields for the `booking` template (design 5). */
async function bookingVars(shopId: string, t: { name: string; location: string | null }, feeCents: number, startsAt: Date, tz: string) {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true } });
  return { shop_name: shop.name, shop_phone: shop.phone ?? "", what: t.name, when: fmtWhen(startsAt, tz), location_line: t.location ? ` At ${t.location}.` : "", fee_line: feeCents > 0 ? ` Fee: ${money(feeCents)}, paid at the counter.` : "" };
}

/** A booking, or (admins) a block that holds the resource. Returns the id and the shop day, for the redirect. */
export async function bookAs(user: CurrentUser, fd: FormData, now = new Date()): Promise<{ id: string; ymd: string }> {
  await asUser(user);
  const shopId = user.shopId;
  const type = await ownType(shopId, str(fd.get("typeId")) ?? "");
  if (!type.active) throw new UserError("Pick what they're booking.");
  const tz = await shopTimeZone(shopId);
  const { startsAt, endsAt } = timesFrom(fd, type.minutes, tz);
  if (startsAt.getTime() < now.getTime() - DAY) throw new UserError("That time has passed.");
  const block = fd.get("block") === "on";
  if (block && user.role === "TECH") throw new UserError("Only an owner or admin can block time.");
  const title = block ? (str(fd.get("title"))?.trim() ?? "") : type.name;
  if (block && !title) throw new UserError("Say why, like 'Longarm maintenance'.");
  const staffId = await staffFrom(shopId, fd);
  const link = block ? { ticketId: null, repairJobId: null } : await linkFrom(shopId, fd);
  const note = limited(str(fd.get("note")), 1000, "The note");
  const outsideHours = fd.get("outsideHours") === "on" && user.role !== "TECH";
  const wantTell = fd.get("tell") === "on" && !block;
  const ms = await messagingView(shopId);
  const id = await db.$transaction(async (tx) => {
    const customer = block ? null : await customerFromForm(tx, shopId, fd, user.id, "counter", "", { notifyRequired: wantTell }).catch((e) => {
      if (e instanceof UserError && /name and a phone/.test(e.message)) throw new UserError("Pick or add the customer.");
      throw e;
    });
    await checkRoom(tx, { shopId, type, startsAt, endsAt, staffId, outsideHours, tz });
    const a = await tx.appointment.create({
      data: {
        shopId,
        typeId: type.id,
        resource: type.resource?.trim() || null,
        blocked: block,
        customerId: customer?.id ?? null,
        name: customer?.name ?? "",
        title: title.slice(0, 120),
        startsAt,
        endsAt,
        staffId,
        ticketId: link.ticketId,
        repairJobId: link.repairJobId,
        feeCents: block ? 0 : type.feeCents,
        taxable: block ? false : type.taxable,
        note,
        createdById: user.id,
      },
      select: { id: true },
    });
    if (wantTell && customer) {
      if (!(await moduleOn(shopId, "marketing"))) throw new UserError("Messages are off: Marketing isn't on. Untick 'tell them' and call them instead.");
      const vars = await bookingVars(shopId, type, type.feeCents, startsAt, tz);
      await queueToCustomer(tx, { shopId, customerId: customer.id, kind: "booking_notice", channels: "preferred", content: (ch) => renderKind(ms, "booking", ch, vars), dedupeKey: `appt:${a.id}:booked`, notAfter: endsAt, refType: "appointment", refId: a.id, byUserId: user.id, ms });
    }
    return a.id;
  });
  return { id, ymd: ymdOf(startsAt, tz) };
}

/** A booked appointment's new time (the same room checks, not counting itself). */
export async function rescheduleApptAs(user: CurrentUser, id: string, fd: FormData, now = new Date()): Promise<{ id: string; ymd: string }> {
  await asUser(user);
  const shopId = user.shopId;
  const a = await ownAppt(shopId, id);
  if (a.status !== "BOOKED") throw new UserError("Only booked appointments can move.");
  const tz = await shopTimeZone(shopId);
  const minutes = a.type?.minutes ?? Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60_000);
  const { startsAt, endsAt } = timesFrom(fd, minutes, tz);
  if (startsAt.getTime() < now.getTime() - DAY) throw new UserError("That time has passed.");
  const staffId = fd.has("staffId") ? await staffFrom(shopId, fd) : a.staffId;
  const outsideHours = fd.get("outsideHours") === "on" && user.role !== "TECH";
  await db.$transaction(async (tx) => {
    if (a.type) await checkRoom(tx, { shopId, type: a.type, startsAt, endsAt, staffId, outsideHours, exceptId: a.id, tz });
    await tx.appointment.updateMany({ where: { id: a.id, shopId, status: "BOOKED" }, data: { startsAt, endsAt, staffId } });
    if (fd.get("tell") === "on" && !a.blocked) {
      await tell(tx, user, a.customerId, `${a.title}: a new time`, `Your ${a.title} is now ${fmtWhen(startsAt, tz)}.`, `appt:${a.id}:moved:${startsAt.getTime()}`, endsAt);
    }
  });
  return { id: a.id, ymd: ymdOf(startsAt, tz) };
}

/** BOOKED -> DONE / NO_SHOW / CANCELLED; DONE / NO_SHOW -> BOOKED (a mistake); CANCELLED is final. */
export async function setApptStatusAs(user: CurrentUser, id: string, status: string, fd: FormData): Promise<void> {
  await asUser(user);
  const shopId = user.shopId;
  const a = await ownAppt(shopId, id);
  if (!["BOOKED", "DONE", "NO_SHOW", "CANCELLED"].includes(status)) throw new UserError("Unknown status.");
  if (a.status === "CANCELLED") throw new UserError("Book it again instead.");
  if (a.status !== "BOOKED" && status !== "BOOKED") throw new UserError("Only a booked appointment can be marked that.");
  const tz = await shopTimeZone(shopId);
  await db.$transaction(async (tx) => {
    await tx.appointment.updateMany({ where: { id: a.id, shopId }, data: { status, cancelledAt: status === "CANCELLED" ? new Date() : null } });
    if (status === "CANCELLED") {
      await tx.outMessage.updateMany({ where: { shopId, refType: "appointment", refId: a.id, status: "QUEUED" }, data: { status: "CANCELLED", error: "The appointment was cancelled" } });
      if (fd.get("tell") === "on" && !a.blocked) await tell(tx, user, a.customerId, `${a.title} on ${fmtWhen(a.startsAt, tz)} is cancelled`, `Your ${a.title} on ${fmtWhen(a.startsAt, tz)} is cancelled.`, `appt:${a.id}:cancelled`, null);
    }
  });
}

/** "Ticket 0051" / "tag 101" for a linked appointment. */
export async function linkedWords(shopId: string, a: { ticketId: string | null; repairJobId: string | null }): Promise<{ label: string; href: string } | null> {
  if (a.ticketId) {
    const t = await db.ticket.findFirst({ where: { id: a.ticketId, shopId }, select: { number: true } });
    return t ? { label: `Ticket ${ticketNo(t.number)}`, href: `/tickets/${a.ticketId}` } : null;
  }
  if (a.repairJobId) {
    const j = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id: a.repairJobId } }, select: { tag: true } });
    return j ? { label: `Tag ${j.tag}`, href: `/repairs/${a.repairJobId}` } : null;
  }
  return null;
}
