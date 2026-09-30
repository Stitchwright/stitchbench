// Days, months and clock times in the shop's own time zone (Shop.timeZone, Settings -> Shop). A hosted install's server
// runs on UTC, so anything that cuts or names a day by the server's clock puts an evening sale on tomorrow. Safe on the
// server and in the browser. Print with fmtDate / fmtDateTime (lib/format.ts); the server reads the zone with
// shopTimeZone (lib/shop-zone.ts).

/** What a company gets until it sets its own. */
export const DEFAULT_TIME_ZONE = "America/New_York";

/** Year, month (1-12) and day of an instant, as the clock on the wall in `timeZone` shows it. */
export function zonedParts(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** The instant a day starts in `timeZone` (month is 0-based and may overflow, like Date). */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string) {
  const guess = new Date(Date.UTC(year, month, day));
  // How far the zone's wall clock is from UTC at that moment, applied twice to settle around a DST change.
  let t = guess.getTime();
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(t));
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    t = guess.getTime() - (wall - t);
  }
  return new Date(t);
}

const ymd = (v: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? "");
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
};
const iso = (p: { year: number; month: number; day: number }) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

/**
 * From..to (whole days, to included) as instants, in the shop's time zone: a day starts at the shop's midnight, not
 * the server's. Defaults: the 1st of this month through today.
 */
export function monthRange(from: string | null | undefined, to: string | null | undefined, timeZone: string) {
  const today = zonedParts(new Date(), timeZone);
  const f = ymd(from) ?? { ...today, day: 1 };
  const t = ymd(to) ?? today;
  const start = zonedMidnight(f.year, f.month - 1, f.day, timeZone);
  const end = zonedMidnight(t.year, t.month - 1, t.day + 1, timeZone); // exclusive
  return { start, end, fromStr: iso(f), toStr: iso(t) };
}

/** When today began in the shop's time zone. */
export function startOfToday(timeZone: string) {
  const t = zonedParts(new Date(), timeZone);
  return zonedMidnight(t.year, t.month - 1, t.day, timeZone);
}

/** When this month began in the shop's time zone; `back` months earlier with back > 0. */
export function startOfMonth(timeZone: string, back = 0) {
  const t = zonedParts(new Date(), timeZone);
  return zonedMidnight(t.year, t.month - 1 - back, 1, timeZone);
}

/** Today's date in the shop's time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string) {
  return dateIn(new Date(), timeZone);
}

/** The calendar date of a moment in the shop's time zone, as YYYY-MM-DD (for CSV rows; toISOString would give the UTC day). */
export function dateIn(d: Date, timeZone: string) {
  return iso(zonedParts(d, timeZone));
}

/** "2026-09-30 21:15" in the shop's time zone, for CSV columns that need the time too. */
export function dateTimeIn(d: Date | null | undefined, timeZone: string) {
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return `${get("year")}-${get("month").padStart(2, "0")}-${get("day").padStart(2, "0")} ${get("hour")}:${get("minute")}`;
}

/** A "YYYY-MM-DD" day printed as "Sep 30, 2026" without passing through an instant (so no zone can shift it). */
export function fmtDay(day: string) {
  const p = ymd(day);
  if (!p) return day;
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

/** Month boundaries for statements, in the shop's time zone: "2026-09" -> [Sep 1, Oct 1). */
export function monthPeriod(month: string | null | undefined, timeZone: string) {
  const now = zonedParts(new Date(), timeZone);
  const m = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  const y = m ? Number(m[1]) : now.year;
  const mo = m ? Number(m[2]) - 1 : now.month - 1;
  const from = zonedMidnight(y, mo, 1, timeZone);
  const to = zonedMidnight(y, mo + 1, 1, timeZone);
  const key = (yy: number, mm: number) => {
    const d = new Date(Date.UTC(yy, mm, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  return { from, to, month: key(y, mo), prev: key(y, mo - 1), next: key(y, mo + 1) };
}

/**
 * The zone this server's clock runs in, when it is a real place (the Windows program on the shop's PC); null for UTC
 * (a hosted server), where the shop has to say where it is.
 */
export function serverTimeZone(): string | null {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && tz.includes("/") && !tz.startsWith("Etc/") ? tz : null;
}
