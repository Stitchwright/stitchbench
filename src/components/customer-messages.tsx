// A customer's messages and consent (scheduling-messaging-design.md 8.3, /customers/[id]). Server component. Hidden
// when Marketing was never on; otherwise every form here is a consent record, which the law lets a shop keep whatever
// the module says, so nothing in it is gated.
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtPhone, toE164, usMarketingNumber, validEmail } from "@/lib/phone";
import { gateFor } from "@/lib/module-gate";
import { CHANNEL_LABEL, CONSENT_SOURCE_LABEL, MESSAGE_KIND_LABEL, MESSAGE_STATUS_LABEL, MESSAGE_STATUS_TONE, NOTIFY_BY_LABEL } from "@/lib/constants";
import { recordOptOut, recordTextConsent, withdrawTextConsent } from "@/actions/consent";
import { ActionForm, Submit } from "@/components/action-form";

export async function CustomerMessages({ customerId, user }: { customerId: string; user: CurrentUser }) {
  const gate = await gateFor(user.shopId, "marketing");
  if (gate === "hidden") return null;
  const c = await db.customer.findFirst({ where: { id: customerId, shopId: user.shopId } });
  if (!c) return null;
  const tz = await shopTimeZone(user.shopId);
  const number = toE164(c.phone);
  const email = validEmail(c.email);
  const addresses = [number && { channel: "sms", address: number }, email && { channel: "email", address: email }].filter((a): a is { channel: string; address: string } => !!a);
  const [sups, messages] = await Promise.all([
    addresses.length ? db.suppression.findMany({ where: { shopId: user.shopId, OR: addresses } }) : Promise.resolve([]),
    db.outMessage.findMany({ where: { shopId: user.shopId, customerId: c.id }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const smsStop = sups.find((s) => s.channel === "sms");
  const emailSup = sups.find((s) => s.channel === "email");

  // The one-line summary: how we tell them, where marketing texts stand, where email stands.
  const told = c.notifyBy === "" ? "Not asked how to tell them yet" : `Told by ${NOTIFY_BY_LABEL[c.notifyBy] ?? c.notifyBy}`;
  let texts: string;
  if (c.kind !== "RETAIL") texts = "Marketing texts: none (trade account)";
  else if (smsStop) texts = `Opted out of texts ${fmtDate(smsStop.at, tz)}`;
  else if (c.smsConsentAt && number && c.smsConsentPhone !== number) texts = "Marketing texts: their number changed since they agreed: ask again";
  else if (c.smsConsentAt) texts = `Marketing texts: agreed ${fmtDate(c.smsConsentAt, tz)}${c.smsConsentSource ? ` (${c.smsConsentSource === "tablet" ? "tablet" : c.smsConsentSource === "paper_form" ? "paper form" : c.smsConsentSource})` : ""}`;
  else texts = "Marketing texts: not agreed";
  const mail = !email ? "Email: none on file" : emailSup?.scope === "all" ? `Email: opted out ${fmtDate(emailSup.at, tz)}` : emailSup ? `Email: unsubscribed from marketing ${fmtDate(emailSup.at, tz)}` : "Email: subscribed";

  const optOutChannel = number ? "sms" : email ? "email" : null;

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="h2">Messages</h2>
        <Link href={`/messages?customer=${c.id}`} className="link text-sm">
          All messages
        </Link>
      </div>
      <div className="card-pad space-y-3 text-sm">
        <p>
          {told} · {texts} · {mail}
        </p>
        <p className="muted text-xs">How to tell them is changed under Details.</p>

        <details className="rounded border border-line">
          <summary className="cursor-pointer px-3 py-2 font-semibold">Marketing texts</summary>
          <div className="space-y-4 border-t border-line px-3 py-3">
            {c.kind !== "RETAIL" ? (
              <p className="muted">Trade accounts get no marketing texts.</p>
            ) : !number ? (
              <p className="muted">Add their mobile number under Details first.</p>
            ) : !usMarketingNumber(number) ? (
              <p className="muted">Marketing texts go only to US mobile numbers.</p>
            ) : smsStop ? (
              <p className="muted">This number replied STOP. They must text START to your number before they can sign up again.</p>
            ) : (
              <>
                <p>
                  Written consent is needed before any marketing text goes to {fmtPhone(number)}. They can sign on the counter tablet, or sign the paper form.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/consent/${c.id}`} className="btn btn-sm btn-primary">
                    Sign on the tablet
                  </Link>
                  <Link href="/customers/consent-form" className="btn btn-sm">
                    Print the paper form
                  </Link>
                </div>
                <ActionForm action={recordTextConsent.bind(null, c.id)} success="Recorded" className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="source" value="paper_form" />
                  <div className="field">
                    <label htmlFor="consent-signedOn" className="label">
                      Date on the signed form
                    </label>
                    <input id="consent-signedOn" name="signedOn" type="date" required className="input" />
                  </div>
                  <div className="field">
                    <label htmlFor="consent-code" className="label">
                      Form code (bottom of the form)
                    </label>
                    <input id="consent-code" name="code" required className="input mono" placeholder="A1B2C3" maxLength={12} />
                  </div>
                  <Submit className="btn btn-sm">Record the signed form</Submit>
                </ActionForm>
              </>
            )}
            {c.smsConsentAt && (
              <div className="space-y-2 rounded bg-surface-2 p-3">
                <p>
                  Agreed {fmtDateTime(c.smsConsentAt, tz)} for {c.smsConsentPhone ? fmtPhone(c.smsConsentPhone) : "-"}
                  {c.smsConsentSource ? ` (${CONSENT_SOURCE_LABEL[c.smsConsentSource] ?? c.smsConsentSource})` : ""}.
                </p>
                {c.smsConsentText && <p className="muted text-xs whitespace-pre-wrap">{c.smsConsentText}</p>}
                <ActionForm action={withdrawTextConsent.bind(null, c.id)} success="Withdrawn" className="flex flex-wrap items-end gap-2">
                  <div className="field">
                    <label htmlFor="withdraw-detail" className="label">
                      Why (for the record)
                    </label>
                    <input id="withdraw-detail" name="detail" className="input" placeholder="Asked at the counter" />
                  </div>
                  <Submit className="btn btn-sm">Withdraw</Submit>
                </ActionForm>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="label">Opt-outs</span>
                {sups.length === 0 && <span className="muted">None.</span>}
                {sups.map((s) => (
                  <span key={`${s.channel}:${s.address}`} className="pill tone-bad">
                    {s.channel === "sms" ? `Opted out of texts: ${fmtPhone(s.address)}` : s.scope === "all" ? `Opted out of email: ${s.address}` : `Unsubscribed from marketing email: ${s.address}`}
                  </span>
                ))}
              </div>
              {optOutChannel && (
                <ActionForm action={recordOptOut} success="Opt-out recorded" className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="customerId" value={c.id} />
                  <input type="hidden" name="channel" value={optOutChannel} />
                  <input type="hidden" name="scope" value="all" />
                  <input type="hidden" name="source" value="staff" />
                  <input type="hidden" name="detail" value="They asked for no more messages" />
                  <Submit className="btn btn-sm">Record an opt-out</Submit>
                  <span className="muted text-xs">
                    They don&apos;t want our {optOutChannel === "sms" ? "texts" : "emails"} any more ({optOutChannel === "sms" ? fmtPhone(number!) : email}). For another address use{" "}
                    <Link href="/messages/opt-outs" className="link">
                      Opt-outs
                    </Link>
                    .
                  </span>
                </ActionForm>
              )}
            </div>
          </div>
        </details>

        <details className="rounded border border-line">
          <summary className="cursor-pointer px-3 py-2 font-semibold">Latest messages{messages.length ? ` (${messages.length})` : ""}</summary>
          <div className="border-t border-line px-3 py-3">
            {messages.length === 0 ? (
              <p className="muted">No messages yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {messages.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="num muted">{fmtDateTime(m.sentAt ?? m.createdAt, tz)}</span>
                      <span>{MESSAGE_KIND_LABEL[m.kind] ?? m.kind}</span>
                      <span className="muted">{CHANNEL_LABEL[m.channel] ?? m.channel}</span>
                    </span>
                    <span className={`pill tone-${MESSAGE_STATUS_TONE[m.status] ?? "neutral"}`}>{MESSAGE_STATUS_LABEL[m.status] ?? m.status}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2">
              <Link href={`/messages?customer=${c.id}`} className="link">
                All messages
              </Link>
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}
