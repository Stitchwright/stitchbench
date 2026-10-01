// Settings -> Messages: the three tabs, and the one-line status of each channel that the Setup page, Settings and the
// outbox show (scheduling-messaging-design.md 4.2, 8.3). Server components.
import Link from "next/link";
import { fmtDateTime } from "@/lib/format";
import { isDesktop } from "@/lib/modules";
import type { MessagingView } from "@/lib/messaging/settings";
import type { Channel } from "@/lib/messaging/types";
import { addDays, fmtTime, ymdOf } from "@/lib/zoned";

export type MessagingTab = "setup" | "auto" | "rules";

const TABS: { key: MessagingTab; label: string; href: string }[] = [
  { key: "setup", label: "Setup", href: "/settings/messages" },
  { key: "auto", label: "Automatic messages", href: "/settings/messages/auto" },
  { key: "rules", label: "Rules", href: "/settings/messages/rules" },
];

export function MessagingTabs({ active }: { active: MessagingTab }) {
  return (
    <nav aria-label="Message settings" className="no-print flex flex-wrap gap-2">
      {TABS.map((t) => (
        <Link key={t.key} href={t.href} className={`btn btn-sm${t.key === active ? " btn-primary" : ""}`} aria-current={t.key === active ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export type ChannelStatus = { label: string; text: string; tone: "ready" | "wait" | "bad" | "neutral" };

/** "tomorrow 8:00 am", "8:00 am" (today) or the full date. */
function whenText(d: Date, tz: string, now = new Date()) {
  const day = ymdOf(d, tz);
  const today = ymdOf(now, tz);
  if (day === today) return fmtTime(d, tz);
  if (day === addDays(today, 1)) return `tomorrow ${fmtTime(d, tz)}`;
  return fmtDateTime(d, tz);
}

/**
 * One plain line per channel: "Working, last sent 10:42", "Paused: ... (10:40). Save the settings again to try again.",
 * "Paused until tomorrow 8:00 am: ...", "Waiting for the internet since 9:15 (12 messages waiting)". `waiting` is the
 * number of queued rows on that channel when the caller has it.
 */
export function channelStatus(ms: MessagingView, channel: Channel, timeZone: string, waiting = 0): ChannelStatus {
  const email = channel === "email";
  const label = email ? "Email" : "Texts";
  const on = email ? ms.emailOn : ms.smsOn;
  const ready = email ? ms.emailReady : ms.smsReady;
  const pausedAt = email ? ms.emailPausedAt : ms.smsPausedAt;
  const pausedUntil = email ? ms.emailPausedUntil : ms.smsPausedUntil;
  const error = email ? ms.emailError : ms.smsError;
  const okAt = email ? ms.emailOkAt : ms.smsOkAt;
  const hasSecret = email ? ms.hasSmtpPass : ms.hasTwilioToken;
  const time = (d: Date) => fmtTime(d, timeZone);
  const queued = waiting ? ` (${waiting} message${waiting === 1 ? "" : "s"} waiting)` : "";
  if (!on) return { label, text: email ? "Off. Set up a mail account to send email." : "Off. Set up Twilio to send texts.", tone: "neutral" };
  if (pausedAt) {
    if (pausedUntil && pausedUntil.getTime() > Date.now()) return { label, text: `Paused until ${whenText(pausedUntil, timeZone)}: ${error ?? "a sending problem"}${queued}`, tone: "bad" };
    return { label, text: `Paused: ${error ?? "a sending problem"} (${time(pausedAt)}). Save the settings again to try again.${queued}`, tone: "bad" };
  }
  if (ms.secretsUnreadable && hasSecret) {
    return { label, text: "The saved password can't be read on this computer (the program's secret changed, for example after moving to a new PC). Enter it again.", tone: "bad" };
  }
  if (!ready) {
    const missing: string[] = [];
    const hosted = !isDesktop();
    if (email) {
      if (!ms.smtpHost) missing.push("the mail server");
      if (!ms.fromEmail) missing.push("the From address");
      if (hosted && !ms.smtpUser) missing.push("the user name");
      if (!ms.hasSmtpPass && (hosted || ms.smtpUser)) missing.push("the password");
    } else {
      if (!ms.twilioSid) missing.push("the Account SID");
      if (!ms.hasTwilioToken) missing.push("the token or key secret");
      if (!ms.twilioFrom) missing.push("the Twilio number");
      if (!ms.tzConfirmedAt) missing.push("the time zone check");
    }
    return { label, text: missing.length ? `Not ready: ${missing.join(", ")} still needed.` : "Not ready. Save the settings again.", tone: "wait" };
  }
  if (error) return { label, text: `Waiting for the internet${okAt ? ` since ${time(okAt)}` : ""}${queued}. Last problem: ${error}`, tone: "wait" };
  return { label, text: `Working${okAt ? `, last sent ${time(okAt)}` : ""}.${queued}`, tone: "ready" };
}

export function ChannelStatusLine({ status }: { status: ChannelStatus }) {
  return (
    <p className="text-sm">
      <span className={`pill tone-${status.tone} mr-2`}>{status.label}</span>
      {status.text}
    </p>
  );
}
