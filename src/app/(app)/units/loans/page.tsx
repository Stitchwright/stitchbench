// Loaners and demos (shop-features-round-2-design.md 1.7): what's out now (overdue first) with "It's back", lend a
// loaner, take a demo out, and the loaner settings. A machine for sale becomes a loaner or demo on its own page.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtYmdLong } from "@/lib/units/units";
import { LOAN_KIND_LABEL, loanDefaults, loansFor, unitsToLend } from "@/lib/loans";
import { saveLoanerSettings } from "@/actions/loans";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { LendForm } from "@/components/lend-form";
import { LoanBackForm } from "@/components/loan-back-form";
import { Empty, PageHeader, Section } from "@/components/ui";
import { db } from "@/lib/db";
import { rentalsFor, rentalsIn } from "@/lib/rentals";
import { saveTrialDays, sendRentLink } from "@/actions/rentals";
import { RentalMoney, RentOutForm } from "@/components/rental-forms";

export default async function Loans() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [rentals, rentable] = await Promise.all([rentalsFor(user.shopId), rentalsIn(user.shopId)]);
  const [out, loaners, demos, d, tz, shop] = await Promise.all([
    loansFor(user.shopId, { out: true, kinds: ["LOAN", "DEMO"] }),
    unitsToLend(user.shopId, "LOANER"),
    unitsToLend(user.shopId, "DEMO"),
    loanDefaults(user.shopId),
    shopTimeZone(user.shopId),
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { loanerDays: true, loanerDepositCents: true, trialDays: true } }),
  ]);
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Loaners, demos and rentals" sub="Machines you lend while hers is in for repair, demos taken to a class, a show or a home, and machines rented out." back={{ href: "/units", label: "Machines for sale" }} />
      <Section title={`Out now${out.length ? ` (${out.length})` : ""}`}>
        {out.length === 0 ? (
          <Empty>Nothing is out. Lend a loaner below, or from a repair ticket.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {out.map((l) => (
              <li key={l.id} className="space-y-2 py-3 text-base">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="pill tone-neutral mr-1">{LOAN_KIND_LABEL[l.kind]}</span>
                    <Link href={`/units/loans/${l.id}`} className="link font-semibold">
                      {l.machine}
                    </Link>
                    {l.customer && (
                      <>
                        {" "}
                        with{" "}
                        <Link href={`/customers/${l.customer.id}`} className="link">
                          {l.customer.name}
                        </Link>
                      </>
                    )}
                  </span>
                  <span>
                    {l.dueOn ? `due ${fmtYmdLong(l.dueOn)}` : `out since ${fmtDate(l.outAt, tz)}`}
                    {l.overdue && <span className="pill tone-wait ml-2">Overdue</span>}
                    {l.heldCents > 0 && <span className="muted"> · {money(l.heldCents)} deposit</span>}
                  </span>
                </div>
                <details>
                  <summary className="link cursor-pointer text-base">It&apos;s back</summary>
                  <div className="mt-2">
                    <LoanBackForm loanId={l.id} heldCents={l.heldCents} admin={admin} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Lend a loaner">
        <LendForm units={loaners} customer={null} dueOn={d.dueOn} depositCents={d.depositCents} />
      </Section>
      <Section title={`Rentals${rentals.length ? ` out (${rentals.length})` : ""}`}>
        {rentals.length === 0 ? (
          <p className="muted text-base">No rentals out.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rentals.map((r) => (
              <li key={r.id} className="space-y-2 py-3 text-base">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="font-semibold">{r.machine}</span>
                    {r.customer && (
                      <>
                        {" "}
                        with{" "}
                        <Link href={`/customers/${r.customer.id}`} className="link">
                          {r.customer.name}
                        </Link>
                      </>
                    )}{" "}
                    · {money(r.rateCents)} a {r.ratePer}
                  </span>
                  <span>
                    paid through {fmtYmdLong(r.paidThrough)}
                    {r.overdue && <span className="pill tone-wait ml-2">Rent overdue</span>}
                  </span>
                </div>
                {r.ownUntil && r.creditCents > 0 && (
                  <p className="muted text-sm">
                    Rent-to-own: {money(r.creditCents)} counts toward buying it, until {fmtYmdLong(r.ownUntil)}.
                  </p>
                )}
                {admin && <RentalMoney loanId={r.id} rateCents={r.rateCents} ratePer={r.ratePer} creditCents={r.creditCents} priceCents={r.priceCents} />}
                <div className="flex flex-wrap gap-2">
                  {admin && (
                    <ActionButton action={sendRentLink.bind(null, r.id)} className="btn btn-sm min-h-11" confirm={`Tap again to send a link for ${money(r.rateCents)} plus tax`}>
                      Send the rent as a pay link
                    </ActionButton>
                  )}
                </div>
                <details>
                  <summary className="link cursor-pointer text-base">It&apos;s back (the rental ends)</summary>
                  <div className="mt-2">
                    <LoanBackForm loanId={r.id} heldCents={0} admin={admin} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <details className="mt-3">
            <summary className="link cursor-pointer text-base">Rent one out</summary>
            <div className="mt-2">
              <RentOutForm units={rentable} />
            </div>
          </details>
        )}
      </Section>
      <details className="card card-pad">
        <summary className="link cursor-pointer text-base">Take a demo out</summary>
        <div className="mt-3">
          <LendForm units={demos} kind="DEMO" customer={null} dueOn={d.dueOn} depositCents={0} />
        </div>
      </details>
      {admin && (
        <details className="card card-pad">
          <summary className="link cursor-pointer text-base">Loaner settings</summary>
          <ActionForm action={saveLoanerSettings} success="Saved" className="mt-3 flex flex-wrap items-end gap-3 text-base">
            <div className="field">
              <label htmlFor="ls-deposit" className="label">
                Deposit by default (0: none)
              </label>
              <input id="ls-deposit" name="deposit" className="input num w-28" inputMode="decimal" defaultValue={(shop.loanerDepositCents / 100).toFixed(2)} />
            </div>
            <div className="field">
              <label htmlFor="ls-days" className="label">
                Lent for (days)
              </label>
              <input id="ls-days" name="days" className="input num w-20" inputMode="numeric" defaultValue={shop.loanerDays} />
            </div>
            <Submit className="btn min-h-11">Save</Submit>
          </ActionForm>
          <ActionForm action={saveTrialDays} success="Saved" className="mt-3 flex flex-wrap items-end gap-3 text-base">
            <div className="field">
              <label htmlFor="ls-trial" className="label">
                Machines sold with &quot;Try it for&quot; this many days (0: off)
              </label>
              <input id="ls-trial" name="trialDays" className="input num w-20" inputMode="numeric" defaultValue={shop.trialDays} />
            </div>
            <Submit className="btn min-h-11">Save</Submit>
          </ActionForm>
        </details>
      )}
    </div>
  );
}
