import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { hubFetch, type Reputation } from "@/lib/hub";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ListingCard, MarketNav, Stars } from "@/components/market-ui";

type Rep = { asSeller: Reputation; asBuyer: Reputation; recent: { stars: number; comment: string | null; role: string; at: string }[] };

// A shop on the marketplace: how other shops rated it, and what it has for sale.
export default async function ShopPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const [listings, rep] = await Promise.all([
    db.listing.findMany({ where: { sellerId: id, status: "ACTIVE" }, orderBy: { createdAt: "desc" } }),
    hubFetch(`/v1/reputation/${id}`)
      .then((r) => r.json() as Promise<Rep>)
      .catch(() => null),
  ]);
  const name = listings[0]?.shopName ?? (await db.listing.findFirst({ where: { sellerId: id }, select: { shopName: true } }))?.shopName ?? "Shop";

  return (
    <div className="space-y-6">
      <PageHeader back={{ href: "/market", label: "Marketplace" }} title={name} sub="How other shops rated them, and what they have for sale." />
      <MarketNav current="browse" />
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-2">
          <Section title="Ratings">
            {!rep ? (
              <p className="muted text-sm">Couldn&apos;t reach the community hub for ratings right now.</p>
            ) : (
              <div className="space-y-4 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="label">As a seller</div>
                    <Stars avg={rep.asSeller.avg} count={rep.asSeller.count} />
                  </div>
                  <div>
                    <div className="label">As a buyer</div>
                    <Stars avg={rep.asBuyer.avg} count={rep.asBuyer.count} />
                  </div>
                </div>
                {rep.recent.length > 0 && (
                  <ul className="divide-y divide-line">
                    {rep.recent.map((r, i) => (
                      <li key={i} className="py-2">
                        <span className="text-[var(--wait)]" aria-label={`${r.stars} out of 5`}>
                          {"★".repeat(r.stars)}
                          <span className="text-line">{"★".repeat(5 - r.stars)}</span>
                        </span>{" "}
                        <span className="muted text-xs">
                          as {r.role === "seller" ? "seller" : "buyer"} · {fmtDate(r.at)}
                        </span>
                        {r.comment && <div>&ldquo;{r.comment}&rdquo;</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Section>
        </div>
        <div className="xl:col-span-3">
          <Section title={`For sale (${listings.length})`}>
            {listings.length === 0 ? (
              <Empty>Nothing for sale right now.</Empty>
            ) : (
              <ul className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                {listings.map((l) => (
                  <li key={l.id}>
                    <ListingCard l={l} />
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
