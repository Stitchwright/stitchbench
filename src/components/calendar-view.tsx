// The Day and Week views (scheduling-messaging-design.md 12.2). Server component: it gets the items and draws them.
// Day: hour rows from the earliest opening or item to the latest, each item a card, one "+" per empty hour. Week:
// seven columns from the xl width, one list per day below that; each item one line with its tone as a left border.
import Link from "next/link";
import type { CalItem } from "@/lib/calendar";
import { APPOINTMENT_STATUS_LABEL } from "@/lib/constants";
import { addDays, dayStart, fmtDay, fmtTime, wall, ymdOf } from "@/lib/zoned";

const TONE_BORDER: Record<CalItem["tone"], string> = {
  neutral: "border-l-4 border-l-line",
  work: "border-l-4 border-l-blue-400",
  wait: "border-l-4 border-l-amber-400",
  ready: "border-l-4 border-l-emerald-500",
  done: "border-l-4 border-l-emerald-300",
  bad: "border-l-4 border-l-red-400",
};

function ItemCard({ it, tz, status, paid }: { it: CalItem; tz: string; status?: string | null; paid?: string | null }) {
  return (
    <Link href={it.href} className={`card block px-3 py-2 text-sm hover:bg-surface-2 ${TONE_BORDER[it.tone]}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="num">
          {fmtTime(it.start, tz)}-{fmtTime(it.end, tz)}
        </span>
        <span className={`font-semibold ${it.struck ? "line-through muted" : ""}`}>{it.title}</span>
        {status && <span className="pill tone-neutral">{status}</span>}
        {paid && <span className="pill tone-done">{paid}</span>}
      </div>
      {it.sub && <div className="muted text-xs">{it.sub}</div>}
    </Link>
  );
}

export function DayView({ ymd, items, tz, hours, working, statuses, paid }: { ymd: string; items: CalItem[]; tz: string; hours: { from: number; to: number }; working: string[]; statuses: Map<string, string>; paid: Map<string, string> }) {
  const start = dayStart(ymd, tz);
  const end = dayStart(addDays(ymd, 1), tz);
  const today = items.filter((i) => i.start < end && i.end > start && i.kind !== "shift");
  const firstHour = Math.min(hours.from, ...today.map((i) => wall(i.start, tz).hour));
  const lastHour = Math.max(hours.to, ...today.map((i) => (i.end > start ? Math.min(23, wall(new Date(i.end.getTime() - 1), tz).hour + 1) : 0)));
  const rows: number[] = [];
  for (let h = firstHour; h < lastHour; h++) rows.push(h);
  const byHour = new Map<number, CalItem[]>();
  for (const it of today) {
    const h = it.start < start ? firstHour : wall(it.start, tz).hour;
    byHour.set(h, [...(byHour.get(h) ?? []), it]);
  }
  return (
    <div className="space-y-2">
      {working.length > 0 && <p className="muted text-sm">Working today: {working.join(", ")}</p>}
      <div className="divide-y divide-line rounded border border-line">
        {rows.map((h) => {
          const list = byHour.get(h) ?? [];
          const label = fmtTime(new Date(start.getTime() + h * 3_600_000), tz).replace(":00", "");
          return (
            <div key={h} className="flex gap-3 px-2 py-2">
              <div className="num muted w-16 shrink-0 pt-1 text-xs">{label}</div>
              <div className="flex-1 space-y-2">
                {list.map((it) => (
                  <ItemCard key={`${it.kind}:${it.id}`} it={it} tz={tz} status={it.kind === "appointment" ? (statuses.get(it.id) ?? null) : null} paid={it.kind === "appointment" ? (paid.get(it.id) ?? null) : null} />
                ))}
                {list.length === 0 && (
                  <Link href={`/calendar/new?date=${ymd}&start=${String(h).padStart(2, "0")}:00`} className="btn btn-sm" aria-label={`Book at ${label}`}>
                    +
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function WeekView({ fromYmd, items, tz }: { fromYmd: string; items: CalItem[]; tz: string }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(fromYmd, i));
  const todayYmd = ymdOf(new Date(), tz);
  const column = (ymd: string) => {
    const s = dayStart(ymd, tz);
    const e = dayStart(addDays(ymd, 1), tz);
    const list = items.filter((i) => i.start < e && i.end > s);
    return (
      <div key={ymd} className={`space-y-1 ${ymd === todayYmd ? "rounded bg-surface-2 p-1" : ""}`}>
        <Link href={`/calendar?view=day&date=${ymd}`} className="link block text-sm font-semibold">
          {fmtDay(s, tz)}
        </Link>
        {list.length === 0 && <div className="muted text-xs">Nothing</div>}
        {list.map((it) => (
          <Link key={`${it.kind}:${it.id}`} href={it.href} className={`block truncate rounded bg-surface px-2 py-1 text-xs ${TONE_BORDER[it.tone]} ${it.struck ? "line-through muted" : ""}`} title={`${it.title}${it.sub ? ` · ${it.sub}` : ""}`}>
            {fmtTime(it.start, tz).replace(" ", "")} {it.title}
            {it.sub ? ` · ${it.sub}` : ""}
          </Link>
        ))}
      </div>
    );
  };
  return (
    <>
      <div className="hidden gap-2 xl:grid xl:grid-cols-7">{days.map(column)}</div>
      <div className="space-y-3 xl:hidden">{days.map(column)}</div>
    </>
  );
}

export const apptStatusWords = (status: string) => APPOINTMENT_STATUS_LABEL[status] ?? status;
