// The kit builder for a new kit; "Use in a kit" on a bolt end opens it with that fabric already on the first line, and the
// quilt planner's "Make it a kit" with its pull list, pattern and name (shop-features-round-2-design.md 5.3).
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { KitBuilder } from "@/components/kit-forms";
import { pullListItems } from "@/lib/quilt";

export default async function NewKitPage({ searchParams }: { searchParams: Promise<{ fabric?: string; lines?: string; pattern?: string; name?: string }> }) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const sp = await searchParams;
  const { fabric } = sp;
  const part = fabric && /^[a-z0-9]{10,40}$/i.test(fabric) ? await db.part.findFirst({ where: { id: fabric, shopId: user.shopId, consignLinkId: null }, select: { partNumber: true, unit: true } }) : null;
  // From the quilt planner: its pull list (this company's own items only), the pattern and a name.
  const wanted = pullListItems(typeof sp.lines === "string" ? sp.lines : null);
  const planned = wanted.length ? await db.part.findMany({ where: { shopId: user.shopId, id: { in: wanted.map((w) => w.id) }, consignLinkId: null }, select: { id: true, partNumber: true, unit: true } }) : [];
  const fromPlan = wanted.flatMap((w) => {
    const p = planned.find((x) => x.id === w.id);
    return p ? [{ item: p.partNumber, qty: String(w.qty), unit: p.unit }] : [];
  });
  const patternPart = typeof sp.pattern === "string" && /^[a-z0-9]{10,40}$/i.test(sp.pattern) ? await db.part.findFirst({ where: { id: sp.pattern, shopId: user.shopId, kind: "PATTERN" }, select: { partNumber: true } }) : null;
  const name = typeof sp.name === "string" ? sp.name.slice(0, 80) : "";
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: "/fabric?tab=kits", label: "Kits" }} title="New kit" sub={fromPlan.length ? "Started from the quilt plan. Check the amounts, then save." : part ? `Started with ${part.partNumber}. Say how much of it goes in one kit.` : "Name it, add the fabric, notions and pattern, and let the price suggest itself."} />
      <div className="card card-pad">
        <KitBuilder kitId={null} suggestion={null} init={{ name, note: "", pattern: patternPart?.partNumber ?? "", patternNote: "", patternCost: "", price: "", lines: fromPlan.length ? fromPlan : part ? [{ item: part.partNumber, qty: "", unit: part.unit }] : [] }} />
      </div>
    </div>
  );
}
