import "server-only";
// The work behind src/actions/classes.ts (scheduling-messaging-design.md 12.1), callable with a user so the check
// script can drive it. Every function needs Scheduling (requireOn); the admin-only ones say so.
import { Prisma } from "@/generated/prisma/client";
import { choicesFromText, isEventKind } from "@/lib/events-math";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { money, str, toCents } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { moduleOn, requireOn } from "@/lib/module-gate";
import { customerFromForm } from "@/lib/customer-input";
import { classLine, enrollIn, meetingDays, MAX_MEETINGS, REPEATS, seatCounts, syncClassDates, type Repeat } from "@/lib/classes";
import type { BookingDue } from "@/lib/booking-types";
import { lockKeys } from "@/lib/lock";
import { queueToCustomer } from "@/lib/messaging/queue";
import { messagingView } from "@/lib/messaging/settings";
import { cleanText, plainText, renderKind } from "@/lib/messaging/templates";
import { shopTimeZone } from "@/lib/shop-zone";
import { classCreditsFor } from "@/lib/units/units";
import { fmtDay, fmtWhen, rangeFromForm, wall, ymdOf, zonedTime } from "@/lib/zoned";

type Tx = Prisma.TransactionClient;

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

async function ownClass(shopId: string, id: string) {
  const c = await db.shopClass.findFirst({ where: { id: assertId(id), shopId } });
  if (!c) throw new UserError("Class not found.");
  return c;
}
async function ownMeeting(shopId: string, id: string) {
  const m = await db.classMeeting.findFirst({ where: { id: assertId(id), shopId }, include: { shopClass: true } });
  if (!m) throw new UserError("Meeting not found.");
  return m;
}
async function ownEnrollment(shopId: string, id: string) {
  const e = await db.enrollment.findFirst({ where: { id: assertId(id), shopId }, include: { shopClass: true } });
  if (!e) throw new UserError("Sign-up not found.");
  return e;
}

// Wall-clock helpers for meeting rows: the repeat keeps 6:00 pm on every date, across a DST change.
const minutesOf = (d: Date, tz: string) => {
  const w = wall(d, tz);
  return w.hour * 60 + w.minute;
};
const zoned = (ymd: string, minutes: number, tz: string) => zonedTime(ymd, minutes, tz);

const limited = (v: string | null, max: number, what: string): string | null => {
  const t = v?.trim() ?? "";
  if (t.length > max) throw new UserError(`${what} is too long (${max} characters at most).`);
  return t || null;
};

/** The `tell` box was ticked: a notice goes through the queue (Marketing must be on; otherwise the box isn't shown). */
async function tellCustomer(tx: Tx, user: CurrentUser, a: { customerId: string | null; subject: string; body: string; dedupeKey: string; notAfter?: Date | null; vars?: Record<string, string>; kind?: "class_notice" }) {
  if (!a.customerId) return;
  if (!(await moduleOn(user.shopId, "marketing"))) throw new UserError("Messages are off: Marketing isn't on. Untick 'tell them' and call them instead.");
  await queueToCustomer(tx, {
    shopId: user.shopId,
    customerId: a.customerId,
    kind: a.kind ?? "class_notice",
    channels: "preferred",
    content: (ch) => (ch === "email" ? { subject: a.subject, body: a.body } : { body: plainText(a.body).text }),
    dedupeKey: a.dedupeKey,
    notAfter: a.notAfter ?? null,
    refType: "class",
    byUserId: user.id,
  });
}

/** The class_signup wording for a sign-up (design 5): what / when / location / supplies / fee. */
async function signupVars(shopId: string, c: { title: string; firstAt: Date | null; location: string | null; supplies: string | null }, e: { feeCents: number; attendee: string | null }, tz: string) {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true } });
  return {
    shop_name: shop.name,
    shop_phone: shop.phone ?? "",
    what: e.attendee ? `${c.title} for ${e.attendee}` : c.title,
    when: c.firstAt ? fmtWhen(c.firstAt, tz) : "a date to be announced",
    location_line: c.location ? ` At ${c.location}.` : "",
    supplies_line: c.supplies ? `\n\nBring: ${c.supplies}` : "",
    fee_line: e.feeCents > 0 ? ` Fee: ${money(e.feeCents)}, paid at the counter.` : "",
  };
}

function repeatFrom(fd: FormData): { repeat: Repeat; count: number } {
  const repeat = (str(fd.get("repeat")) ?? "once") as Repeat;
  if (!REPEATS.includes(repeat)) throw new UserError("Pick how often it meets.");
  if (repeat === "once") return { repeat, count: 1 };
  const count = Number(str(fd.get("count")) ?? "");
  const max = repeat === "weekly" || repeat === "biweekly" ? 52 : 24;
  if (!Number.isInteger(count) || count < 1 || count > max) throw new UserError(`How many times: 1 to ${max}.`);
  return { repeat, count };
}

/** The class's fields from the form, checked. */
function classFields(fd: FormData) {
  const title = str(fd.get("title"))?.trim() ?? "";
  if (!title || title.length > 120) throw new UserError("Give the class a name.");
  const fee = toCents(fd.get("fee") ?? "0");
  if (fee == null || fee < 0 || fee > 10_000_000) throw new UserError("Check the fee.");
  const seats = Number(str(fd.get("seats")) ?? "");
  if (!Number.isInteger(seats) || seats < 1 || seats > 500) throw new UserError("Seats must be 1 to 500.");
  const remind = str(fd.get("remind")) ?? "every";
  if (!["every", "first", "never"].includes(remind)) throw new UserError("Pick when to remind people.");
  return {
    title,
    teacher: limited(str(fd.get("teacher")), 80, "The teacher's name"),
    location: limited(str(fd.get("location")), 120, "The location"),
    description: limited(str(fd.get("description")), 4000, "The description"),
    supplies: limited(str(fd.get("supplies")), 4000, "The supply list"),
    feeCents: fee,
    taxable: fd.get("taxable") === "on",
    seats,
    // The form sends a hidden "off" before the checkbox's "on" (the first value alone would always read off); a form
    // without the field at all means on.
    waitlist: checkbox(fd, "waitlist"),
    remind,
    ...eventFields(fd),
  };
}

/**
 * An event's fields (shop-features-round-2-design.md 4.5), when the form has them: the kind, the early-bird price and
 * its last day, the deposit (refundable or not) and the days before the first day the balance is due, the rooms and
 * meals with their prices, the dietary question, the door price. A form without "kind" leaves them as they are.
 */
function eventFields(fd: FormData) {
  if (!fd.has("kind")) return {};
  const kind = str(fd.get("kind")) ?? "CLASS";
  if (!isEventKind(kind)) throw new UserError("Pick what it is: a class, a retreat or an event.");
  if (kind === "CLASS") return { kind, earlyCents: null, earlyUntil: null, depositCents: null, doorCents: null, choices: Prisma.DbNull };
  const money = (k: string, what: string) => {
    const raw = str(fd.get(k));
    if (!raw) return null;
    const c = toCents(raw);
    if (c == null || c < 0 || c > 10_000_000) throw new UserError(`Check the ${what}.`);
    return c;
  };
  const earlyCents = money("earlyFee", "early-bird price");
  const earlyUntil = str(fd.get("earlyUntil"));
  if (earlyCents != null && !/^\d{4}-\d{2}-\d{2}$/.test(earlyUntil ?? "")) throw new UserError("Pick the last day of the early-bird price.");
  const depositCents = money("deposit", "deposit");
  const days = Number(str(fd.get("balanceDays")) ?? "60");
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new UserError("The balance is due 0 to 365 days before the first day.");
  let choices;
  try {
    choices = choicesFromText({ rooms: str(fd.get("rooms")), meals: str(fd.get("meals")), dietary: fd.get("askDietary") === "on" });
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : "Check the choices.");
  }
  return {
    kind,
    earlyCents,
    earlyUntil: earlyCents != null ? earlyUntil : null,
    depositCents: depositCents || null,
    depositRefundable: fd.get("depositRefundable") === "on",
    balanceDays: days,
    doorCents: money("doorFee", "door price"),
    choices: choices.list.length || choices.dietary ? (choices as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
  };
}

/** A new class (with its first meeting and repeats) or the details of one. A fee change never re-prices sign-ups. */
export async function saveClassAs(user: CurrentUser, classId: string | null, fd: FormData) {
  await asAdmin(user);
  const shopId = user.shopId;
  const data = classFields(fd);
  if (classId) {
    const c = await ownClass(shopId, classId);
    await db.$transaction(async (tx) => {
      await lockKeys(tx, [`class:${c.id}`]);
      const enrolled = await tx.enrollment.count({ where: { classId: c.id, status: "ENROLLED" } });
      if (data.seats < enrolled) throw new UserError(`${enrolled} people are signed up. Keep at least ${enrolled} seats.`);
      await tx.shopClass.updateMany({ where: { id: c.id, shopId }, data });
    });
    return c.id;
  }
  const tz = await shopTimeZone(shopId);
  const { startsAt, endsAt } = rangeFromForm(fd, tz);
  const { repeat, count } = repeatFrom(fd);
  const days = meetingDays(ymdOf(startsAt, tz), repeat, count);
  const startMin = minutesOf(startsAt, tz);
  const endMin = minutesOf(endsAt, tz);
  const made = await db.$transaction(async (tx) => {
    const c = await tx.shopClass.create({ data: { shopId, ...data, createdById: user.id }, select: { id: true } });
    await tx.classMeeting.createMany({ data: days.map((d) => ({ shopId, classId: c.id, startsAt: zoned(d, startMin, tz), endsAt: zoned(d, endMin, tz) })) });
    await syncClassDates(tx, c.id);
    return c;
  });
  return made.id;
}


/** More meetings for a class (the same date/start/end/repeat fields as a new class). */
export async function addMeetingsAs(user: CurrentUser, classId: string, fd: FormData) {
  await asAdmin(user);
  const c = await ownClass(user.shopId, classId);
  const tz = await shopTimeZone(user.shopId);
  const { startsAt, endsAt } = rangeFromForm(fd, tz);
  const { repeat, count } = repeatFrom(fd);
  const days = meetingDays(ymdOf(startsAt, tz), repeat, count);
  const startMin = minutesOf(startsAt, tz);
  const endMin = minutesOf(endsAt, tz);
  await db.$transaction(async (tx) => {
    const have = await tx.classMeeting.count({ where: { classId: c.id } });
    if (have + days.length > MAX_MEETINGS) throw new UserError(`That's more than ${MAX_MEETINGS} meetings.`);
    await tx.classMeeting.createMany({ data: days.map((d) => ({ shopId: user.shopId, classId: c.id, startsAt: zoned(d, startMin, tz), endsAt: zoned(d, endMin, tz) })) });
    await syncClassDates(tx, c.id);
  });
}

/** A meeting's new time; `tell` sends "the meeting on {old day} is now {new when}". */
export async function saveMeetingAs(user: CurrentUser, meetingId: string, fd: FormData) {
  await asAdmin(user);
  const m = await ownMeeting(user.shopId, meetingId);
  const tz = await shopTimeZone(user.shopId);
  const { startsAt, endsAt } = rangeFromForm(fd, tz);
  const oldDay = fmtDay(m.startsAt, tz);
  await db.$transaction(async (tx) => {
    await tx.classMeeting.updateMany({ where: { id: m.id, shopId: user.shopId }, data: { startsAt, endsAt, note: limited(str(fd.get("note")), 500, "The note") } });
    await syncClassDates(tx, m.classId);
    if (fd.get("tell") === "on") {
      const people = await tx.enrollment.findMany({ where: { classId: m.classId, status: "ENROLLED", customerId: { not: null } }, select: { id: true, customerId: true } });
      for (const p of people) {
        await tellCustomer(tx, user, { customerId: p.customerId, subject: `${m.shopClass.title}: a time change`, body: `${m.shopClass.title}: the meeting on ${oldDay} is now ${fmtWhen(startsAt, tz)}.`, dedupeKey: `class:${m.classId}:moved:${m.id}:${startsAt.getTime()}:${p.id}`, notAfter: endsAt });
      }
    }
  });
  return m.classId;
}

/** A meeting is cancelled (kept, marked); `tell` sends the news with the note. */
export async function cancelMeetingAs(user: CurrentUser, meetingId: string, fd: FormData) {
  await asAdmin(user);
  const m = await ownMeeting(user.shopId, meetingId);
  const tz = await shopTimeZone(user.shopId);
  const note = limited(str(fd.get("note")), 500, "The note");
  await db.$transaction(async (tx) => {
    await tx.classMeeting.updateMany({ where: { id: m.id, shopId: user.shopId }, data: { cancelled: true, note } });
    await syncClassDates(tx, m.classId);
    if (fd.get("tell") === "on") {
      const people = await tx.enrollment.findMany({ where: { classId: m.classId, status: "ENROLLED", customerId: { not: null } }, select: { id: true, customerId: true } });
      for (const p of people) {
        await tellCustomer(tx, user, { customerId: p.customerId, subject: `${m.shopClass.title}: ${fmtDay(m.startsAt, tz)} is cancelled`, body: `${m.shopClass.title} on ${fmtWhen(m.startsAt, tz)} is cancelled.${note ? ` ${note}` : ""}`, dedupeKey: `class:${m.classId}:cancelled:${m.id}:${p.id}` });
      }
    }
  });
  return m.classId;
}

/** A meeting nobody has signed up for can simply go. */
export async function deleteMeetingAs(user: CurrentUser, meetingId: string) {
  await asAdmin(user);
  const m = await ownMeeting(user.shopId, meetingId);
  const signed = await db.enrollment.count({ where: { classId: m.classId, status: { in: ["ENROLLED", "WAITLIST"] } } });
  if (signed) throw new UserError("People are signed up. Cancel the meeting instead.");
  await db.$transaction(async (tx) => {
    await tx.classMeeting.deleteMany({ where: { id: m.id, shopId: user.shopId } });
    await syncClassDates(tx, m.classId);
  });
  return m.classId;
}

/** OPEN / CLOSED / CANCELLED; cancelling also cancels the meetings still to come, and `tell` says so to everyone. */
export async function setClassStatusAs(user: CurrentUser, classId: string, status: string, fd: FormData) {
  await asAdmin(user);
  const c = await ownClass(user.shopId, classId);
  if (status !== "OPEN" && status !== "CLOSED" && status !== "CANCELLED") throw new UserError("Unknown status.");
  const tz = await shopTimeZone(user.shopId);
  const now = new Date();
  await db.$transaction(async (tx) => {
    await lockKeys(tx, [`class:${c.id}`]);
    await tx.shopClass.updateMany({ where: { id: c.id, shopId: user.shopId }, data: { status } });
    if (status === "CANCELLED") {
      await tx.classMeeting.updateMany({ where: { classId: c.id, startsAt: { gte: now }, cancelled: false }, data: { cancelled: true, note: "Class cancelled" } });
      await syncClassDates(tx, c.id);
      if (fd.get("tell") === "on") {
        const people = await tx.enrollment.findMany({ where: { classId: c.id, status: { in: ["ENROLLED", "WAITLIST"] }, customerId: { not: null } }, select: { id: true, customerId: true } });
        for (const p of people) {
          await tellCustomer(tx, user, { customerId: p.customerId, subject: `${c.title} is cancelled`, body: `${c.title}${c.firstAt ? `, starting ${fmtWhen(c.firstAt, tz)},` : ""} is cancelled. We're sorry. Anything paid is refunded at the counter.`, dedupeKey: `class:${c.id}:classcancelled:${p.id}` });
        }
      }
    }
  });
}

/** A class nobody ever signed up for can go; otherwise cancel it (the record stays). */
export async function deleteClassAs(user: CurrentUser, classId: string) {
  await asAdmin(user);
  const c = await ownClass(user.shopId, classId);
  if (await db.enrollment.count({ where: { classId: c.id } })) throw new UserError("People signed up for this class. Cancel it instead; the record stays.");
  await db.shopClass.deleteMany({ where: { id: c.id, shopId: user.shopId } });
}

/** Sign someone up (the class page, the customer page). Anyone at the counter. */
export async function enrollAs(user: CurrentUser, classId: string, fd: FormData) {
  await asUser(user);
  const shopId = user.shopId;
  const c = await ownClass(shopId, classId);
  const attendee = limited(str(fd.get("attendee")), 80, "Who's coming");
  const skipWaitlist = fd.get("skipWaitlist") === "on" && user.role !== "TECH";
  const tell = fd.get("tell") === "on";
  const tz = await shopTimeZone(shopId);
  const ms = await messagingView(shopId);
  const customerId = await db.$transaction(async (tx) => {
    const customer = await customerFromForm(tx, shopId, fd, user.id, "counter", "", { notifyRequired: tell });
    const e = await enrollIn(tx, { shopId, classId: c.id, customer, attendee, byUserId: user.id, skipWaitlist, choices: { room: str(fd.get("choice_room")), meals: str(fd.get("choice_meals")), dietary: str(fd.get("dietary")) } });
    if (tell && e.status === "ENROLLED") {
      const vars = await signupVars(shopId, c, e, tz);
      const content = (ch: "email" | "sms") => renderKind(ms, "class_signup", ch, vars);
      if (!(await moduleOn(shopId, "marketing"))) throw new UserError("Messages are off: Marketing isn't on. Untick 'tell them' and call them instead.");
      await queueToCustomer(tx, { shopId, customerId: customer.id, kind: "class_notice", channels: "preferred", content, dedupeKey: `class:${c.id}:signup:${e.id}`, notAfter: c.lastAt, refType: "enrollment", refId: e.id, byUserId: user.id, ms });
    } else if (tell && e.status === "WAITLIST") {
      await tellCustomer(tx, user, { customerId: customer.id, subject: `${c.title}: you're on the waiting list`, body: `You're on the waiting list for ${c.title}${c.firstAt ? `, starting ${fmtWhen(c.firstAt, tz)}` : ""}. We'll tell you if a seat opens up.`, dedupeKey: `class:${c.id}:waitlist:${e.id}`, notAfter: c.lastAt });
    }
    return customer.id;
  });
  return customerId;
}

/** A sign-up is cancelled; a paid one still is (the roster then says to refund it at the register). */
export async function cancelEnrollmentAs(user: CurrentUser, enrollmentId: string, fd: FormData) {
  await asUser(user);
  const e = await ownEnrollment(user.shopId, enrollmentId);
  if (e.status === "CANCELLED") throw new UserError("Already cancelled.");
  await db.enrollment.updateMany({ where: { id: e.id, shopId: user.shopId }, data: { status: "CANCELLED", cancelledAt: new Date(), note: limited(str(fd.get("note")), 500, "The note") } });
  return { classId: e.classId, customerId: e.customerId };
}

/** Someone waiting takes a seat; `tell` sends the good news. */
export async function moveUpAs(user: CurrentUser, enrollmentId: string, fd: FormData) {
  await asUser(user);
  const e = await ownEnrollment(user.shopId, enrollmentId);
  if (e.status !== "WAITLIST") throw new UserError("They aren't on the waiting list.");
  const tz = await shopTimeZone(user.shopId);
  await db.$transaction(async (tx) => {
    await lockKeys(tx, [`class:${e.classId}`]);
    const enrolled = await tx.enrollment.count({ where: { classId: e.classId, status: "ENROLLED" } });
    if (enrolled >= e.shopClass.seats) throw new UserError("The class is full. Add a seat or cancel someone first.");
    await tx.enrollment.updateMany({ where: { id: e.id, shopId: user.shopId, status: "WAITLIST" }, data: { status: "ENROLLED" } });
    if (fd.get("tell") === "on") {
      await tellCustomer(tx, user, { customerId: e.customerId, subject: `A seat opened up in ${e.shopClass.title}`, body: `Good news: a seat opened up for you in ${e.shopClass.title}${e.shopClass.firstAt ? `, starting ${fmtWhen(e.shopClass.firstAt, tz)}` : ""}.`, dedupeKey: `class:${e.classId}:moveup:${e.id}`, notAfter: e.shopClass.lastAt });
    }
  });
  return { classId: e.classId, customerId: e.customerId };
}

/** "Price for this person", before it's paid. */
export async function setEnrollmentFeeAs(user: CurrentUser, enrollmentId: string, fd: FormData) {
  await asAdmin(user);
  const e = await ownEnrollment(user.shopId, enrollmentId);
  if (e.paidAt) throw new UserError("It's already paid. Refund and ring it up again.");
  const fee = toCents(fd.get("fee"));
  if (fee == null || fee < 0 || fee > 10_000_000) throw new UserError("Check the fee.");
  await db.enrollment.updateMany({ where: { id: e.id, shopId: user.shopId }, data: { feeCents: fee } });
  return { classId: e.classId, customerId: e.customerId };
}

/**
 * An owner's class that came with a machine bought here (tax-machine-sales-layaway-design.md section 3): the seat is
 * free, counted against that machine's classes. `unitId` null puts the class's price back. Anyone at the counter: the
 * shop promised the classes when it sold the machine.
 */
export async function applyClassCreditAs(user: CurrentUser, enrollmentId: string, unitId: string | null) {
  await asUser(user);
  const e = await ownEnrollment(user.shopId, enrollmentId);
  if (e.paidAt) throw new UserError("It's already paid. Refund it at the register first.");
  if (e.status === "CANCELLED") throw new UserError("That sign-up was cancelled.");
  if (!unitId) {
    if (e.creditUnitId) await db.enrollment.updateMany({ where: { id: e.id, shopId: user.shopId, paidAt: null }, data: { creditUnitId: null, feeCents: e.shopClass.feeCents } });
    return { classId: e.classId, customerId: e.customerId };
  }
  if (e.creditUnitId) throw new UserError("This seat already uses an owner's class.");
  if (!e.customerId) throw new UserError("Pick the customer first.");
  const left = (await classCreditsFor(user.shopId, e.customerId)).find((c) => c.unitId === unitId);
  if (!left || left.left <= 0) throw new UserError("No owner's classes left for that machine.");
  await db.$transaction(async (tx) => {
    // Two clicks at once must not use the same last class twice.
    await lockKeys(tx, [`credit:${unitId}`]);
    const used = await tx.enrollment.count({ where: { shopId: user.shopId, creditUnitId: unitId, status: { not: "CANCELLED" } } });
    if (used >= left.granted) throw new UserError("No owner's classes left for that machine.");
    await tx.enrollment.updateMany({ where: { id: e.id, shopId: user.shopId, paidAt: null, creditUnitId: null }, data: { creditUnitId: unitId, feeCents: 0 } });
  });
  return { classId: e.classId, customerId: e.customerId };
}

/** "Message everyone": a note about this class to everyone signed up (and the waiting list when ticked). Needs Marketing. */
export async function messageClassAs(user: CurrentUser, classId: string, fd: FormData) {
  await asAdmin(user);
  await requireOn(user, "marketing");
  const shopId = user.shopId;
  const c = await ownClass(shopId, classId);
  if (fd.get("onlyAboutClass") !== "on") throw new UserError("Tick the box to confirm it's only about this class. Promotions go in Campaigns.");
  const body = cleanText(str(fd.get("body")) ?? "", 2000);
  if (!body) throw new UserError("Write the message.");
  const subject = cleanText(str(fd.get("subject")) ?? "", 150) || `${c.title}: a note from us`;
  const waitlist = fd.get("waitlist") === "on";
  const now = new Date();
  const rows = await db.enrollment.findMany({ where: { shopId, classId: c.id, status: { in: waitlist ? ["ENROLLED", "WAITLIST"] : ["ENROLLED"] }, customerId: { not: null } }, select: { id: true, customerId: true } });
  // One message per person, however many of their family are signed up.
  const people = [...new Map(rows.map((r) => [r.customerId!, r])).values()];
  if (!people.length) throw new UserError("Nobody is signed up.");
  let queued = 0;
  const skipped: string[] = [];
  const ms = await messagingView(shopId);
  const names = new Map((await db.customer.findMany({ where: { shopId, id: { in: people.map((p) => p.customerId!) } }, select: { id: true, name: true } })).map((k) => [k.id, k.name]));
  await db.$transaction(async (tx) => {
    for (const p of people) {
      const r = await queueToCustomer(tx, {
        shopId,
        customerId: p.customerId!,
        kind: "class_notice",
        channels: "preferred",
        content: (ch) => (ch === "email" ? { subject, body } : { body: plainText(body).text }),
        dedupeKey: `class:${c.id}:${now.getTime()}:${p.id}`,
        notAfter: c.lastAt,
        refType: "class",
        refId: c.id,
        byUserId: user.id,
        ms,
      });
      if (r.queued.length) queued += 1;
      else skipped.push(`${names.get(p.customerId!) ?? "someone"} (${r.skipped[0]?.reason === "staff_cap" ? "already 3 messages today" : "can't be messaged"})`);
    }
  });
  if (!queued) throw new UserError(`Nothing went out: ${skipped.join(", ")}.`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The register (src/actions/class-register.ts)

/** OPEN classes not yet over, with seats left, soonest first (30 at most). [] without Scheduling. */
export async function openClassSeatsFor(shopId: string, now = new Date()): Promise<{ id: string; title: string; firstAt: Date | null; seatsLeft: number; feeCents: number }[]> {
  if (!(await moduleOn(shopId, "scheduling"))) return [];
  const classes = await db.shopClass.findMany({
    where: { shopId, status: "OPEN", OR: [{ lastAt: null }, { lastAt: { gte: now } }] },
    select: { id: true, title: true, firstAt: true, seats: true, feeCents: true },
    orderBy: [{ firstAt: "asc" }, { createdAt: "asc" }],
    take: 60,
  });
  const counts = await seatCounts(db, classes.map((c) => c.id));
  return classes
    .map((c) => ({ id: c.id, title: c.title, firstAt: c.firstAt, seatsLeft: c.seats - (counts.get(c.id)?.enrolled ?? 0), feeCents: c.feeCents }))
    .filter((c) => c.seatsLeft > 0)
    .slice(0, 30);
}

/** A sign-up from the register (never waitlisted there); the new seat comes back as the line to ring up. */
export async function enrollAtRegisterAs(user: CurrentUser, classId: string, fd: FormData): Promise<BookingDue> {
  await asUser(user);
  const shopId = user.shopId;
  const c = await ownClass(shopId, classId);
  const tz = await shopTimeZone(shopId);
  const e = await db.$transaction(async (tx) => {
    const customer = await customerFromForm(tx, shopId, fd, user.id, "counter");
    const row = await enrollIn(tx, { shopId, classId: c.id, customer, attendee: str(fd.get("attendee")), byUserId: user.id, skipWaitlist: false });
    if (row.status !== "ENROLLED") throw new UserError("The class is full.");
    return { ...row, customerName: customer.name };
  });
  return { kind: "enrollment", id: e.id, description: classLine(c, tz), dueCents: e.feeCents, taxable: e.taxable, customerId: e.customerId, customerName: e.customerName, startsAt: c.firstAt ?? new Date() };
}
