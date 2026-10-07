// An event's money and lists on its page (shop-features-round-2-design.md 4.5): who's coming with what they chose, paid and
// owing; per person "Take a payment" (at the counter: the deposit, then the balance, by cash, card or check) and "Send a
// pay link"; "Ask for the balances"; links to the door page (check-in, tickets, the drawing) and the room and meal lists.
// A server component; the actions are bound here.
import Link from "next/link";
import { money } from "@/lib/format";
import { fmtYmdLong } from "@/lib/units/units";
import type { EventView } from "@/lib/events";
import { removeEventPayment, sendBalanceLinks, sendEventLink, takeEventPayment } from "@/actions/events";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

const KIND_WORDS: Record<string, string> = { DEPOSIT: "Deposit", BALANCE: "Balance", PAYMENT: "Payment", TICKET: "Ticket" };

export function EventPanel({ v, on, admin, canLink }: { v: EventView; on: boolean; admin: boolean; canLink: boolean }) {
  const askable = v.people.filter((p) => p.owingCents > 0 && !p.askedCents && p.customerId).length;
  return (
    <Section
      title={`Who's coming (${v.people.length})`}
      actions={
        <div className="flex flex-wrap gap-2">
          <Link href={`/classes/${v.id}/door`} className="btn btn-sm min-h-11">
            At the door
          </Link>
          {v.choices.list.length > 0 && (
            <Link href={`/classes/${v.id}/lists`} className="btn btn-sm min-h-11">
              Room and meal lists
            </Link>
          )}
        </div>
      }
    >
      <p className="text-base">
        {money(v.totals.paidCents)} paid of {money(v.totals.priceCents)}
        {v.totals.owingCents ? `, ${money(v.totals.owingCents)} still owed` : ""}
        {v.dueYmd ? `. Balances are due by ${fmtYmdLong(v.dueYmd)}.` : "."}
      </p>
      {v.people.length === 0 ? (
        <p className="muted mt-2 text-base">Nobody yet. Sign someone up above; her deposit and balance are taken here.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {v.people.map((p) => (
            <li key={p.id} className="rounded border border-line p-3 text-base">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">
                  {p.customerId ? (
                    <Link href={`/customers/${p.customerId}`} className="link">
                      {p.attendee ?? p.name}
                    </Link>
                  ) : (
                    (p.attendee ?? p.name)
                  )}
                  {p.checkedIn && <span className="pill tone-ok ml-2">Here</span>}
                </span>
                <span>
                  {p.owingCents ? (
                    <>
                      Owes <span className="num font-semibold">{money(p.owingCents)}</span> of {money(p.priceCents)}
                    </>
                  ) : (
                    <span className="pill tone-ok">Paid in full</span>
                  )}
                </span>
              </div>
              {Object.keys(p.choices).length > 0 && (
                <p className="muted text-sm">
                  {Object.entries(p.choices)
                    .map(([k, val]) => `${k === "room" ? "Room" : k === "meals" ? "Meals" : k === "dietary" ? "Dietary" : k}: ${val}`)
                    .join(" · ")}
                </p>
              )}
              {p.payments.length > 0 && (
                <ul className="muted mt-1 text-sm">
                  {p.payments.map((x) => (
                    <li key={x.id} className="flex flex-wrap items-center gap-2">
                      {KIND_WORDS[x.kind] ?? x.kind} {money(x.amountCents)} {x.paidAt ? (x.webOrderId ? "paid by link" : "paid at the counter") : "pay link sent, not paid yet"}
                      {admin && on && (
                        <ActionButton action={removeEventPayment.bind(null, v.id, x.id)} className="link min-h-11 text-sm" confirm="Tap again: only after refunding it at the register" success="Taken off">
                          Take off
                        </ActionButton>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {on && p.next && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <ActionForm action={takeEventPayment.bind(null, v.id, p.id)} className="flex flex-wrap items-end gap-2">
                    {admin && (
                      <label className="field text-sm">
                        <span className="label">Amount (empty: the {p.next.kind === "DEPOSIT" ? "deposit" : "balance"})</span>
                        <input name="amount" inputMode="decimal" className="input num w-28 text-base" placeholder={(p.next.cents / 100).toFixed(2)} />
                      </label>
                    )}
                    <label className="field text-sm">
                      <span className="label">Paid by</span>
                      <select name="method" className="select text-base" defaultValue="CARD">
                        <option value="CARD">Card</option>
                        <option value="CASH">Cash</option>
                        <option value="CHECK">Check</option>
                        <option value="OTHER">Other</option>
                      </select>
                    </label>
                    <Submit className="btn btn-primary btn-sm min-h-11">
                      Take the {p.next.kind === "DEPOSIT" ? "deposit" : "balance"} ({money(p.next.cents)})
                    </Submit>
                  </ActionForm>
                  {canLink && p.customerId && !p.askedCents && (
                    <ActionForm action={sendEventLink.bind(null, v.id, p.id)} className="inline-flex">
                      <Submit className="btn btn-sm min-h-11">Send a pay link</Submit>
                    </ActionForm>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {on && canLink && askable > 0 && (
        <div className="mt-4 flex justify-end">
          <ActionButton action={sendBalanceLinks.bind(null, v.id)} className="btn min-h-11 text-base" confirm={`Tap again to send ${askable} pay link${askable === 1 ? "" : "s"}`}>
            Ask for the balances
          </ActionButton>
        </div>
      )}
    </Section>
  );
}

/** The sign-up form's event part: her choices (room, meals, dietary) and the price today. */
export function EventSignupFields({ v, priceWords }: { v: EventView; priceWords: string }) {
  return (
    <div className="space-y-3">
      <p className="text-base">{priceWords}</p>
      {v.choices.list.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {v.choices.list.map((c) => (
            <div key={c.key} className="field">
              <label htmlFor={`ch-${c.key}`} className="label">
                {c.label}
              </label>
              <select id={`ch-${c.key}`} name={`choice_${c.key}`} className="select text-base">
                {c.options.map((o) => (
                  <option key={o.label} value={o.label}>
                    {o.label}
                    {o.cents ? ` (+${money(o.cents)})` : ""}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
      {v.choices.dietary && (
        <div className="field">
          <label htmlFor="ch-dietary" className="label">
            Dietary needs
          </label>
          <input id="ch-dietary" name="dietary" className="input text-base" maxLength={200} placeholder="Gluten free, vegetarian..." />
        </div>
      )}
    </div>
  );
}
