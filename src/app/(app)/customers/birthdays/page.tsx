// This month's birthdays (shop-features-round-2-design.md 1.6): a list for a card or a campaign, with the shop's
// birthday offer. Next month is one tap away.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
import { birthdayOfferOf, birthdaysIn, monthName, offerWords } from "@/lib/birthdays";
import { Empty, PageHeader } from "@/components/ui";

export default async function Birthdays({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const now = Number(ymdOf(new Date(), await shopTimeZone(user.shopId)).slice(5, 7));
  const m = Number(sp.m) >= 1 && Number(sp.m) <= 12 ? Number(sp.m) : now;
  const [rows, offer] = await Promise.all([birthdaysIn(user.shopId, m), birthdayOfferOf(user.shopId)]);
  const next = (m % 12) + 1;
  return (
    <div className="space-y-4">
      <PageHeader
        title={`Birthdays in ${monthName(m)}`}
        sub={offer ? `Your birthday offer: ${offerWords(offer)}, shown at the register during her birthday month.` : "No birthday offer set (Settings, Prices and members)."}
        back={{ href: "/customers", label: "Customers" }}
        actions={
          <Link href={`/customers/birthdays?m=${m === now ? next : now}`} className="btn min-h-11">
            {m === now ? `${monthName(next)}'s` : "This month's"}
          </Link>
        }
      />
      {rows.length === 0 ? (
        <Empty>No birthdays on file for {monthName(m)}. Add one on a customer&apos;s page (only if she&apos;d like to tell you).</Empty>
      ) : (
        <ul className="card card-pad divide-y divide-line text-base">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
              <Link href={`/customers/${r.id}`} className="link">
                {r.name}
              </Link>
              <span>
                {monthName(m)} {r.day}
                <span className="muted text-sm"> {[r.phone, r.email].filter(Boolean).join(" · ")}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
