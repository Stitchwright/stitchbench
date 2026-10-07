// The Kits tab (fabric-smarts-design.md section 2, item 5): each kit with its stock, cost, price, margin and sell-through,
// and Block of the Month series.
import Link from "next/link";
import { money } from "@/lib/format";
import { kitsFor, seriesListFor } from "@/lib/kits";
import { Empty } from "@/components/ui";
import { Swatch } from "@/components/fabric-swatch";
import { NewSeriesForm } from "@/components/kit-forms";

export async function KitsTab({ shopId }: { shopId: string }) {
  const [kits, series] = await Promise.all([kitsFor(shopId), seriesListFor(shopId)]);
  return (
    <div className="space-y-4">
      <p className="muted text-sm">
        A kit is a recipe: fabric cuts, a pattern and notions, with a price. Making kits takes the yards and items off your shelves and adds the kits to the kit&apos;s own stock item, which sells at the register
        like anything else. Margin is the price less the parts&apos; cost, as a share of the price. Sold counts are completed sales.
      </p>
      <div className="card">
        {kits.length === 0 ? (
          <div className="card-pad">
            <Empty>No kits yet. Start one with &quot;New kit&quot;, or from a bolt end with &quot;Use in a kit&quot;.</Empty>
          </div>
        ) : (
          <ul className="divide-y divide-line" aria-label="Kits">
            {kits.map((k) => (
              <li key={k.id} className="card-pad flex flex-wrap items-start gap-3">
                <Swatch photoId={k.photoId} alt={k.name} />
                <div className="min-w-0 flex-1 space-y-1">
                  <Link href={`/fabric/kits/${k.id}`} className="link font-medium">
                    {k.name}
                  </Link>
                  {k.series && (
                    <div className="muted text-xs">
                      {k.series}, month {k.seriesMonth}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <span>
                      <span className="num font-semibold">{k.stock}</span> in stock
                    </span>
                    {k.makeable != null && <span className="muted">shelf covers {k.makeable} more</span>}
                    <span>
                      cost <span className="num">{money(k.cost)}</span>
                    </span>
                    <span>
                      price <span className="num">{k.priceCents == null ? "-" : money(k.priceCents)}</span>
                    </span>
                    <span>
                      margin <span className="num">{k.marginPct == null ? "-" : `${k.marginPct}%`}</span>
                    </span>
                    <span className="muted">
                      sold <span className="num">{k.sold30}</span> in 30 days, <span className="num">{k.sold90}</span> in 90
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Block of the Month</h2>
        <p className="muted text-xs">A series of kits, one a month (up to 12), with a sign-up roster of your customers and each month&apos;s handout marked done.</p>
        {series.length > 0 && (
          <ul className="divide-y divide-line">
            {series.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-4 py-2 text-sm">
                <Link href={`/fabric/kits/series/${s.id}`} className="link font-medium">
                  {s.name}
                </Link>
                <span className="muted">
                  {s.kits} of {s.months} months have a kit · {s.done} handouts done · {s.members} signed up
                </span>
              </li>
            ))}
          </ul>
        )}
        <NewSeriesForm />
      </div>
    </div>
  );
}
