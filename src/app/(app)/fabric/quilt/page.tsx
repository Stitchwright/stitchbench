// The quilt planner (shop-features-round-2-design.md 5.3), for companies that sell retail: a pattern and size, or a plain
// quilt; the yards worked out by the program; fabrics from the shelf; the pull list to ring up, print or make a kit.
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { plannerData } from "@/lib/quilt";
import { entryFor } from "@/lib/assistant/ui";
import { PageHeader } from "@/components/ui";
import { QuiltPlanner } from "@/components/quilt-planner";

export default async function QuiltPlannerPage({ searchParams }: { searchParams: Promise<{ pattern?: string }> }) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const { pattern } = await searchParams;
  const data = await plannerData(user.shopId);
  // "Suggest coordinates" with the Assistant on and its quilt switch on (shop-features-round-2-design.md 5.3).
  const ai = await entryFor(user.shopId, "quilt");
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: "/fabric", label: "Fabric" }} title="Plan a quilt" sub="Choose the quilt, then a fabric from your shelves for each part. The yards are worked out for you." />
      {data.more && <p className="muted text-sm">Showing the first {data.fabrics.length} fabrics in stock, by name.</p>}
      <QuiltPlanner patterns={data.patterns} fabrics={data.fabrics} startPattern={typeof pattern === "string" ? pattern : null} ai={ai.show ? { unavailable: ai.unavailable } : null} />
    </div>
  );
}
