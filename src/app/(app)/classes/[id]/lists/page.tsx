// A retreat's room list and meal list to print (shop-features-round-2-design.md 4.5): everyone signed up, grouped by
// what they chose, with dietary needs on the meal list.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { eventView } from "@/lib/events";
import { ModuleOff } from "@/components/module-off";
import { PrintButton } from "@/components/print-button";
import { PageHeader } from "@/components/ui";

export default async function EventLists({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const gate = await gateFor(user.shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={user.shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const v = await eventView(user.shopId, id);
  if (!v) notFound();
  return (
    <div className="space-y-6">
      <PageHeader title={`${v.title}: lists`} back={{ href: `/classes/${v.id}`, label: v.title }} actions={<PrintButton />} />
      {v.choices.list.map((ch) => (
        <section key={ch.key} className="break-after-page space-y-3">
          <h2 className="h2">
            {ch.key === "room" ? "Room list" : ch.key === "meals" ? "Meal list" : ch.label}: {v.title}
          </h2>
          {ch.options.map((o) => {
            const who = v.people.filter((p) => (p.choices[ch.key] ?? ch.options[0].label) === o.label);
            return (
              <div key={o.label}>
                <h3 className="text-base font-semibold">
                  {o.label} ({who.length})
                </h3>
                {who.length === 0 ? (
                  <p className="muted text-base">Nobody</p>
                ) : (
                  <ul className="list-disc pl-6 text-base">
                    {who.map((p) => (
                      <li key={p.id}>
                        {p.attendee ?? p.name}
                        {ch.key === "meals" && p.choices.dietary ? ` (${p.choices.dietary})` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </section>
      ))}
      {v.choices.dietary && (
        <section className="space-y-2">
          <h2 className="h2">Dietary needs</h2>
          <ul className="list-disc pl-6 text-base">
            {v.people
              .filter((p) => p.choices.dietary)
              .map((p) => (
                <li key={p.id}>
                  {p.attendee ?? p.name}: {p.choices.dietary}
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
