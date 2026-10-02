// Appointment types (scheduling-messaging-design.md 12.2): the table, and the form for admins.
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { money } from "@/lib/format";
import { hoursOf, hoursText } from "@/lib/appointments";
import { saveApptType } from "@/actions/appointments";
import { ApptTypeForm } from "@/components/appt-type-form";
import { ModuleOff } from "@/components/module-off";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function ApptTypesPage() {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const admin = user.role !== "TECH" && gate === "on";
  const types = await db.appointmentType.findMany({ where: { shopId }, orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }] });
  return (
    <div className="space-y-4">
      <PageHeader title="Appointment types" back={{ href: "/calendar", label: "Calendar" }} sub="What people can book: a longarm rental, a lesson, a machine drop-off." />
      {gate === "readonly" && <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />}
      {types.length === 0 ? (
        <Empty>No types yet.</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Length</th>
                <th className="num">Fee</th>
                <th className="num">At once</th>
                <th>Uses</th>
                <th>Bookable</th>
                <th>Where</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.id} className={t.active ? "" : "muted"}>
                  <td>{t.name}</td>
                  <td className="num">{t.minutes} min</td>
                  <td className="num">{t.feeCents ? money(t.feeCents) : "Free"}</td>
                  <td className="num">{t.capacity}</td>
                  <td>{t.resource ?? ""}</td>
                  <td>{hoursText(hoursOf(t.hours))}</td>
                  <td>{t.location ?? ""}</td>
                  <td>{t.active ? "" : <span className="pill tone-neutral">Not bookable</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {admin && (
        <>
          {types.map((t) => (
            <details key={t.id} className="card card-pad">
              <summary className="cursor-pointer font-semibold">Edit {t.name}</summary>
              <div className="mt-3">
                <ApptTypeForm action={saveApptType.bind(null, t.id)} draft={{ ...t, hours: hoursOf(t.hours) }} />
              </div>
            </details>
          ))}
          <Section title="Add a type">
            <ApptTypeForm action={saveApptType.bind(null, null)} draft={null} />
          </Section>
        </>
      )}
    </div>
  );
}
