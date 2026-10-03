import "server-only";
// The hosted service's own mail (hub-accounts-billing-design.md 4.3.2, package hosted-provisioning): password reset links,
// from one mailbox whoever runs the service controls, not from any shop's. PLATFORM_SMTP_URL (smtps://user:pass@host:465,
// or smtp://user:pass@host:587 for STARTTLS) and PLATFORM_MAIL_FROM. Sent with the shops' own SMTP code
// (messaging/smtp.ts openSmtp), so the hosted rules hold: a public server, TLS, a log-in. A host:port in
// SMTP_ALLOW_HOSTS (a check's mail sink) is spoken to plainly. Nothing from PLATFORM_SMTP_URL is ever logged or shown:
// errors carry the server's reply words only. Never on the Windows program (it resets from the tray).
import { isValidEmail } from "@/lib/email";
import { isDesktop } from "@/lib/modules";
import { MESSAGING_DEFAULTS, type MessagingView, type SendConfig } from "@/lib/messaging/settings";
import { openSmtp } from "@/lib/messaging/smtp";
import { appName } from "@/lib/shops";

type Server = { host: string; port: number; security: "tls" | "starttls" | "none"; user: string | null; pass: string | null; from: string };

const allowListed = (host: string, port: number) =>
  (process.env.SMTP_ALLOW_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(`${host}:${port}`);

/** The mail server from the variables, or why there is none (words for the administrator, never the URL itself). */
function server(): Server | { problem: string } {
  if (isDesktop()) return { problem: "The Windows program doesn't send mail of its own: a password is reset from the tray icon on the shop PC." };
  const raw = (process.env.PLATFORM_SMTP_URL ?? "").trim();
  const from = (process.env.PLATFORM_MAIL_FROM ?? "").trim();
  if (!raw || !from) return { problem: "This server can't send email of its own yet: PLATFORM_SMTP_URL and PLATFORM_MAIL_FROM aren't set." };
  if (!isValidEmail(from)) return { problem: "PLATFORM_MAIL_FROM isn't an email address." };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { problem: "PLATFORM_SMTP_URL isn't a mail server address (smtps://user:pass@host:465)." };
  }
  if (!/^smtps?:$/.test(u.protocol) || !u.hostname) return { problem: "PLATFORM_SMTP_URL isn't a mail server address (smtps://user:pass@host:465)." };
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const secure = u.protocol === "smtps:";
  const port = Number(u.port) || (secure ? 465 : 587);
  const security = secure ? "tls" : allowListed(host, port) ? "none" : "starttls";
  return { host, port, security, user: decodeURIComponent(u.username) || null, pass: decodeURIComponent(u.password) || null, from };
}

/** Why this server can't mail a reset link, or null when it can. */
export function platformMailProblem(): string | null {
  const s = server();
  return "problem" in s ? s.problem : null;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** One plain message from the platform's mailbox. Throws a SendError (plain words) when the server says no. */
export async function sendPlatformMail(m: { to: string; subject: string; text: string }): Promise<void> {
  const s = server();
  if ("problem" in s) throw new Error(s.problem);
  const view = {
    ...MESSAGING_DEFAULTS,
    shopId: "platform",
    updatedAt: new Date(0),
    emailOn: true,
    smtpHost: s.host,
    smtpPort: s.port,
    smtpSecurity: s.security,
    smtpUser: s.user,
    fromName: appName(),
    fromEmail: s.from,
    replyTo: null,
    hasSmtpPass: Boolean(s.pass),
    hasTwilioToken: false,
    secretsUnreadable: false,
    emailReady: true,
    smsReady: false,
    publicUrl: null,
    replyWatched: false,
  } as MessagingView;
  const cfg: SendConfig = { shopId: "platform", shop: { name: appName(), phone: null, address: null, email: null, timeZone: "UTC" }, view, smtpPass: s.pass, twilioToken: null };
  const session = await openSmtp(cfg);
  try {
    const html = `<p>${escapeHtml(m.text)
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>")
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`;
    await session.send({ to: m.to, subject: m.subject, text: m.text, html, headers: { "Auto-Submitted": "auto-generated" } });
  } finally {
    session.close();
  }
}
