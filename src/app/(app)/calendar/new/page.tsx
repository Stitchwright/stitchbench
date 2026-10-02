// Booking (scheduling-messaging-design.md 12.2): the form, with the picked type's free times for the next 7 days.
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { freeWeek, hoursOf, hoursText } from "@/lib/appointments";
import { fmtDay, fmtTime, hmOf, parseYmd, wall, ymdOf, dayStart } from "@/lib/zoned";
import { book } from "@/actions/appointments";
import { AppointmentForm, type FreeDay } from "@/components/appointment-form";
import { ModuleOff } from "@/components/module-off";
import { Empty, PageHeader, Section } from "@/components/ui";

type SP = { type?: string; date?: string; start?: string; customer?: string };

export default async function NewAppointmentPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate !== "on") return <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const sp = await searchParams;
  const tz = await shopTimeZone(shopId);
  const today = ymdOf(new Date(), tz);
  const date = parseYmd(sp.date) ?? today;
  const start = sp.start && /^\d{2}:\d{2}$/.test(sp.start) ? sp.start : "10:00";
  const [types, staff, marketing, customer] = await Promise.all([
    db.appointmentType.findMany({ where: { shopId, active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    db.user.findMany({ where: { shopId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    gateFor(shopId, "marketing").then((g) => g === "on"),
    sp.customer ? db.customer.findFirst({ where: { id: sp.customer, shopId }, select: { id: true, name: true, phone: true } }) : Promise.resolve(null),
  ]);
  const picked = types.find((t) => t.id === sp.type) ?? (types.length === 1 ? types[0] : null);
  let free: FreeDay[] = [];
  if (picked) {
    const week = await freeWeek(db, shopId, picked, date < today ? today : date, tz);
    free = week.map((d) => ({
      ymd: d.ymd,
      label: fmtDay(dayStart(d.ymd, tz), tz),
      starts: d.starts.map((s) => {
        const w = wall(s.start, tz);
        return { hm: hmOf(w.hour * 60 + w.minute), label: fmtTime(s.start, tz), free: s.free };
      }),
    }));
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Book" back={{ href: `/calendar?date=${date}`, label: "Calendar" }} />
      {types.length === 0 ? (
        <Empty>No appointment types yet. {user.role !== "TECH" ? "Add one under Types." : "Ask an owner or admin to add one under Types."}</Empty>
      ) : (
        <Section title={picked ? picked.name : "What are they booking?"}>
          <AppointmentForm
            action={book}
            types={types.map((t) => ({ id: t.id, name: t.name, minutes: t.minutes, feeText: t.feeCents ? money(t.feeCents) : "", hoursText: hoursText(hoursOf(t.hours)), location: t.location }))}
            free={free}
            typeId={picked?.id ?? ""}
            date={date}
            start={start}
            customer={customer}
            staff={staff}
            admin={user.role !== "TECH"}
            marketing={marketing}
          />
        </Section>
      )}
    </div>
  );
}
