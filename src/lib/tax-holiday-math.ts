// Sales tax holidays (tax-machine-sales-layaway-design.md section 1), the same in the register (while ringing up) and
// on the server (when the sale is saved). Pure: no database. Days are YYYY-MM-DD in the shop's zone; money in cents.
import { roundCents } from "@/lib/register-math";

/** What a holiday can cover: the categories register lines are reported under (src/lib/sale-kind.ts). */
export const HOLIDAY_KINDS: { key: string; label: string }[] = [
  { key: "FABRIC", label: "Fabric" },
  { key: "NOTION", label: "Notions" },
  { key: "THREAD", label: "Thread" },
  { key: "PATTERN", label: "Patterns and books" },
  { key: "ACCESSORY", label: "Accessories" },
  { key: "SUPPLY", label: "Supplies" },
  { key: "PART", label: "Parts" },
  { key: "UNIT", label: "Machines for sale" },
  { key: "MISC", label: "Other items" },
  { key: "CLASS", label: "Classes" },
  { key: "APPOINTMENT", label: "Appointments and services" },
  { key: "SERVICE_PLAN", label: "Service plans" },
];

/** Things you can hold: every kind but classes, appointments and service plans (left out unless the shop ticks them). */
export const GOODS_KINDS = HOLIDAY_KINDS.map((k) => k.key).filter((k) => !["CLASS", "APPOINTMENT", "SERVICE_PLAN"].includes(k));

export type Holiday = { id: string; name: string; kinds: string[]; maxUnitCents: number | null; firstDay: string; lastDay: string };

export type HolidayPreset = { key: string; state: string; name: string; kinds: string[]; maxUnitCents: number | null; month: number; datesFor: (year: number) => { firstDay: string; lastDay: string }; note: string };

const pad = (n: number) => String(n).padStart(2, "0");

/** The second Saturday of August and the Sunday after: Massachusetts' usual weekend (set by law each year). */
function secondAugustWeekend(year: number) {
  const first = new Date(Date.UTC(year, 7, 1)).getUTCDay();
  const sat = 1 + ((6 - first + 7) % 7) + 7;
  return { firstDay: `${year}-08-${pad(sat)}`, lastDay: `${year}-08-${pad(sat + 1)}` };
}

/** States we know (owner's answer 6: Massachusetts first). The shop confirms the dates each year. */
export const HOLIDAY_PRESETS: HolidayPreset[] = [
  {
    key: "MA",
    state: "Massachusetts",
    name: "Massachusetts sales tax holiday",
    kinds: GOODS_KINDS,
    maxUnitCents: 250_000,
    month: 8,
    datesFor: (year) => (year === 2026 ? { firstDay: "2026-08-08", lastDay: "2026-08-09" } : secondAugustWeekend(year)),
    note: "Most items for personal use, $2,500 or less each (a dearer item is taxed in full). Every Massachusetts seller takes part. The dates are set by law each year: check mass.gov.",
  },
];
export const presetByKey = (key: string | null | undefined) => HOLIDAY_PRESETS.find((p) => p.key === key) ?? null;

/**
 * The stores in a preset's state, by their address ("Boston, MA 02110" or "... Massachusetts"); every store when no
 * address says the state (the owner ticks them on the form).
 */
export function storesInState<S extends { id: string; address: string | null }>(stores: S[], preset: Pick<HolidayPreset, "key" | "state">): S[] {
  const re = new RegExp(`(^|[^A-Za-z])(${preset.key}|${preset.state})([^A-Za-z]|$)`);
  const hit = stores.filter((s) => s.address && re.test(s.address));
  return hit.length ? hit : stores;
}

/** The holiday in force on `ymd`, if any (the first found). */
export const holidayOn = (holidays: Holiday[], ymd: string) => holidays.find((h) => h.firstDay <= ymd && ymd <= h.lastDay) ?? null;

type HolidayLine = { kind: string | null | undefined; qty: number; unitPriceCents: number; discountCents?: number; taxable: boolean };

/**
 * Does the holiday take the tax off this line? A taxable line of a covered kind whose price each, after its own
 * discount, is at or under the limit (over it: taxed in full, the rule Massachusetts and most states use).
 */
export function holidayCovers(h: Pick<Holiday, "kinds" | "maxUnitCents">, l: HolidayLine): boolean {
  if (!l.taxable || !l.qty || !h.kinds.includes(l.kind ?? "MISC")) return false;
  if (h.maxUnitCents == null) return true;
  const net = Math.abs(roundCents(l.qty * l.unitPriceCents)) - (l.discountCents ?? 0);
  return net / Math.abs(l.qty) <= h.maxUnitCents;
}

/** "Aug 8 to 9, 2026" / "Aug 30 to Sep 2, 2026" for a holiday's days. */
export function holidayDays(h: { firstDay: string; lastDay: string }): string {
  const f = (ymd: string, o: Intl.DateTimeFormatOptions) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...o });
  if (h.firstDay === h.lastDay) return f(h.firstDay, { month: "short", day: "numeric", year: "numeric" });
  const sameMonth = h.firstDay.slice(0, 7) === h.lastDay.slice(0, 7);
  return `${f(h.firstDay, { month: "short", day: "numeric" })} to ${sameMonth ? f(h.lastDay, { day: "numeric" }) : f(h.lastDay, { month: "short", day: "numeric" })}, ${h.lastDay.slice(0, 4)}`;
}
