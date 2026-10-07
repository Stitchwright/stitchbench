// One live sale (shop-features-round-2-design.md 4.3), big and simple for a phone or tablet beside the camera: the claim
// form, today's show with what's left, the claims by buyer (Take off, with Undo), and at the end "Send pay links" (one
// link a buyer). Afterwards: who has paid, Send it again, and for a link unpaid after the hold time "Let go of these?".
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";
import { CLAIM_WORDS, liveView } from "@/lib/live-sales";
import { payLinkProblem } from "@/lib/pay-links";
import { claimItem, dropClaim, letGoClaims, resendLiveLink, sendLivePayLinks, setPick, undropClaim } from "@/actions/live-sales";
import { ActionButton } from "@/components/action-form";
import { LiveClaimForm } from "@/components/live-claim-form";
import { Empty, PageHeader, Section } from "@/components/ui";

const TONE: Record<string, string> = { HELD: "tone-wait", SENT: "tone-work", PAID: "tone-ok", LET_GO: "tone-neutral" };

export default async function LiveSalePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [v, problem] = await Promise.all([liveView(user.shopId, id), payLinkProblem(user.shopId)]);
  if (!v) notFound();
  const open = v.status === "OPEN";
  const toSend = v.buyers.filter((b) => !b.webOrderId && b.claims.some((c) => c.status === "HELD")).length;
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={v.name}
        sub={`${v.counts.held} held, ${v.counts.sent} sent, ${v.counts.paid} paid${v.counts.letGo ? `, ${v.counts.letGo} let go` : ""}. Unpaid claims are held ${v.holdHours} hours.`}
        back={{ href: "/register/live", label: "Live sales" }}
      />
      {problem && (
        <p className="card card-pad text-base" role="alert">
          {problem}{" "}
          {user.role !== "TECH" && (
            <Link href="/settings/shop" className="link">
              Open Settings, Online shop
            </Link>
          )}
        </p>
      )}

      {open && <LiveClaimForm claim={claimItem.bind(null, v.id)} addPick={setPick.bind(null, v.id)} picks={v.picks} admin={user.role !== "TECH"} />}

      <Section title="On today's show">
        {v.picks.length === 0 ? (
          <Empty>Nothing picked yet. Search an item above and claim it, or pick the items before the show: they show here with what&apos;s left.</Empty>
        ) : (
          <ul className="divide-y divide-line text-base">
            {v.picks.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {p.description} <span className="muted">{p.partNumber}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className={p.left > 0 ? "num" : "num font-semibold"}>{p.left > 0 ? `${qtyText(p.left, p.unit)} left` : "All claimed"}</span>
                  {open && p.held === 0 && (
                    <ActionButton action={setPick.bind(null, v.id, p.id, false)} className="link min-h-11 text-sm">
                      Take off the show
                    </ActionButton>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Buyers">
        {v.buyers.length === 0 ? (
          <Empty>No claims yet. When a buyer calls out an item, claim it above: the stock is held for her.</Empty>
        ) : (
          <ul className="space-y-3">
            {v.buyers.map((b) => (
              <li key={b.key} className="rounded border border-line p-3 text-base">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">
                    {b.customerId ? (
                      <Link href={`/customers/${b.customerId}`} className="link">
                        {b.name}
                      </Link>
                    ) : (
                      b.name
                    )}
                  </span>
                  <span className="num font-semibold">{money(b.totalCents)}</span>
                </div>
                <ul className="mt-1 space-y-1">
                  {b.claims.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {c.description} x {qtyText(c.qty, c.unit)} at {money(c.priceCents)}
                        {c.unit === "yd" ? "/yd" : ""} <span className={`pill ${TONE[c.status] ?? ""}`}>{CLAIM_WORDS[c.status] ?? c.status}</span>
                      </span>
                      {c.status === "HELD" && (
                        <ActionButton action={dropClaim.bind(null, v.id, c.id)} className="link min-h-11 text-sm" success="Taken off. The stock is free again.">
                          Take off
                        </ActionButton>
                      )}
                      {c.status === "LET_GO" && !b.webOrderId && open && (
                        <ActionButton action={undropClaim.bind(null, v.id, c.id)} className="link min-h-11 text-sm" success="Put back">
                          Undo
                        </ActionButton>
                      )}
                    </li>
                  ))}
                </ul>
                {b.webOrderId && b.claims.some((c) => c.status === "SENT") && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {b.overdue && <span className="text-base">Not paid after {v.holdHours} hours. Let go of these?</span>}
                    {b.overdue ? (
                      <ActionButton action={letGoClaims.bind(null, v.id, b.webOrderId)} className="btn btn-sm min-h-11" success="Let go. The stock is back on the shelf and her link is taken back.">
                        Let go of these
                      </ActionButton>
                    ) : (
                      <ActionButton action={letGoClaims.bind(null, v.id, b.webOrderId)} className="link min-h-11 text-sm" confirm="Tap again to let these go" success="Let go. The stock is back on the shelf and her link is taken back.">
                        Let go
                      </ActionButton>
                    )}
                    <ActionButton action={resendLiveLink.bind(null, v.id, b.webOrderId)} className="btn btn-sm min-h-11">
                      Send it again
                    </ActionButton>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {toSend > 0 && !problem && (
        <div className="flex justify-end">
          <ActionButton action={sendLivePayLinks.bind(null, v.id)} className="btn btn-primary min-h-11 px-6 text-lg" confirm={`Tap again to send ${toSend} pay link${toSend === 1 ? "" : "s"}`}>
            {open ? "End the show and send pay links" : "Send the pay links"}
          </ActionButton>
        </div>
      )}
    </div>
  );
}
