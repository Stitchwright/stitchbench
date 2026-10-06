// The Clubs tab (fabric-smarts-design.md section 4a, package F7): the shop's clubs with members, the month's money and
// failed payments, and the form to start one.
import Link from "next/link";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { KIND_LABEL, cardBillingFor, clubsFor } from "@/lib/clubs";
import { Empty } from "@/components/ui";
import { NewClubForm } from "@/components/club-forms";

export async function ClubsTab({ shopId }: { shopId: string }) {
  const [clubs, series, card] = await Promise.all([clubsFor(shopId), db.kitSeries.findMany({ where: { shopId }, orderBy: { name: "asc" }, select: { id: true, name: true } }), cardBillingFor(shopId)]);
  const failed = clubs.reduce((a, c) => a + c.failed, 0);
  return (
    <div className="space-y-4">
      <p className="muted text-sm">
        Clubs are the steadiest money a fabric shop has: a fat quarter club, a fabric club or a Block of the Month at a monthly price. Members pay by card on your own Stripe account, or at pickup; each month&apos;s pick
        list says who gets what, shipped or picked up.
      </p>
      {!card.ready && <p className="card card-pad text-sm">{card.why}</p>}
      {failed > 0 && (
        <p className="rounded border border-line p-3 text-sm" role="status">
          <span className="pill tone-bad">Payment failed</span> {failed} {failed === 1 ? "member's" : "members'"} last card payment failed. Open the club to see who.
        </p>
      )}
      <div className="card">
        {clubs.length === 0 ? (
          <div className="card-pad">
            <Empty>No clubs yet. Start one below.</Empty>
          </div>
        ) : (
          <ul className="divide-y divide-line" aria-label="Clubs">
            {clubs.map((c) => (
              <li key={c.id} className="card-pad flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/fabric/clubs/${c.id}`} className="link font-medium">
                    {c.name}
                  </Link>
                  {c.closed && <span className="pill tone-neutral ml-2">closed</span>}
                  <div className="muted text-xs">
                    {KIND_LABEL[c.kind]} · {money(c.monthlyCents)} a month{c.series ? ` · ${c.series.name}` : ""}
                  </div>
                </div>
                <div className="text-sm">
                  <span className="num font-semibold">{c.active}</span> active
                  {c.paused > 0 && <span className="muted"> · {c.paused} paused</span>}
                  {c.failed > 0 && <span className="pill tone-bad ml-2">{c.failed} payment failed</span>}
                </div>
                <div className="num text-sm">{c.active > 0 ? `${money(c.monthlyTotalCents)} a month` : ""}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card card-pad space-y-2">
        <h2 className="text-sm font-semibold">Start a club</h2>
        <NewClubForm series={series} />
      </div>
    </div>
  );
}
