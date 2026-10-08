// A new class with its first meeting (scheduling-messaging-design.md 12.1). Admins with Scheduling on and the counter.
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { saveClass } from "@/actions/classes";
import { ClassForm } from "@/components/class-form";
import { entryFor } from "@/lib/assistant/ui";
import { isEventKind } from "@/lib/events-math";
import { ModuleOff } from "@/components/module-off";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function NewClassPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const sp = await searchParams;
  const kind = isEventKind(sp.kind) ? sp.kind : "CLASS";
  const user = await requireAdmin();
  const gate = await gateFor(user.shopId, "scheduling");
  if (gate !== "on") return <ModuleOff shopId={user.shopId} module="scheduling" admin />;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  const mk = await entryFor(user.shopId, "marketing");
  return (
    <div className="space-y-4">
      <PageHeader title={kind === "CLASS" ? "New class" : "New event"} back={{ href: "/classes", label: "Classes" }} />
      {shop.sellsRetail ? (
        <Section title={kind === "CLASS" ? "The class" : "The event"}>
          <ClassForm action={saveClass.bind(null, null)} draft={null} isNew kind={kind} drafting={mk.show ? { classId: null, unavailable: mk.unavailable } : null} />
        </Section>
      ) : (
        <Empty>Classes are for shops with the counter: turn &quot;sells retail&quot; on in Settings.</Empty>
      )}
    </div>
  );
}
