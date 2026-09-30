import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { barcodeSvg } from "@/lib/barcode";
import { PageHeader } from "@/components/ui";
import { PrintButton } from "@/components/print-button";

/** Two-part claim tag: the customer keeps the top, the bottom goes on the machine. */
export default async function ClaimTag({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const { id } = await params;
  const j = await db.repairJob.findUnique({ where: { shopId_id: { shopId: user.shopId, id } }, include: { customer: true, shop: true } });
  if (!j || j.side !== "retail") notFound();
  const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId: user.shopId, id: j.linkId } } });
  const svg = barcodeSvg(`T${j.tag}`, 8);
  const shop = j.shop;

  return (
    <div className="space-y-4">
      <PageHeader back={{ href: `/repairs/${j.id}`, label: `Tag ${j.tag}` }} title="Claim tag" actions={<PrintButton />} />
      <div className="mx-auto max-w-md space-y-0 font-mono text-sm">
        <div className="card card-pad space-y-1">
          <div className="text-center font-bold">{shop.name}</div>
          <div className="text-center text-xs">{[shop.address, shop.phone].filter(Boolean).join(" · ")}</div>
          <div className="flex items-baseline justify-between pt-2">
            <span>CLAIM TAG</span>
            <span className="text-3xl font-bold">{j.tag}</span>
          </div>
          <div>
            {j.customer?.name} {j.customer?.phone}
          </div>
          <div>
            {j.brand} {j.model} {j.serial ? `SN ${j.serial}` : ""}
          </div>
          <div>Left {fmtDate(j.createdAt, tz)}. Repaired by {link?.partnerName}.</div>
          {j.preApprovedCents != null && <div>OK&apos;d up to {money(j.preApprovedCents)} without a call.</div>}
          <div className="text-xs">Bring this tag to collect your machine. We&apos;ll call when it&apos;s ready.</div>
        </div>
        <div className="border-t-2 border-dashed border-line py-1 text-center text-xs">cut here</div>
        <div className="card card-pad space-y-1">
          <div className="flex items-baseline justify-between">
            <span className="font-bold">{shop.name}</span>
            <span className="text-3xl font-bold">{j.tag}</span>
          </div>
          {svg && <div className="w-56" dangerouslySetInnerHTML={{ __html: svg }} />}
          <div>{j.customerName}</div>
          <div>
            {j.brand} {j.model} {j.serial ? `SN ${j.serial}` : ""}
          </div>
          <div>Problem: {j.problem}</div>
          <div>With: {j.accessories.join(", ") || "machine only"}</div>
          <div>For: {link?.partnerName}</div>
        </div>
      </div>
    </div>
  );
}
