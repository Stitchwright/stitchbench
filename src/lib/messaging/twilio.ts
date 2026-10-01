import "server-only";
// Texts through Twilio's REST API with fetch, no SDK (scheduling-messaging-design.md section 4.1, twilio.ts). The base
// is TWILIO_API_BASE (the tests' mock), default https://api.twilio.com. Basic auth user = the API key SID when one is
// used, else the account SID; URLs always carry the account SID. Errors are SendErrors from the HTTP status and Twilio's
// error code, in plain words.
import { SendError } from "./errors";
import type { SendConfig } from "./settings";

const TIMEOUT = 15_000;
const SID = /^AC[0-9a-f]{32}$/i;
const KEY_SID = /^SK[0-9a-f]{32}$/i;

/** A customer's text to the shop's number. */
export type Reply = { sid: string; from: string; body: string; receivedAt: Date };

type TwilioMessage = {
  sid: string;
  from?: string | null;
  to?: string | null;
  body?: string | null;
  direction?: string | null;
  status?: string | null;
  error_code?: number | null;
  date_created?: string | null;
  date_sent?: string | null;
};

type ListPage = { messages?: TwilioMessage[]; next_page_uri?: string | null };

const base = () => (process.env.TWILIO_API_BASE?.trim().replace(/\/+$/, "") || "https://api.twilio.com");

function basic(user: string, secret: string) {
  return `Basic ${Buffer.from(`${user}:${secret}`, "utf8").toString("base64")}`;
}

/** The account SID, auth user and secret from a shop's settings, or a settings SendError. */
function creds(cfg: SendConfig): { sid: string; auth: string } {
  const v = cfg.view;
  const sid = v.twilioSid?.trim() ?? "";
  if (!SID.test(sid)) throw new SendError("Texts aren't set up: the Twilio Account SID is missing or isn't an AC... value.", "settings");
  if (v.twilioKeySid && !KEY_SID.test(v.twilioKeySid.trim())) throw new SendError("The Twilio API key SID should start with SK.", "settings");
  if (!cfg.twilioToken) throw new SendError("The saved Twilio token can't be read. Enter it again in Settings -> Messages.", "settings");
  return { sid, auth: basic(v.twilioKeySid?.trim() || sid, cfg.twilioToken) };
}

const OFFLINE_CODES = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN"];

/** fetch itself failed: offline when nothing could have reached Twilio, ambiguous otherwise (a request may have gone). */
function fetchFailed(e: unknown): SendError {
  const cause = (e as { cause?: NodeJS.ErrnoException })?.cause;
  const code = cause?.code ?? (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error && e.name === "TimeoutError" ? "ETIMEDOUT" : "EFETCH");
  if (OFFLINE_CODES.includes(code)) return new SendError("Can't reach Twilio.", "offline", code);
  return new SendError("Twilio stopped answering mid-way; the text may have gone.", "ambiguous", code);
}

type Answer = { status: number; json: Record<string, unknown> | null };

async function call(auth: string, method: "GET" | "POST", path: string, form?: URLSearchParams): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { authorization: auth, accept: "application/json", ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? form.toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    throw fetchFailed(e);
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const twilioCode = (a: Answer): number | null => (typeof a.json?.code === "number" ? (a.json.code as number) : null);

/** A non-2xx answer to a read (status, list, account): settings for a bad login, otherwise retry / ambiguous. */
function readFailed(a: Answer, what: string): SendError {
  const code = twilioCode(a);
  if (a.status === 401 || code === 20003) return new SendError("Twilio said the Account SID or the token / secret is wrong.", "settings", String(code ?? a.status));
  if (a.status === 404) return new SendError(`Twilio has no ${what} by that id.`, "recipient", String(code ?? 404));
  if (a.status === 429) return new SendError("Twilio asked us to slow down.", "retry", "429");
  if (a.status >= 500) return new SendError("Twilio is having trouble; trying again later.", "ambiguous", String(a.status));
  return new SendError(`Twilio refused the request (${code ?? a.status}).`, "retry", String(code ?? a.status));
}

const RECIPIENT_CODES = [21211, 21214, 21612, 21614, 21408];
const SETTINGS_CODES = [21606, 21659, 21212, 21608];

/** A failed send, from the HTTP status and Twilio's error code (design 4.1). */
function sendFailed(a: Answer): SendError {
  const code = twilioCode(a);
  const c = code != null ? String(code) : String(a.status);
  if (a.status >= 500) return new SendError("Twilio is having trouble; the text may have gone.", "ambiguous", c);
  if (a.status === 401 || code === 20003) return new SendError("Twilio said the Account SID or the token / secret is wrong.", "settings", c);
  if (code === 21610) return new SendError("The number has opted out of texts from your Twilio number (STOP).", "recipient", c);
  if (code === 21211) return new SendError("That isn't a valid mobile number.", "recipient", c);
  if (code === 21614) return new SendError("That number can't receive texts (a landline?).", "recipient", c);
  if (code != null && RECIPIENT_CODES.includes(code)) return new SendError(`Twilio can't text that number (${c}).`, "recipient", c);
  if (code === 21606) return new SendError("Your Twilio number isn't able to send texts. Check the From number in Settings -> Messages.", "settings", c);
  if (code === 21608) return new SendError("Your Twilio account is a trial: it can only text verified numbers. Upgrade it or verify the number.", "settings", c);
  if (code != null && SETTINGS_CODES.includes(code)) return new SendError(`Twilio refused the From number (${c}). Check it in Settings -> Messages.`, "settings", c);
  if (code === 21611 || a.status === 429) return new SendError("Twilio's queue for your number is full; trying again later.", "retry", c);
  return new SendError(`Twilio refused the text (${c}).`, "recipient", c);
}

/** One text. The SID comes back; failures are SendErrors (offline / ambiguous / settings / recipient / retry). */
export async function sendText(cfg: SendConfig, to: string, body: string): Promise<{ id: string }> {
  const { sid, auth } = creds(cfg);
  const from = cfg.view.twilioFrom?.trim();
  if (!from) throw new SendError("Texts aren't set up: the Twilio number is missing.", "settings");
  const form = new URLSearchParams({ To: to, From: from, Body: body });
  const a = await call(auth, "POST", `/2010-04-01/Accounts/${sid}/Messages.json`, form);
  if (a.status >= 200 && a.status < 300 && typeof a.json?.sid === "string") return { id: a.json.sid as string };
  throw sendFailed(a);
}

const ymdUtc = (d: Date) => d.toISOString().slice(0, 10);

const when = (m: TwilioMessage): Date => {
  const d = new Date(m.date_sent ?? m.date_created ?? 0);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
};

/** The SID of an outbound text with exactly this body to this number made at or after `since` - 60 s, or null (before an ambiguous text is retried). */
export async function findSent(cfg: SendConfig, to: string, body: string, since: Date): Promise<string | null> {
  const { sid, auth } = creds(cfg);
  const from = cfg.view.twilioFrom?.trim() ?? "";
  const q = new URLSearchParams({ To: to, From: from, PageSize: "50" });
  q.set("DateSent>", ymdUtc(since));
  const a = await call(auth, "GET", `/2010-04-01/Accounts/${sid}/Messages.json?${q}`);
  if (a.status !== 200 || !a.json) throw readFailed(a, "message");
  const floor = since.getTime() - 60_000;
  const list = ((a.json as ListPage).messages ?? []).filter((m) => (m.direction ?? "").startsWith("outbound") && (m.body ?? "") === body && when(m).getTime() >= floor);
  list.sort((x, y) => when(x).getTime() - when(y).getTime());
  return list[0]?.sid ?? null;
}

/** Settings' check: the account is readable with these credentials. SendError settings / offline otherwise. */
export async function checkTwilio(sid: string, user: string, secret: string): Promise<void> {
  const acc = sid.trim();
  if (!SID.test(acc)) throw new SendError("The Twilio Account SID should be AC followed by 32 letters and digits.", "settings");
  const a = await call(basic(user.trim(), secret), "GET", `/2010-04-01/Accounts/${acc}.json`);
  if (a.status === 200) return;
  if (a.status === 404) throw new SendError("Twilio has no account with that SID.", "settings", "404");
  throw readFailed(a, "account");
}

/**
 * The customers' texts to the shop's number on one UTC day ("2026-10-07"), oldest first: PageSize 1000 and every
 * next_page_uri until the last page (complete), or until Date.now() passes `deadline` (incomplete: act on nothing).
 */
export async function listReplies(cfg: SendConfig, day: string, deadline: number): Promise<{ replies: Reply[]; complete: boolean }> {
  const { sid, auth } = creds(cfg);
  const to = cfg.view.twilioFrom?.trim() ?? "";
  const q = new URLSearchParams({ To: to, DateSent: day, PageSize: "1000" });
  let path: string | null = `/2010-04-01/Accounts/${sid}/Messages.json?${q}`;
  const replies: Reply[] = [];
  while (path) {
    if (Date.now() > deadline) return { replies, complete: false };
    const a: Answer = await call(auth, "GET", path);
    if (a.status !== 200 || !a.json) throw readFailed(a, "message list");
    const page = a.json as ListPage;
    for (const m of page.messages ?? []) {
      if ((m.direction ?? "") !== "inbound" || !m.sid) continue;
      replies.push({ sid: m.sid, from: m.from ?? "", body: m.body ?? "", receivedAt: when(m) });
    }
    path = page.next_page_uri ? (page.next_page_uri.startsWith("/") ? page.next_page_uri : `/${page.next_page_uri}`) : null;
  }
  replies.sort((x, y) => x.receivedAt.getTime() - y.receivedAt.getTime());
  return { replies, complete: true };
}

/** A sent text's delivery status and Twilio error code (null when none). */
export async function messageStatus(cfg: SendConfig, messageSid: string): Promise<{ status: string; errorCode: number | null }> {
  const { sid, auth } = creds(cfg);
  if (!/^[A-Za-z0-9]{2,40}$/.test(messageSid)) throw new SendError("That isn't a Twilio message SID.", "recipient");
  const a = await call(auth, "GET", `/2010-04-01/Accounts/${sid}/Messages/${messageSid}.json`);
  if (a.status !== 200 || !a.json) throw readFailed(a, "message");
  const m = a.json as TwilioMessage;
  return { status: String(m.status ?? ""), errorCode: typeof m.error_code === "number" ? m.error_code : null };
}
