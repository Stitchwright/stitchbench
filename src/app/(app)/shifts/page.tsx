// Staff shifts. Foundation placeholder (owner: shifts).
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { ModuleOff } from "@/components/module-off";
import { Empty, PageHeader } from "@/components/ui";

export default async function ShiftsPage() {
  const user = await requireUser();
  const gate = await gateFor(user.shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={user.shopId} module="scheduling" admin={user.role !== "TECH"} />;
  return (
    <div className="space-y-4">
      <PageHeader title="Staff schedule" />
      {gate === "readonly" && <ModuleOff shopId={user.shopId} module="scheduling" admin={user.role !== "TECH"} />}
      <Empty>Coming in this update.</Empty>
    </div>
  );
}
