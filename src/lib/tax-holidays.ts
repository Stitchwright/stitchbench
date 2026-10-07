import "server-only";
// Sales tax holidays (tax-machine-sales-layaway-design.md section 1): the shop's list (Settings → Selling), the ones in
// force on a day (the register, the online shop and a layaway's pick-up apply them by date), and the yearly reminder
// to confirm a preset's dates. Every query by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { centsField } from "@/lib/parts";
import { str } from "@/lib/format";
import { parseYmd } from "@/lib/zoned";
import { HOLIDAY_KINDS, HOLIDAY_PRESETS, presetByKey, type Holiday } from "@/lib/tax-holiday-math";

const SELECT = { id: true, name: true, kinds: true, maxUnitCents: true, firstDay: true, lastDay: true } as const;

export type HolidayRow = Holiday & { preset: string | null; active: boolean; locationIds: string[] };

export async function listHolidays(shopId: string): Promise<HolidayRow[]> {
  return db.taxHoliday.findMany({ where: { shopId }, orderBy: { firstDay: "desc" }, select: { ...SELECT, preset: true, active: true, locationIds: true } });
}

/**
 * The active holidays covering any of these days (a sale's day; a layaway's start too) at this store (null: the main
 * store). A holiday names the stores it covers (stores can be in different states); none named: every store.
 */
export async function holidaysOn(shopId: string, days: string[], storeId: string | null): Promise<Holiday[]> {
  const ds = [...new Set(days.filter(Boolean))];
  if (!ds.length) return [];
  const rows = await db.taxHoliday.findMany({ where: { shopId, active: true, OR: ds.map((d) => ({ firstDay: { lte: d }, lastDay: { gte: d } })) }, select: { ...SELECT, locationIds: true }, orderBy: { firstDay: "asc" } });
  if (!rows.some((h) => h.locationIds.length)) return rows.map(({ locationIds, ...h }) => (void locationIds, h));
  const at = storeId ?? (await db.location.findFirst({ where: { shopId, main: true }, select: { id: true } }))?.id ?? null;
  return rows.filter((h) => !h.locationIds.length || (at != null && h.locationIds.includes(at))).map(({ locationIds, ...h }) => (void locationIds, h));
}

/** Adds (id null) or changes a holiday; owner or admin. */
export async function saveHolidayFor(user: CurrentUser, id: string | null, fd: FormData): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const name = str(fd.get("name"))?.slice(0, 80);
  if (!name) throw new UserError("Name it, e.g. Massachusetts tax-free weekend.");
  const firstDay = parseYmd(str(fd.get("firstDay")));
  const lastDay = parseYmd(str(fd.get("lastDay"))) ?? firstDay;
  if (!firstDay || !lastDay) throw new UserError("Enter the first and last day.");
  if (lastDay < firstDay) throw new UserError("The last day is before the first.");
  if (Number(lastDay.slice(0, 4)) - Number(firstDay.slice(0, 4)) > 1) throw new UserError("A tax holiday is a few days, not years.");
  const known = new Set(HOLIDAY_KINDS.map((k) => k.key));
  const kinds = fd.getAll("kinds").map(String).filter((k) => known.has(k));
  if (!kinds.length) throw new UserError("Tick what it covers.");
  const preset = presetByKey(str(fd.get("preset")))?.key ?? null;
  // The stores it covers (more than one store: the form lists them); every store ticked is saved as "every store".
  let locationIds: string[] = [];
  if (fd.get("storesShown") === "1") {
    const open = (await db.location.findMany({ where: { shopId: user.shopId, active: true }, select: { id: true } })).map((l) => l.id);
    const picked = [...new Set(fd.getAll("stores").map(String))].filter((s) => open.includes(s));
    if (!picked.length) throw new UserError("Tick the stores it covers.");
    locationIds = picked.length === open.length ? [] : picked;
  }
  const data = { name, firstDay, lastDay, kinds, maxUnitCents: centsField(fd.get("maxUnitCents"), "The price limit"), preset, locationIds, active: id ? fd.get("active") === "on" : true };
  if (!id) return (await db.taxHoliday.create({ data: { shopId: user.shopId, ...data }, select: { id: true } })).id;
  const r = await db.taxHoliday.updateMany({ where: { id, shopId: user.shopId }, data });
  if (!r.count) throw new UserError("Tax holiday not found.");
  return id;
}

export async function deleteHolidayFor(user: CurrentUser, id: string): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  // A holiday sales were made under stays (the receipts and the tax report name it): it is switched off instead.
  const used = await db.saleLine.count({ where: { taxNote: `holiday:${id}`, sale: { shopId: user.shopId } } });
  if (used) await db.taxHoliday.updateMany({ where: { id, shopId: user.shopId }, data: { active: false } });
  else await db.taxHoliday.deleteMany({ where: { id, shopId: user.shopId } });
}

/** Holiday names by id, for receipts and the tax report. */
export async function holidayNames(shopId: string, notes: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(notes.filter((n): n is string => !!n && n.startsWith("holiday:")).map((n) => n.slice(8)))];
  if (!ids.length) return new Map();
  return new Map((await db.taxHoliday.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, name: true } })).map((h) => [h.id, h.name]));
}

/**
 * "Is Massachusetts' tax-free weekend on this year? Confirm the dates." From two weeks before the preset's usual month
 * until a holiday from that preset is set up for this year (or the month is over), for shops that have used it before.
 */
export async function presetReminders(shopId: string, todayYmd: string): Promise<{ key: string; state: string }[]> {
  const year = Number(todayYmd.slice(0, 4));
  const used = await db.taxHoliday.findMany({ where: { shopId, preset: { not: null } }, select: { preset: true, firstDay: true } });
  const out: { key: string; state: string }[] = [];
  for (const p of HOLIDAY_PRESETS) {
    const mine = used.filter((h) => h.preset === p.key);
    if (!mine.length || mine.some((h) => h.firstDay.startsWith(String(year)))) continue;
    const monthStart = `${year}-${String(p.month).padStart(2, "0")}-01`;
    const from = new Date(new Date(`${monthStart}T12:00:00Z`).getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
    const until = `${year}-${String(p.month).padStart(2, "0")}-31`;
    if (todayYmd >= from && todayYmd <= until) out.push({ key: p.key, state: p.state });
  }
  return out;
}
