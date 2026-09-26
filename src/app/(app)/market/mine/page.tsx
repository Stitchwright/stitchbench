import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hubJoined } from "@/lib/hub";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ListingCard, MarketNav } from "@/components/market-ui";
import { ListingForm } from "@/components/listing-form";

export default async function MyListings() {
  const user = await requireUser();
  const [joined, listings, shop] = await Promise.all([
    hubJoined(),
    db.listing.findMany({ where: { mine: true, shopId: user.shopId }, orderBy: { createdAt: "desc" } }),
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { payInstructions: true } }),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title="My listings" sub="What your shop has for sale to other shops." />
      <MarketNav current="mine" />
      {!joined ? (
        <p className="pill tone-wait inline-block">
          The marketplace is on the community hub. <Link href="/settings#hub" className="link">Join it in Settings</Link>.
        </p>
      ) : (
        <>
          {!shop.payInstructions && (
            <p className="pill tone-wait inline-block">
              Add how other shops pay you (PayPal, Zelle, check to...) in <Link href="/settings" className="link">Settings → Shop</Link>. It goes on
              your invoices.
            </p>
          )}
          {listings.length === 0 ? (
            <Empty>Nothing listed yet. List a spare part below, or from a part&apos;s page (&ldquo;Sell it on the marketplace&rdquo;).</Empty>
          ) : (
            <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
              {listings.map((l) => (
                <li key={l.id}>
                  <ListingCard l={l} />
                </li>
              ))}
            </ul>
          )}
          <Section title="List something for sale">
            <ListingForm />
          </Section>
        </>
      )}
    </div>
  );
}
