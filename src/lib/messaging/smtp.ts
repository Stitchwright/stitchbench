import "server-only";
// Sending email over SMTP, driven at the connection level so the outcome of every message is known
// (scheduling-messaging-design.md section 4.1, smtp.ts). nodemailer 10's SMTPConnection and MailComposer; no transport
// object, no pooling: one session per shop per worker run. Errors become SendErrors whose message is plain words built
// from the server's reply codes, never from the connection's settings (so nothing secret reaches a log or a page).
import dns from "node:dns/promises";
import net from "node:net";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import MailComposer from "nodemailer/lib/mail-composer";
import { isUserError, UserError } from "@/lib/user-error";
import { isDesktop } from "@/lib/modules";
import { privateAddress } from "@/lib/safe-fetch";
import { SendError } from "./errors";
import type { SendConfig } from "./settings";

/** What nodemailer puts on its errors (NodemailerError in its typings). */
type MailError = Error & { code?: string; command?: string; response?: string; responseCode?: number };

const HOSTED_PORTS = [465, 587, 2525];
const DNS_CODES = ["EDNS", "ENOTFOUND", "EAI_AGAIN", "ESERVFAIL", "ENODATA", "ETIMEOUT"];

/** `host:port` entries that may be private or plain under hosted rules (the tests' sink). */
function allowList(): string[] {
  return (process.env.SMTP_ALLOW_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const isAllowed = (host: string, port: number) => allowList().includes(`${host.toLowerCase()}:${port}`);

/** Every address the name has, IPv4 first; SendError offline when the lookup fails. */
async function lookup(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  let list: { address: string; family: number }[];
  try {
    list = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "EDNS";
    throw new SendError("Can't find the mail server's address right now.", "offline", code);
  }
  const addresses = list.map((a) => a.address);
  addresses.sort((a, b) => Number(!net.isIPv4(a)) - Number(!net.isIPv4(b)));
  if (!addresses.length) throw new SendError("Can't find the mail server's address right now.", "offline", "ENOTFOUND");
  return addresses;
}

/** The hosted rules (public server, 465 / 587 / 2525, TLS) and the Windows rule ("none" only on the shop's network). */
function applyRules(host: string, port: number, security: string, addresses: string[]): void {
  if (!isDesktop()) {
    if (isAllowed(host, port)) return;
    if (addresses.some(privateAddress)) throw new UserError("That mail server is on a private network. Use your provider's public server name.");
    if (!HOSTED_PORTS.includes(port)) throw new UserError("Use port 587 (or 465 for SSL). Other ports aren't allowed here.");
    if (security !== "tls" && security !== "starttls") throw new UserError("Pick SSL or STARTTLS. A plain connection isn't allowed here.");
    return;
  }
  if (security === "none" && !addresses.every(privateAddress)) throw new UserError("'None' is only for a mail server on this shop's own network.");
}

/**
 * Resolves the server name (IPv4 first) and applies the rules: hosted (not the Windows program) only public addresses on
 * 465 / 587 / 2525 with TLS, unless `host:port` is in SMTP_ALLOW_HOSTS; the Windows program any server, "none" only for
 * one on the shop's own network. UserError for the admin; the addresses for the connection.
 */
export async function checkSmtpHost(host: string, port: number, security: string): Promise<string[]> {
  const name = host.trim().toLowerCase();
  if (!name) throw new UserError("Enter your mail server, like smtp.gmail.com.");
  let addresses: string[];
  try {
    addresses = await lookup(name);
  } catch {
    throw new UserError(`Can't find a mail server called ${name}. Check the name (and that you're online).`);
  }
  applyRules(name, port, security, addresses);
  return addresses;
}

export type SmtpSession = {
  send(m: { to: string; toName?: string | null; subject: string; text: string; html: string; headers: Record<string, string>; attachments?: { filename: string; content: string; contentType: string }[] }): Promise<{ id: string }>;
  close(): void;
};

const AUTH_WRONG = "The mail server said the user name or password is wrong. For Gmail or Outlook use an app password, not your normal password.";

/** The enhanced status code ("5.1.1") in a reply, when there is one. */
function enhancedCode(response: string | undefined): string | null {
  const m = response ? /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(response) : null;
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** The server's reply as one short line for the status page (its own words, never ours). */
function replyText(response: string | undefined): string {
  const first = (response ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return first.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160);
}

/** Connect / greeting / TLS failures, before any login. */
function classifyConnect(e: unknown, host: string): SendError {
  const err = e as MailError;
  const code = err.code ?? "";
  if (code === "ETLS" || /^CERT_|^ERR_TLS_|certificate|self[ -]signed/i.test(code + " " + (err.message ?? ""))) {
    return new SendError(`The mail server's certificate doesn't match ${host}.`, "settings", code || "ETLS");
  }
  if (err.responseCode && err.responseCode >= 500) return new SendError(`The mail server refused the connection (${replyText(err.response) || err.responseCode}).`, "settings", String(err.responseCode));
  if (err.responseCode && err.responseCode >= 400) return new SendError(`The mail server is busy (${replyText(err.response) || err.responseCode}).`, "retry", String(err.responseCode));
  return new SendError(`Can't reach the mail server at ${host}.`, "offline", code || "ECONNECTION");
}

/** Login failures: a 5xx is the password, a 4xx a server asking for patience, no reply at all the connection. */
function classifyLogin(e: unknown, host: string): SendError {
  const err = e as MailError;
  if (err.responseCode && err.responseCode >= 500) return new SendError(AUTH_WRONG, "settings", String(err.responseCode));
  if (err.responseCode && err.responseCode >= 400) return new SendError(`The mail server asked us to sign in later (${replyText(err.response) || err.responseCode}).`, "retry", String(err.responseCode));
  if (err.code === "EAUTH") return new SendError(AUTH_WRONG, "settings", "EAUTH");
  return classifyConnect(e, host);
}

/**
 * A failure while sending one message, from the stage and the reply (design 4.1 classification table). `hadReply` tells
 * the session whether a RSET is enough or the connection is gone.
 */
function classifySend(e: unknown): { error: SendError; hadReply: boolean } {
  const err = e as MailError;
  const code = err.responseCode;
  const command = err.command ?? "";
  if (!code || !err.response) {
    if (command === "API") {
      // Nothing reached the server: a malformed envelope, or a connection that had already gone.
      if (err.code === "EENVELOPE" || err.code === "EMESSAGE") return { error: new SendError("The address can't be used.", "recipient", err.code), hadReply: false };
      return { error: new SendError("The mail connection had closed; trying again.", "retry", err.code ?? "ECONNECTION"), hadReply: false };
    }
    return { error: new SendError("The mail server stopped answering mid-way; the message may have gone.", "ambiguous", err.code ?? "CONN"), hadReply: false };
  }
  const text = replyText(err.response) || String(code);
  if (code < 500) return { error: new SendError(`The mail server asked us to try later (${text}).`, "retry", String(code)), hadReply: true };
  const enhanced = enhancedCode(err.response);
  if (command === "MAIL FROM") return { error: new SendError(`The mail server refused to send (${text}).`, "quota", String(code)), hadReply: true };
  if (enhanced && (enhanced === "5.4.5" || enhanced.startsWith("5.7.") || enhanced === "5.2.0")) {
    return { error: new SendError(`The mail server refused to send (${text}).`, "quota", String(code)), hadReply: true };
  }
  if (enhanced && (enhanced.startsWith("5.1.") || enhanced === "5.2.1" || enhanced === "5.2.2")) {
    return { error: new SendError(`The address was refused (${text}).`, "recipient", String(code)), hadReply: true };
  }
  return { error: new SendError(`The address was refused (${text}).`, "recipient", String(code)), hadReply: true };
}

function connectTo(conn: SMTPConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      conn.removeListener("error", finish);
      if (err) reject(err);
      else resolve();
    };
    conn.once("error", finish);
    conn.connect((err) => finish(err ?? undefined));
  });
}

function loginTo(conn: SMTPConnection, user: string, pass: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.login({ user, pass }, (err) => (err ? reject(err) : resolve()));
  });
}

function sendOn(conn: SMTPConnection, from: string, to: string, raw: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.send({ from, to: [to] }, raw, (err) => (err ? reject(err) : resolve()));
  });
}

function resetOn(conn: SMTPConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.reset((err) => (err ? reject(err) : resolve()));
  });
}

const cleanName = (s: string | null | undefined) => (s ?? "").replace(/[\u0000-\u001f\u007f<>"]/g, " ").replace(/ {2,}/g, " ").trim();

/**
 * Opens a session to the shop's mail server: the host checked (every time), each of its addresses tried in order until
 * one connects (the address pinned, TLS checked against the name), then the login. Errors here are SendErrors
 * (offline / settings / retry). Messages then go through send(); close() always.
 */
export async function openSmtp(cfg: SendConfig): Promise<SmtpSession> {
  const v = cfg.view;
  const host = (v.smtpHost ?? "").trim().toLowerCase();
  const port = v.smtpPort;
  const security = v.smtpSecurity;
  const fromEmail = v.fromEmail;
  if (!host || !fromEmail) throw new SendError("Email isn't set up: the mail server or the From address is missing.", "settings");
  const hosted = !isDesktop();
  if (hosted && !isAllowed(host, port) && (!v.smtpUser || !cfg.smtpPass)) throw new SendError("This server needs a mail log-in (user name and password).", "settings");
  if (v.smtpUser && !cfg.smtpPass) throw new SendError("The saved mail password can't be read. Enter it again in Settings -> Messages.", "settings");

  const addresses = await lookup(host);
  try {
    applyRules(host, port, security, addresses);
  } catch (e) {
    if (isUserError(e)) throw new SendError(e.message, "settings");
    throw e;
  }

  let conn: SMTPConnection | null = null;
  let last: SendError | null = null;
  for (const address of addresses) {
    const c = new SMTPConnection({
      host: address,
      port,
      secure: security === "tls",
      requireTLS: security === "starttls",
      ignoreTLS: security === "none",
      servername: host,
      tls: { servername: host, minVersion: "TLSv1.2" },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      logger: false,
      debug: false,
    });
    try {
      await connectTo(c);
      conn = c;
      break;
    } catch (e) {
      c.close();
      last = classifyConnect(e, host);
      if (last.kind !== "offline") throw last;
    }
  }
  if (!conn) throw last ?? new SendError(`Can't reach the mail server at ${host}.`, "offline", "ECONNECTION");
  const live = conn;

  if (v.smtpUser && cfg.smtpPass) {
    try {
      await loginTo(live, v.smtpUser, cfg.smtpPass);
    } catch (e) {
      live.close();
      throw classifyLogin(e, host);
    }
  }

  let open = true;
  // Errors between commands (the server dropping an idle connection) must not crash the process.
  live.on("error", () => {
    open = false;
  });
  live.on("end", () => {
    open = false;
  });
  const fromName = v.fromName?.trim() || cfg.shop.name;
  const replyTo = v.replyTo ?? fromEmail;

  return {
    async send(m) {
      if (!open) throw new SendError("The mail connection had closed; trying again.", "retry", "ECONNECTION");
      const composer = new MailComposer({
        from: { name: cleanName(fromName), address: fromEmail },
        to: { name: cleanName(m.toName), address: m.to },
        replyTo: { name: cleanName(cfg.shop.name), address: replyTo },
        subject: m.subject,
        text: m.text,
        html: m.html,
        headers: m.headers,
        attachments: m.attachments,
      });
      const node = composer.compile();
      const raw = await node.build();
      const id = node.messageId();
      try {
        await sendOn(live, fromEmail, m.to, raw);
        return { id };
      } catch (e) {
        const { error, hadReply } = classifySend(e);
        if (hadReply && open) {
          // The transaction failed but the connection is fine: start clean for the next message.
          await resetOn(live).catch(() => {
            open = false;
            live.close();
          });
        } else {
          open = false;
          live.close();
        }
        throw error;
      }
    },
    close() {
      if (!open) return;
      open = false;
      try {
        live.quit();
      } catch {
        live.close();
      }
    },
  };
}

/** Open and close: Settings' "check it" (rate-limited by the action) and the worker's hourly re-check of a paused channel. */
export async function verifySmtp(cfg: SendConfig): Promise<void> {
  const s = await openSmtp(cfg);
  s.close();
}
