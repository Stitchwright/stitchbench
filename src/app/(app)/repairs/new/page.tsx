import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { IntakeForm } from "@/components/intake-form";

export default async function NewRepair() {
  const user = await requireUser();
  const partners = await db.partnerLink.findMany({ where: { shopId: user.shopId, side: "retail", status: "ACTIVE" }, orderBy: { partnerName: "asc" } });
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: "/repairs", label: "Repairs" }} title="Take in a machine" sub="The customer's name and phone stay here. The repair shop sees the first name, last initial and your tag number." />
      {partners.length === 0 ? (
        <p className="card card-pad text-sm">
          Connect to your repair shop first:{" "}
          <Link href="/partners" className="link">
            Partners
          </Link>
          .
        </p>
      ) : (
        <IntakeForm partners={partners.map((p) => ({ id: p.id, name: p.partnerName }))} />
      )}
    </div>
  );
}
