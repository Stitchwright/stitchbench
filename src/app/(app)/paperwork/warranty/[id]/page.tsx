// One warranty claim (shop-features-round-2-design.md 9.1): the lines claimed from the ticket, the maker's claim number,
// the one next step as the main button (sent, then what came in), refused and undo folded away.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, money, ticketNo } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
import { LINE_LABEL } from "@/lib/constants";
import { CLAIM_LABEL, CLAIM_TONE, claimView } from "@/lib/warranty-claims";
import { fileClaim, recordClaimPayment, refuseClaim, saveClaim, undoClaimStep } from "@/actions/warranty-claims";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";
import { PaperFrame } from "@/components/paperwork/frame";

export default async function WarrantyClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [c, tz] = await Promise.all([claimView(user.shopId, id), shopTimeZone(user.shopId)]);
  if (!c) notFound();
  const admin = user.role !== "TECH";
  const dollars = (n: number) => (n / 100).toFixed(2);
  const settled = ["PAID", "SHORT", "REFUSED"].includes(c.status);
  return (
    <PaperFrame
      title={`Claim #${c.number} to ${c.maker}`}
      tab="warranty"
      admin={admin}
      back={{ href: "/paperwork/warranty", label: "Warranty claims" }}
      sub={
        <>
          <span className={`pill ${CLAIM_TONE[c.status] ?? ""}`}>{CLAIM_LABEL[c.status] ?? c.status}</span>
          {c.ticket && (
            <>
              {" "}
              for{" "}
              <Link href={`/tickets/${c.ticket.id}`} className="link">
                ticket {ticketNo(c.ticket.number)}
              </Link>
              {c.ticket.customer ? ` (${c.ticket.customer.name})` : ""}
            </>
          )}
          {c.machine && ` · ${c.machine.brand} ${c.machine.model}${c.machine.serial ? `, serial ${c.machine.serial}` : ""}`}
        </>
      }
    >
      {c.status === "OPEN" && (
        <div className="card card-pad space-y-2">
          <h2 className="text-base font-semibold">Sent it through {c.maker}&apos;s website?</h2>
          <ActionForm action={fileClaim.bind(null, c.id)} className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label className="label" htmlFor="wc-file-number">
                Their claim number (optional)
              </label>
              <input id="wc-file-number" name="claimNumber" className="input mono" defaultValue={c.claimNumber ?? ""} />
            </div>
            <Submit>Mark it sent</Submit>
          </ActionForm>
        </div>
      )}
      {c.status === "FILED" && admin && (
        <div className="card card-pad space-y-2">
          <h2 className="text-base font-semibold">Money came in from {c.maker}?</h2>
          <ActionForm action={recordClaimPayment.bind(null, c.id)} className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label className="label" htmlFor="wc-amount">
                Amount ($)
              </label>
              <input id="wc-amount" name="amount" inputMode="decimal" className="input num w-32" defaultValue={dollars(c.expectedCents)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="wc-on">
                On
              </label>
              <input id="wc-on" name="on" type="date" className="input" defaultValue={ymdOf(new Date(), tz)} />
            </div>
            <Submit>Record what came in</Submit>
          </ActionForm>
          <details>
            <summary className="link cursor-pointer text-sm">They refused it</summary>
            <ActionForm action={refuseClaim.bind(null, c.id)} className="mt-2 flex flex-wrap items-end gap-2">
              <div className="field min-w-64 flex-1">
                <label className="label" htmlFor="wc-why">
                  Why (optional)
                </label>
                <input id="wc-why" name="why" className="input" maxLength={300} />
              </div>
              <Submit className="btn">Mark it refused</Submit>
            </ActionForm>
          </details>
        </div>
      )}
      {settled && (
        <div className="card card-pad text-base">
          {c.status === "REFUSED" ? "Refused" : `${money(c.receivedCents)} came in`}
          {c.receivedAt ? ` on ${fmtDate(c.receivedAt, tz)}` : ""}
          {c.status === "SHORT" && <span className="pill tone-bad ml-2">{money(c.expectedCents - c.receivedCents)} short</span>}
        </div>
      )}

      <Section title="What is claimed">
        <table className="table">
          <thead>
            <tr>
              <th>Line</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Each</th>
            </tr>
          </thead>
          <tbody>
            {c.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  <span className="label mr-2">{LINE_LABEL[l.kind as keyof typeof LINE_LABEL] ?? l.kind}</span>
                  {l.description}
                </td>
                <td className="num text-right">{l.qty}</td>
                <td className="num text-right">{money(l.coveredCents ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="num mt-3 ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
          <dt className="muted">Parts</dt>
          <dd className="text-right">{money(c.partsCents)}</dd>
          <dt className="muted">Labour</dt>
          <dd className="text-right">{money(c.laborCents)}</dd>
          <dt className="font-semibold">Expected from {c.maker}</dt>
          <dd className="text-right font-semibold">{money(c.expectedCents)}</dd>
        </dl>
        {c.status === "OPEN" && <p className="muted mt-2 text-sm">Add more from the ticket: &quot;Claim it from the maker&quot; on a line. &quot;Charge it instead&quot; there takes a line off.</p>}
      </Section>

      <Section title="Details">
        <ActionForm action={saveClaim.bind(null, c.id)} className="grid gap-3 sm:grid-cols-2">
          <div className="field">
            <label className="label" htmlFor="wc-maker">
              Maker
            </label>
            <input id="wc-maker" name="maker" className="input" required maxLength={80} defaultValue={c.maker} />
          </div>
          <div className="field">
            <label className="label" htmlFor="wc-number">
              Their claim number
            </label>
            <input id="wc-number" name="claimNumber" className="input mono" maxLength={60} defaultValue={c.claimNumber ?? ""} />
          </div>
          {admin && c.status === "OPEN" && (
            <div className="field">
              <label className="label" htmlFor="wc-expected">
                Amount expected ($)
              </label>
              <input id="wc-expected" name="expected" inputMode="decimal" className="input num w-32" defaultValue={dollars(c.expectedCents)} />
              <p className="muted text-sm">Filled in from the lines. Change it if the maker pays labour at its own rate.</p>
            </div>
          )}
          <div className="field sm:col-span-2">
            <label className="label" htmlFor="wc-note">
              Note
            </label>
            <textarea id="wc-note" name="note" className="input" rows={3} maxLength={1000} defaultValue={c.note ?? ""} />
          </div>
          <div className="sm:col-span-2">
            <Submit className="btn">Save</Submit>
          </div>
        </ActionForm>
      </Section>

      {admin && c.status !== "OPEN" && (
        <p className="text-sm">
          <ActionButton action={undoClaimStep.bind(null, c.id)} className="link">
            {settled ? "Undo: not settled yet" : "Undo: not sent yet"}
          </ActionButton>
        </p>
      )}
    </PaperFrame>
  );
}
