// One co-op or rebate claim (shop-features-round-2-design.md 9.2): the proof, the one next step (send it, then what came
// in), turned down and undo folded away, and its details.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
import { COOP_KIND_LABEL, COOP_LABEL, COOP_TONE, coopView, dayWords } from "@/lib/coop-claims";
import { denyCoop, fileCoop, recordCoopPayment, removeCoopProof, saveCoop, undoCoop } from "@/actions/coop-claims";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";
import { PaperFrame } from "@/components/paperwork/frame";
import { CoopFields } from "@/components/paperwork/coop-fields";

export default async function CoopClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [c, tz] = await Promise.all([coopView(user.shopId, id), shopTimeZone(user.shopId)]);
  if (!c) notFound();
  const admin = user.role !== "TECH";
  const dollars = (n: number) => (n ? (n / 100).toFixed(2) : "");
  const settled = ["PAID", "SHORT", "DENIED"].includes(c.status);
  return (
    <PaperFrame
      title={`Claim #${c.number}: ${c.maker}`}
      tab="coop"
      admin={admin}
      back={{ href: "/paperwork/coop", label: "Co-op and rebates" }}
      sub={
        <>
          <span className={`pill ${COOP_TONE[c.status] ?? ""}`}>{COOP_LABEL[c.status] ?? c.status}</span> {COOP_KIND_LABEL[c.kind]}
          {c.program ? ` · ${c.program}` : ""} · claim {money(c.claimCents)} of {money(c.spentCents)} spent
          {c.status === "OPEN" && c.deadline ? ` · send by ${dayWords(c.deadline)}` : ""}
        </>
      }
    >
      {admin && c.status === "OPEN" && (
        <div className="card card-pad">
          <ActionButton action={fileCoop.bind(null, c.id)} className="btn btn-primary">
            I sent it to {c.maker}
          </ActionButton>
        </div>
      )}
      {admin && c.status === "FILED" && (
        <div className="card card-pad space-y-2">
          <h2 className="text-base font-semibold">Money came in from {c.maker}?</h2>
          <ActionForm action={recordCoopPayment.bind(null, c.id)} className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label className="label" htmlFor="cc-amount">
                Amount ($)
              </label>
              <input id="cc-amount" name="amount" inputMode="decimal" className="input num w-32" defaultValue={dollars(c.claimCents)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="cc-on">
                On
              </label>
              <input id="cc-on" name="on" type="date" className="input" defaultValue={ymdOf(new Date(), tz)} />
            </div>
            <Submit>Record what came in</Submit>
          </ActionForm>
          <details>
            <summary className="link cursor-pointer text-sm">They turned it down</summary>
            <ActionForm action={denyCoop.bind(null, c.id)} className="mt-2 flex flex-wrap items-end gap-2">
              <div className="field min-w-64 flex-1">
                <label className="label" htmlFor="cc-why">
                  Why (optional)
                </label>
                <input id="cc-why" name="why" className="input" maxLength={300} />
              </div>
              <Submit className="btn">Mark it turned down</Submit>
            </ActionForm>
          </details>
        </div>
      )}
      {settled && (
        <div className="card card-pad text-base">
          {c.status === "DENIED" ? "Turned down" : `${money(c.receivedCents)} came in`}
          {c.receivedAt ? ` on ${fmtDate(c.receivedAt, tz)}` : ""}
          {c.status === "SHORT" && <span className="pill tone-bad ml-2">{money(c.claimCents - c.receivedCents)} short</span>}
        </div>
      )}

      <Section title={`Proof (${c.proofs.length})`}>
        {c.proofs.length ? (
          <ul className="flex flex-wrap gap-3">
            {c.proofs.map((p) => (
              <li key={p.id} className="space-y-1 text-sm">
                <a href={`/api/paperwork/coop-proof/${p.id}`} target="_blank" rel="noreferrer" className="link block">
                  {/* eslint-disable-next-line @next/next/no-img-element -- the company's own upload, served by its route */}
                  {p.mime.startsWith("image/") ? <img src={`/api/paperwork/coop-proof/${p.id}`} alt={p.name} className="h-32 w-auto rounded border border-line" /> : p.name}
                </a>
                {admin && (
                  <ActionButton action={removeCoopProof.bind(null, c.id, p.id)} className="link text-xs" confirm="Tap again to remove">
                    Remove
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted text-sm">No proof yet. Makers ask for a copy of the ad as it ran and the invoice for it: add a photo below.</p>
        )}
      </Section>

      {admin ? (
        <Section title="Details">
          <ActionForm action={saveCoop.bind(null, c.id)} className="grid gap-3 sm:grid-cols-2">
            <CoopFields
              p="cc-"
              lockClaim={c.status !== "OPEN"}
              d={{ maker: c.maker, kind: c.kind, program: c.program ?? "", adWhere: c.adWhere ?? "", placedOn: c.placedOn ?? "", spent: dollars(c.spentCents), claim: dollars(c.claimCents), deadline: c.deadline ?? "", note: c.note ?? "" }}
            />
            <div className="sm:col-span-2">
              <Submit className="btn">Save</Submit>
            </div>
          </ActionForm>
          {c.status !== "OPEN" && (
            <p className="mt-3 text-sm">
              <ActionButton action={undoCoop.bind(null, c.id)} className="link">
                {settled ? "Undo: not settled yet" : "Undo: not sent yet"}
              </ActionButton>
            </p>
          )}
        </Section>
      ) : (
        c.note && (
          <Section title="Note">
            <p className="text-base whitespace-pre-line">{c.note}</p>
          </Section>
        )
      )}
    </PaperFrame>
  );
}
