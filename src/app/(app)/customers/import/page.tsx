// Importing a customer list (scheduling-messaging-design.md 11.3). Admins with Marketing on.
import { requireAdmin } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { CustomerImport } from "@/components/customer-import";
import { ModuleOff } from "@/components/module-off";
import { PageHeader, Section } from "@/components/ui";

export default async function CustomerImportPage() {
  const user = await requireAdmin();
  const gate = await gateFor(user.shopId, "marketing");
  if (gate !== "on") return <ModuleOff shopId={user.shopId} module="marketing" admin />;
  return (
    <div className="space-y-4">
      <PageHeader title="Bring in your email list" back={{ href: "/campaigns", label: "Campaigns" }} />
      <Section title="The list">
        <CustomerImport />
      </Section>
    </div>
  );
}
