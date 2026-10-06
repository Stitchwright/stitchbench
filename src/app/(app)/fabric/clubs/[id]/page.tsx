// One club (fabric-smarts-design.md section 4a, package F7): this month's pick list (who gets what, shipped or picked up,
// marked done), the members with their payment standing and the ways to pause or cancel, adding a member, and the club's
// own settings.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { fmtDate, money } from "@/lib/format";
import { KIND_LABEL, STATUS_LABEL, cardBillingFor, clubFor, isMonth, monthLabel, monthOf, pickListFor } from "@/lib/clubs";
import { PageHeader } from "@/components/ui";
import { AddMemberForm, ClubSettingsForm, MemberControls, MonthForm, PickControls } from "@/components/club-forms";

const shift = (month: string, by: number) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export default async function ClubPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ month?: string }> }) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const { id } = await params;
  const club = await clubFor(user.shopId, id);
  if (!club) notFound();
  const { month: raw } = await searchParams;
  const now = monthOf(new Date(), club.timeZone);
  const month = isMonth(raw) ? raw : now;
  const [list, card, series] = await Promise.all([pickListFor(user.shopId, id, month), cardBillingFor(user.shopId), db.kitSeries.findMany({ where: { shopId: user.shopId }, orderBy: { name: "asc" }, select: { id: true, name: true } })]);
  if (!list) notFound();
  const s = list.summary;
  const href = (m: string) => `/fabric/clubs/${id}?month=${m}`;
  return (
    <div className="space-y-4">
      <PageHeader
        back={{ href: "/fabric?tab=clubs", label: "Clubs" }}
        title={club.name}
        sub={`${KIND_LABEL[club.kind]}, ${money(club.monthlyCents)} a month. ${club.active} active${club.paused ? `, ${club.paused} paused` : ""}${club.active ? `: ${money(club.monthlyTotalCents)} a month` : ""}.`}
      />
      {club.failed > 0 && (
        <p className="rounded border border-line p-3 text-sm" role="status">
          <span className="pill tone-bad">Payment failed</span> {club.failed} {club.failed === 1 ? "member's" : "members'"} last card payment failed (marked below). Stripe retries on its own schedule; if a card has stopped
          working, cancel the member and add them again to send a new card link.
        </p>
      )}

      <div className="card card-pad space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Pick list: {monthLabel(month)}</h2>
          <Link href={href(shift(month, -1))} className="btn btn-sm" aria-label="Previous month">
            &larr;
          </Link>
          {month !== now && (
            <Link href={href(now)} className="btn btn-sm">
              This month
            </Link>
          )}
          <Link href={href(shift(month, 1))} className="btn btn-sm" aria-label="Next month">
            &rarr;
          </Link>
          <span className="muted text-xs">
            {s.done} of {s.total} done · {s.pickup} to pick up · {s.ship} to ship{s.unpaid ? ` · ${s.unpaid} not paid yet` : ""}
          </span>
        </div>
        <MonthForm clubId={club.id} month={month} what={list.what?.text ?? ""} kitId={list.what?.kitId ?? ""} kits={list.kits} />
        {list.rows.length === 0 ? (
          <p className="muted text-sm">No active members yet.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Pick list">
            {list.rows.map((r) => (
              <li key={r.memberId} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-[12rem] flex-1">
                  <div className="font-medium">{r.name}</div>
                  <div className="muted text-xs">
                    {r.fulfil === "SHIP" ? `Ship${r.address ? `: ${r.address}` : " (no address on file)"}` : "Pick up"}
                    {r.phone ? ` · ${r.phone}` : ""}
                    {r.note ? ` · ${r.note}` : ""}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1 text-xs">
                  {r.failed && <span className="pill tone-bad">Payment failed</span>}
                  {!r.failed && r.awaitingCard && <span className="pill tone-wait">no card yet</span>}
                  {!r.failed && !r.awaitingCard && (r.paid ? <span className="pill tone-ready">paid</span> : <span className="pill tone-wait">{r.billing === "STRIPE" ? "card payment due" : "pay at pickup"}</span>)}
                  {r.doneAt && (
                    <span className="pill tone-ready">
                      {r.doneFulfil === "SHIP" ? "shipped" : "picked up"} {fmtDate(r.doneAt, club.timeZone)}
                      {r.tracking ? ` (${r.tracking})` : ""}
                    </span>
                  )}
                </div>
                <PickControls clubId={club.id} month={month} r={{ memberId: r.memberId, fulfil: r.fulfil, billing: r.billing, paid: r.paid, doneAt: r.doneAt ? r.doneAt.toISOString() : null }} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Members ({club.members.length})</h2>
        {club.members.length === 0 ? (
          <p className="muted text-sm">Nobody has joined yet.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Members">
            {club.members.map((m) => (
              <li key={m.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/customers/${m.customerId}`} className="link font-medium">
                    {m.name}
                  </Link>
                  <span className={`pill ${m.status === "ACTIVE" ? "tone-ready" : m.status === "PAUSED" ? "tone-wait" : "tone-neutral"}`}>{STATUS_LABEL[m.status]}</span>
                  <span className="muted text-xs">
                    {m.billing === "STRIPE" ? "Card" : "Pays at pickup"} · {m.fulfil === "SHIP" ? "ships" : "picks up"} · joined {fmtDate(m.joinedAt, club.timeZone)}
                    {m.paidMonth ? ` · paid through ${monthLabel(m.paidMonth)}` : ""}
                    {m.status !== "CANCELLED" && [m.phone, m.email].filter(Boolean).length ? ` · ${[m.phone, m.email].filter(Boolean).join(" · ")}` : ""}
                  </span>
                  {m.payFailedAt && m.status !== "CANCELLED" && <span className="pill tone-bad">Payment failed {fmtDate(m.payFailedAt, club.timeZone)}</span>}
                  {m.awaitingCard && <span className="pill tone-wait">no card yet</span>}
                </div>
                <MemberControls clubId={club.id} m={{ id: m.id, status: m.status, fulfil: m.fulfil, billing: m.billing, awaitingCard: m.awaitingCard, note: m.note ?? "" }} />
              </li>
            ))}
          </ul>
        )}
        {!club.closed && <AddMemberForm clubId={club.id} cardReady={card.ready} cardWhy={card.why} defaultFulfil={club.fulfil} />}
      </div>

      <details className="card card-pad">
        <summary className="cursor-pointer text-sm font-semibold">Club settings</summary>
        <div className="pt-3">
          <ClubSettingsForm
            clubId={club.id}
            closed={club.closed}
            series={series}
            init={{ name: club.name, kind: club.kind, price: (club.monthlyCents / 100).toFixed(2), fulfil: club.fulfil, billDay: club.billDay ? String(club.billDay) : "", seriesId: club.series?.id ?? "", note: club.note ?? "" }}
          />
        </div>
      </details>
    </div>
  );
}
