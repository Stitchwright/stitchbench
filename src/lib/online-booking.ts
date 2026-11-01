import "server-only";
// Online booking (online-and-parts-design.md section 2): the public pages under /book/{slug} where a customer books an
// appointment type or signs up for a class, the manage link in the confirmation, and the Settings page's save. No
// session on the public side: the slug names the shop, the token names the booking, and every query filters by that
// shop's id. Bodies with plain arguments so the check script can drive them; the API routes and actions wrap them.
import crypto from "node:crypto";
import type { AppointmentType, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { freeWeek, hoursOf, hoursText, overlapCount, poolKey, withinHours } from "@/lib/appointments";
import { nextMeetings, seatCounts, enrollIn } from "@/lib/classes";
import { money, str } from "@/lib/format";
import { rentalFeeCents } from "@/lib/longarm-math";
import { isNotifyBy } from "@/components/notify-by-field";
import { lockKeys } from "@/lib/lock";
import { recordConsent } from "@/lib/messaging/consent";
import { queueToCustomer } from "@/lib/messaging/queue";
import { messagingView, publicBaseUrl } from "@/lib/messaging/settings";
import { plainText, renderKind } from "@/lib/messaging/templates";
import { baseWritable } from "@/lib/base-gate";
import { moduleOn, requireOn } from "@/lib/module-gate";
import { toE164, validEmail } from "@/lib/phone";
import type { CurrentUser } from "@/lib/session";
import { addDays, fmtWhen, ymdOf } from "@/lib/zoned";

type Db = Prisma.TransactionClient | typeof db;
const DAY = 86_400_000;
const HOUR = 3_600_000;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
/** How many days of free times the public page offers at once. */
export const PUBLIC_DAYS = 14;

/** "Sew & Vac Center" -> "sew-vac-center" */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export type PublicShop = { id: string; name: string; phone: string | null; address: string | null; timeZone: string; slug: string; welcome: string | null; leadHours: number; daysAhead: number; open: boolean };

/**
 * The shop a slug names, and whether it takes bookings right now: switched on, Scheduling active, and the program itself
 * not read-only (a lapsed shop's public booking is paused, hub-accounts-billing-design.md 3.5).
 */
export async function publicShop(slug: string): Promise<PublicShop | null> {
  if (!SLUG_RE.test(slug)) return null;
  const s = await db.shop.findUnique({ where: { bookingSlug: slug }, select: { id: true, name: true, phone: true, address: true, timeZone: true, bookingSlug: true, bookingOn: true, bookingLeadHours: true, bookingDaysAhead: true, bookingWelcome: true } });
  if (!s) return null;
  const open = s.bookingOn && (await moduleOn(s.id, "scheduling")) && (await baseWritable(s.id));
  return { id: s.id, name: s.name, phone: s.phone, address: s.address, timeZone: s.timeZone, slug: s.bookingSlug!, welcome: s.bookingWelcome, leadHours: s.bookingLeadHours, daysAhead: s.bookingDaysAhead, open };
}

/** The types a customer may book online, in the shop's order. */
export async function publicTypes(shopId: string): Promise<AppointmentType[]> {
  return db.appointmentType.findMany({ where: { shopId, active: true, online: true, needsCert: false }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export type PublicClass = { id: string; title: string; description: string | null; teacher: string | null; location: string | null; feeCents: number; seats: number; seatsLeft: number; waitlist: boolean; firstAt: Date | null; lastAt: Date | null; next: Date | null; meetings: number };

/** Open classes a customer may sign up for online: not over, with seats left or a waiting list. */
export async function publicClasses(shopId: string, now = new Date()): Promise<PublicClass[]> {
  const rows = await db.shopClass.findMany({ where: { shopId, online: true, status: "OPEN", OR: [{ lastAt: null }, { lastAt: { gte: now } }] }, orderBy: [{ firstAt: "asc" }], include: { _count: { select: { meetings: { where: { cancelled: false } } } } } });
  if (!rows.length) return [];
  const ids = rows.map((c) => c.id);
  const [counts, next] = await Promise.all([seatCounts(db, ids), nextMeetings(db, ids, now)]);
  return rows
    .map((c) => {
      const n = counts.get(c.id) ?? { enrolled: 0, waiting: 0 };
      return { id: c.id, title: c.title, description: c.description, teacher: c.teacher, location: c.location, feeCents: c.feeCents, seats: c.seats, seatsLeft: Math.max(0, c.seats - n.enrolled), waitlist: c.waitlist, firstAt: c.firstAt, lastAt: c.lastAt, next: next.get(c.id)?.startsAt ?? null, meetings: c._count.meetings };
    })
    .filter((c) => c.seatsLeft > 0 || c.waitlist);
}

export type FreeDay = { ymd: string; starts: Date[] };

/** The free start times the public page offers: inside the type's hours and capacity, at least `leadHours` from now, at most `daysAhead` out. */
export async function publicFreeTimes(shop: PublicShop, type: AppointmentType, fromYmd: string | null, now = new Date()): Promise<FreeDay[]> {
  const today = ymdOf(now, shop.timeZone);
  const start = fromYmd && fromYmd >= today ? fromYmd : today;
  const week = await freeWeek(db, shop.id, type, start, shop.timeZone, PUBLIC_DAYS);
  const earliest = now.getTime() + shop.leadHours * HOUR;
  const latest = now.getTime() + shop.daysAhead * DAY;
  return week.map((d) => ({ ymd: d.ymd, starts: d.starts.map((s) => s.start).filter((s) => s.getTime() >= earliest && s.getTime() <= latest) }));
}

export type OnlineCustomer = { name: string; phone: string | null; email: string | null; notify: string };

/** The customer as the public form gave them: matched by mobile number or email within the shop, else made; the way to tell them recorded. */
export async function customerForOnline(tx: Db, shopId: string, c: OnlineCustomer, source = "online booking"): Promise<{ id: string; name: string }> {
  const name = c.name.trim().slice(0, 120);
  if (name.length < 2) throw new UserError("Please give us your name.");
  const phone = c.phone ? toE164(c.phone) : null;
  if (c.phone && !phone) throw new UserError("That phone number doesn't look right. Use the 10-digit number.");
  const email = c.email ? validEmail(c.email) : null;
  if (c.email && !email) throw new UserError("That email address doesn't look right.");
  if (!phone && !email) throw new UserError("Please give us a mobile number or an email address, so we can confirm it.");
  const notify = isNotifyBy(c.notify) ? c.notify : "";
  if (notify === "sms" && !phone) throw new UserError("Texts need a mobile number.");
  if (notify === "email" && !email) throw new UserError("Email confirmations need an email address.");
  const found = await tx.customer.findFirst({
    where: { shopId, OR: [...(phone ? [{ phone: { in: [phone, phone.replace(/^\+1/, "")] } }] : []), ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : [])] },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, kind: true, notifyBy: true, phone: true, email: true },
  });
  if (found?.kind === "TRADE") throw new UserError(`That number or email belongs to a trade account. Please call us${source === "online booking" ? " to book" : ""}.`);
  if (found) {
    const data: Prisma.CustomerUpdateInput = {};
    if (!found.phone && phone) data.phone = phone;
    if (!found.email && email) data.email = email;
    if (notify && notify !== found.notifyBy) data.notifyBy = notify;
    if (Object.keys(data).length) await tx.customer.update({ where: { id: found.id }, data });
    if (notify && notify !== found.notifyBy) await recordConsent(tx, { shopId, customerId: found.id, channel: "any", event: "notify_pref", source, detail: notify });
    return { id: found.id, name: found.name };
  }
  const made = await tx.customer.create({ data: { shopId, kind: "RETAIL", name, phone, email, notifyBy: notify }, select: { id: true, name: true } });
  if (notify) await recordConsent(tx, { shopId, customerId: made.id, channel: "any", event: "notify_pref", source, detail: notify });
  return made;
}

/** The manage link: a fresh token, hashed in BookingLink, good until the booking is over (plus a day). */
async function makeLink(tx: Db, a: { shopId: string; appointmentId?: string; enrollmentId?: string; customerId: string; until: Date }): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await tx.bookingLink.create({ data: { shopId: a.shopId, appointmentId: a.appointmentId ?? null, enrollmentId: a.enrollmentId ?? null, customerId: a.customerId, tokenHash: sha256(token), expiresAt: new Date(a.until.getTime() + DAY) } });
  return token;
}

const manageUrl = (token: string) => `${publicBaseUrl() ?? ""}/book/m/${token}`;

/** The booking confirmation (the `booking` template plus the manage link), when Marketing is on and the customer can be reached. */
async function confirm(tx: Db, a: { shopId: string; customerId: string; kind: "appointment" | "enrollment"; refId: string; what: string; when: string; location: string | null; feeCents: number; notAfter: Date; token: string; shop: { name: string; phone: string | null } }) {
  if (!(await moduleOn(a.shopId, "marketing"))) return;
  const ms = await messagingView(a.shopId, tx);
  const vars = { shop_name: a.shop.name, shop_phone: a.shop.phone ?? "", what: a.what, when: a.when, location_line: a.location ? ` At ${a.location}.` : "", fee_line: a.feeCents > 0 ? ` Fee: ${money(a.feeCents)}, paid at the counter.` : "", supplies_line: "" };
  const link = manageUrl(a.token);
  await queueToCustomer(tx, {
    shopId: a.shopId,
    customerId: a.customerId,
    kind: a.kind === "appointment" ? "booking_notice" : "class_notice",
    channels: "preferred",
    dedupeKey: `${a.kind === "appointment" ? "appt" : "enroll"}:${a.refId}:online`,
    notAfter: a.notAfter,
    refType: a.kind === "appointment" ? "appointment" : "enrollment",
    refId: a.refId,
    content: (ch) => {
      const c = renderKind(ms, a.kind === "appointment" ? "booking" : "class_signup", ch, vars);
      const tail = ch === "email" ? `\n\nTo change or cancel: ${link}` : ` Change or cancel: ${link}`;
      return { subject: c.subject, body: `${ch === "email" ? c.body : plainText(c.body).text}${tail}` };
    },
  });
}

export type BookInput = { slug: string; typeId: string; startsAt: Date; customer: OnlineCustomer; note: string | null };

/** A customer books a type at a free time: the same room check as the counter, the appointment marked online, a manage link, the confirmation. */
export async function bookOnline(a: BookInput, now = new Date()): Promise<{ appointmentId: string; token: string }> {
  const shop = await publicShop(a.slug);
  if (!shop || !shop.open) throw new UserError("Online booking isn't available right now. Please call the shop.");
  const type = await db.appointmentType.findFirst({ where: { id: a.typeId, shopId: shop.id, active: true, online: true, needsCert: false } });
  if (!type) throw new UserError("That appointment isn't offered online. Please call the shop.");
  const startsAt = a.startsAt;
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.getTime())) throw new UserError("Pick a time.");
  const endsAt = new Date(startsAt.getTime() + type.minutes * 60_000);
  if (startsAt.getTime() < now.getTime() + shop.leadHours * HOUR) throw new UserError(`The earliest time we offer online is ${shop.leadHours} hours from now. Please pick another time, or call us.`);
  if (startsAt.getTime() > now.getTime() + shop.daysAhead * DAY) throw new UserError(`We take online bookings up to ${shop.daysAhead} days ahead. Please pick an earlier time.`);
  const hours = hoursOf(type.hours);
  if (!withinHours(hours, startsAt, endsAt, shop.timeZone)) throw new UserError(`${type.name} can be booked ${hoursText(hours)}. Please pick another time.`);
  const note = a.note?.trim().slice(0, 500) || null;
  // A rental by the hour: the rate x the time booked (the type's flat fee is then ignored), in the record and the confirmation alike.
  const feeCents = type.hourlyCents != null ? rentalFeeCents(type.hourlyCents, type.minutes) : type.feeCents;
  return db.$transaction(async (tx) => {
    const customer = await customerForOnline(tx, shop.id, a.customer);
    await lockKeys(tx, [poolKey(shop.id, type)]);
    const taken = await overlapCount(tx, { shopId: shop.id, resource: type.resource, typeId: type.id }, startsAt, endsAt);
    if (taken >= type.capacity) throw new UserError("That time was just taken. Please pick another.");
    const appt = await tx.appointment.create({
      data: { shopId: shop.id, typeId: type.id, resource: type.resource?.trim() || null, customerId: customer.id, name: customer.name, title: type.name, startsAt, endsAt, feeCents, taxable: type.taxable, note, source: "online" },
      select: { id: true },
    });
    const token = await makeLink(tx, { shopId: shop.id, appointmentId: appt.id, customerId: customer.id, until: endsAt });
    await confirm(tx, { shopId: shop.id, customerId: customer.id, kind: "appointment", refId: appt.id, what: type.name, when: fmtWhen(startsAt, shop.timeZone), location: type.location, feeCents, notAfter: endsAt, token, shop });
    return { appointmentId: appt.id, token };
  });
}

export type SignUpInput = { slug: string; classId: string; customer: OnlineCustomer; attendee: string | null; note: string | null };

/** A customer signs up for a class (the waiting list when it is full and the class keeps one), marked online, with a manage link and the confirmation. */
export async function signUpOnline(a: SignUpInput, now = new Date()): Promise<{ enrollmentId: string; status: string; token: string }> {
  const shop = await publicShop(a.slug);
  if (!shop || !shop.open) throw new UserError("Online booking isn't available right now. Please call the shop.");
  const c = await db.shopClass.findFirst({ where: { id: a.classId, shopId: shop.id, online: true, status: "OPEN" } });
  if (!c) throw new UserError("That class isn't offered online. Please call the shop.");
  return db.$transaction(async (tx) => {
    const customer = await customerForOnline(tx, shop.id, a.customer);
    const e = await enrollIn(tx, { shopId: shop.id, classId: c.id, customer, attendee: a.attendee, byUserId: "", skipWaitlist: false, now });
    await tx.enrollment.updateMany({ where: { id: e.id, shopId: shop.id }, data: { source: "online", note: a.note?.trim().slice(0, 500) || null, createdById: null } });
    const until = c.lastAt ?? c.firstAt ?? new Date(now.getTime() + 180 * DAY);
    const token = await makeLink(tx, { shopId: shop.id, enrollmentId: e.id, customerId: customer.id, until });
    if (e.status === "ENROLLED") {
      await confirm(tx, { shopId: shop.id, customerId: customer.id, kind: "enrollment", refId: e.id, what: a.attendee ? `${c.title} for ${a.attendee}` : c.title, when: c.firstAt ? fmtWhen(c.firstAt, shop.timeZone) : "a date to be announced", location: c.location, feeCents: e.feeCents, notAfter: until, token, shop });
    }
    return { enrollmentId: e.id, status: e.status, token };
  });
}

export type ManageView = {
  kind: "appointment" | "enrollment";
  shop: { name: string; phone: string | null; address: string | null; timeZone: string; slug: string | null };
  firstName: string;
  what: string;
  when: string | null;
  where: string | null;
  feeCents: number;
  status: string;
  startsAt: Date | null;
  canCancel: boolean;
  canMove: boolean;
  typeId: string | null;
  refId: string;
  shopId: string;
};

type Found = { link: { id: string; shopId: string; appointmentId: string | null; enrollmentId: string | null; expiresAt: Date }; view: ManageView };

/** The booking a manage token names, as the public page shows it; null for an unknown or expired token. */
export async function manageByToken(token: string, now = new Date()): Promise<Found | null> {
  if (!TOKEN_RE.test(token)) return null;
  const link = await db.bookingLink.findUnique({ where: { tokenHash: sha256(token) } });
  if (!link || link.expiresAt.getTime() < now.getTime()) return null;
  const shop = await db.shop.findUnique({ where: { id: link.shopId }, select: { id: true, name: true, phone: true, address: true, timeZone: true, bookingSlug: true, bookingLeadHours: true } });
  if (!shop) return null;
  const base = { shop: { name: shop.name, phone: shop.phone, address: shop.address, timeZone: shop.timeZone, slug: shop.bookingSlug }, shopId: shop.id };
  const lead = shop.bookingLeadHours * HOUR;
  if (link.appointmentId) {
    const a = await db.appointment.findFirst({ where: { id: link.appointmentId, shopId: shop.id }, include: { type: { select: { id: true, location: true } } } });
    if (!a) return null;
    const changeable = a.status === "BOOKED" && a.startsAt.getTime() - now.getTime() >= lead;
    return { link, view: { ...base, kind: "appointment", firstName: a.name.split(/\s+/)[0] ?? "", what: a.title, when: fmtWhen(a.startsAt, shop.timeZone), where: a.type?.location ?? null, feeCents: a.feeCents, status: a.status, startsAt: a.startsAt, canCancel: changeable, canMove: changeable && !!a.type, typeId: a.type?.id ?? null, refId: a.id } };
  }
  if (link.enrollmentId) {
    const e = await db.enrollment.findFirst({ where: { id: link.enrollmentId, shopId: shop.id }, include: { shopClass: { select: { title: true, location: true, firstAt: true } } } });
    if (!e) return null;
    const starts = e.shopClass.firstAt;
    const changeable = (e.status === "ENROLLED" || e.status === "WAITLIST") && (!starts || starts.getTime() - now.getTime() >= lead);
    return { link, view: { ...base, kind: "enrollment", firstName: e.name.split(/\s+/)[0] ?? "", what: e.attendee ? `${e.shopClass.title} for ${e.attendee}` : e.shopClass.title, when: starts ? fmtWhen(starts, shop.timeZone) : null, where: e.shopClass.location, feeCents: e.feeCents, status: e.status, startsAt: starts, canCancel: changeable, canMove: false, typeId: null, refId: e.id } };
  }
  return null;
}

/** The customer cancels their own booking (until the lead time); queued reminders and notices for it are cancelled too. */
export async function cancelByToken(token: string, now = new Date()): Promise<void> {
  const f = await manageByToken(token, now);
  if (!f) throw new UserError("This link has expired. Please call the shop.");
  if (!f.view.canCancel) throw new UserError(`It's too close to the time to cancel online. Please call ${f.view.shop.phone ?? "the shop"}.`);
  await db.$transaction(async (tx) => {
    if (f.view.kind === "appointment") {
      await tx.appointment.updateMany({ where: { id: f.view.refId, shopId: f.view.shopId, status: "BOOKED" }, data: { status: "CANCELLED", cancelledAt: now } });
      await tx.outMessage.updateMany({ where: { shopId: f.view.shopId, refType: "appointment", refId: f.view.refId, status: "QUEUED" }, data: { status: "CANCELLED", error: "The customer cancelled online" } });
    } else {
      await tx.enrollment.updateMany({ where: { id: f.view.refId, shopId: f.view.shopId, status: { in: ["ENROLLED", "WAITLIST"] } }, data: { status: "CANCELLED", cancelledAt: now } });
      await tx.outMessage.updateMany({ where: { shopId: f.view.shopId, refType: "enrollment", refId: f.view.refId, status: "QUEUED" }, data: { status: "CANCELLED", error: "The customer cancelled online" } });
    }
  });
}

/** The customer moves their appointment to another offered time (the same checks as a new booking, not counting itself). */
export async function moveByToken(token: string, startsAt: Date, now = new Date()): Promise<void> {
  const f = await manageByToken(token, now);
  if (!f || f.view.kind !== "appointment" || !f.view.typeId) throw new UserError("This link has expired. Please call the shop.");
  if (!f.view.canMove) throw new UserError(`It's too close to the time to move it online. Please call ${f.view.shop.phone ?? "the shop"}.`);
  const shop = await publicShop(f.view.shop.slug ?? "");
  if (!shop || !shop.open) throw new UserError("Online booking isn't available right now. Please call the shop.");
  const type = await db.appointmentType.findFirst({ where: { id: f.view.typeId, shopId: shop.id, active: true, online: true, needsCert: false } });
  if (!type) throw new UserError("Please call the shop to move it.");
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.getTime())) throw new UserError("Pick a time.");
  const endsAt = new Date(startsAt.getTime() + type.minutes * 60_000);
  if (startsAt.getTime() < now.getTime() + shop.leadHours * HOUR) throw new UserError(`The earliest time we offer online is ${shop.leadHours} hours from now.`);
  if (startsAt.getTime() > now.getTime() + shop.daysAhead * DAY) throw new UserError(`We take online bookings up to ${shop.daysAhead} days ahead.`);
  if (!withinHours(hoursOf(type.hours), startsAt, endsAt, shop.timeZone)) throw new UserError(`${type.name} can be booked ${hoursText(hoursOf(type.hours))}.`);
  await db.$transaction(async (tx) => {
    await lockKeys(tx, [poolKey(shop.id, type)]);
    const taken = await overlapCount(tx, { shopId: shop.id, resource: type.resource, typeId: type.id }, startsAt, endsAt, f.view.refId);
    if (taken >= type.capacity) throw new UserError("That time was just taken. Please pick another.");
    const r = await tx.appointment.updateMany({ where: { id: f.view.refId, shopId: shop.id, status: "BOOKED" }, data: { startsAt, endsAt } });
    if (!r.count) throw new UserError("This booking has changed. Please call the shop.");
    // Reminders queued for the old time go; the scheduler queues the new day's.
    await tx.outMessage.updateMany({ where: { shopId: shop.id, refType: "appointment", refId: f.view.refId, kind: "reminder", status: "QUEUED" }, data: { status: "CANCELLED", error: "The customer moved it online" } });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings → Online booking (owners and admins, Scheduling on)

export type BookingSettings = { slug: string | null; on: boolean; leadHours: number; daysAhead: number; welcome: string | null; types: { id: string; name: string; online: boolean; active: boolean }[]; classes: { id: string; title: string; online: boolean; status: string }[] };

export async function bookingSettings(shopId: string): Promise<BookingSettings> {
  const [shop, types, classes] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { bookingSlug: true, bookingOn: true, bookingLeadHours: true, bookingDaysAhead: true, bookingWelcome: true } }),
    db.appointmentType.findMany({ where: { shopId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, online: true, active: true } }),
    db.shopClass.findMany({ where: { shopId, status: { not: "CANCELLED" }, OR: [{ lastAt: null }, { lastAt: { gte: new Date() } }] }, orderBy: { firstAt: "asc" }, select: { id: true, title: true, online: true, status: true } }),
  ]);
  return { slug: shop.bookingSlug, on: shop.bookingOn, leadHours: shop.bookingLeadHours, daysAhead: shop.bookingDaysAhead, welcome: shop.bookingWelcome, types, classes };
}

/** The settings form: the slug (unique across the install), on / off, lead time, how far ahead, the welcome, and which types and classes are offered. */
export async function saveBookingSettingsFor(user: CurrentUser, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can change this.");
  await requireOn(user, "scheduling");
  const shopId = user.shopId;
  const slugRaw = str(fd.get("slug"));
  const slug = slugRaw ? slugOf(slugRaw) : null;
  const on = fd.get("on") != null && String(fd.get("on")) !== "false";
  if (slug && !SLUG_RE.test(slug)) throw new UserError("The address is 3 to 40 lower-case letters, digits and dashes.");
  if (on && !slug) throw new UserError("Give the booking page an address first, like your-shop-name.");
  if (slug) {
    const taken = await db.shop.findFirst({ where: { bookingSlug: slug, id: { not: shopId } }, select: { id: true } });
    if (taken) throw new UserError(`The address "${slug}" is taken. Pick another.`);
  }
  const lead = Number(str(fd.get("leadHours")) ?? "24");
  if (!Number.isInteger(lead) || lead < 0 || lead > 24 * 14) throw new UserError("Lead time: whole hours from 0 to 336.");
  const ahead = Number(str(fd.get("daysAhead")) ?? "60");
  if (!Number.isInteger(ahead) || ahead < 1 || ahead > 365) throw new UserError("How far ahead: 1 to 365 days.");
  const welcome = str(fd.get("welcome"))?.slice(0, 500) ?? null;
  const typeIds = new Set(fd.getAll("type").map(String));
  const classIds = new Set(fd.getAll("class").map(String));
  await db.$transaction(async (tx) => {
    await tx.shop.update({ where: { id: shopId }, data: { bookingSlug: slug, bookingOn: on, bookingLeadHours: lead, bookingDaysAhead: ahead, bookingWelcome: welcome } });
    const types = await tx.appointmentType.findMany({ where: { shopId }, select: { id: true } });
    for (const t of types) await tx.appointmentType.updateMany({ where: { id: t.id, shopId }, data: { online: typeIds.has(t.id) } });
    const classes = await tx.shopClass.findMany({ where: { shopId }, select: { id: true } });
    for (const c of classes) await tx.shopClass.updateMany({ where: { id: c.id, shopId }, data: { online: classIds.has(c.id) } });
  });
}

/** The booking page's address for a shop, or null without a slug or a public address. */
export function bookingUrl(slug: string | null): string | null {
  const base = publicBaseUrl();
  return slug && base ? `${base}/book/${slug}` : null;
}

/** For the manage page: the type's free times around a booking (the same rule as a new booking). */
export async function freeTimesForMove(f: Found, fromYmd: string | null, now = new Date()): Promise<FreeDay[]> {
  if (f.view.kind !== "appointment" || !f.view.typeId || !f.view.shop.slug) return [];
  const shop = await publicShop(f.view.shop.slug);
  const type = await db.appointmentType.findFirst({ where: { id: f.view.typeId, shopId: f.view.shopId, active: true, online: true, needsCert: false } });
  if (!shop || !type) return [];
  return publicFreeTimes(shop, type, fromYmd ?? addDays(ymdOf(now, shop.timeZone), 0), now);
}
