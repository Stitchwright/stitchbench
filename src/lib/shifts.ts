import "server-only";
// Staff shifts (scheduling-messaging-design.md 12.4): a week's shifts, the hours per person, and the work behind the
// actions (callable with a user so the check script can drive it).
import type { Prisma, Shift } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { assertId } from "@/lib/input";
import { str } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { requireOn } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { addDays, dayStart, fmtRange, parseYmd, rangeFromForm, wall, weekStart, ymdOf, zonedTime } from "@/lib/zoned";

/** The shifts of the week that starts on `weekYmd` (a Sunday), by start. */
export async function weekShifts(shopId: string, weekYmd: string, tz: string): Promise<Shift[]> {
  const from = dayStart(weekYmd, tz);
  const to = dayStart(addDays(weekYmd, 7), tz);
  return db.shift.findMany({ where: { shopId, startsAt: { lt: to }, endsAt: { gt: from } }, orderBy: [{ startsAt: "asc" }, { name: "asc" }] });
}

/** Minutes per person for a list of shifts, grouped by name (case-insensitive), the first spelling kept. */
export function minutesByName(list: Pick<Shift, "name" | "startsAt" | "endsAt">[]): { name: string; minutes: number }[] {
  const out = new Map<string, { name: string; minutes: number }>();
  for (const s of list) {
    const k = s.name.trim().toLowerCase();
    const cur = out.get(k) ?? { name: s.name.trim(), minutes: 0 };
    cur.minutes += Math.max(0, Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000));
    out.set(k, cur);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** "9:00-1:00" style hours: "7h 30m" */
export const hoursText = (minutes: number) => `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;

async function asAdmin(user: CurrentUser): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireOn(user, "scheduling");
}

const limited = (v: string | null, max: number, what: string): string | null => {
  const t = v?.trim() ?? "";
  if (t.length > max) throw new UserError(`${what} is too long (${max} characters at most).`);
  return t || null;
};

/** Another shift of the same person (same login, or the same name) that overlaps. */
async function overlapping(tx: Prisma.TransactionClient | typeof db, shopId: string, who: { userId: string | null; name: string }, startsAt: Date, endsAt: Date, exceptId?: string): Promise<Shift | null> {
  return tx.shift.findFirst({
    where: {
      shopId,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      ...(exceptId ? { id: { not: exceptId } } : {}),
      OR: [...(who.userId ? [{ userId: who.userId }] : []), { name: { equals: who.name, mode: "insensitive" as const } }],
    },
  });
}

/** A shift's "who": a login of this shop (the name follows it) or a typed name for someone without one. */
async function whoFrom(shopId: string, fd: FormData): Promise<{ userId: string | null; name: string }> {
  const userId = str(fd.get("userId"));
  if (userId) {
    const u = await db.user.findFirst({ where: { id: assertId(userId), shopId, active: true }, select: { id: true, name: true } });
    if (!u) throw new UserError("Pick someone or type a name.");
    return { userId: u.id, name: u.name };
  }
  const name = str(fd.get("name"))?.replace(/\s+/g, " ").trim() ?? "";
  if (!name || name.length > 60) throw new UserError("Pick someone or type a name.");
  return { userId: null, name };
}

/** A shift added or changed (admins). Returns the week (Sunday) it belongs to, for the redirect. */
export async function saveShiftAs(user: CurrentUser, shiftId: string | null, fd: FormData): Promise<{ id: string; week: string }> {
  await asAdmin(user);
  const shopId = user.shopId;
  const tz = await shopTimeZone(shopId);
  const who = await whoFrom(shopId, fd);
  const { startsAt, endsAt } = rangeFromForm(fd, tz);
  const role = limited(str(fd.get("role")), 40, "The role");
  const note = limited(str(fd.get("note")), 200, "The note");
  const existing = shiftId ? await db.shift.findFirst({ where: { id: assertId(shiftId), shopId } }) : null;
  if (shiftId && !existing) throw new UserError("Shift not found.");
  const clash = await overlapping(db, shopId, who, startsAt, endsAt, existing?.id);
  if (clash) throw new UserError(`${clash.name} already works ${fmtRange(clash.startsAt, clash.endsAt, tz)} then.`);
  const data = { userId: who.userId, name: who.name, startsAt, endsAt, role, note };
  if (existing) {
    await db.shift.updateMany({ where: { id: existing.id, shopId }, data });
    return { id: existing.id, week: weekStart(ymdOf(startsAt, tz)) };
  }
  const made = await db.shift.create({ data: { shopId, ...data, createdById: user.id }, select: { id: true } });
  return { id: made.id, week: weekStart(ymdOf(startsAt, tz)) };
}

export async function deleteShiftAs(user: CurrentUser, shiftId: string): Promise<string> {
  await asAdmin(user);
  const s = await db.shift.findFirst({ where: { id: assertId(shiftId), shopId: user.shopId } });
  if (!s) throw new UserError("Shift not found.");
  await db.shift.deleteMany({ where: { id: s.id, shopId: user.shopId } });
  const tz = await shopTimeZone(user.shopId);
  return weekStart(ymdOf(s.startsAt, tz));
}

/** Copies one week's shifts onto another by wall clock (same weekday, same times: a DST change doesn't move them). */
export async function copyWeekAs(user: CurrentUser, fd: FormData): Promise<{ to: string; copied: number }> {
  await asAdmin(user);
  const shopId = user.shopId;
  const tz = await shopTimeZone(shopId);
  const fromRaw = parseYmd(str(fd.get("from")));
  const toRaw = parseYmd(str(fd.get("to")));
  if (!fromRaw || !toRaw) throw new UserError("Pick the week to copy and the week to copy it to.");
  const from = weekStart(fromRaw);
  const to = weekStart(toRaw);
  if (from === to) throw new UserError("That's the same week.");
  const source = await weekShifts(shopId, from, tz);
  if (!source.length) throw new UserError("That week has no shifts to copy.");
  const target = await weekShifts(shopId, to, tz);
  const replace = fd.get("replace") === "on";
  if (target.length && !replace) throw new UserError("That week already has shifts. Tick 'Replace them' to copy over them.");
  const rows = source.map((s) => {
    const ws = wall(s.startsAt, tz);
    const we = wall(s.endsAt, tz);
    const day = addDays(to, ws.weekday);
    return { shopId, userId: s.userId, name: s.name, startsAt: zonedTime(day, ws.hour * 60 + ws.minute, tz), endsAt: zonedTime(day, we.hour * 60 + we.minute, tz), role: s.role, note: s.note, createdById: user.id };
  });
  await db.$transaction(async (tx) => {
    if (target.length) await tx.shift.deleteMany({ where: { shopId, id: { in: target.map((t) => t.id) } } });
    await tx.shift.createMany({ data: rows });
  });
  return { to, copied: rows.length };
}
