import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDateTime, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { barcodeSvg } from "@/lib/barcode";
import { cardWithEntries, REASON_LABEL, type EntryReason } from "@/lib/gift-cards";
import { lastFour } from "@/lib/gift-card-number";
import { PageHeader, Section } from "@/components/ui";
import { HistoryLink } from "@/components/history-link";
import { ActionForm, Submit } from "@/components/action-form";
import { adjustGiftCard, moveGiftCard } from "@/actions/gift-cards";

/** One card: its number, balance and ledger (every entry that moved it), with print, adjust and move. */
export default async function GiftCardPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const card = await cardWithEntries(user.shopId, id);
  if (!card) notFound();
  const tz = await shopTimeZone(user.shopId);
  const svg = barcodeSvg(card.number, 8);
  const what = card.kind === "credit" ? "Store credit" : "Gift card";
  const admin = user.role !== "TECH";

  return (
    <div className="space-y-4">
      <PageHeader
        back={{ href: "/register/gift-cards", label: "Gift cards" }}
        title={`${what} ending ${lastFour(card.number)}`}
        sub={card.customer ? <Link href={`/customers/${card.customer.id}`} className="link">{card.customer.name}</Link> : card.kind === "credit" ? "A slip, not tied to a customer" : undefined}
        actions={
          <>
            <HistoryLink role={user.role} type="GiftCard" id={card.id} />
            <Link href={`/register/gift-cards/${card.id}/print`} className="btn btn-primary">
              Print
            </Link>
          </>
        }
      />
      <div className="card card-pad grid gap-4 sm:grid-cols-[1fr_auto]">
        <div className="space-y-1 text-sm">
          <div className="muted">Number</div>
          <div className="mono text-xl font-bold" data-testid="card-number">
            {card.number}
          </div>
          <div className="muted mt-3">Balance</div>
          <div className="num text-3xl font-bold" data-testid="card-balance">
            {money(card.balanceCents)}
          </div>
          {card.status !== "active" && <p className="pill tone-neutral mt-2">Void: its balance was moved or the sale that made it was voided.</p>}
          <p className="muted mt-2 text-xs">Never expires. No fees.</p>
        </div>
        {svg && <div className="w-56 self-center" dangerouslySetInnerHTML={{ __html: svg }} />}
      </div>

      <Section title="History">
        <div className="overflow-x-auto">
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Note</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {card.entries.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap">{fmtDateTime(e.at, tz)}</td>
                  <td>
                    {REASON_LABEL[e.reason as EntryReason] ?? e.reason}
                    {e.saleId && (
                      <>
                        {" "}
                        <Link href={`/register/sales/${e.saleId}`} className="link">
                          sale
                        </Link>
                      </>
                    )}
                    {e.ticketId && (
                      <>
                        {" "}
                        <Link href={`/tickets/${e.ticketId}`} className="link">
                          ticket
                        </Link>
                      </>
                    )}
                  </td>
                  <td className="muted">{e.note}</td>
                  <td className="num text-right">{e.amountCents > 0 ? `+${money(e.amountCents)}` : `-${money(-e.amountCents)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {card.status === "active" && card.balanceCents > 0 && admin && (
        <Section title="Pay out the balance in cash">
          <p className="muted text-sm">
            Some states require a small leftover to be paid out on request. At the register, press Gift card, pick &quot;Pay out a balance in cash&quot; and scan or type this number; the drawer and the payment totals then stay right.
          </p>
        </Section>
      )}

      {user.role === "OWNER" && (
        <Section title="Adjust the balance">
          <ActionForm action={adjustGiftCard.bind(null, card.id)} success="Balance adjusted" className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label htmlFor="adj-balance" className="label">
                The balance it should have ($)
              </label>
              <input id="adj-balance" name="balance" inputMode="decimal" className="input num w-32" defaultValue={(card.balanceCents / 100).toFixed(2)} required />
            </div>
            <div className="field min-w-48 flex-1">
              <label htmlFor="adj-reason" className="label">
                Why
              </label>
              <input id="adj-reason" name="reason" className="input" required />
            </div>
            <Submit>Adjust</Submit>
          </ActionForm>
        </Section>
      )}

      {admin && card.status === "active" && card.balanceCents > 0 && (
        <Section title="Move to a new number (a lost card)">
          <ActionForm action={moveGiftCard.bind(null, card.id)} success="Moved" className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label htmlFor="mv-number" className="label">
                New card number (blank: make one)
              </label>
              <input id="mv-number" name="number" className="input mono" autoComplete="off" />
            </div>
            <div className="field min-w-48 flex-1">
              <label htmlFor="mv-reason" className="label">
                Why
              </label>
              <input id="mv-reason" name="reason" className="input" required />
            </div>
            <Submit className="btn btn-danger">Move the balance</Submit>
          </ActionForm>
          <p className="muted mt-2 text-xs">The old number stops working; the new card keeps the balance and the customer.</p>
        </Section>
      )}
    </div>
  );
}
