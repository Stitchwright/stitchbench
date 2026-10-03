// Shop-time helpers for scheduling and messages (scheduling-messaging-design.md section 4.1). Pure, safe in the
// browser: an independent copy of the wall-clock logic in partners.ts / time-zone.ts, so client code can use it too.
import { UserError } from "@/lib/user-error";

export type Wall = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }; // month 1-12, weekday 0 = Sunday

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
    fmtCache.set(tz, f);
  }
  return f;
}
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall clock in `tz` at instant `d`. */
export function wall(d: Date, tz: string): Wall {
  const parts = fmt(tz).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const n = (t: string) => Number(get(t));
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour") % 24, minute: n("minute"), weekday: WEEKDAYS.indexOf(get("weekday")) };
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymdText = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** "2026-10-07" for an instant in `tz`. */
export function ymdOf(d: Date, tz: string): string {
  const w = wall(d, tz);
  return ymdText(w.year, w.month, w.day);
}

/** A real "YYYY-MM-DD", or null. */
export function parseYmd(s: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? m[0] : null;
}

/** "18:30" -> 1110 (minutes after midnight), or null. Also accepts "6:30 pm". */
export function parseHm(s: string | null | undefined): number | null {
  const t = String(s ?? "").trim().toLowerCase();
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 1110 -> "18:30". */
export function hmOf(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** The year, month and day of a yyyy-mm-dd string. */
export function ymdParts(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}

/** The instant at which the wall clock in `tz` reads `ymd` at `minutes` past midnight; a time skipped by DST moves forward. */
export function zonedTime(ymd: string, minutes: number, tz: string): Date {
  const { y, m, d } = ymdParts(ymd);
  const wantHour = Math.floor(minutes / 60);
  const wantMin = minutes % 60;
  // Start from the UTC guess and correct by the zone's offset, twice (settles around a DST change).
  const guess = Date.UTC(y, m - 1, d, wantHour, wantMin);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const w = wall(new Date(t), tz);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    t = guess - (asUtc - t);
  }
  // A skipped time (spring forward): the wall clock reads later than asked; move forward to the next existing minute.
  const w = wall(new Date(t), tz);
  if (w.hour * 60 + w.minute !== minutes || w.day !== d) {
    // Try the hour after: during the gap the clock jumps an hour, so asking for the time an hour later and subtracting 60 min isn't right;
    // instead walk forward minute by minute from the guess until the wall clock is at or past the asked time on that day.
    let s = t - 2 * 3_600_000;
    for (let i = 0; i < 300; i++) {
      const ww = wall(new Date(s), tz);
      const sameDay = ymdText(ww.year, ww.month, ww.day) === ymd;
      if (sameDay && ww.hour * 60 + ww.minute >= minutes) return new Date(s);
      if (ymdText(ww.year, ww.month, ww.day) > ymd) return new Date(s);
      s += 60_000;
    }
  }
  return new Date(t);
}

/** When the day starts in `tz`. */
export function dayStart(ymd: string, tz: string): Date {
  return zonedTime(ymd, 0, tz);
}

/** The calendar day n days later (negative n goes back). */
export function addDays(ymd: string, n: number): string {
  const { y, m, d } = ymdParts(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymdText(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** The same date n months later, or null when it doesn't exist (Feb 30). */
export function addMonths(ymd: string, n: number): string | null {
  const { y, m, d } = ymdParts(ymd);
  const t = new Date(Date.UTC(y, m - 1 + n, d));
  if (t.getUTCDate() !== d) return null;
  return ymdText(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Which weekday of the month a date is ("3rd Saturday"); `last` when the next such weekday falls in another month. */
export function nthWeekdayOf(ymd: string): { n: number; weekday: number; last: boolean } {
  const { y, m, d } = ymdParts(ymd);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const n = Math.floor((d - 1) / 7) + 1;
  const last = new Date(Date.UTC(y, m - 1, d + 7)).getUTCMonth() !== m - 1;
  return { n, weekday, last };
}

/** The date of the nth (or last) weekday in a month, or null when that month has no nth one. */
export function nthWeekdayIn(year: number, month: number, n: number, weekday: number, last: boolean): string | null {
  if (last) {
    const end = new Date(Date.UTC(year, month, 0));
    const back = (end.getUTCDay() - weekday + 7) % 7;
    return ymdText(year, month, end.getUTCDate() - back);
  }
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  const t = new Date(Date.UTC(year, month - 1, day));
  return t.getUTCMonth() === month - 1 ? ymdText(year, month, day) : null;
}

/** The Sunday on or before the date. */
export function weekStart(ymd: string): string {
  const { y, m, d } = ymdParts(ymd);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(ymd, -wd);
}

/** Whole calendar months from a to b in `tz` (0 when b is before a). */
export function monthsBetween(a: Date, b: Date, tz: string): number {
  const wa = wall(a, tz);
  const wb = wall(b, tz);
  let n = (wb.year - wa.year) * 12 + (wb.month - wa.month);
  if (wb.day < wa.day || (wb.day === wa.day && wb.hour * 60 + wb.minute < wa.hour * 60 + wa.minute)) n--;
  return Math.max(0, n);
}

/** "Tue, Oct 7" */
export function fmtDay(d: Date, tz: string): string {
  return d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
}

/** "Tue, Oct 7, 2026" (a date that may be months away, or read long after) */
export function fmtDayYear(d: Date, tz: string): string {
  return d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/** "6:00 pm" */
export function fmtTime(d: Date, tz: string): string {
  return d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(/\s?(AM|PM)$/, (_, x: string) => ` ${x.toLowerCase()}`);
}

/** "Tue, Oct 7 at 6:00 pm" */
export function fmtWhen(d: Date, tz: string): string {
  return `${fmtDay(d, tz)} at ${fmtTime(d, tz)}`;
}

/** "Tue, Oct 7, 6:00-8:00 pm" (two dates when it spans days). */
export function fmtRange(a: Date, b: Date, tz: string): string {
  if (ymdOf(a, tz) !== ymdOf(b, tz)) return `${fmtWhen(a, tz)} to ${fmtWhen(b, tz)}`;
  const ta = fmtTime(a, tz);
  const tb = fmtTime(b, tz);
  const sameHalf = ta.slice(-2) === tb.slice(-2);
  return `${fmtDay(a, tz)}, ${sameHalf ? ta.slice(0, -3) : ta}-${tb}`;
}

/** The start and end instants typed into `${p}date`, `${p}start`, `${p}end` (shop wall clock). */
export function rangeFromForm(fd: FormData, tz: string, p = ""): { startsAt: Date; endsAt: Date } {
  const ymd = parseYmd(String(fd.get(`${p}date`) ?? ""));
  if (!ymd) throw new UserError("Pick a date.");
  const start = parseHm(String(fd.get(`${p}start`) ?? ""));
  if (start == null) throw new UserError("Enter a start time like 18:30.");
  const end = parseHm(String(fd.get(`${p}end`) ?? ""));
  if (end == null) throw new UserError("Enter an end time like 20:00.");
  if (end <= start) throw new UserError("The end time must be after the start.");
  if (end - start > 16 * 60) throw new UserError("That's longer than 16 hours. Check the times.");
  return { startsAt: zonedTime(ymd, start, tz), endsAt: zonedTime(ymd, end, tz) };
}
