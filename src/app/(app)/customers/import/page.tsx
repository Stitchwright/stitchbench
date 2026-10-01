// Importing a customer list. Foundation placeholder (owner: campaigns).
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { ModuleOff } from "@/components/module-off";
import { Empty, PageHeader } from "@/components/ui";

export default async function CustomerImportPage() {
  const user = await requireUser();
  const gate = await gateFor(user.shopId, "marketing");
  if (gate === "hidden") return <ModuleOff shopId={user.shopId} module="marketing" admin={user.role !== "TECH"} />;
  return (
    <div className="space-y-4">
      <PageHeader title="Import customers" />
      {gate === "readonly" && <ModuleOff shopId={user.shopId} module="marketing" admin={user.role !== "TECH"} />}
      <Empty>Coming in this update.</Empty>
    </div>
  );
}
