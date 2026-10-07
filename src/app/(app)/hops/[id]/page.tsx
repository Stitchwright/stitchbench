// One shop hop at this shop (shop-features-round-2-design.md 4.6): "Stamp a passport" with the big tick, today's visitors
// (names only of shoppers who chose to share them with this shop) and totals, stamps waiting for the hub with "Send
// now"; for the organizer, an invite code for another shop, the completed passports and "Draw a winner".
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtTime } from "@/lib/zoned";
import { isUserError } from "@/lib/user-error";
import { completedFor, hopDay } from "@/lib/hops/hops";
import { ruleWords } from "@/lib/hops/hop-math";
import { drawHopWinner, hopNotPresent, leaveHop, makeHopInvite, sendWaitingStamps } from "@/actions/hops";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { HopStamper } from "@/components/hop-stamper";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function HopPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [d, tz] = await Promise.all([hopDay(user.shopId, id), shopTimeZone(user.shopId)]);
  if (!d) notFound();
  const h = d.hop;
  const admin = user.role !== "TECH";
  const organizer = h.role === "ORGANIZER" && admin;
  let org: Awaited<ReturnType<typeof completedFor>> | null = null;
  let orgProblem: string | null = null;
  if (organizer) {
    try {
      org = await completedFor(user, h.id);
    } catch (e) {
      if (!isUserError(e)) throw e;
      orgProblem = e.message;
    }
  }
  const last = org?.draws[org.draws.length - 1] ?? null;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title={h.name} sub={`${h.startsOn} to ${h.endsOn} · ${ruleWords(h.rule, h.shopsCount)} · ${h.shopsCount} shop${h.shopsCount === 1 ? "" : "s"}`} back={{ href: "/hops", label: "Shop hop" }} />
      {h.status === "JOINED" ? <HopStamper hopId={h.id} /> : <p className="card card-pad text-base">This shop left the hop.</p>}

      <Section title={`Today (${d.totals.today})`}>
        <p className="text-base">
          {d.totals.all} passport{d.totals.all === 1 ? "" : "s"} stamped here so far; {d.totals.shared} shared their details with you.
        </p>
        {d.totals.waiting > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="text-base">{d.totals.waiting} waiting to go to the hub.</span>
            <ActionButton action={sendWaitingStamps.bind(null, h.id)} className="btn btn-sm min-h-11">
              Send now
            </ActionButton>
          </div>
        )}
        {d.today.length === 0 ? (
          <Empty>No passports stamped today yet.</Empty>
        ) : (
          <ul className="mt-2 divide-y divide-line text-base">
            {d.today.map((s) => (
              <li key={s.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  {s.name ? `${s.name}${s.email ? ` · ${s.email}` : ""}${s.phone ? ` · ${s.phone}` : ""}` : "A shopper (didn't share her details)"}
                  {s.complete ? <span className="pill tone-ok ml-2">Complete</span> : null}
                </span>
                <span className="muted">
                  {fmtTime(s.at, tz)}
                  {s.stampNo && s.of ? ` · stamp ${s.stampNo} of ${s.of}` : ""}
                  {s.waiting ? " · waiting for the hub" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {organizer && (
        <Section title="Organizer">
          {orgProblem ? (
            <p className="text-base">{orgProblem}</p>
          ) : (
            org && (
              <div className="space-y-4">
                <p className="text-base">
                  {org.passports} passport{org.passports === 1 ? "" : "s"}, {org.stamps} stamp{org.stamps === 1 ? "" : "s"}, <strong>{org.completed.length} complete</strong>.
                </p>
                {last && (
                  <div className="rounded border border-line p-4 text-center" role="status">
                    <p className="muted text-base">{last.prize}</p>
                    <p className="text-4xl font-semibold">{last.name}</p>
                    {!last.present && <p className="muted text-base">Not present</p>}
                    {last.present && (
                      <ActionButton action={hopNotPresent.bind(null, h.id, last.id, last.prize)} className="btn mt-3 min-h-11 text-base">
                        She&apos;s not here: draw again
                      </ActionButton>
                    )}
                  </div>
                )}
                <ActionForm action={drawHopWinner.bind(null, h.id)} className="flex flex-wrap items-end gap-3">
                  <div className="field">
                    <label htmlFor="hop-prize" className="label">
                      The prize
                    </label>
                    <input id="hop-prize" name="prize" className="input text-base" maxLength={120} placeholder="Grand prize" />
                  </div>
                  <Submit className="btn btn-primary min-h-11 px-6 text-lg">Draw a winner</Submit>
                </ActionForm>
                <ActionButton action={makeHopInvite.bind(null, h.id)} className="btn min-h-11 text-base">
                  Invite a shop (make a code)
                </ActionButton>
              </div>
            )
          )}
        </Section>
      )}

      {admin && h.status === "JOINED" && (
        <details>
          <summary className="link cursor-pointer text-base">More choices</summary>
          <div className="mt-3">
            <ActionButton action={leaveHop.bind(null, h.id)} className="btn min-h-11 text-base" confirm="Tap again to leave the hop" success="You left the hop.">
              Leave this hop
            </ActionButton>
          </div>
        </details>
      )}
    </div>
  );
}
