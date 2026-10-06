// One kit: the builder, the cost and price numbers, Make N kits and Unmake 1.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { kitFor } from "@/lib/kits";
import { kitMarginPct } from "@/lib/kits-math";
import { qtyText } from "@/lib/register-math";
import { PageHeader } from "@/components/ui";
import { Swatch } from "@/components/fabric-swatch";
import { DeleteKitButton, KitBuilder, MakeKitsForm } from "@/components/kit-forms";

export default async function KitPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const { id } = await params;
  const k = await kitFor(user.shopId, id);
  if (!k) notFound();
  const s = k.suggestion;
  const margin = kitMarginPct(k.priceCents, k.cost);
  return (
    <div className="space-y-4">
      <PageHeader
        back={{ href: "/fabric?tab=kits", label: "Kits" }}
        title={k.name}
        sub={
          <>
            {k.stock ? (
              <>
                Stock item{" "}
                <Link href={`/parts/${k.stock.partId}`} className="link mono">
                  {k.stock.partNumber}
                </Link>
                .{" "}
              </>
            ) : null}
            {k.series ? (
              <Link href={`/fabric/kits/series/${k.series.id}`} className="link">
                Month {k.seriesMonth} of {k.series.name}
              </Link>
            ) : null}
          </>
        }
      />
      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Make kits</h2>
        <MakeKitsForm kitId={k.id} makeable={k.makeable} stock={k.stock?.onHand ?? 0} />
        <p className="muted text-xs">
          Making takes the yards (cut) and items (used) off your shelves, all or nothing, and adds the kits to {k.stock?.partNumber ?? "the kit's stock item"}. Unmaking puts one kit&apos;s parts back as the recipe stands
          now.
        </p>
      </div>
      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">The numbers for one kit</h2>
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="text-right">Amount</th>
                <th className="text-right">Cost</th>
                <th className="text-right">Shelf price</th>
                <th className="text-right">On hand</th>
              </tr>
            </thead>
            <tbody>
              {k.lines.map((l) => (
                <tr key={l.partId}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Swatch photoId={l.photoId} alt={l.description} />
                      <div>
                        <Link href={`/parts/${l.partId}`} className="link mono">
                          {l.partNumber}
                        </Link>
                        <div className="muted text-xs">{l.description}</div>
                      </div>
                    </div>
                  </td>
                  <td className="num text-right">{qtyText(l.qty, l.unit)}</td>
                  <td className="num text-right">{l.costCents == null ? <span className="muted">no cost</span> : `${money(l.lineCost)}`}</td>
                  <td className="num text-right">{l.priceCents == null ? "-" : money(l.lineRetail)}</td>
                  <td className="num text-right">{qtyText(l.onHand, l.unit)}</td>
                </tr>
              ))}
              {(k.pattern || k.patternNote || k.patternCost > 0) && (
                <tr>
                  <td>
                    {k.pattern ? (
                      <>
                        <Link href={`/parts/${k.pattern.id}`} className="link mono">
                          {k.pattern.partNumber}
                        </Link>
                        <div className="muted text-xs">Pattern: {k.pattern.description}</div>
                      </>
                    ) : (
                      <>
                        Pattern
                        <div className="muted text-xs">{k.patternNote ?? "not in stock"}</div>
                      </>
                    )}
                  </td>
                  <td className="num text-right">1</td>
                  <td className="num text-right">{money(k.patternCost)}</td>
                  <td className="num text-right">{k.pattern?.priceCents != null ? money(k.pattern.priceCents) : "-"}</td>
                  <td className="num text-right">{k.pattern ? k.pattern.onHand : "-"}</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className="font-semibold">Total</td>
                <td />
                <td className="num text-right font-semibold">{money(k.cost)}</td>
                <td className="num text-right font-semibold">{money(k.retail)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="text-sm">
          <span className="font-semibold">Suggested price {money(s.priceCents)}</span> (margin {s.marginPct ?? "-"}%):{" "}
          {s.basis === "bundle"
            ? `the parts sell for ${money(s.retailCents)} separately; less the ${k.settings.fabBundleDiscountPct}% bundle discount is ${money(s.byBundle)}, and cost at a ${k.settings.fabKitMarginPct}% margin would only be ${money(s.byMargin)}.`
            : `cost ${money(s.costCents)} at a ${k.settings.fabKitMarginPct}% margin is ${money(s.byMargin)}, more than the parts' shelf prices less the ${k.settings.fabBundleDiscountPct}% bundle discount (${money(s.byBundle)}).`}{" "}
          Your price is <span className="num font-semibold">{k.priceCents == null ? "not set" : money(k.priceCents)}</span>
          {margin != null ? ` (margin ${margin}%)` : ""}. The margin target and discount are in Settings.
        </p>
        {k.lines.some((l) => l.costCents == null) && <p className="muted text-xs">Some items have no cost on file, so they add nothing to the cost: the margin shown is too good until you enter them.</p>}
      </div>
      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Recipe</h2>
        <KitBuilder
          kitId={k.id}
          suggestion={money(s.priceCents)}
          init={{
            name: k.name,
            note: k.note ?? "",
            pattern: k.pattern?.partNumber ?? "",
            patternNote: k.patternNote ?? "",
            patternCost: k.patternCostCents ? (k.patternCostCents / 100).toFixed(2) : "",
            price: k.priceCents == null ? "" : (k.priceCents / 100).toFixed(2),
            lines: k.lines.map((l) => ({ item: l.partNumber, qty: String(l.qty), unit: l.unit })),
          }}
        />
        <div>
          <DeleteKitButton kitId={k.id} />
        </div>
      </div>
    </div>
  );
}
