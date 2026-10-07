// Software licences (shop-features-round-2-design.md 2.5): codes to fill in (sold with "Add the code later"),
// subscriptions renewing in the next 30 days, and the latest licences sold.
import { requireUser } from "@/lib/session";
import { codesToFillIn, recentLicenses, renewalsDue } from "@/lib/software";
import { LicenseList } from "@/components/software-licenses";
import { PageHeader } from "@/components/ui";

export default async function SoftwarePage() {
  const user = await requireUser();
  const [fill, due, recent] = await Promise.all([codesToFillIn(user.shopId), renewalsDue(user.shopId), recentLicenses(user.shopId, 60)]);
  const admin = user.role !== "TECH";
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader back={{ href: "/parts", label: "Parts" }} title="Software licences" sub="Codes still to give a customer, subscriptions coming up for renewal, and what was sold." />
      <section className="card card-pad space-y-2">
        <h2 className="h2">Codes to fill in ({fill.length})</h2>
        <LicenseList rows={fill} admin={admin} empty="None: every licence sold has its code." />
      </section>
      <section className="card card-pad space-y-2">
        <h2 className="h2">Renewing in the next 30 days ({due.length})</h2>
        <p className="muted text-sm">To renew, ring the software up again for the customer at the register and tick &quot;Renew their subscription&quot;.</p>
        <LicenseList rows={due} admin={admin} empty="No subscriptions renew in the next 30 days." />
      </section>
      <section className="card card-pad space-y-2">
        <h2 className="h2">Sold lately</h2>
        <LicenseList rows={recent} admin={admin} empty="No software sold yet. Make an item with &quot;What is it?&quot; set to Software, then ring it up." />
      </section>
    </div>
  );
}
