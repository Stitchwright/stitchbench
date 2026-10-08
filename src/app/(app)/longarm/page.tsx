// Longarm quilting (fabric-smarts-design.md section 4a, package F7): the shop's quilting work orders (received, on the
// frame, ready, collected) with the due date, and the form to take a quilt in. Rental is booked on the Calendar.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { ordersFor } from "@/lib/longarm";
import { STATUS_LABEL } from "@/lib/longarm-math";
import { Empty, PageHeader, Section } from "@/components/ui";
import { NewOrderForm } from "@/components/longarm-forms";

const TONE = { RECEIVED: "tone-wait", ON_FRAME: "tone-work", READY: "tone-ready", COLLECTED: "tone-done", CANCELLED: "tone-neutral" } as const;

export default async function LongarmPage({ searchParams }: { searchParams: Promise<{ closed?: string }> }) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const { closed } = await searchParams;
  const showClosed = closed === "1";
  const [rows, tz] = await Promise.all([ordersFor(user.shopId, { closed: showClosed }), shopTimeZone(user.shopId)]);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Longarm quilting"
        sub="Quilts in for longarm work: size, price, thread and batting, and the day it is due (it shows on the Calendar). Renting the machine by the hour is booked on the Calendar."
        actions={
          <>
            <Link href={showClosed ? "/longarm" : "/longarm?closed=1"} className="btn">
              {showClosed ? "Show open orders" : "Show collected and cancelled"}
            </Link>
            <Link href="/appraisals" className="btn">
              Quilt appraisals
            </Link>
          </>
        }
      />
      <div className="card">
        {rows.length === 0 ? (
          <div className="card-pad">
            <Empty>{showClosed ? "Nothing collected or cancelled yet." : "No quilts in. Take one in below."}</Empty>
          </div>
        ) : (
          <ul className="divide-y divide-line" aria-label="Work orders">
            {rows.map((o) => (
              <li key={o.id} className="card-pad flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/longarm/${o.id}`} className="link font-medium">
                    #{o.number} {o.name}
                  </Link>
                  <div className="muted text-xs">
                    {o.widthIn} x {o.lengthIn} in · {money(o.totalCents)} before tax{o.dueAt ? ` · due ${fmtDate(o.dueAt, tz)}` : ""}
                  </div>
                </div>
                {o.overdue && <span className="pill tone-bad">overdue</span>}
                <span className={`pill ${TONE[o.status]}`}>{STATUS_LABEL[o.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Section title="Take a quilt in">
        <NewOrderForm />
      </Section>
    </div>
  );
}
