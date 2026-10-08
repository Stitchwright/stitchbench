// One special order or pre-order (shop-features-round-2-design.md 1.2): what she wants and what it comes to, what was
// paid, where it is (not ordered, waiting for the supplier, here, picked up, cancelled), and the next step: order it,
// mark it here, take a payment or send a pay link for the rest, pick it up at the register, cancel by the shop's rule
// (undo for a day). The slip to print is one tap away.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtYmdLong } from "@/lib/units/units";
import { payLinkProblem, payLinksFor, payLinkWords } from "@/lib/pay-links";
import { pickUpBy, RULE_WORDS, specialOrderView } from "@/lib/special-orders";
import { cancelSpecialOrder, markSpecialOrderCalled, markSpecialOrderHere, orderSpecialOrders, sendSpecialOrderBalance, specialOrderNotHere, undoSpecialOrderCancel } from "@/actions/special-orders";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { SpecialOrderPay } from "@/components/special-order-pay";
import { KV, PageHeader, Section } from "@/components/ui";

export default async function SpecialOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const o = await specialOrderView(user.shopId, id);
  if (!o) notFound();
  const [tz, links, linkProblem] = await Promise.all([shopTimeZone(user.shopId), payLinksFor(user.shopId, { specialOrderId: o.id, take: 10 }), payLinkProblem(user.shopId)]);
  const open = ["WAITING", "ORDERED", "HERE"].includes(o.status);
  const admin = user.role !== "TECH";
  const by = o.hereAt && o.status === "HERE" ? await pickUpBy(user.shopId, o.hereAt) : null;
  const word = o.kind === "PREORDER" ? "Pre-order" : "Special order";
  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/special-orders", label: "Special orders" }}
        title={`${word} ${o.number}`}
        sub={
          <>
            <span className={`pill ${o.status === "HERE" ? "tone-ready" : o.status === "DONE" ? "tone-done" : o.status === "CANCELLED" ? "tone-neutral" : "tone-wait"}`}>{o.statusWords}</span>
            {o.customer ? (
              <>
                {" "}
                for{" "}
                <Link href={`/customers/${o.customer.id}`} className="link">
                  {o.customer.name}
                </Link>
              </>
            ) : null}
          </>
        }
        actions={
          <Link href={`/special-orders/${o.id}/print`} className="btn min-h-11">
            Print the slip
          </Link>
        }
      />
      {o.status === "HERE" && (
        <p className="card card-pad text-base">
          It&apos;s here and held for her{by ? ` (to pick up by ${fmtYmdLong(by)})` : ""}. To hand it over, pick her at the{" "}
          <Link href="/register" className="link">
            register
          </Link>
          : it shows &quot;Special order waiting&quot; with Add it.
          {!o.noticedAt && !o.calledAt && " She hasn't been told yet: call her."}
        </p>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="What she wants">
          <div className="space-y-1 text-base">
            <KV k="Item" v={<>{o.partId ? <Link href={`/parts/${o.partId}`} className="link">{o.partNumber ?? o.description}</Link> : null} {o.description}</>} />
            <KV k="How many" v={qtyText(o.qty, o.unit)} />
            <KV k="Price each" v={money(o.priceCents)} />
            <KV k="With tax" v={money(o.owedCents)} />
            {o.expectedOn && <KV k="Expected" v={fmtYmdLong(o.expectedOn)} />}
            <KV k="Taken" v={fmtDate(o.createdAt, tz)} />
            {o.hereAt && <KV k="Here since" v={fmtDate(o.hereAt, tz)} />}
            <KV k="Deposit rule" v={RULE_WORDS[o.depositRule]} />
            {o.note && <KV k="Note" v={o.note} />}
          </div>
        </Section>
        <Section title="Money">
          <div className="space-y-3 text-base">
            <p>
              Paid <span className="num font-semibold">{money(o.paidCents)}</span>
              {open && (
                <>
                  {" "}
                  · <span className="num font-semibold">{money(o.leftCents)}</span>{" "}left (at today&apos;s tax)
                </>
              )}
            </p>
            {open && o.leftCents > 0 && <SpecialOrderPay id={o.id} leftCents={o.leftCents} />}
            {open && o.leftCents >= 50 && !linkProblem && (
              <ActionButton action={sendSpecialOrderBalance.bind(null, o.id)} className="btn min-h-11" confirm={`Tap again to send a link for ${money(o.leftCents)}`}>
                Send a pay link for the rest
              </ActionButton>
            )}
            {links.length > 0 && (
              <ul className="muted text-sm">
                {links.map((l) => (
                  <li key={l.id}>
                    Pay link #{l.number}, {money(l.totalCents)}: {payLinkWords(l)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>
      </div>
      {open && (
        <Section title="Next step">
          <div className="flex flex-wrap gap-2">
            {o.status === "WAITING" && o.partId && (
              <ActionForm action={orderSpecialOrders}>
                <input type="hidden" name="id" value={o.id} />
                <Submit className="btn btn-primary min-h-11">Order it from the supplier</Submit>
              </ActionForm>
            )}
            {o.status !== "HERE" && (
              <ActionButton action={markSpecialOrderHere.bind(null, o.id)} className={`btn min-h-11 ${o.partId && o.status === "WAITING" ? "" : "btn-primary"}`}>
                It&apos;s here
              </ActionButton>
            )}
            {o.status === "HERE" && !o.noticedAt && !o.calledAt && (
              <ActionButton action={markSpecialOrderCalled.bind(null, o.id)} className="btn btn-primary min-h-11" success="Marked called">
                I called her
              </ActionButton>
            )}
            {o.status === "HERE" && (
              <ActionButton action={specialOrderNotHere.bind(null, o.id)} className="btn min-h-11" success="Back to waiting for the supplier">
                It isn&apos;t here after all
              </ActionButton>
            )}
          </div>
          {o.status === "WAITING" && o.partId && <p className="muted mt-2 text-sm">Ordering it puts it on the supplier&apos;s next order (Inventory, Orders to suppliers). When that order is received, this is marked here and she hears.</p>}
        </Section>
      )}
      {open && (
        <details className="card card-pad">
          <summary className="link cursor-pointer text-base">Cancel this order</summary>
          <ActionForm action={cancelSpecialOrder.bind(null, o.id)} className="mt-3 space-y-3 text-base">
            {o.paidCents > 0 && admin ? (
              <fieldset className="space-y-1">
                <legend className="label">The {money(o.paidCents)} paid</legend>
                {(["credit", "refund", "keep"] as const).map((r) => (
                  <label key={r} className="flex min-h-11 items-center gap-2">
                    <input type="radio" name="rule" value={r} defaultChecked={r === o.depositRule} className="h-5 w-5" />
                    {r === "credit" ? "Give it back as store credit" : r === "refund" ? "Give the money back (cash)" : "Keep it (not refundable)"}
                    {r === o.depositRule ? " (the order's rule)" : ""}
                  </label>
                ))}
              </fieldset>
            ) : o.paidCents > 0 ? (
              <p>Only an owner or admin can cancel an order with money paid on it.</p>
            ) : null}
            <div className="field">
              <label htmlFor="so-reason" className="label">
                Why (optional)
              </label>
              <input id="so-reason" name="reason" className="input text-base" />
            </div>
            <Submit className="btn min-h-11">Cancel the order</Submit>
            <p className="muted text-sm">You can undo a cancel for a day.</p>
          </ActionForm>
        </details>
      )}
      {o.undoable && (
        <p className="card card-pad flex flex-wrap items-center gap-3 text-base">
          Cancelled {fmtDate(o.cancelledAt!, tz)}.
          <ActionButton action={undoSpecialOrderCancel.bind(null, o.id)} className="btn btn-primary min-h-11">
            Undo
          </ActionButton>
        </p>
      )}
      {o.saleId && (
        <p className="text-base">
          <Link href={`/register/sales/${o.saleId}`} className="link">
            {o.status === "DONE" ? "The pick-up sale" : "The cancel's sale"}
          </Link>
        </p>
      )}
    </div>
  );
}
