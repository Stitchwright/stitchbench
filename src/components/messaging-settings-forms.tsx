"use client";
// The forms of Settings -> Messages (scheduling-messaging-design.md 4.2, 8.1, 8.3). Secrets: the password and token
// fields are always empty; the placeholder says when one was saved. Nothing here ever receives a saved secret.
import { useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import { ActionForm, Submit } from "@/components/action-form";
import { TemplateEditor } from "@/components/template-editor";
import { SMTP_PRESETS, PRESET_KEYS } from "@/lib/messaging/presets";
import { KIND_PURPOSE, type MessageKind } from "@/lib/messaging/types";
import { fmtPhone } from "@/lib/phone";
import { saveAutoMessages, saveEmailSettings, saveMessageRules, saveTextSettings, sendTestMessage } from "@/actions/messaging";

export const LOCAL_ONLY_MESSAGE = "Enter passwords on the shop PC itself (in the StitchBench window), not from another device on the network.";

function Field({ id, label, children, hint }: { id: string; label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children}
      {hint && <div className="muted mt-1 text-xs">{hint}</div>}
    </div>
  );
}

// ---------- email ----------

export type EmailSettingsValues = {
  emailOn: boolean;
  smtpPreset: string | null;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecurity: string;
  smtpUser: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  replyWatched: boolean;
  hasSmtpPass: boolean;
  /** "Saved Oct 7, 2026. Leave blank to keep it." when a password is saved. */
  passPlaceholder: string;
};

export function EmailSettingsForm({ v, secretsAllowed, hosted, shopName }: { v: EmailSettingsValues; secretsAllowed: boolean; hosted: boolean; shopName: string }) {
  const [preset, setPreset] = useState(v.smtpPreset ?? (v.smtpHost ? "other" : ""));
  const [host, setHost] = useState(v.smtpHost ?? "");
  const [port, setPort] = useState(String(v.smtpPort));
  const [security, setSecurity] = useState(v.smtpSecurity);
  const help = preset && SMTP_PRESETS[preset] ? SMTP_PRESETS[preset].help : null;
  return (
    <ActionForm action={saveEmailSettings} success="Saved" className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="emailOn" defaultChecked={v.emailOn} className="check" /> Send email
      </label>
      <div className="grid-form">
        <Field id="smtpPreset" label="Provider" hint={help}>
          <select
            id="smtpPreset"
            name="smtpPreset"
            className="select"
            value={preset}
            onChange={(e) => {
              const key = e.target.value;
              setPreset(key);
              const p = SMTP_PRESETS[key];
              if (p && key !== "other") {
                setHost(p.host);
                setPort(String(p.port));
                setSecurity(p.security);
              }
            }}
          >
            <option value="">Pick your mail provider</option>
            {PRESET_KEYS.map((k) => (
              <option key={k} value={k}>
                {SMTP_PRESETS[k].label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="smtpHost" label="Mail server">
          <input id="smtpHost" name="smtpHost" className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.gmail.com" autoComplete="off" />
        </Field>
        <Field id="smtpPort" label="Port">
          <input id="smtpPort" name="smtpPort" className="input num" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        </Field>
        <Field id="smtpSecurity" label="Security" hint={hosted ? "Plain connections (None) are only for a mail server on the shop's own network, on the Windows program." : undefined}>
          <select id="smtpSecurity" name="smtpSecurity" className="select" value={security} onChange={(e) => setSecurity(e.target.value)}>
            <option value="starttls">STARTTLS (port 587)</option>
            <option value="tls">SSL / TLS (port 465)</option>
            <option value="none">None</option>
          </select>
        </Field>
        <Field id="smtpUser" label="User name">
          <input id="smtpUser" name="smtpUser" className="input" defaultValue={v.smtpUser ?? ""} autoComplete="off" />
        </Field>
        {secretsAllowed ? (
          <Field id="smtpPass" label="Password" hint={v.hasSmtpPass ? v.passPlaceholder : "For Gmail or Outlook, an app password."}>
            <input id="smtpPass" name="smtpPass" type="password" className="input" placeholder={v.hasSmtpPass ? v.passPlaceholder : ""} autoComplete="new-password" />
            {v.hasSmtpPass && (
              <label className="mt-1 flex items-center gap-2 text-xs">
                <input type="checkbox" name="forgetPass" className="check" /> Forget the saved one
              </label>
            )}
          </Field>
        ) : (
          <div className="field">
            <div className="label">Password</div>
            <p className="text-sm">{LOCAL_ONLY_MESSAGE}</p>
            {v.hasSmtpPass && <p className="muted text-xs">{v.passPlaceholder}</p>}
          </div>
        )}
        <Field id="fromName" label="From name" hint={`Blank: ${shopName}.`}>
          <input id="fromName" name="fromName" className="input" defaultValue={v.fromName ?? ""} maxLength={80} />
        </Field>
        <Field id="fromEmail" label="From address" hint="The address emails come from. With Gmail or Outlook it must be the mailbox you sign in with.">
          <input id="fromEmail" name="fromEmail" type="email" className="input" defaultValue={v.fromEmail ?? ""} autoComplete="off" />
        </Field>
        <Field id="replyTo" label="Reply-to address" hint="Optional. Replies and UNSUBSCRIBE emails arrive here (otherwise at the From address).">
          <input id="replyTo" name="replyTo" type="email" className="input" defaultValue={v.replyTo ?? ""} autoComplete="off" />
          <label className="mt-1 flex items-center gap-2 text-xs">
            <input type="checkbox" name="replyWatched" defaultChecked={v.replyWatched} className="check" /> Someone reads this mailbox at least once a week
          </label>
        </Field>
      </div>
      <p className="muted text-xs">Marketing email needs a reply-to address someone reads every week: unsubscribes arrive there.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Submit>Save email settings</Submit>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="skipCheck" className="check" /> Save without checking
        </label>
      </div>
      <p className="muted text-xs">Saving connects to the mail server once to check the login. Tick &apos;Save without checking&apos; if you&apos;re offline.</p>
    </ActionForm>
  );
}

// ---------- texts ----------

export type TextSettingsValues = {
  smsOn: boolean;
  twilioSid: string | null;
  twilioKeySid: string | null;
  twilioFrom: string | null;
  hasTwilioToken: boolean;
  tokenPlaceholder: string;
};

export function TextSettingsForm({ v, secretsAllowed, tzConfirmed }: { v: TextSettingsValues; secretsAllowed: boolean; tzConfirmed: boolean }) {
  return (
    <ActionForm action={saveTextSettings} success="Saved" className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="smsOn" defaultChecked={v.smsOn} className="check" /> Send texts
      </label>
      {!tzConfirmed && <p className="muted text-xs">Texts can go on once the shop&apos;s time zone is confirmed (just below): quiet hours depend on it.</p>}
      <div className="grid-form">
        <Field id="twilioSid" label="Account SID" hint="Starts with AC; on the front page of the Twilio console.">
          <input id="twilioSid" name="twilioSid" className="input mono" defaultValue={v.twilioSid ?? ""} autoComplete="off" />
        </Field>
        <Field id="twilioKeySid" label="API key SID (recommended)" hint="Twilio console -> API keys -> Standard key. Starts with SK. Leave blank to use the Auth Token instead.">
          <input id="twilioKeySid" name="twilioKeySid" className="input mono" defaultValue={v.twilioKeySid ?? ""} autoComplete="off" />
        </Field>
        {secretsAllowed ? (
          <Field id="twilioToken" label="Auth Token, or the API key's secret" hint={v.hasTwilioToken ? v.tokenPlaceholder : "An API key's secret is shown once, when you make the key."}>
            <input id="twilioToken" name="twilioToken" type="password" className="input mono" placeholder={v.hasTwilioToken ? v.tokenPlaceholder : ""} autoComplete="new-password" />
            {v.hasTwilioToken && (
              <label className="mt-1 flex items-center gap-2 text-xs">
                <input type="checkbox" name="forgetToken" className="check" /> Forget the saved one
              </label>
            )}
          </Field>
        ) : (
          <div className="field">
            <div className="label">Auth Token, or the API key&apos;s secret</div>
            <p className="text-sm">{LOCAL_ONLY_MESSAGE}</p>
            {v.hasTwilioToken && <p className="muted text-xs">{v.tokenPlaceholder}</p>}
          </div>
        )}
        <Field id="twilioFrom" label="Twilio number" hint="The number texts come from, like (555) 123-4567.">
          <input id="twilioFrom" name="twilioFrom" className="input" defaultValue={v.twilioFrom ? fmtPhone(v.twilioFrom) : ""} autoComplete="off" />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Submit>Save text settings</Submit>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="skipCheck" className="check" /> Save without checking
        </label>
      </div>
      <p className="muted text-xs">Saving asks Twilio once whether the SID and token work. Tick &apos;Save without checking&apos; if you&apos;re offline.</p>
    </ActionForm>
  );
}

// ---------- test sends ----------

/**
 * Sends a test email or text to one of the admin's own addresses (sendTestMessage returns the result, so this isn't an
 * ActionForm). `sample` names a template key to send rendered with the sample values.
 */
export function TestSendForm({ channel, addresses, sample, idPrefix, label, button }: { channel: "email" | "sms"; addresses: string[]; sample?: string; idPrefix: string; label?: string; button?: string }) {
  const [pending, start] = useTransition();
  const what = channel === "email" ? "email" : "text";
  if (!addresses.length) {
    return <p className="muted text-sm">{channel === "email" ? "Save a From address first: test emails go to your own login address, the From address or the Reply-to address." : "Add your mobile number as a test number first."}</p>;
  }
  const selectId = `${idPrefix}-to`;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        const fd = new FormData(e.currentTarget);
        start(async () => {
          try {
            const r = await sendTestMessage(fd);
            if ("error" in r) toast.error(r.error);
            else toast.success(r.detail);
          } catch (err) {
            unstable_rethrow(err);
            console.error(err);
            toast.error("Couldn't send: check the connection and try again.");
          }
        });
      }}
    >
      <input type="hidden" name="channel" value={channel} />
      {sample && <input type="hidden" name="sample" value={sample} />}
      <div className="field">
        <label htmlFor={selectId} className="label">
          {label ?? `Send a test ${what} to`}
        </label>
        <select id={selectId} name="to" className="select">
          {addresses.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn btn-sm" disabled={pending}>
        {pending ? "Sending..." : (button ?? `Send a test ${what}`)}
      </button>
    </form>
  );
}

// ---------- rules ----------

export type RulesValues = {
  postalAddress: string | null;
  quietStart: string; // "09:00"
  quietEnd: string;
  noSundayMarketing: boolean;
  emailDailyCap: number;
  smsDailyCap: number;
  smsPartMills: number;
  smsConsentText: string | null;
};

export function RulesForm({ v, shopAddress, shopName, defaultConsent, currentCode }: { v: RulesValues; shopAddress: string | null; shopName: string; defaultConsent: string; currentCode: string }) {
  const [wording, setWording] = useState(v.smsConsentText ?? "");
  const preview = (wording.trim() || defaultConsent).replace(/\{shop_name\}/g, shopName);
  return (
    <ActionForm action={saveMessageRules} success="Saved" className="space-y-4">
      <Field id="postalAddress" label="Postal address (printed in every marketing email)" hint="The law requires it. Blank uses the shop address from Settings.">
        <input id="postalAddress" name="postalAddress" className="input" defaultValue={v.postalAddress ?? shopAddress ?? ""} maxLength={300} />
      </Field>
      <div className="grid-form">
        <Field id="quietStart" label="Texts from" hint="Shop time. Texts wait until this time; between 8:00 am and 9:00 pm.">
          <input id="quietStart" name="quietStart" type="time" className="input" defaultValue={v.quietStart} />
        </Field>
        <Field id="quietEnd" label="Texts until">
          <input id="quietEnd" name="quietEnd" type="time" className="input" defaultValue={v.quietEnd} />
        </Field>
        <Field id="emailDailyCap" label="Marketing emails a day, at most" hint="Gmail allows about 500 a day in all.">
          <input id="emailDailyCap" name="emailDailyCap" className="input num" inputMode="numeric" defaultValue={String(v.emailDailyCap)} />
        </Field>
        <Field id="smsDailyCap" label="Marketing texts a day, at most">
          <input id="smsDailyCap" name="smsDailyCap" className="input num" inputMode="numeric" defaultValue={String(v.smsDailyCap)} />
        </Field>
        <Field id="smsPartMills" label="What a text part costs you (tenths of a cent)" hint="Twilio's price per part; 11 means 1.1¢. Only for the cost hints.">
          <input id="smsPartMills" name="smsPartMills" className="input num" inputMode="numeric" defaultValue={String(v.smsPartMills)} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="noSundayMarketing" defaultChecked={v.noSundayMarketing} className="check" /> No marketing texts on Sundays
      </label>
      <div className="space-y-2">
        <Field id="smsConsentText" label="What customers agree to for marketing texts" hint={<>Blank uses the standard wording. It must name the shop ({"{shop_name}"} is filled in), say consent is not a condition of purchase, and tell people they can reply STOP.</>}>
          <textarea id="smsConsentText" name="smsConsentText" rows={4} className="textarea" value={wording} onChange={(e) => setWording(e.target.value)} maxLength={1000} placeholder={defaultConsent} />
        </Field>
        <div className="rounded border border-line p-3 text-sm">
          <div className="label mb-1">As customers will read it</div>
          <p className="whitespace-pre-wrap">{preview}</p>
          <p className="muted mt-2 text-xs">
            Form code for the saved wording: <span className="mono">{currentCode}</span>. A changed wording gets a new code when you save; printed forms keep working with their old code.
          </p>
        </div>
      </div>
      <Submit>Save rules</Submit>
    </ActionForm>
  );
}

// ---------- automatic messages ----------

export type AutoValues = {
  readyNotice: boolean;
  reminders: boolean;
  reminderHour: number;
  abandonNotices: boolean;
  abandonDays: number[];
  finalNoticeDays: number;
  serviceDue: boolean;
  serviceDueMonths: number;
  reviewRequest: boolean;
  reviewUrl: string | null;
  reviewDelayHours: number;
  reviewEveryDays: number;
  reviewAfterSales: boolean;
  estimateLinkDays: number;
};

export type AutoWording = {
  /** every template key -> the saved or default text */
  templates: Record<string, string>;
  fields: Record<string, string[]>;
  sample: Record<string, string>;
  /** "{Shop}: " */
  smsPrefix: string;
  /** the signature finalize adds to notice emails / the advertisement footer of marketing emails */
  noticeEmailFooter: string;
  marketingEmailFooter: string;
  partMills: number;
  addresses: { emails: string[]; phones: string[] };
};

type Block = { title: string; who: string; marketing: boolean; keys: string[]; vac?: boolean; controls?: (v: AutoValues, formId: string) => React.ReactNode; summary?: (v: AutoValues) => string };

const num = (id: string, name: string, label: string, value: number, min: number, max: number, formId: string, hint?: string) => (
  <Field id={id} label={label} hint={hint}>
    <input id={id} name={name} form={formId} className="input num w-28" inputMode="numeric" min={min} max={max} defaultValue={String(value)} />
  </Field>
);
const sw = (name: string, label: string, on: boolean, formId: string) => (
  <label className="flex items-center gap-2 text-sm font-semibold">
    <input type="checkbox" name={name} form={formId} defaultChecked={on} className="check" /> {label}
  </label>
);

const BLOCKS: Block[] = [
  {
    title: "Ready for pickup",
    who: "The customer, when their repair is marked ready (after a 2-minute undo window), the way they asked to be told. A notice about their own repair, not marketing.",
    marketing: false,
    keys: ["ready"],
    controls: (v, f) => sw("readyNotice", "Send ready-for-pickup notices", v.readyNotice, f),
    summary: (v) => (v.readyNotice ? "On" : "Off"),
  },
  {
    title: "Reminders for classes and appointments",
    who: "Everyone signed up or booked, the day before. Sign-up and booking confirmations go at the counter. Notices, not marketing.",
    marketing: false,
    keys: ["reminder", "class_signup", "booking"],
    controls: (v, f) => (
      <>
        {sw("reminders", "Send reminders the day before", v.reminders, f)}
        {num("reminderHour", "reminderHour", "From this hour (8-20, shop time)", v.reminderHour, 8, 20, f)}
      </>
    ),
    summary: (v) => (v.reminders ? `On, from ${v.reminderHour}:00` : "Off"),
  },
  {
    title: "Estimates",
    who: "Sent by staff from a ticket. The customer approves or declines through the link, or by calling. A notice.",
    marketing: false,
    keys: ["estimate", "estimate_nolink"],
    controls: (v, f) => num("estimateLinkDays", "estimateLinkDays", "Estimate links stay open (days, 1-30)", v.estimateLinkDays, 1, 30, f),
    summary: (v) => `Links open ${v.estimateLinkDays} days`,
  },
  {
    title: "Not picked up notices",
    who: "Customers whose repair has been ready for the days listed; the final notice goes before the abandon date set under Settings -> Shop. A notice about their own property: only an owner or admin can stop one.",
    marketing: false,
    keys: ["abandon", "abandon_final"],
    controls: (v, f) => (
      <>
        {sw("abandonNotices", "Send not-picked-up notices", v.abandonNotices, f)}
        <div className="grid-form">
          <Field id="abandonDays" label="Days after ready (1 to 4 numbers, like 7, 30)">
            <input id="abandonDays" name="abandonDays" form={f} className="input w-40" defaultValue={v.abandonDays.join(", ")} />
          </Field>
          {num("finalNoticeDays", "finalNoticeDays", "Final notice this many days before the abandon date (1-60)", v.finalNoticeDays, 1, 60, f)}
        </div>
      </>
    ),
    summary: (v) => (v.abandonNotices ? `On: days ${v.abandonDays.join(", ")}; final notice ${v.finalNoticeDays} days before` : "Off"),
  },
  {
    title: "Service reminders",
    who: "Customers whose machine was serviced this long ago. Marketing: texts only to customers who signed up for marketing texts; email only while they haven't unsubscribed.",
    marketing: true,
    keys: ["service_due"],
    controls: (v, f) => (
      <>
        {sw("serviceDue", "Send service reminders", v.serviceDue, f)}
        {num("serviceDueMonths", "serviceDueMonths", "Months after the service (3-60)", v.serviceDueMonths, 3, 60, f)}
      </>
    ),
    summary: (v) => (v.serviceDue ? `On, after ${v.serviceDueMonths} months` : "Off"),
  },
  {
    title: "Review requests",
    who: "Customers after a pickup (and after register sales if ticked), once in a while. Marketing.",
    marketing: true,
    keys: ["review"],
    controls: (v, f) => (
      <>
        {sw("reviewRequest", "Ask for a review", v.reviewRequest, f)}
        <Field id="reviewUrl" label="Your review link (https://...)">
          <input id="reviewUrl" name="reviewUrl" form={f} className="input mono" defaultValue={v.reviewUrl ?? ""} placeholder="https://g.page/r/.../review" />
        </Field>
        <div className="grid-form">
          {num("reviewDelayHours", "reviewDelayHours", "Hours after pickup (1-168)", v.reviewDelayHours, 1, 168, f)}
          {num("reviewEveryDays", "reviewEveryDays", "At most once every (days, 30-3650)", v.reviewEveryDays, 30, 3650, f)}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="reviewAfterSales" form={f} defaultChecked={v.reviewAfterSales} className="check" /> Also after register sales
        </label>
      </>
    ),
    summary: (v) => (v.reviewRequest ? `On, ${v.reviewDelayHours} h after pickup, at most every ${v.reviewEveryDays} days` : "Off"),
  },
  {
    title: "Bags due reminders",
    who: "Vac shops: customers who bought bags this long ago (the service-reminder months). Marketing.",
    marketing: true,
    keys: ["bags_due"],
    vac: true,
  },
  {
    title: "Text sign-ups and HELP replies",
    who: "Sent by themselves: the confirmation when someone agrees to marketing texts, and the answer to a HELP reply. Required by the carriers.",
    marketing: false,
    keys: ["consent_confirm", "help_reply"],
  },
];

const PART_LABEL: Record<string, string> = { sms: "Text", subject: "Email subject", email: "Email" };

export function AutoMessagesForm({ v, wording, hasVac, readOnly }: { v: AutoValues; wording: AutoWording; hasVac: boolean; readOnly: boolean }) {
  const formId = "auto-messages";
  return (
    <div className="space-y-4">
      {BLOCKS.filter((b) => !b.vac || hasVac).map((b) => (
        <section key={b.title} className="card card-pad space-y-3">
          <h2 className="h2">
            {b.title} {b.marketing ? <span className="pill tone-wait ml-1">Marketing</span> : <span className="pill tone-neutral ml-1">Notice</span>}
          </h2>
          <p className="muted text-sm">{b.who}</p>
          {b.controls && (readOnly ? <p className="text-sm">{b.summary?.(v)}</p> : <div className="space-y-2">{b.controls(v, formId)}</div>)}
          <details>
            <summary className="link cursor-pointer text-sm">Wording</summary>
            <div className="mt-2 space-y-4">
              {b.keys.flatMap((kind) => {
                const marketing = KIND_PURPOSE[kind as MessageKind] === "marketing";
                return ["sms", "subject", "email"]
                  .map((part) => `${kind}.${part}`)
                  .filter((key) => key in wording.templates)
                  .map((key) => {
                    const part = key.split(".")[1];
                    return (
                      <div key={key}>
                        <div className="label mb-1">
                          {b.keys.length > 1 ? `${kind.replace(/_/g, " ")}: ` : ""}
                          {PART_LABEL[part]}
                        </div>
                        <TemplateEditor
                          templateKey={key}
                          value={wording.templates[key]}
                          fields={wording.fields[kind] ?? []}
                          sample={wording.sample}
                          prefix={part === "sms" ? wording.smsPrefix : ""}
                          suffix={part === "sms" ? (marketing ? " Reply STOP to opt out." : "") : part === "email" ? (marketing ? wording.marketingEmailFooter : wording.noticeEmailFooter) : ""}
                          partMills={wording.partMills}
                          addresses={wording.addresses}
                          readOnly={readOnly}
                        />
                      </div>
                    );
                  });
              })}
            </div>
          </details>
        </section>
      ))}
      {!readOnly && (
        <ActionForm id={formId} action={saveAutoMessages} success="Saved">
          <Submit>Save automatic messages</Submit>
        </ActionForm>
      )}
    </div>
  );
}
