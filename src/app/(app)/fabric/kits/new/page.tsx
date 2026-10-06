// The kit builder for a new kit; "Use in a kit" on a bolt end opens it with that fabric already on the first line.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { KitBuilder } from "@/components/kit-forms";

export default async function NewKitPage({ searchParams }: { searchParams: Promise<{ fabric?: string }> }) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const { fabric } = await searchParams;
  const part = fabric && /^[a-z0-9]{10,40}$/i.test(fabric) ? await db.part.findFirst({ where: { id: fabric, shopId: user.shopId, consignLinkId: null }, select: { partNumber: true, unit: true } }) : null;
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: "/fabric?tab=kits", label: "Kits" }} title="New kit" sub={part ? `Started with ${part.partNumber}. Say how much of it goes in one kit.` : "Name it, add the fabric, notions and pattern, and let the price suggest itself."} />
      <div className="card card-pad">
        <KitBuilder kitId={null} suggestion={null} init={{ name: "", note: "", pattern: "", patternNote: "", patternCost: "", price: "", lines: part ? [{ item: part.partNumber, qty: "", unit: part.unit }] : [] }} />
      </div>
    </div>
  );
}
