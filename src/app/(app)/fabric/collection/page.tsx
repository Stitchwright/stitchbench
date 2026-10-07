// Add a collection (fabric-smarts-design.md section 3, item 3): the maker, collection and designer once, then a row per colorway.
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { CollectionForm } from "@/components/collection-form";
import { entryFor } from "@/lib/assistant/ui";

export default async function AddCollectionPage() {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  return (
    <div className="space-y-4">
      <PageHeader title="Add a collection" sub="A new collection arrives as a dozen colorways: the maker, collection and designer once, then a row each." back={{ href: "/fabric", label: "Fabric" }} />
      <div className="card card-pad">
        <CollectionForm label={await entryFor(user.shopId, "fabric")} />
      </div>
    </div>
  );
}
