// The Fabric page (fabric-smarts-design.md section 2), for companies that sell retail. Package F1 has the Bolt ends tab;
// What sells, Slow fabric, Reorder and Kits join it in F2 to F4.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { boltEndsFor } from "@/lib/fabric";
import { cutWords } from "@/lib/fabric-math";
import { qtyText } from "@/lib/register-math";
import { Empty, PageHeader } from "@/components/ui";
import { FabricCuts } from "@/components/fabric-cuts";

export default async function FabricPage() {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const { rows, limit } = await boltEndsFor(user.shopId);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Fabric"
        sub={`Bolt ends: ${qtyText(limit, "yd")} or less left, none on order. Cut them into fat quarters before they sit.`}
        actions={
          <Link href="/fabric/collection" className="btn btn-primary">
            Add a collection
          </Link>
        }
      />
      <nav className="flex flex-wrap gap-2" aria-label="Fabric tabs">
        <span className="btn btn-sm btn-primary" aria-current="page">
          Bolt ends ({rows.length})
        </span>
      </nav>
      <div className="card">
        {rows.length === 0 ? (
          <div className="card-pad">
            <Empty>No bolt ends right now. Fabric with {qtyText(limit, "yd")} or less left (and none on order) shows up here.</Empty>
          </div>
        ) : (
          <ul className="divide-y divide-line" aria-label="Bolt ends">
            {rows.map((r) => (
              <li key={r.id} className="card-pad flex flex-wrap items-start gap-3">
                {r.photoId ? (
                  // eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset
                  <img src={`/api/parts/photo/${r.photoId}`} alt={`${r.description} swatch`} className="h-16 w-16 shrink-0 rounded border border-line object-cover" loading="lazy" />
                ) : (
                  <div className="muted flex h-16 w-16 shrink-0 items-center justify-center rounded border border-dashed border-line text-xs" aria-hidden="true">
                    no photo
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  <div>
                    <Link href={`/parts/${r.id}`} className="link mono">
                      {r.partNumber}
                    </Link>{" "}
                    {r.description}
                    <div className="muted text-xs">
                      {[r.brand, r.collection].filter(Boolean).join(" · ")}
                      {r.priceCents != null ? ` · ${money(r.priceCents)}/yd` : " · no price yet"}
                    </div>
                  </div>
                  <div className="text-sm">
                    <span className="num font-semibold">{qtyText(r.qtyOnHand, "yd")}</span> left. {cutWords("FQ", r.qtyOnHand)}
                  </div>
                  <FabricCuts id={r.id} yards={r.qtyOnHand} hasPrice={r.priceCents != null} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
