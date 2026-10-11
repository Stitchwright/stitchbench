// Maker Shop → Maker-space time (shop-features-round-2-design.md 6.4): the shop's own laser or 3D printer booked by the
// hour, exactly as longarm rental works (an appointment type with an hourly rate, how many at once and what it uses up),
// for customers certified on that machine; who is certified; the next bookings. Material used is rung up at the register
// with the booking. Booking itself is on the calendar (the Scheduling module).
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { gateFor } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";
import { MAKER_EQUIPMENT, certifiedBy } from "@/lib/certifications";
import { saveApptType } from "@/actions/appointments";
import { ActionForm, Submit } from "@/components/action-form";
import { Empty, Section } from "@/components/ui";
import { MakerFrame, makerPageState } from "@/components/maker/maker-page";

export default async function MakerSpacePage() {
  const user = await requireUser();
  const shopId = user.shopId;
  const now = new Date();
  const [s, scheduling, tz, types, certs] = await Promise.all([
    makerPageState(user),
    gateFor(shopId, "scheduling"),
    shopTimeZone(shopId),
    db.appointmentType.findMany({ where: { shopId, certFor: { not: null } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    certifiedBy(shopId),
  ]);
  const upcoming = types.length
    ? await db.appointment.findMany({
        where: { shopId, typeId: { in: types.map((t) => t.id) }, status: "BOOKED", blocked: false, startsAt: { gte: now, lte: new Date(now.getTime() + 14 * 86_400_000) } },
        include: { customer: { select: { name: true } } },
        orderBy: { startsAt: "asc" },
        take: 50,
      })
    : [];
  const write = s.gate === "write";
  const makerCerts = certs.filter((c) => c.equipment !== "Longarm");
  return (
    <MakerFrame title="Maker-space time" tab="space" what="Maker-space time" sub="Customers book your own laser or 3D printer by the hour once they are certified on it. Material they use is rung up at the register with the booking." {...s}>
      {scheduling !== "on" && (
        <p className="card card-pad text-base">
          Booking by the hour uses the calendar, which comes with Scheduling.{" "}
          {s.admin && (
            <Link href="/settings/features" className="link">
              Switch Scheduling on in Settings → Features
            </Link>
          )}
        </p>
      )}
      <Section title="Your machines by the hour">
        {types.length === 0 ? (
          <Empty>None yet. Set one up below: then certify customers on it from their page, and book them on the calendar.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {types.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-base">
                  {t.name} <span className="muted text-sm">· certified on the {t.certFor} · {t.capacity} at a time</span>
                </span>
                <span className="text-base">{t.hourlyCents != null ? `${money(t.hourlyCents)} an hour` : money(t.feeCents)}</span>
              </li>
            ))}
          </ul>
        )}
        {s.admin && write && scheduling === "on" && (
          <details className="mt-3" open={types.length === 0}>
            <summary className="link cursor-pointer text-sm">Set up a machine by the hour</summary>
            <ActionForm action={saveApptType.bind(null, null)} reset success="Set up" className="mt-2 flex flex-wrap items-end gap-2">
              <input type="hidden" name="minutes" value="60" />
              <input type="hidden" name="fee" value="0" />
              <input type="hidden" name="capacity" value="1" />
              <input type="hidden" name="needsCert" value="on" />
              <input type="hidden" name="active" value="on" />
              <div className="field">
                <label className="label" htmlFor="space-machine">
                  Machine
                </label>
                <input id="space-machine" name="certFor" list="space-machines" className="input" defaultValue="Laser" required />
                <datalist id="space-machines">
                  {MAKER_EQUIPMENT.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label className="label" htmlFor="space-name">
                  Name customers see
                </label>
                <input id="space-name" name="name" className="input" defaultValue="Laser time" required />
              </div>
              <div className="field">
                <label className="label" htmlFor="space-rate">
                  Dollars an hour
                </label>
                <input id="space-rate" name="hourly" inputMode="decimal" className="input num w-28" required />
              </div>
              <div className="field">
                <label className="label" htmlFor="space-resource">
                  What it uses up
                </label>
                <input id="space-resource" name="resource" className="input" defaultValue="Laser" required />
              </div>
              <Submit>Set it up</Submit>
            </ActionForm>
            <p className="muted mt-1 text-sm">The rest (bookable hours, two machines at once, tax) is on Calendar → Types.</p>
          </details>
        )}
      </Section>
      <Section title="Coming up (two weeks)">
        {upcoming.length === 0 ? (
          <Empty>No maker-space bookings in the next two weeks.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {upcoming.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2 text-base">
                <Link href={`/calendar/appointments/${a.id}`} className="link">
                  {a.title}
                </Link>
                <span>
                  {a.customer?.name ?? a.name} · {fmtWhen(a.startsAt, tz)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Who is certified">
        {makerCerts.length === 0 ? (
          <Empty>Nobody yet. After the safety class, open the customer&apos;s page and press Certify.</Empty>
        ) : (
          <div className="space-y-3">
            {makerCerts.map((c) => (
              <div key={c.equipment}>
                <h3 className="text-base font-semibold">
                  {c.equipment} ({c.people.length})
                </h3>
                <p className="text-sm">
                  {c.people.map((p, i) => (
                    <span key={p.customerId}>
                      {i > 0 && ", "}
                      <Link href={`/customers/${p.customerId}`} className="link">
                        {p.name}
                      </Link>
                    </span>
                  ))}
                </p>
              </div>
            ))}
          </div>
        )}
      </Section>
    </MakerFrame>
  );
}
