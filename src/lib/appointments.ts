import "server-only";
// Appointments (scheduling-messaging-design.md 12.2): a type's bookable hours, what counts as "booked then" (capacity
// shared by every type naming the same resource), free start times, and the lock key for a booking.
import type { AppointmentType, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { addDays, dayStart, hmOf, parseHm, wall, ymdOf, zonedTime } from "@/lib/zoned";

type Db = Prisma.TransactionClient | typeof db;

/** One window per weekday (0 = Sunday); a day left out can't be booked (empty = any time). */
export type Hours = { day: number; from: string; to: string }[];

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Seven rows on the form: `day{d}` ticked, `from{d}` and `to{d}` as hh:mm. */
export function hoursFromForm(fd: FormData): Hours {
  const out: Hours = [];
  for (let d = 0; d < 7; d++) {
    if (fd.get(`day${d}`) !== "on") continue;
    const from = parseHm(String(fd.get(`from${d}`) ?? ""));
    const to = parseHm(String(fd.get(`to${d}`) ?? ""));
    if (from == null || to == null) throw new UserError(`${WEEKDAY_NAMES[d]}: enter the opening and closing times like 10:00 and 17:00.`);
    if (to <= from) throw new UserError(`${WEEKDAY_NAMES[d]}: the closing time must be after the opening time.`);
    out.push({ day: d, from: hmOf(from), to: hmOf(to) });
  }
  return out;
}

/** The stored JSON read back; anything odd is "any time". */
export function hoursOf(json: unknown): Hours {
  if (!Array.isArray(json)) return [];
  return json
    .filter((h): h is { day: number; from: string; to: string } => !!h && typeof h === "object" && Number.isInteger((h as { day: unknown }).day) && typeof (h as { from: unknown }).from === "string" && typeof (h as { to: unknown }).to === "string")
    .filter((h) => h.day >= 0 && h.day <= 6 && parseHm(h.from) != null && parseHm(h.to) != null)
    .sort((a, b) => a.day - b.day);
}

/** "Tue-Sat 10:00-17:00", "Mon, Wed 09:00-12:00, Sat 10:00-14:00"; "any time" when empty. */
export function hoursText(h: Hours): string {
  if (!h.length) return "any time";
  // Days with the same window go together; runs of three or more consecutive days read as a range.
  const byWindow = new Map<string, number[]>();
  for (const w of [...h].sort((a, b) => a.day - b.day)) {
    const k = `${w.from}-${w.to}`;
    byWindow.set(k, [...(byWindow.get(k) ?? []), w.day]);
  }
  const dayWords = (days: number[]) => {
    const parts: string[] = [];
    for (let i = 0; i < days.length; ) {
      let j = i;
      while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++;
      parts.push(j - i >= 2 ? `${SHORT[days[i]]}-${SHORT[days[j]]}` : days.slice(i, j + 1).map((d) => SHORT[d]).join(", "));
      i = j + 1;
    }
    return parts.join(", ");
  };
  return [...byWindow.entries()].map(([k, days]) => `${dayWords(days)} ${k}`).join(", ");
}

const minutesOf = (d: Date, tz: string) => {
  const w = wall(d, tz);
  return { minutes: w.hour * 60 + w.minute, weekday: w.weekday, ymd: ymdOf(d, tz) };
};

/** Inside that shop day's window, start to end (no window at all = any time). */
export function withinHours(h: Hours, start: Date, end: Date, tz: string): boolean {
  if (!h.length) return true;
  const s = minutesOf(start, tz);
  const e = minutesOf(end, tz);
  if (s.ymd !== e.ymd) return false;
  const w = h.find((x) => x.day === s.weekday);
  if (!w) return false;
  const from = parseHm(w.from)!;
  const to = parseHm(w.to)!;
  return s.minutes >= from && e.minutes <= to;
}

/** The start times with room on one shop day (every `step` minutes inside the window; 9:00-18:00 when the type has no hours). */
export function freeSlots(t: { minutes: number; capacity: number; hours: Hours }, ymd: string, tz: string, booked: { startsAt: Date; endsAt: Date }[], step = 30): { start: Date; free: number }[] {
  const weekday = wall(dayStart(ymd, tz), tz).weekday;
  const w = t.hours.length ? t.hours.find((x) => x.day === weekday) : { day: weekday, from: "09:00", to: "18:00" };
  if (!w) return [];
  const from = parseHm(w.from)!;
  const to = parseHm(w.to)!;
  const out: { start: Date; free: number }[] = [];
  for (let m = from; m + t.minutes <= to; m += step) {
    const start = zonedTime(ymd, m, tz);
    const end = zonedTime(ymd, m + t.minutes, tz);
    const taken = booked.filter((b) => b.startsAt < end && b.endsAt > start).length;
    if (t.capacity - taken > 0) out.push({ start, free: t.capacity - taken });
  }
  return out;
}

/** The lock key a booking takes: the resource when the type has one (shared with other types), else the type. */
export function poolKey(shopId: string, t: { id: string; resource: string | null }): string {
  return t.resource?.trim() ? `res:${shopId}:${t.resource.trim().toLowerCase()}` : `appt-type:${t.id}`;
}

/** Bookings that overlap [start, end): by staff member, else by resource (any case), else by type. */
export async function overlapCount(tx: Db, w: { shopId: string; resource?: string | null; typeId?: string; staffId?: string }, start: Date, end: Date, exceptId?: string): Promise<number> {
  const base: Prisma.AppointmentWhereInput = { shopId: w.shopId, status: "BOOKED", startsAt: { lt: end }, endsAt: { gt: start }, ...(exceptId ? { id: { not: exceptId } } : {}) };
  if (w.staffId) return tx.appointment.count({ where: { ...base, staffId: w.staffId } });
  if (w.resource?.trim()) return tx.appointment.count({ where: { ...base, resource: { equals: w.resource.trim(), mode: "insensitive" } } });
  return tx.appointment.count({ where: { ...base, typeId: w.typeId ?? "" } });
}

/** The next `days` days' free start times for a type (what the booking form offers as buttons). */
export async function freeWeek(tx: Db, shopId: string, type: AppointmentType, fromYmd: string, tz: string, days = 7): Promise<{ ymd: string; starts: { start: Date; free: number }[] }[]> {
  const from = dayStart(fromYmd, tz);
  const to = dayStart(addDays(fromYmd, days), tz);
  const pool: Prisma.AppointmentWhereInput = type.resource?.trim() ? { resource: { equals: type.resource.trim(), mode: "insensitive" } } : { typeId: type.id };
  const booked = await tx.appointment.findMany({ where: { shopId, status: "BOOKED", startsAt: { lt: to }, endsAt: { gt: from }, ...pool }, select: { startsAt: true, endsAt: true } });
  const hours = hoursOf(type.hours);
  const out: { ymd: string; starts: { start: Date; free: number }[] }[] = [];
  for (let i = 0; i < days; i++) {
    const ymd = addDays(fromYmd, i);
    out.push({ ymd, starts: freeSlots({ minutes: type.minutes, capacity: type.capacity, hours }, ymd, tz, booked) });
  }
  return out;
}
