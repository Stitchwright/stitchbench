// The day and week calendar (scheduling-messaging-design.md 12.2). Everyone with Scheduling not hidden.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { hoursOf } from "@/lib/appointments";
import { calendarItems } from "@/lib/calendar";
import { APPOINTMENT_STATUS_LABEL } from "@/lib/constants";
import { addDays, dayStart, fmtDay, parseHm, parseYmd, weekStart, ymdOf } from "@/lib/zoned";
import { CalendarTabs } from "@/components/calendar-tabs";
import { DayView, WeekView } from "@/components/calendar-view";
import { ModuleOff } from "@/components/module-off";
import { PageHeader } from "@/components/ui";

type SP = { view?: string; date?: string; staff?: string };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const sp = await searchParams;
  const tz = await shopTimeZone(shopId);
  const today = ymdOf(new Date(), tz);
  const date = parseYmd(sp.date) ?? today;
  const view = sp.view === "week" ? "week" : "day";
  const showStaff = sp.staff === "1";
  const from = view === "day" ? date : weekStart(date);
  const to = addDays(from, view === "day" ? 1 : 7);
  const [items, types] = await Promise.all([
    calendarItems(shopId, dayStart(from, tz), dayStart(to, tz), { shifts: true }),
    db.appointmentType.findMany({ where: { shopId, active: true }, select: { hours: true } }),
  ]);
  const shifts = items.filter((i) => i.kind === "shift");
  const shown = showStaff ? items : items.filter((i) => i.kind !== "shift");
  // The hour rows: from the earliest opening to the latest closing of the bookable types (9:00-18:00 when none).
  let open = 24;
  let close = 0;
  for (const t of types) for (const h of hoursOf(t.hours)) {
    open = Math.min(open, Math.floor((parseHm(h.from) ?? 540) / 60));
    close = Math.max(close, Math.ceil((parseHm(h.to) ?? 1080) / 60));
  }
  const hours = open < close ? { from: open, to: close } : { from: 9, to: 18 };
  const apptIds = shown.filter((i) => i.kind === "appointment").map((i) => i.id);
  const appts = apptIds.length ? await db.appointment.findMany({ where: { shopId, id: { in: apptIds } }, select: { id: true, status: true, paidAt: true, paidCents: true, feeCents: true, blocked: true } }) : [];
  const statuses = new Map(appts.filter((a) => !a.blocked && a.status !== "BOOKED").map((a) => [a.id, APPOINTMENT_STATUS_LABEL[a.status] ?? a.status]));
  const paid = new Map(appts.filter((a) => !a.blocked && a.paidAt).map((a) => [a.id, `Paid ${money(a.paidCents ?? a.feeCents)}`]));
  const working = [...new Set(shifts.filter((s) => s.start < dayStart(addDays(date, 1), tz) && s.end > dayStart(date, tz)).map((s) => s.title))];
  const q = (d: string, v = view, staff = showStaff) => `/calendar?view=${v}&date=${d}${staff ? "&staff=1" : ""}`;
  const step = view === "day" ? 1 : 7;

  return (
    <div className="space-y-4">
      <PageHeader
        title={view === "day" ? fmtDay(dayStart(date, tz), tz) : `Week of ${fmtDay(dayStart(from, tz), tz)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {gate === "on" && (
              <Link href={`/calendar/new?date=${date}`} className="btn btn-primary">
                Book
              </Link>
            )}
            {user.role !== "TECH" && (
              <Link href="/calendar/types" className="btn">
                Types
              </Link>
            )}
          </div>
        }
      />
      {gate === "readonly" && <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />}
      <div className="flex flex-wrap items-center gap-2">
        <CalendarTabs active={view} date={date} />
        <span className="mx-1" />
        <Link href={q(addDays(date, -step))} className="btn">
          Previous
        </Link>
        <Link href={q(today)} className="btn">
          Today
        </Link>
        <Link href={q(addDays(date, step))} className="btn">
          Next
        </Link>
        <form method="get" action="/calendar" className="flex items-center gap-2">
          <input type="hidden" name="view" value={view} />
          {showStaff && <input type="hidden" name="staff" value="1" />}
          <input type="date" name="date" className="input" defaultValue={date} aria-label="Go to date" />
          <button type="submit" className="btn">
            Go
          </button>
        </form>
        <Link href={q(date, view, !showStaff)} className={`btn btn-sm ${showStaff ? "btn-primary" : ""}`} aria-pressed={showStaff}>
          Show staff
        </Link>
      </div>
      {view === "day" ? <DayView ymd={date} items={shown} tz={tz} hours={hours} working={working} statuses={statuses} paid={paid} /> : <WeekView fromYmd={from} items={shown} tz={tz} />}
    </div>
  );
}
