// The month's classes to print for the window or the newsletter (scheduling-messaging-design.md 12.1): every OPEN
// class meeting in the month with title, dates, time, teacher, fee and seats left.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { addMonths, dayStart, fmtRange, ymdOf } from "@/lib/zoned";
import { seatCounts } from "@/lib/classes";
import { ModuleOff } from "@/components/module-off";
import { PrintButton } from "@/components/print-button";
import { PageHeader } from "@/components/ui";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export default async function ClassesPrintPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const tz = await shopTimeZone(shopId);
  const { month: raw } = await searchParams;
  const month = raw && MONTH.test(raw) ? raw : ymdOf(new Date(), tz).slice(0, 7);
  const from = dayStart(`${month}-01`, tz);
  const to = dayStart(addMonths(`${month}-01`, 1)!, tz); // the 1st always exists
  const [shop, meetings] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true } }),
    db.classMeeting.findMany({ where: { shopId, cancelled: false, startsAt: { gte: from, lt: to }, shopClass: { status: "OPEN" } }, orderBy: { startsAt: "asc" }, include: { shopClass: true } }),
  ]);
  const counts = await seatCounts(db, [...new Set(meetings.map((m) => m.classId))]);
  const title = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const prev = addMonths(`${month}-01`, -1)!.slice(0, 7);
  const next = addMonths(`${month}-01`, 1)!.slice(0, 7);

  return (
    <div>
      <div className="no-print">
        <PageHeader
          back={{ href: "/classes", label: "Classes" }}
          title={`Classes in ${title}`}
          actions={
            <div className="flex flex-wrap gap-2">
              <Link href={`/classes/print?month=${prev}`} className="btn btn-sm">
                Previous month
              </Link>
              <Link href={`/classes/print?month=${next}`} className="btn btn-sm">
                Next month
              </Link>
              <PrintButton />
            </div>
          }
        />
      </div>
      <article className="card mx-auto max-w-3xl bg-white p-8 text-black print:border-0 print:p-0">
        <header className="border-b border-line pb-3">
          <div className="text-xl font-bold">{shop.name}: classes in {title}</div>
          {shop.phone && <div className="text-sm">Call {shop.phone} to sign up.</div>}
        </header>
        {meetings.length === 0 ? (
          <p className="muted mt-4 text-sm">No classes this month.</p>
        ) : (
          <ul className="mt-4 space-y-3 text-sm">
            {meetings.map((m) => {
              const k = counts.get(m.classId) ?? { enrolled: 0, waiting: 0 };
              const left = m.shopClass.seats - k.enrolled;
              return (
                <li key={m.id}>
                  <div className="font-semibold">{m.shopClass.title}</div>
                  <div>
                    {fmtRange(m.startsAt, m.endsAt, tz)}
                    {m.shopClass.teacher ? ` · ${m.shopClass.teacher}` : ""}
                    {m.shopClass.location ? ` · ${m.shopClass.location}` : ""}
                    {" · "}
                    {m.shopClass.feeCents ? money(m.shopClass.feeCents) : "Free"}
                    {" · "}
                    {left > 0 ? `${left} seat${left === 1 ? "" : "s"} left` : "Full"}
                  </div>
                  {m.shopClass.description && <div className="muted">{m.shopClass.description}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </article>
    </div>
  );
}
