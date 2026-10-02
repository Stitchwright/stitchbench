// The week's shifts as a print view (scheduling-messaging-design.md 12.4).
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { hoursText, minutesByName, weekShifts } from "@/lib/shifts";
import { addDays, dayStart, fmtDay, fmtTime, parseYmd, weekStart, ymdOf } from "@/lib/zoned";
import { ModuleOff } from "@/components/module-off";
import { PrintButton } from "@/components/print-button";
import { PageHeader } from "@/components/ui";

export default async function ShiftsPrintPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const { week: raw } = await searchParams;
  const tz = await shopTimeZone(shopId);
  const week = weekStart(parseYmd(raw) ?? ymdOf(new Date(), tz));
  const [shop, shifts] = await Promise.all([db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true } }), weekShifts(shopId, week, tz)]);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const totals = minutesByName(shifts);
  const short = (d: Date) => fmtTime(d, tz).replace(":00", "");
  return (
    <div>
      <div className="no-print">
        <PageHeader back={{ href: `/shifts?week=${week}`, label: "Staff" }} title="Print the week" actions={<PrintButton />} />
      </div>
      <article className="card mx-auto max-w-4xl bg-white p-8 text-black print:border-0 print:p-0">
        <header className="border-b border-line pb-3">
          <div className="text-xl font-bold">{shop.name}: who&apos;s working</div>
          <div className="text-sm">Week of {fmtDay(dayStart(week, tz), tz)}</div>
        </header>
        <table className="table mt-4">
          <thead>
            <tr>
              <th>Who</th>
              {days.map((d) => (
                <th key={d}>{fmtDay(dayStart(d, tz), tz)}</th>
              ))}
              <th className="num">Hours</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((t) => (
              <tr key={t.name}>
                <td className="font-semibold">{t.name}</td>
                {days.map((d) => {
                  const s = dayStart(d, tz);
                  const e = dayStart(addDays(d, 1), tz);
                  const list = shifts.filter((x) => x.name.trim().toLowerCase() === t.name.trim().toLowerCase() && x.startsAt < e && x.endsAt > s);
                  return (
                    <td key={d} className="text-xs">
                      {list.map((x) => (
                        <div key={x.id}>
                          {short(x.startsAt)}-{short(x.endsAt)}
                          {x.role ? ` ${x.role}` : ""}
                        </div>
                      ))}
                    </td>
                  );
                })}
                <td className="num">{hoursText(t.minutes)}</td>
              </tr>
            ))}
            {totals.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  Nobody is on the schedule this week.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </article>
    </div>
  );
}
