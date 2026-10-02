// Staff shifts for a week (scheduling-messaging-design.md 12.4): the grid people x days (phones: one list per day),
// weekly hours per person, the signed-in person's row highlighted; admins add, change, delete and copy weeks.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { hoursText, minutesByName, weekShifts } from "@/lib/shifts";
import { addDays, dayStart, fmtDay, fmtTime, hmOf, parseYmd, wall, weekStart, ymdOf } from "@/lib/zoned";
import { copyWeek, deleteShift, saveShift } from "@/actions/shifts";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CalendarTabs } from "@/components/calendar-tabs";
import { ModuleOff } from "@/components/module-off";
import { ShiftForm } from "@/components/shift-form";
import { PageHeader } from "@/components/ui";

type SP = { week?: string; date?: string };

export default async function ShiftsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const sp = await searchParams;
  const tz = await shopTimeZone(shopId);
  const today = ymdOf(new Date(), tz);
  const week = weekStart(parseYmd(sp.week) ?? parseYmd(sp.date) ?? today);
  const admin = user.role !== "TECH" && gate === "on";
  const [shifts, users, pastNames] = await Promise.all([
    weekShifts(shopId, week, tz),
    db.user.findMany({ where: { shopId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.shift.findMany({ where: { shopId, userId: null }, select: { name: true }, distinct: ["name"], orderBy: { name: "asc" }, take: 50 }),
  ]);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const totals = minutesByName(shifts);
  const people = totals.map((t) => t.name);
  const mine = user.name.trim().toLowerCase();
  const inDay = (name: string, ymd: string) => {
    const s = dayStart(ymd, tz);
    const e = dayStart(addDays(ymd, 1), tz);
    return shifts.filter((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase() && x.startsAt < e && x.endsAt > s);
  };
  const hm = (d: Date) => hmOf(wall(d, tz).hour * 60 + wall(d, tz).minute);
  const short = (d: Date) => fmtTime(d, tz).replace(":00", "");

  const cell = (name: string, ymd: string) => (
    <div className="space-y-1">
      {inDay(name, ymd).map((s) => (
        <div key={s.id} className="rounded bg-surface-2 px-2 py-1 text-xs">
          <span className="num">
            {short(s.startsAt)}-{short(s.endsAt)}
          </span>
          {s.role ? ` ${s.role}` : ""}
          {s.note && <div className="muted">{s.note}</div>}
          {admin && (
            <details className="mt-1">
              <summary className="link cursor-pointer">Change</summary>
              <div className="mt-2 space-y-2">
                <ShiftForm action={saveShift.bind(null, s.id)} users={users} names={pastNames.map((n) => n.name)} draft={{ userId: s.userId, name: s.name, date: ymdOf(s.startsAt, tz), start: hm(s.startsAt), end: hm(s.endsAt), role: s.role, note: s.note }} submitLabel="Save" />
                <ActionButton action={deleteShift.bind(null, s.id)} confirm="Tap again to delete" success="Deleted" className="btn btn-sm">
                  Delete
                </ActionButton>
              </div>
            </details>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Staff: week of ${fmtDay(dayStart(week, tz), tz)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/shifts/print?week=${week}`} className="btn">
              Print
            </Link>
            {admin && (
              <ActionForm action={copyWeek} className="inline-flex items-center gap-2">
                <input type="hidden" name="from" value={addDays(week, -7)} />
                <input type="hidden" name="to" value={week} />
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" name="replace" className="check" /> Replace them
                </label>
                <Submit className="btn">Copy last week</Submit>
              </ActionForm>
            )}
          </div>
        }
      />
      {gate === "readonly" && <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />}
      <div className="flex flex-wrap items-center gap-2">
        <CalendarTabs active="staff" date={week} />
        <span className="mx-1" />
        <Link href={`/shifts?week=${addDays(week, -7)}`} className="btn">
          Previous
        </Link>
        <Link href={`/shifts?week=${weekStart(today)}`} className="btn">
          This week
        </Link>
        <Link href={`/shifts?week=${addDays(week, 7)}`} className="btn">
          Next
        </Link>
      </div>

      {admin && (
        <div className="card card-pad">
          <div className="label mb-2">Add a shift</div>
          <ShiftForm action={saveShift.bind(null, null)} users={users} names={pastNames.map((n) => n.name)} draft={{ userId: users[0]?.id ?? null, name: "", date: week >= today ? week : today, start: "09:00", end: "17:00", role: null, note: null }} submitLabel="Add" />
        </div>
      )}

      {people.length === 0 ? (
        <p className="card card-pad text-sm">Nobody is on the schedule this week.</p>
      ) : (
        <>
          {/* Wide: people down, days across. */}
          <div className="hidden overflow-x-auto xl:block">
            <table className="table" aria-label="Shifts">
              <thead>
                <tr>
                  <th>Who</th>
                  {days.map((d) => (
                    <th key={d} className={d === today ? "bg-surface-2" : ""}>
                      {fmtDay(dayStart(d, tz), tz)}
                    </th>
                  ))}
                  <th className="num">Hours</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((t) => (
                  <tr key={t.name} className={t.name.trim().toLowerCase() === mine ? "bg-surface-2 font-semibold" : ""}>
                    <td>{t.name}</td>
                    {days.map((d) => (
                      <td key={d} className="align-top">
                        {cell(t.name, d)}
                      </td>
                    ))}
                    <td className="num">{hoursText(t.minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Narrow: one list per day. */}
          <div className="space-y-3 xl:hidden">
            {days.map((d) => {
              const list = shifts.filter((s) => s.startsAt < dayStart(addDays(d, 1), tz) && s.endsAt > dayStart(d, tz));
              return (
                <div key={d} className={`card card-pad ${d === today ? "border-2" : ""}`}>
                  <div className="font-semibold">{fmtDay(dayStart(d, tz), tz)}</div>
                  {list.length === 0 ? (
                    <div className="muted text-sm">Nobody</div>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {list.map((s) => (
                        <li key={s.id} className={s.name.trim().toLowerCase() === mine ? "font-semibold" : ""}>
                          {s.name}: {short(s.startsAt)}-{short(s.endsAt)}
                          {s.role ? ` ${s.role}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
            <div className="card card-pad text-sm">
              <div className="label mb-1">Hours this week</div>
              <ul>
                {totals.map((t) => (
                  <li key={t.name} className={t.name.trim().toLowerCase() === mine ? "font-semibold" : ""}>
                    {t.name}: {hoursText(t.minutes)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
