// Settings -> Messages -> Setup: the mail account, Twilio, the time-zone check, test numbers, "Try it" and the public
// address (scheduling-messaging-design.md 4.2, 8.3). Everyone sees the status; admins edit while Marketing is on. No
// secret, sealed or plain, ever reaches this page: MessagingView carries only "has one" flags.
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { fmtTime } from "@/lib/zoned";
import { isDesktop } from "@/lib/modules";
import { fmtPhone, validEmail } from "@/lib/phone";
import { consentWording, isLocalRequest, messagingView, type MessagingView } from "@/lib/messaging/settings";
import { render, SAMPLE_VARS, templateFor } from "@/lib/messaging/templates";
import { finalize } from "@/lib/messaging/queue";
import type { MessageKind } from "@/lib/messaging/types";
import { KV, PageHeader, Section } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";
import { ChannelStatusLine, channelStatus, MessagingTabs } from "@/components/messaging-tabs";
import { EmailSettingsForm, LOCAL_ONLY_MESSAGE, TestSendForm, TextSettingsForm } from "@/components/messaging-settings-forms";
import { addTestPhone, confirmTestPhone, confirmTimeZone, removeTestPhone } from "@/actions/messaging";

type Shop = { name: string; phone: string | null; address: string | null; email: string | null; timeZone: string };

/** The PC's own zone, on the Windows program (the server runs on the shop PC). */
function pcTimeZone(): string | null {
  if (!isDesktop()) return null;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function TimeZoneCheck({ ms, shop, canEdit }: { ms: MessagingView; shop: Shop; canEdit: boolean }) {
  const now = new Date();
  const pcZone = pcTimeZone();
  const offerPc = pcZone && pcZone !== shop.timeZone ? pcZone : null;
  return (
    <div className="rounded border border-line p-3 text-sm">
      <div className="label mb-1">Time zone</div>
      {ms.tzConfirmedAt ? (
        <p>
          {shop.timeZone}, where it&apos;s {fmtTime(now, shop.timeZone)} now. Confirmed {fmtDate(ms.tzConfirmedAt, shop.timeZone)}.
        </p>
      ) : (
        <p>
          It&apos;s <strong>{fmtTime(now, shop.timeZone)}</strong> in {shop.timeZone}. Is that your shop&apos;s time? Quiet hours for texts count from it.
        </p>
      )}
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-start gap-3">
          {!ms.tzConfirmedAt && (
            <ActionForm action={confirmTimeZone} success="Saved">
              <input type="hidden" name="timeZone" value={shop.timeZone} />
              <Submit className="btn btn-sm btn-primary">Yes</Submit>
            </ActionForm>
          )}
          {offerPc && (
            <ActionForm action={confirmTimeZone} success="Saved">
              <input type="hidden" name="timeZone" value={offerPc} />
              <Submit className="btn btn-sm">
                Use this PC&apos;s zone: {offerPc} ({fmtTime(now, offerPc)})
              </Submit>
            </ActionForm>
          )}
          <details>
            <summary className="link cursor-pointer text-sm">{ms.tzConfirmedAt ? "Change the zone" : "No, pick another zone"}</summary>
            <ActionForm action={confirmTimeZone} success="Saved" className="mt-2 flex flex-wrap items-end gap-2">
              <div className="field">
                <label htmlFor="tz-other" className="label">
                  Time zone, like America/Chicago
                </label>
                <input id="tz-other" name="timeZone" className="input w-64" defaultValue={shop.timeZone} autoComplete="off" />
              </div>
              <Submit className="btn btn-sm">Use this zone</Submit>
            </ActionForm>
          </details>
        </div>
      )}
    </div>
  );
}

function Registering({ ms, shop }: { ms: MessagingView; shop: Shop }) {
  const vars = { ...SAMPLE_VARS, shop_name: shop.name, shop_phone: shop.phone ?? SAMPLE_VARS.shop_phone };
  const ctx = { shopName: shop.name, shopPhone: shop.phone, postal: ms.postalAddress ?? shop.address, unsubscribeUrl: null, replyWord: true };
  const text = (kind: MessageKind) => finalize("sms", kind, render(templateFor(ms, `${kind}.sms`), vars), ctx);
  const samples: { label: string; text: string }[] = [
    { label: "Opt-in wording (what customers agree to)", text: consentWording(ms, shop.name) },
    { label: "Opt-in confirmation", text: text("consent_confirm") },
    { label: "Sample notice (ready for pickup)", text: text("ready") },
    { label: "Sample marketing text (service reminder)", text: text("service_due") },
    { label: "HELP reply", text: text("help_reply") },
  ];
  return (
    <details className="rounded border border-line p-3 text-sm">
      <summary className="cursor-pointer font-semibold">Registering your number</summary>
      <div className="mt-2 space-y-3">
        <p>
          US carriers block business texts from numbers that aren&apos;t registered. In the Twilio console, register your number for business texting: A2P 10DLC
          for a local number, or toll-free verification for an 8xx number. Twilio asks for your business details, how customers opt in (the counter tablet or
          the paper form, with the wording below) and sample messages. Copy these:
        </p>
        {samples.map((s) => (
          <div key={s.label}>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="label">{s.label}</span>
              <CopyButton text={s.text} />
            </div>
            <pre className="whitespace-pre-wrap rounded border border-line p-2 font-sans">{s.text}</pre>
          </div>
        ))}
        <p className="muted">
          Most US shops pay a one-time brand fee and a small monthly campaign fee; texts cost about {ms.smsPartMills} tenths of a cent per part. Registration
          takes a few days; until it&apos;s done, carriers may drop your texts.
        </p>
      </div>
    </details>
  );
}

function TestNumbers({ ms, canEdit }: { ms: MessagingView; canEdit: boolean }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="label">Test numbers</div>
      <p className="muted">Test texts go only to mobile numbers you&apos;ve proved are yours: a code is texted to the number, and you type it in here.</p>
      {ms.testPhones.length ? (
        <ul className="space-y-1">
          {ms.testPhones.map((p) => (
            <li key={p} className="flex flex-wrap items-center gap-2">
              <span>{fmtPhone(p)}</span>
              {canEdit && (
                <ActionButton action={removeTestPhone.bind(null, p)} className="btn btn-sm" confirm="Remove it?" success="Removed">
                  Remove
                </ActionButton>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No test numbers yet.</p>
      )}
      {canEdit && ms.testPhonePending && (
        <ActionForm action={confirmTestPhone} reset success="Saved" className="flex flex-wrap items-end gap-2">
          <div className="field">
            <label htmlFor="test-code" className="label">
              Code from the text
            </label>
            <input id="test-code" name="code" className="input w-40 mono" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" />
          </div>
          <Submit className="btn btn-sm btn-primary">Confirm</Submit>
          <span className="muted text-xs">Texted to {fmtPhone(ms.testPhonePending)}. It works for 10 minutes.</span>
        </ActionForm>
      )}
      {canEdit && ms.testPhones.length < 5 && (
        <ActionForm action={addTestPhone} reset success="Code sent. Type it in below." className="flex flex-wrap items-end gap-2">
          <div className="field">
            <label htmlFor="test-phone" className="label">
              Mobile number to add
            </label>
            <input id="test-phone" name="phone" className="input w-48" inputMode="tel" placeholder="(555) 123-4567" autoComplete="off" />
          </div>
          <Submit className="btn btn-sm">Text me a code</Submit>
        </ActionForm>
      )}
    </div>
  );
}

export default async function MessagesSetupPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  // In the base since 7 Oct 2026 (pricing-review-2026-10.md): the ready, parts-in and estimate messages need this setup.
  const canEdit = admin;
  const [ms, shop, waitingEmail, waitingSms] = await Promise.all([
    messagingView(user.shopId),
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true, address: true, email: true, timeZone: true } }),
    db.outMessage.count({ where: { shopId: user.shopId, channel: "email", status: "QUEUED" } }),
    db.outMessage.count({ where: { shopId: user.shopId, channel: "sms", status: "QUEUED" } }),
  ]);
  const secretsAllowed = !isDesktop() || isLocalRequest(await headers());
  const hosted = !isDesktop();
  const savedLine = (d: Date | null) => (d ? `Saved ${fmtDate(d, shop.timeZone)}. Leave blank to keep it.` : "");
  const emailStatus = channelStatus(ms, "email", shop.timeZone, waitingEmail);
  const smsStatus = channelStatus(ms, "sms", shop.timeZone, waitingSms);
  const ownEmail = validEmail(user.email);
  const testEmails = [...new Set([ownEmail, ms.fromEmail, ms.replyTo].filter((a): a is string => !!a))];
  const securityLabel: Record<string, string> = { starttls: "STARTTLS", tls: "SSL / TLS", none: "None" };

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Email and text messages" back={{ href: "/settings", label: "Settings" }} sub="Where messages to customers go out from. Automatic messages and the rules have their own tabs." />
      <MessagingTabs active="setup" />

      <Section title="Email" id="email">
        <div className="space-y-4">
          <ChannelStatusLine status={emailStatus} />
          {canEdit ? (
            <EmailSettingsForm
              v={{
                emailOn: ms.emailOn,
                smtpPreset: ms.smtpPreset,
                smtpHost: ms.smtpHost,
                smtpPort: ms.smtpPort,
                smtpSecurity: ms.smtpSecurity,
                smtpUser: ms.smtpUser,
                fromName: ms.fromName,
                fromEmail: ms.fromEmail,
                replyTo: ms.replyTo,
                replyWatched: ms.replyWatched,
                hasSmtpPass: ms.hasSmtpPass,
                passPlaceholder: savedLine(ms.smtpPassSavedAt),
              }}
              secretsAllowed={secretsAllowed}
              hosted={hosted}
              shopName={shop.name}
            />
          ) : (
            <div className="grid-form text-sm">
              <KV k="Send email" v={ms.emailOn ? "On" : "Off"} />
              <KV k="Mail server" v={ms.smtpHost ? `${ms.smtpHost}:${ms.smtpPort} (${securityLabel[ms.smtpSecurity] ?? ms.smtpSecurity})` : null} />
              <KV k="User name" v={ms.smtpUser} />
              <KV k="Password" v={ms.hasSmtpPass ? `Saved ${fmtDate(ms.smtpPassSavedAt, shop.timeZone)}` : "None"} />
              <KV k="From" v={ms.fromEmail ? `${ms.fromName ?? shop.name} <${ms.fromEmail}>` : null} />
              <KV k="Reply-to" v={ms.replyTo ? `${ms.replyTo}${ms.replyWatched ? " (read weekly)" : ""}` : null} />
            </div>
          )}
          {!admin && <p className="muted text-sm">The shop owner or an admin changes these.</p>}
        </div>
      </Section>

      <Section title="Texts" id="texts">
        <div className="space-y-4">
          <ChannelStatusLine status={smsStatus} />
          <p className="muted text-sm">Texts go out from your Twilio number. Make a Twilio account, buy a number, register it for business texting, and enter the account details here.</p>
          <TimeZoneCheck ms={ms} shop={shop} canEdit={canEdit} />
          {canEdit ? (
            <TextSettingsForm
              v={{ smsOn: ms.smsOn, twilioSid: ms.twilioSid, twilioKeySid: ms.twilioKeySid, twilioFrom: ms.twilioFrom, hasTwilioToken: ms.hasTwilioToken, tokenPlaceholder: savedLine(ms.twilioTokenSavedAt) }}
              secretsAllowed={secretsAllowed}
              tzConfirmed={!!ms.tzConfirmedAt}
            />
          ) : (
            <div className="grid-form text-sm">
              <KV k="Send texts" v={ms.smsOn ? "On" : "Off"} />
              <KV k="Account SID" v={ms.twilioSid ? `${ms.twilioSid.slice(0, 6)}...` : null} />
              <KV k="API key" v={ms.twilioKeySid ? `${ms.twilioKeySid.slice(0, 6)}...` : "Auth Token"} />
              <KV k="Token or secret" v={ms.hasTwilioToken ? `Saved ${fmtDate(ms.twilioTokenSavedAt, shop.timeZone)}` : "None"} />
              <KV k="Twilio number" v={ms.twilioFrom ? fmtPhone(ms.twilioFrom) : null} />
            </div>
          )}
          {admin && !secretsAllowed && <p className="muted text-xs">{LOCAL_ONLY_MESSAGE}</p>}
          <Registering ms={ms} shop={shop} />
          <TestNumbers ms={ms} canEdit={canEdit} />
        </div>
      </Section>

      {canEdit && (
        <Section title="Try it" id="try">
          <div className="space-y-3">
            <p className="muted text-sm">Right after saving, send yourself a message. Tests go only to your own addresses, and work even while a channel is paused.</p>
            <TestSendForm channel="email" addresses={testEmails} idPrefix="try-email" />
            <TestSendForm channel="sms" addresses={ms.testPhones} idPrefix="try-sms" />
          </div>
        </Section>
      )}

      <Section title="Public address" id="public">
        <p className="text-sm">
          {ms.publicUrl ? (
            <>
              Links customers can open: <span className="mono">{ms.publicUrl}</span>
            </>
          ) : (
            <>None: estimate links are off and unsubscribes come back by email reply. On the Windows program an address can be set in the program&apos;s settings file (see INSTALL.md).</>
          )}
        </p>
      </Section>
    </div>
  );
}
