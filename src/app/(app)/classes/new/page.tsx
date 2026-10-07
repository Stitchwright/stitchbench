// A new class with its first meeting (scheduling-messaging-design.md 12.1). Admins with Scheduling on and the counter.
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { saveClass } from "@/actions/classes";
import { ClassForm } from "@/components/class-form";
import { entryFor } from "@/lib/assistant/ui";
import { ModuleOff } from "@/components/module-off";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function NewClassPage() {
  const user = await requireAdmin();
  const gate = await gateFor(user.shopId, "scheduling");
  if (gate !== "on") return <ModuleOff shopId={user.shopId} module="scheduling" admin />;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  const mk = await entryFor(user.shopId, "marketing");
  return (
    <div className="space-y-4">
      <PageHeader title="New class" back={{ href: "/classes", label: "Classes" }} />
      {shop.sellsRetail ? (
        <Section title="The class">
          <ClassForm action={saveClass.bind(null, null)} draft={null} isNew drafting={mk.show ? { classId: null, unavailable: mk.unavailable } : null} />
        </Section>
      ) : (
        <Empty>Classes are for shops with the counter: turn &quot;sells retail&quot; on in Settings.</Empty>
      )}
    </div>
  );
}
