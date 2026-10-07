// Settings → Switching from another system (shop-features-round-2-design.md 4.7): items, customers and gift card balances
// from Square, Rain or Like Sew, or QuickBooks Point of Sale, from each one's own export. Owners and admins.
import { requireUser } from "@/lib/session";
import { SwitchImport } from "@/components/switch-import";
import { PageHeader } from "@/components/ui";

export default async function SwitchPage() {
  const user = await requireUser();
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Switching from another system"
        sub="Bring your items, customers and gift card balances from Square, Rain or Like Sew, or QuickBooks Point of Sale. Nothing changes until you press Bring them in."
        back={{ href: "/settings", label: "Settings" }}
      />
      {user.role === "TECH" ? <p className="card card-pad text-base">An owner or admin brings in another system&apos;s records.</p> : <SwitchImport />}
    </div>
  );
}
