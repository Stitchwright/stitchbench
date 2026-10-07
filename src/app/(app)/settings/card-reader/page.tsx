// Settings → Card reader (shop-features-round-2-design.md 4.8): Stripe Terminal on the shop's own Stripe account. The
// key (shared with the online shop), the switch, pairing a reader by its code (the simulated reader in test mode), and
// approved payments on no sale to refund. Owners and admins.
import { requireAdmin } from "@/lib/session";
import { fmtDateTime, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { loosePayments, readerSettings } from "@/lib/card-reader";
import { pairReader, refundLoosePayment, removeReader, saveReaderSettings } from "@/actions/card-reader";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { PageHeader, Section } from "@/components/ui";

export default async function CardReaderSettings() {
  const user = await requireAdmin();
  const [s, loose, tz] = await Promise.all([readerSettings(user.shopId), loosePayments(user.shopId), shopTimeZone(user.shopId)]);
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Card reader"
        back={{ href: "/settings", label: "Settings" }}
        sub="A Stripe card reader at the counter: the register sends the amount to it and the sale finishes when the card is approved; a return from the receipt refunds the card. Uses your own Stripe account. Needs the internet."
      />
      <Section title="Your Stripe account">
        <ActionForm action={saveReaderSettings} className="space-y-3">
          <div className="field">
            <label className="label" htmlFor="cr-key">
              Stripe secret key {s.hasKey ? "(saved; paste a new one to change it)" : ""}
            </label>
            <input id="cr-key" name="stripeKey" type="password" autoComplete="off" className="input mono" placeholder={s.hasKey ? "••••••••" : "sk_test_... or sk_live_..."} />
            <p className="muted text-sm">The same key as the online shop. Kept locked; never shown again. A test key (sk_test_) uses Stripe&apos;s simulated reader and no real money.</p>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-base">
            <input type="checkbox" name="on" className="check" defaultChecked={s.on} /> Use the card reader at the register
          </label>
          <Submit>Save</Submit>
        </ActionForm>
        {s.hasKey && <p className="mt-2 text-sm">{s.testMode ? "Test mode: no real money." : "Live mode: real cards are charged."}</p>}
      </Section>
      {s.hasKey && (
        <Section title={`Readers (${s.readers.length})`}>
          {s.readers.length > 0 && (
            <ul className="mb-3 divide-y divide-line">
              {s.readers.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-2 text-base">
                  <span>
                    {r.label} <span className="muted text-sm">{r.deviceType ?? ""}</span>
                  </span>
                  <ActionButton action={removeReader.bind(null, r.id)} className="link text-sm" confirm="Tap again to remove">
                    Remove
                  </ActionButton>
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={pairReader} reset className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label className="label" htmlFor="cr-code">
                The code on the reader
              </label>
              <input id="cr-code" name="code" className="input mono" autoComplete="off" placeholder={s.testMode ? "simulated-wpe" : "three words"} />
            </div>
            <div className="field">
              <label className="label" htmlFor="cr-label">
                Its name
              </label>
              <input id="cr-label" name="label" className="input" defaultValue="Counter" maxLength={40} />
            </div>
            <Submit>Pair the reader</Submit>
          </ActionForm>
          {s.testMode && <p className="muted mt-2 text-sm">In test mode, type simulated-wpe to pair Stripe&apos;s simulated reader.</p>}
        </Section>
      )}
      {loose.length > 0 && (
        <Section title="Approved, but on no sale">
          <p className="muted mb-2 text-sm">The card was charged but the sale wasn&apos;t finished (or was voided). Put it right with the customer: refund it here.</p>
          <ul className="divide-y divide-line">
            {loose.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-base">
                <span>
                  {money(p.amountCents - p.refundedCents)}
                  {p.last4 ? ` · card ending ${p.last4}` : ""} · {fmtDateTime(p.createdAt, tz)}
                </span>
                <ActionButton action={refundLoosePayment.bind(null, p.id)} className="btn btn-sm" confirm="Tap again: refund it to the card">
                  Refund to the card
                </ActionButton>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
