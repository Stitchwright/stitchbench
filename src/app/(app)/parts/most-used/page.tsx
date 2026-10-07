import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { startOfMonth } from "@/lib/time-zone";
import { hubFetch, hubJoined } from "@/lib/hub";
import { numberKey } from "@/lib/parts";
import { PageHeader, Empty } from "@/components/ui";
import { ActionButton } from "@/components/action-form";
import { setUsageSharing } from "@/actions/hub";

type Top = {
  from: string;
  to: string;
  shops: number;
  items: { numberKey: string; number: string; brand: string; qty: number; tickets: number; shops: number; xpartId: string | null; name: string | null }[];
};

const PERIODS = [3, 6, 12, 24];

// What gets used the most: in this shop (from the parts that went out on tickets) and across the whole community.
export default async function MostUsed({ searchParams }: { searchParams: Promise<{ view?: string; months?: string; brand?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const view = sp.view === "community" ? "community" : "shop";
  const months = PERIODS.includes(Number(sp.months)) ? Number(sp.months) : 12;
  const brand = sp.brand?.trim() ?? "";
  const since = startOfMonth(await shopTimeZone(user.shopId), months - 1);
  const qs = (o: Record<string, string>) => `/parts/most-used?${new URLSearchParams({ view, months: String(months), ...(brand ? { brand } : {}), ...o })}`;

  let shopRows: { id: string; partNumber: string; description: string; brand: string | null; qtyOnHand: number; reorderAt: number; location: string | null; used: number; tickets: number; supplier: string | null }[] = [];
  let top: Top | null = null;
  let topError: string | null = null;
  const joined = await hubJoined();
  const { shareUsage } = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { shareUsage: true } });

  if (view === "shop") {
    const rows = await db.$queryRaw<{ partId: string; used: bigint; tickets: bigint }[]>`
      SELECT sm."partId", SUM(-sm.qty) AS used, COUNT(DISTINCT sm."ticketId") AS tickets
      FROM "StockMove" sm
      WHERE sm."shopId" = ${user.shopId} AND sm.reason IN ('USED', 'RETURNED') AND sm."createdAt" >= ${since}
      GROUP BY sm."partId" HAVING SUM(-sm.qty) > 0 ORDER BY used DESC LIMIT 300`;
    const parts = await db.part.findMany({
      where: { id: { in: rows.map((r) => r.partId) }, shopId: user.shopId, ...(brand ? { brand: { contains: brand, mode: "insensitive" as const } } : {}) },
      include: { sources: { where: { preferred: true }, take: 1 } },
    });
    const byId = new Map(parts.map((p) => [p.id, p]));
    shopRows = rows
      .filter((r) => byId.has(r.partId))
      .map((r) => {
        const p = byId.get(r.partId)!;
        return {
          id: p.id,
          partNumber: p.partNumber,
          description: p.description,
          brand: p.brand,
          qtyOnHand: p.qtyOnHand,
          reorderAt: p.reorderAt,
          location: p.location,
          used: Number(r.used),
          tickets: Number(r.tickets),
          supplier: p.sources[0]?.vendor ?? p.supplier,
        };
      });
  } else if (joined) {
    try {
      top = (await (await hubFetch(`/v1/usage/top?months=${months}&limit=200${brand ? `&brand=${encodeURIComponent(brand)}` : ""}`, { quick: true, shopRef: user.shopId })).json()) as Top;
    } catch (e) {
      topError = e instanceof Error ? e.message : "Couldn't reach the community hub.";
    }
  }
  const mine = top
    ? await db.part.findMany({
        where: { shopId: user.shopId, numberKeys: { hasSome: top.items.map((i) => i.numberKey) } },
        select: { id: true, numberKeys: true, qtyOnHand: true },
      })
    : [];
  const stockFor = (key: string) => mine.find((p) => p.numberKeys.includes(key) || p.numberKeys.includes(numberKey(key)));

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        back={{ href: "/parts", label: "Parts" }}
        title="Most-used parts"
        sub="What goes out on tickets the most: stock these. The community view adds up every shop on the hub (counts only)."
      />
      <nav className="flex flex-wrap gap-2" aria-label="Whose parts">
        <Link href={qs({ view: "shop" })} className={`btn btn-sm ${view === "shop" ? "btn-primary" : ""}`} aria-current={view === "shop" ? "page" : undefined}>
          Your shop
        </Link>
        <Link href={qs({ view: "community" })} className={`btn btn-sm ${view === "community" ? "btn-primary" : ""}`} aria-current={view === "community" ? "page" : undefined}>
          Community
        </Link>
      </nav>
      <form className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="view" value={view} />
        <label htmlFor="mu-months" className="text-sm">
          Last
        </label>
        <select id="mu-months" name="months" defaultValue={String(months)} className="select w-32">
          {PERIODS.map((m) => (
            <option key={m} value={m}>
              {m} months
            </option>
          ))}
        </select>
        <label htmlFor="mu-brand" className="sr-only">
          Brand
        </label>
        <input id="mu-brand" name="brand" defaultValue={brand} className="input w-48" placeholder="Brand (optional)" />
        <button className="btn btn-sm">Show</button>
      </form>

      <div className="card">
        {view === "shop" ? (
          shopRows.length === 0 ? (
            <div className="card-pad">
              <Empty>No parts used on tickets in this period yet. Parts added to tickets from stock are counted here.</Empty>
            </div>
          ) : (
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Part</th>
                    <th className="text-right">Used</th>
                    <th className="text-right">Tickets</th>
                    <th className="text-right">On hand</th>
                    <th>Buy from</th>
                  </tr>
                </thead>
                <tbody>
                  {shopRows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/parts/${r.id}`} className="link mono">
                          {r.partNumber}
                        </Link>{" "}
                        {r.description}
                        <div className="muted text-xs">{[r.brand, r.location ? `bin ${r.location}` : null].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="num text-right font-semibold">{r.used}</td>
                      <td className="num text-right">{r.tickets}</td>
                      <td className="num text-right">
                        <span className={r.qtyOnHand <= r.reorderAt ? `pill ${r.qtyOnHand <= 0 ? "tone-bad" : "tone-wait"}` : ""}>{r.qtyOnHand}</span>
                      </td>
                      <td className="text-sm">{r.supplier ?? <span className="muted">-</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : !joined ? (
          <div className="card-pad">
            <Empty>
              Join the community hub (<Link href="/settings#hub" className="link">Settings</Link>) to see what shops everywhere use most.
            </Empty>
          </div>
        ) : topError ? (
          <div className="card-pad">
            <Empty>{topError}</Empty>
          </div>
        ) : !top || top.items.length === 0 ? (
          <div className="card-pad">
            <Empty>No shop has reported usage for this period yet. Counts come in as shops use parts on tickets.</Empty>
          </div>
        ) : (
          <>
            <p className="card-pad muted pb-0 text-xs">
              {top.shops} shop{top.shops === 1 ? "" : "s"} reporting, {top.from} to {top.to}.
            </p>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Part</th>
                    <th className="text-right">Shops using it</th>
                    <th className="text-right">Used</th>
                    <th className="text-right">Your stock</th>
                  </tr>
                </thead>
                <tbody>
                  {top.items.map((i) => {
                    const s = stockFor(i.numberKey);
                    return (
                      <tr key={i.numberKey}>
                        <td>
                          <span className="mono">{i.number}</span> {i.name ?? ""}
                          <div className="muted text-xs">
                            {i.brand}
                            {i.xpartId && (
                              <>
                                {" · "}
                                <Link href={`/xref/${i.xpartId}`} className="link">
                                  cross-reference
                                </Link>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="num text-right font-semibold">{i.shops}</td>
                        <td className="num text-right">{i.qty}</td>
                        <td className="num text-right">
                          {s ? (
                            <Link href={`/parts/${s.id}`} className="link">
                              {s.qtyOnHand}
                            </Link>
                          ) : (
                            <span className="muted text-xs">not stocked</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {joined ? (
        <div className="card card-pad flex flex-wrap items-center justify-between gap-3 text-sm">
          <span>
            {shareUsage
              ? "Your shop offers its monthly counts to the community list."
              : "Your shop's counts stay here: they're added to the community list only if you offer them."}{" "}
            <span className="muted">Only part numbers and counts go to the hub: no customers, tickets or prices.</span>
          </span>
          {user.role !== "TECH" && (
            <ActionButton action={setUsageSharing.bind(null, !shareUsage)} className="btn btn-sm" success={shareUsage ? "Counts no longer offered" : "Counts offered"}>
              {shareUsage ? "Stop offering our counts" : "Offer our counts"}
            </ActionButton>
          )}
        </div>
      ) : (
        <p className="muted text-xs">Only part numbers and counts would be shared with the hub, and only if you offer them: no customers, tickets or prices.</p>
      )}
    </div>
  );
}
