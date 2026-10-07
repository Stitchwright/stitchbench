// Settings -> Messages -> Rules: the postal address, quiet hours, caps, the text part price and the wording customers
// agree to for marketing texts, with its form code and the earlier wordings (scheduling-messaging-design.md 8.3).
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { hmOf } from "@/lib/zoned";
import { consentCode, consentWording, DEFAULT_SMS_CONSENT_TEXT, messagingView } from "@/lib/messaging/settings";
import { KV, PageHeader, Section } from "@/components/ui";
import { MessagingTabs } from "@/components/messaging-tabs";
import { RulesForm } from "@/components/messaging-settings-forms";

type OldWording = { code?: unknown; text?: unknown; from?: unknown; to?: unknown };

/** 540 -> "9:00 am" */
function hm12(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

export default async function MessageRulesPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  // In the base since 7 Oct 2026: quiet hours and the consent wording govern the ready and estimate texts too.
  const canEdit = admin;
  const [ms, shop] = await Promise.all([messagingView(user.shopId), db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, address: true, timeZone: true } })]);
  const wording = consentWording(ms, shop.name);
  const code = consentCode(wording);
  const history = (Array.isArray(ms.consentTexts) ? (ms.consentTexts as OldWording[]) : []).filter((w) => typeof w.text === "string" && typeof w.code === "string").reverse();
  const when = (v: unknown) => (typeof v === "string" && v ? fmtDate(v, shop.timeZone) : null);

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Email and text messages" back={{ href: "/settings", label: "Settings" }} sub="The rules every message follows: the law's parts, quiet hours and daily limits." />
      <MessagingTabs active="rules" />

      <Section title="Rules">
        {canEdit ? (
          <RulesForm
            v={{
              postalAddress: ms.postalAddress,
              quietStart: hmOf(ms.quietStart),
              quietEnd: hmOf(ms.quietEnd),
              noSundayMarketing: ms.noSundayMarketing,
              emailDailyCap: ms.emailDailyCap,
              smsDailyCap: ms.smsDailyCap,
              smsPartMills: ms.smsPartMills,
              smsConsentText: ms.smsConsentText,
            }}
            shopAddress={shop.address}
            shopName={shop.name}
            defaultConsent={DEFAULT_SMS_CONSENT_TEXT}
            currentCode={code}
          />
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid-form">
              <KV k="Postal address in marketing email" v={ms.postalAddress ?? shop.address} />
              <KV k="Texts go out" v={`${hm12(ms.quietStart)} to ${hm12(ms.quietEnd)}, shop time${ms.noSundayMarketing ? "; no marketing texts on Sundays" : ""}`} />
              <KV k="Marketing emails a day, at most" v={String(ms.emailDailyCap)} />
              <KV k="Marketing texts a day, at most" v={String(ms.smsDailyCap)} />
              <KV k="A text part costs" v={`${(ms.smsPartMills / 10).toFixed(1)}¢`} />
            </div>
            <div>
              <div className="label mb-1">What customers agree to for marketing texts</div>
              <p className="whitespace-pre-wrap">{wording}</p>
              <p className="muted mt-1 text-xs">
                Form code <span className="mono">{code}</span>
              </p>
            </div>
            {!admin && <p className="muted">The shop owner or an admin changes these.</p>}
          </div>
        )}
      </Section>

      {history.length > 0 && (
        <Section title="Earlier wordings">
          <p className="muted mb-2 text-sm">Paper forms printed with these codes can still be recorded on a customer&apos;s page.</p>
          <ul className="space-y-3 text-sm">
            {history.map((w, i) => (
              <li key={`${String(w.code)}-${i}`}>
                <div className="muted text-xs">
                  Code <span className="mono">{String(w.code)}</span>
                  {when(w.to) ? ` · used ${when(w.from) ? `${when(w.from)} to ` : "until "}${when(w.to)}` : ""}
                </div>
                <p className="whitespace-pre-wrap">{String(w.text)}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
