import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { KIND_LABEL } from "@/lib/parts";
import type { CatalogItem } from "@/lib/partners";
import { PageHeader, Empty } from "@/components/ui";
import { PartnerOrderForm } from "@/components/partner-order-form";

export default async function OrderFromPartner({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const { id } = await params;
  const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId: user.shopId, id } } });
  if (!link || link.side !== "retail") notFound();
  const items = (link.catalog as CatalogItem[] | null) ?? [];
  return (
    <div className="space-y-4">
      <PageHeader
        back={{ href: `/partners/${id}`, label: link.partnerName }}
        title={`Order from ${link.partnerName}`}
        sub={link.catalogAt ? `Catalog as of ${fmtDateTime(link.catalogAt, tz)} · ${items.length} items` : undefined}
      />
      {items.length === 0 ? (
        <Empty>{link.partnerName} hasn&apos;t shared a catalog yet. It arrives on the next sync after they mark items &quot;Offer to partner shops&quot;.</Empty>
      ) : (
        <PartnerOrderForm linkId={id} items={items} kindLabel={KIND_LABEL} />
      )}
    </div>
  );
}
