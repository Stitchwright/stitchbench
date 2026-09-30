import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { modelKey } from "@/lib/format";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ModelPanel } from "@/components/model-panel";
import { ModelMachines, ModelPhotos } from "@/components/model-history";
import { SharedPosts } from "@/components/shared-posts";
import { ManualLinks } from "@/components/manual-links";
import { PartsThatFit } from "@/components/parts-that-fit";

export default async function ModelPage({ params }: { params: Promise<{ brand: string; model: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const p = await params;
  const brand = decodeURIComponent(p.brand);
  const model = decodeURIComponent(p.model);
  const key = modelKey(model);
  const parts = await db.part.findMany({
    where: { shopId: user.shopId, OR: [{ fits: { contains: model, mode: "insensitive" } }, { fits: { contains: key, mode: "insensitive" } }] },
    orderBy: { partNumber: "asc" },
  });

  return (
    <div className="space-y-6">
      <PageHeader title={`${brand} ${model}`} sub="Factory specs, gotchas, manuals, parts, and every one we've serviced." back={{ href: "/machines", label: "Machines" }} />
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          <ModelPanel shopId={user.shopId} brand={brand} model={model} showLink={false} />
          <ManualLinks brand={brand} model={model} timeZone={tz} />
        </div>
        <div className="space-y-6 xl:col-span-2">
          <ModelMachines shopId={user.shopId} brand={brand} model={model} title="Serviced here" />
          <PartsThatFit shopId={user.shopId} brand={brand} model={model} />
          <ModelPhotos shopId={user.shopId} brand={brand} model={model} title="Inside & wiring photos" />
          <SharedPosts user={user} brand={brand} model={model} title="Shared by techs" />
          <Section title="Parts in stock that fit">
            {parts.length === 0 ? (
              <Empty>No stocked part lists this model in its &ldquo;fits&rdquo; field.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {parts.map((pt) => (
                  <li key={pt.id} className="flex justify-between gap-2 py-2">
                    <Link href={`/parts/${pt.id}`} className="link min-w-0 truncate">
                      <span className="mono">{pt.partNumber}</span> {pt.description}
                    </Link>
                    <span className="num">{pt.qtyOnHand}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
