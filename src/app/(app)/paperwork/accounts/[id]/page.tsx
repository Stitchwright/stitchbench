// One house account (shop-features-round-2-design.md 9.4): what she owes and how old, "Take a payment", the charges and
// payments, her statements, and her limit and terms.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
import { PAY_METHODS, accountView, lastMonth } from "@/lib/house-accounts";
import { emailStatement, takeAccountPayment, undoAccountEntry } from "@/actions/house-accounts";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";
import { PaperFrame } from "@/components/paperwork/frame";
import { AccountTerms } from "@/components/paperwork/account-terms";

export default async function HouseAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [a, tz, month] = await Promise.all([accountView(user.shopId, id), shopTimeZone(user.shopId), lastMonth(user.shopId)]);
  if (!a) notFound();
  const c = await db.customer.findFirst({ where: { id: a.customerId, shopId: user.shopId }, select: { id: true, name: true } });
  const admin = user.role !== "TECH";
  return (
    <PaperFrame
      title={`House account: ${c?.name ?? "Deleted customer"}`}
      tab="accounts"
      admin={admin}
      back={{ href: "/paperwork/accounts", label: "House accounts" }}
      sub={`Owes ${money(a.balanceCents)} · ${a.limitCents ? `limit ${money(a.limitCents)}` : "no limit"} · ${a.termsDays} days to pay${a.status === "CLOSED" ? " · closed to new charges" : ""}`}
    >
      <div className="card card-pad space-y-2">
        <h2 className="text-base font-semibold">She paid?</h2>
        <ActionForm action={takeAccountPayment.bind(null, a.id)} reset className="flex flex-wrap items-end gap-2">
          <div className="field">
            <label className="label" htmlFor="ha-amount">
              Amount ($)
            </label>
            <input id="ha-amount" name="amount" inputMode="decimal" className="input num w-32" defaultValue={a.balanceCents > 0 ? (a.balanceCents / 100).toFixed(2) : ""} />
          </div>
          <div className="field">
            <label className="label" htmlFor="ha-method">
              By
            </label>
            <select id="ha-method" name="method" className="select" defaultValue="CHECK">
              {Object.entries(PAY_METHODS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="ha-note">
              Check number
            </label>
            <input id="ha-note" name="note" className="input w-32" maxLength={120} />
          </div>
          <div className="field">
            <label className="label" htmlFor="ha-on">
              On
            </label>
            <input id="ha-on" name="on" type="date" className="input" defaultValue={ymdOf(new Date(), tz)} />
          </div>
          <Submit>Take the payment</Submit>
        </ActionForm>
      </div>
      <Section title="By age">
        <dl className="num grid grid-cols-2 gap-2 text-base sm:grid-cols-5">
          <div>Current {money(a.aging.current)}</div>
          <div>31-60 days {money(a.aging.d30)}</div>
          <div>61-90 {money(a.aging.d60)}</div>
          <div>Over 90 {money(a.aging.d90)}</div>
          <div className="font-semibold">Owed {money(a.aging.total)}</div>
        </dl>
      </Section>
      <Section
        title="Charges and payments"
        actions={
          <span className="flex flex-wrap gap-2">
            <Link href={`/paperwork/accounts/${a.id}/statement?month=${month}`} className="btn btn-sm" target="_blank">
              Print last month&apos;s statement
            </Link>
            {admin && (
              <ActionButton action={emailStatement.bind(null, a.id, month)} className="btn btn-sm">
                Email it
              </ActionButton>
            )}
          </span>
        }
      >
        <ul className="divide-y divide-line">
          {a.entries.map((e) => (
            <li key={e.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 text-base ${e.voidedAt ? "muted line-through" : ""}`}>
              <span>
                {fmtDate(e.at, tz)} · {e.kind === "PAYMENT" ? `Paid by ${PAY_METHODS[e.method as keyof typeof PAY_METHODS]?.toLowerCase() ?? "?"}${e.note ? ` (${e.note})` : ""}` : e.note ?? "Charge"}
                {e.saleId && (
                  <>
                    {" "}
                    <Link href={`/register/sales/${e.saleId}`} className="link text-sm">
                      the sale
                    </Link>
                  </>
                )}
                {e.ticketId && (
                  <>
                    {" "}
                    <Link href={`/tickets/${e.ticketId}`} className="link text-sm">
                      the ticket
                    </Link>
                  </>
                )}
              </span>
              <span className="flex items-center gap-2">
                <span className="num">{e.kind === "PAYMENT" ? `-${money(e.amountCents)}` : money(e.amountCents)}</span>
                {admin && e.kind === "PAYMENT" && !e.voidedAt && (
                  <ActionButton action={undoAccountEntry.bind(null, e.id)} className="link text-sm" confirm="Tap again to undo">
                    Undo
                  </ActionButton>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      {admin && c && (
        <Section title="Limit and terms">
          <AccountTerms customerId={c.id} limitCents={a.limitCents} termsDays={a.termsDays} status={a.status} />
        </Section>
      )}
    </PaperFrame>
  );
}
