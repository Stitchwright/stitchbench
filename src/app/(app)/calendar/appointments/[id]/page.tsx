// One appointment (scheduling-messaging-design.md 12.2): details, status buttons, the reschedule form, fee and payment,
// the linked ticket or job, and its messages.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { fmtDateTime, money } from "@/lib/format";
import { fmtPhone } from "@/lib/phone";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtRange, hmOf, wall, ymdOf } from "@/lib/zoned";
import { APPOINTMENT_STATUS_LABEL, CHANNEL_LABEL, MESSAGE_KIND_LABEL, MESSAGE_STATUS_LABEL, MESSAGE_STATUS_TONE } from "@/lib/constants";
import { linkedWords } from "@/lib/appointment-actions";
import { rescheduleAppt, setApptStatus } from "@/actions/appointments";
import { ActionForm, Submit } from "@/components/action-form";
import { ModuleOff } from "@/components/module-off";
import { KV, PageHeader, Section } from "@/components/ui";

const TONE: Record<string, string> = { BOOKED: "ready", DONE: "done", NO_SHOW: "bad", CANCELLED: "neutral" };

function TellBox({ label }: { label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name="tell" className="check" defaultChecked /> {label}
    </label>
  );
}

export default async function AppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const a = await db.appointment.findFirst({ where: { id, shopId }, include: { type: true, customer: { select: { id: true, name: true, phone: true } }, staff: { select: { id: true, name: true } } } });
  if (!a) notFound();
  const on = gate === "on";
  const [tz, marketing, messages, linked, staff, sale] = await Promise.all([
    shopTimeZone(shopId),
    gateFor(shopId, "marketing").then((g) => g === "on"),
    db.outMessage.findMany({ where: { shopId, refType: "appointment", refId: a.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    linkedWords(shopId, a),
    db.user.findMany({ where: { shopId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    a.paidLineId ? db.saleLine.findFirst({ where: { id: a.paidLineId }, select: { sale: { select: { id: true, number: true } } } }) : Promise.resolve(null),
  ]);
  const w = wall(a.startsAt, tz);
  const we = wall(a.endsAt, tz);
  const booked = a.status === "BOOKED";
  const canTell = marketing && !a.blocked && !!a.customerId;

  return (
    <div className="space-y-4">
      <PageHeader
        title={a.blocked ? `Blocked: ${a.title}` : a.title}
        back={{ href: `/calendar?date=${ymdOf(a.startsAt, tz)}`, label: "Calendar" }}
        sub={
          <>
            {fmtRange(a.startsAt, a.endsAt, tz)} · <span className={`pill tone-${TONE[a.status] ?? "neutral"}`}>{APPOINTMENT_STATUS_LABEL[a.status] ?? a.status}</span>
          </>
        }
      />
      {gate === "readonly" && <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />}

      <Section title="Details">
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          {!a.blocked && (
            <KV
              k="Customer"
              v={
                a.customer ? (
                  <>
                    <Link href={`/customers/${a.customer.id}`} className="link">
                      {a.customer.name}
                    </Link>
                    {a.customer.phone && <span className="muted"> · {fmtPhone(a.customer.phone)}</span>}
                  </>
                ) : (
                  a.name
                )
              }
            />
          )}
          <KV k="With" v={a.staff?.name} />
          <KV k="Where" v={a.type?.location} />
          <KV k="Uses" v={a.resource} />
          <KV
            k="Ticket / tag"
            v={
              linked ? (
                <Link href={linked.href} className="link">
                  {linked.label}
                </Link>
              ) : null
            }
          />
          <KV k="Note" v={a.note} />
          {a.source === "online" && <KV k="Booked" v="Online, by the customer" />}
          {!a.blocked && (
            <KV
              k="Fee"
              v={
                a.refundedAt ? (
                  `Refunded ${money(a.refundedCents ?? 0)}`
                ) : a.paidAt ? (
                  sale ? (
                    <Link href={`/register/sales/${sale.sale.id}`} className="link">
                      Paid, sale #{sale.sale.number}
                    </Link>
                  ) : (
                    `Paid ${money(a.paidCents ?? a.feeCents)}`
                  )
                ) : a.feeCents ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    Owes {money(a.feeCents)}
                    {on && a.status !== "CANCELLED" && (
                      <Link href={`/register?booking=appointment:${a.id}`} className="btn btn-sm">
                        Ring up
                      </Link>
                    )}
                  </span>
                ) : (
                  "Free"
                )
              }
            />
          )}
          {a.status === "CANCELLED" && a.paidAt && !a.refundedAt && <KV k="Refund" v={`Paid ${money(a.paidCents ?? a.feeCents)}: refund it at the register`} />}
        </div>
        {on && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {booked && (
              <>
                <ActionForm action={setApptStatus.bind(null, a.id, "DONE")} success="Done" className="inline-flex">
                  <Submit className="btn btn-sm btn-primary">Done</Submit>
                </ActionForm>
                {!a.blocked && (
                  <ActionForm action={setApptStatus.bind(null, a.id, "NO_SHOW")} success="Marked" className="inline-flex">
                    <Submit className="btn btn-sm">Didn&apos;t come</Submit>
                  </ActionForm>
                )}
                <ActionForm action={setApptStatus.bind(null, a.id, "CANCELLED")} success="Cancelled" className="inline-flex items-center gap-3">
                  {canTell && <TellBox label="Tell them" />}
                  <Submit className="btn btn-sm">Cancel</Submit>
                </ActionForm>
              </>
            )}
            {(a.status === "DONE" || a.status === "NO_SHOW") && (
              <ActionForm action={setApptStatus.bind(null, a.id, "BOOKED")} success="Back to booked" className="inline-flex">
                <Submit className="btn btn-sm">That was a mistake: back to booked</Submit>
              </ActionForm>
            )}
            {a.status === "CANCELLED" && <span className="muted text-sm">Cancelled. Book it again instead.</span>}
          </div>
        )}
      </Section>

      {on && booked && (
        <Section title="Move it">
          <ActionForm action={rescheduleAppt.bind(null, a.id)} success="Moved" className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <input name="date" type="date" className="input" defaultValue={ymdOf(a.startsAt, tz)} aria-label="Date" required />
              <input name="start" type="time" className="input" defaultValue={hmOf(w.hour * 60 + w.minute)} aria-label="Starts" required />
              <input name="end" type="time" className="input" defaultValue={hmOf(we.hour * 60 + we.minute)} aria-label="Ends" />
              <select name="staffId" className="select" defaultValue={a.staffId ?? ""} aria-label="With">
                <option value="">Anyone</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              {user.role !== "TECH" && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="outsideHours" className="check" /> Outside the usual hours
                </label>
              )}
              {canTell && <TellBox label="Tell them the new time" />}
              <Submit className="btn btn-sm">Save the new time</Submit>
            </div>
          </ActionForm>
        </Section>
      )}

      <Section title="Messages">
        {messages.length === 0 ? (
          <p className="muted text-sm">No messages about this yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {messages.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-semibold">{MESSAGE_KIND_LABEL[m.kind] ?? m.kind}</span>
                <span className="muted">{CHANNEL_LABEL[m.channel] ?? m.channel}</span>
                <span className="num muted">{fmtDateTime(m.sentAt ?? m.sendAfter, tz)}</span>
                <span className={`pill tone-${MESSAGE_STATUS_TONE[m.status] ?? "neutral"}`}>{MESSAGE_STATUS_LABEL[m.status] ?? m.status}</span>
                {m.status !== "SENT" && m.error && <span className="muted text-xs">{m.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
