// Loaners and demos (shop-features-round-2-design.md 1.7): what's out now (overdue first) with "It's back", lend a
// loaner, take a demo out, and the loaner settings. A machine for sale becomes a loaner or demo on its own page.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtYmdLong } from "@/lib/units/units";
import { LOAN_KIND_LABEL, loanDefaults, loansFor, unitsToLend } from "@/lib/loans";
import { saveLoanerSettings } from "@/actions/loans";
import { ActionForm, Submit } from "@/components/action-form";
import { LendForm } from "@/components/lend-form";
import { LoanBackForm } from "@/components/loan-back-form";
import { Empty, PageHeader, Section } from "@/components/ui";
import { db } from "@/lib/db";

export default async function Loans() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [out, loaners, demos, d, tz, shop] = await Promise.all([
    loansFor(user.shopId, { out: true, kinds: ["LOAN", "DEMO"] }),
    unitsToLend(user.shopId, "LOANER"),
    unitsToLend(user.shopId, "DEMO"),
    loanDefaults(user.shopId),
    shopTimeZone(user.shopId),
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { loanerDays: true, loanerDepositCents: true } }),
  ]);
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Loaners and demos" sub="Machines you lend while hers is in for repair, and demos taken to a class, a show or a home." back={{ href: "/units", label: "Machines for sale" }} />
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
        </details>
      )}
    </div>
  );
}
