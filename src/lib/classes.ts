import "server-only";
// Classes and workshops (scheduling-messaging-design.md 12.1): seats, meeting dates, the class's date range, and the one
// way anyone is signed up (enrollIn, under the class lock). The actions in src/actions/classes.ts check who is asking.
import type { Enrollment, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { lockKeys } from "@/lib/lock";
import { addDays, addMonths, fmtWhen, nthWeekdayIn, nthWeekdayOf, ymdOf, ymdParts } from "@/lib/zoned";
import { choicesOf, pickedChoices, priceToday } from "@/lib/events-math";

type Db = Prisma.TransactionClient | typeof db;

export const MAX_MEETINGS = 100;

/** Signed-up and waiting counts per class (cancelled rows don't count). */
export async function seatCounts(tx: Db, classIds: string[]): Promise<Map<string, { enrolled: number; waiting: number }>> {
  const out = new Map<string, { enrolled: number; waiting: number }>();
  if (!classIds.length) return out;
  const rows = await tx.enrollment.groupBy({ by: ["classId", "status"], where: { classId: { in: classIds }, status: { in: ["ENROLLED", "WAITLIST"] } }, _count: { _all: true } });
  for (const id of classIds) out.set(id, { enrolled: 0, waiting: 0 });
  for (const r of rows) {
    const c = out.get(r.classId) ?? { enrolled: 0, waiting: 0 };
    if (r.status === "ENROLLED") c.enrolled += r._count._all;
    else c.waiting += r._count._all;
    out.set(r.classId, c);
  }
  return out;
}

/** firstAt / lastAt follow the meetings that aren't cancelled (null when there are none). */
export async function syncClassDates(tx: Db, classId: string): Promise<void> {
  const agg = await tx.classMeeting.aggregate({ where: { classId, cancelled: false }, _min: { startsAt: true }, _max: { endsAt: true } });
  await tx.shopClass.updateMany({ where: { id: classId }, data: { firstAt: agg._min.startsAt ?? null, lastAt: agg._max.endsAt ?? null } });
}

/** "Class: Beginning Quilting, Tue, Oct 7 at 6:00 pm" (the register's line and the messages' {what}). */
export function classLine(c: { title: string; firstAt: Date | null }, tz: string): string {
  return `Class: ${c.title}${c.firstAt ? `, ${fmtWhen(c.firstAt, tz)}` : ""}`;
}

export type Repeat = "once" | "weekly" | "biweekly" | "monthly_weekday" | "monthly_date";
export const REPEATS: Repeat[] = ["once", "weekly", "biweekly", "monthly_weekday", "monthly_date"];
export const REPEAT_LABEL: Record<Repeat, string> = {
  once: "Once",
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  monthly_weekday: "Monthly on the same weekday (the 3rd Saturday)",
  monthly_date: "Monthly on the same date",
};

/**
 * The meeting days (yyyy-mm-dd) of a repeating class: weekly / biweekly step 7 / 14 days; monthly_weekday keeps the
 * "3rd Saturday" (or the last one); monthly_date keeps the date and skips months without it (Feb 30). Dates only: the
 * wall-clock time is applied per date, so a DST change never moves a 6:00 pm class.
 */
export function meetingDays(firstYmd: string, repeat: Repeat, count: number): string[] {
  const n = Math.max(1, Math.min(MAX_MEETINGS, Math.floor(count)));
  if (repeat === "once") return [firstYmd];
  if (repeat === "weekly" || repeat === "biweekly") {
    const step = repeat === "weekly" ? 7 : 14;
    return Array.from({ length: n }, (_, i) => addDays(firstYmd, i * step));
  }
  const out: string[] = [];
  const { y, m } = ymdParts(firstYmd);
  if (repeat === "monthly_weekday") {
    const { n: nth, weekday, last } = nthWeekdayOf(firstYmd);
    for (let i = 0; out.length < n && i < n * 2 + 12; i++) {
      const t = new Date(Date.UTC(y, m - 1 + i, 1));
      const d = nthWeekdayIn(t.getUTCFullYear(), t.getUTCMonth() + 1, nth, weekday, last);
      if (d) out.push(d);
    }
    return out;
  }
  for (let i = 0; out.length < n && i < n * 2 + 12; i++) {
    const d = addMonths(firstYmd, i);
    if (d) out.push(d);
  }
  return out;
}

/** "Mary Smith" vs "mary smith": the same person. */
const same = (a: string | null, b: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Signs a customer (or their attendee) up, under the class lock: seats free and nobody waiting (or skipWaitlist) ->
 * ENROLLED; else the waiting list when the class has one; else "The class is full." Always a NEW row with the name,
 * attendee, fee and taxable snapshotted.
 */
export async function enrollIn(
  tx: Prisma.TransactionClient,
  a: {
    shopId: string;
    classId: string;
    customer: { id: string; name: string };
    attendee: string | null;
    byUserId: string;
    skipWaitlist: boolean;
    now?: Date;
    /** An event's choices as she picked them (room, meals, dietary); the first of each when missing. */
    choices?: Record<string, string | null | undefined>;
    /** A ticket sold at the door: the event's door price. */
    door?: boolean;
  },
): Promise<Enrollment> {
  const now = a.now ?? new Date();
  await lockKeys(tx, [`class:${a.classId}`]);
  const c = await tx.shopClass.findFirst({ where: { id: a.classId, shopId: a.shopId } });
  if (!c) throw new UserError("Class not found.");
  if (c.status !== "OPEN") throw new UserError("Sign-ups for this class are closed.");
  if (c.lastAt && c.lastAt.getTime() < now.getTime()) throw new UserError("This class is over.");
  const attendee = a.attendee?.trim() ? a.attendee.trim().slice(0, 80) : null;
  const rows = await tx.enrollment.findMany({ where: { shopId: a.shopId, classId: a.classId, status: { in: ["ENROLLED", "WAITLIST"] } }, select: { customerId: true, attendee: true, status: true } });
  const dup = rows.find((r) => r.customerId === a.customer.id && same(r.attendee, attendee));
  if (dup) throw new UserError(`${dup.attendee ?? a.customer.name} is already ${dup.status === "ENROLLED" ? "signed up" : "on the waiting list"}.`);
  const enrolled = rows.filter((r) => r.status === "ENROLLED").length;
  const waiting = rows.filter((r) => r.status === "WAITLIST").length;
  let status: "ENROLLED" | "WAITLIST";
  if (enrolled < c.seats && (waiting === 0 || a.skipWaitlist)) status = "ENROLLED";
  else if (c.waitlist) status = "WAITLIST";
  else throw new UserError("The class is full.");
  // An event (shop-features-round-2-design.md 4.5): the early-bird or door price, and what her choices add.
  let feeCents = c.feeCents;
  let picked: Record<string, string> | null = null;
  if (c.kind !== "CLASS") {
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { timeZone: true } });
    const base = a.door && c.doorCents != null ? c.doorCents : priceToday(c, ymdOf(now, shop.timeZone)).cents;
    const ch = pickedChoices(choicesOf(c.choices), a.choices ?? {});
    feeCents = base + ch.extraCents;
    picked = Object.keys(ch.picked).length ? ch.picked : null;
  }
  return tx.enrollment.create({
    data: {
      shopId: a.shopId,
      classId: a.classId,
      customerId: a.customer.id,
      name: a.customer.name,
      attendee,
      status,
      feeCents,
      taxable: c.taxable,
      createdById: a.byUserId,
      ...(picked ? { choices: picked } : {}),
      ...(a.door ? { checkedInAt: now } : {}),
    },
  });
}

/** The next meeting of each class from `now` (not cancelled), for lists. */
export async function nextMeetings(tx: Db, classIds: string[], now: Date): Promise<Map<string, { startsAt: Date; endsAt: Date }>> {
  const out = new Map<string, { startsAt: Date; endsAt: Date }>();
  if (!classIds.length) return out;
  const rows = await tx.classMeeting.findMany({ where: { classId: { in: classIds }, cancelled: false, endsAt: { gte: now } }, orderBy: { startsAt: "asc" }, select: { classId: true, startsAt: true, endsAt: true } });
  for (const r of rows) if (!out.has(r.classId)) out.set(r.classId, { startsAt: r.startsAt, endsAt: r.endsAt });
  return out;
}
