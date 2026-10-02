// A customer's appointments on their page (scheduling-messaging-design.md 12.2): upcoming and the last 10, and "Book".
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtRange } from "@/lib/zoned";
import { APPOINTMENT_STATUS_LABEL } from "@/lib/constants";
import { Section } from "@/components/ui";

const TONE: Record<string, string> = { BOOKED: "ready", DONE: "done", NO_SHOW: "bad", CANCELLED: "neutral" };

export async function CustomerAppointmentsSlot({ customerId, user }: { customerId: string; user: CurrentUser }) {
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return null;
  const now = new Date();
  const [upcoming, past, tz] = await Promise.all([
    db.appointment.findMany({ where: { shopId, customerId, endsAt: { gte: now }, status: "BOOKED" }, orderBy: { startsAt: "asc" }, take: 20 }),
    db.appointment.findMany({ where: { shopId, customerId, OR: [{ endsAt: { lt: now } }, { status: { not: "BOOKED" } }] }, orderBy: { startsAt: "desc" }, take: 10 }),
    shopTimeZone(shopId),
  ]);
  const on = gate === "on";
  if (!upcoming.length && !past.length && !on) return null;
  const row = (a: (typeof upcoming)[number]) => (
    <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <Link href={`/calendar/appointments/${a.id}`} className="link">
        {a.title}
      </Link>
      <span className="muted">{fmtRange(a.startsAt, a.endsAt, tz)}</span>
      <span className={`pill tone-${TONE[a.status] ?? "neutral"}`}>{APPOINTMENT_STATUS_LABEL[a.status] ?? a.status}</span>
      {a.paidAt ? <span className="muted">Paid</span> : a.feeCents && a.status === "BOOKED" ? <span>Owes {money(a.feeCents)}</span> : null}
    </li>
  );
  return (
    <Section
      title="Appointments"
      actions={
        on ? (
          <Link href={`/calendar/new?customer=${customerId}`} className="btn btn-sm">
            Book
          </Link>
        ) : undefined
      }
    >
      <div className="space-y-2 text-sm">
        {upcoming.length === 0 && past.length === 0 && <p className="muted">No appointments yet.</p>}
        {upcoming.length > 0 && <ul className="divide-y divide-line">{upcoming.map(row)}</ul>}
        {past.length > 0 && (
          <details>
            <summary className="muted cursor-pointer">Earlier ({past.length})</summary>
            <ul className="divide-y divide-line">{past.map(row)}</ul>
          </details>
        )}
      </div>
    </Section>
  );
}
