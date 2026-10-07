// One layaway (tax-machine-sales-layaway-design.md section 4): what is held, what it comes to with today's tax, the
// payment plan and what has been paid (each payment's receipt), and what is left. Payments and the pick-up happen at
// the register; an owner or admin cancels here by the shop's rule.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { gateFor } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { layawaySettings, layawayView } from "@/lib/layaway";
import { cancelSplit, EVERY_LABEL, LAYAWAY_STATUS_LABEL, planProgress } from "@/lib/layaway-math";
import { lineNet, qtyText } from "@/lib/register-math";
import { fmtYmdLong } from "@/lib/units/units";
import { ymdOf } from "@/lib/zoned";
import { cancelLayaway, remindLayaway } from "@/actions/layaway";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { KV, PageHeader, Section } from "@/components/ui";

export default async function LayawayPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const l = await layawayView(user.shopId, id);
  if (!l) notFound();
  const [tz, settings, marketing] = await Promise.all([shopTimeZone(user.shopId), layawaySettings(user.shopId), gateFor(user.shopId, "marketing")]);
  const today = ymdOf(new Date(), tz);
  const admin = user.role !== "TECH";
  const open = l.status === "OPEN";
  const split = cancelSplit(l.paidCents, settings.feeCents, settings.feePct);
  const plan = planProgress(l.plan, l.depositMinCents, l.paidCents, today);
  const finished = l.completedAt ?? l.cancelledAt;
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={`Layaway #${l.number}`}
        back={{ href: "/layaways", label: "Layaways" }}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <span className={`pill ${open ? (l.behindCents ? "tone-wait" : "tone-ready") : "tone-done"}`}>{LAYAWAY_STATUS_LABEL[l.status] ?? l.status}</span>
            {l.customer && (
              <Link href={`/customers/${l.customer.id}`} className="link">
                {l.customer.name}
              </Link>
            )}
            <span>started {fmtDate(l.startedAt, tz)}</span>
          </span>
        }
        actions={
          <>
            <Link href={`/layaways/${l.id}/print`} className="btn">
              Print the terms
            </Link>
            {open && (
              <Link href="/register" className="btn btn-primary">
                Take a payment at the register
              </Link>
            )}
          </>
        }
      />

      <Section title="Money">
        <div className="grid gap-4 sm:grid-cols-3">
          <KV k="Items" v={money(l.priceCents)} />
          <KV k={open ? "Tax if picked up today" : "Tax"} v={money(l.taxCents)} />
          <KV k="Total" v={money(l.owedCents)} />
          <KV k="Paid" v={money(l.paidCents)} />
          {open && <KV k="Left to pay" v={<span className="text-lg font-semibold">{money(l.leftCents)}</span>} />}
          {open && <KV k="Pay off by" v={fmtYmdLong(l.dueBy)} />}
          {l.behindCents > 0 && <KV k="Behind" v={<span className="pill tone-wait">{money(l.behindCents)}</span>} />}
          {l.cancelFeeCents != null && <KV k="Cancel fee kept" v={money(l.cancelFeeCents)} />}
          {l.saleId && finished && (
            <KV
              k={l.status === "COMPLETED" ? "Picked up" : "Cancelled"}
              v={
                <Link href={`/register/sales/${l.saleId}`} className="link">
                  {fmtDate(finished, tz)}: the receipt
                </Link>
              }
            />
          )}
        </div>
        {open && l.customer && marketing === "on" && (
          <div className="mt-3">
            <ActionButton action={remindLayaway.bind(null, l.id)} className="btn btn-sm" success="Reminder on its way">
              Send a friendly reminder
            </ActionButton>
          </div>
        )}
      </Section>

      <Section title="Held items">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Price</th>
            </tr>
          </thead>
          <tbody>
            {l.lines.map((x) => (
              <tr key={x.id}>
                <td>
                  {x.stockUnitId ? (
                    <Link href={`/units/${x.stockUnitId}`} className="link">
                      {x.description}
                    </Link>
                  ) : (
                    x.description
                  )}
                </td>
                <td className="num text-right">{qtyText(x.qty, null)}</td>
                <td className="num text-right">{money(lineNet(x))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={`Payment plan (${EVERY_LABEL[l.every]})`}>
        <ul className="divide-y divide-line text-sm">
          <li className="flex justify-between py-2">
            <span>Deposit</span>
            <span className="num">{money(l.depositMinCents)}</span>
          </li>
          {plan.map((p) => (
            <li key={p.due} className="flex justify-between py-2">
              <span>
                {fmtYmdLong(p.due)}
                {p.paid ? <span className="pill tone-done ml-2">Paid</span> : p.late ? <span className="pill tone-wait ml-2">Late</span> : null}
              </span>
              <span className="num">{money(p.cents)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Payments">
        {l.payments.length === 0 ? (
          <p className="muted text-sm">No payments yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {l.payments.map((p, i) => (
              <li key={i} className="flex justify-between py-2">
                <Link href={`/register/sales/${p.saleId}`} className="link">
                  {fmtDate(p.at, tz)}: sale #{p.number}
                  {p.kind === "LAYAWAY_FEE" ? " (cancel fee)" : p.cents < 0 ? " (used at pick-up, or given back)" : ""}
                </Link>
                <span className="num">{money(p.cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {open && admin && (
        <Section title="Cancel">
          <details>
            <summary className="link cursor-pointer text-sm">Cancel this layaway</summary>
            <ActionForm action={cancelLayaway.bind(null, l.id)} success="Layaway cancelled. The items are back on sale." className="mt-3 space-y-3">
              <p className="text-sm">
                They paid {money(l.paidCents)}. {split.fee > 0 ? `Your rule keeps ${money(split.fee)}; ` : ""}
                {money(split.back)} goes back to them. The items go back on sale.
              </p>
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="refund" value="credit" defaultChecked={settings.refund === "credit"} /> As store credit
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="refund" value="money" defaultChecked={settings.refund === "money"} /> As money:
                </label>
                <select name="method" className="select w-auto" defaultValue="CASH" aria-label="Paid back by">
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="CHECK">Check</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="lw-reason" className="label">
                  Why (optional)
                </label>
                <input id="lw-reason" name="reason" className="input" maxLength={200} />
              </div>
              <Submit className="btn">Cancel the layaway</Submit>
            </ActionForm>
          </details>
        </Section>
      )}
    </div>
  );
}
