import "server-only";
// The program's one way to the Foundry Account service (cloud.stitchfoundry.app; code and docs in
// github.com/Stitchwright/StitchFoundry, apps/stitchfoundry-cloud and docs/cloud.md): sign up and in, the account and its
// credits, and AI requests paid in Foundry credits (POST /v1/messages). Plan: docs/plan.md, task FA-1.
//
// The session token (sfs_…) can spend the account's credits, so it never leaves the server: callers keep it in the
// database, sealed, and never put it in a cookie, a page, a log line or an error message. Nothing here does either: a
// FoundryError carries the service's own words (they never contain the token or the password).
//
// The address is FOUNDRY_CLOUD_URL, else the real service. Like the hub's address it must be https, or http for this
// computer only (the tests use a stand-in on 127.0.0.1: scripts/test-mail/foundry-mock.mjs).
import { UserError } from "@/lib/user-error";

export const DEFAULT_CLOUD_URL = "https://cloud.stitchfoundry.app";
/** Longest answer read from the service: a Messages reply is at most 16,000 tokens, far under this. */
const MAX_ANSWER_BYTES = 2_000_000;
const QUICK_MS = 15_000;
/** An AI request may take a while (Opus, long answers); the service itself waits on Anthropic. */
const AI_MS = 120_000;

/** What went wrong, in words a person can act on. */
export type FoundryFailure =
  | "offline" //   couldn't reach the service (no internet, it is down, it timed out)
  | "signed-out" // 401: the sign-in ended or the password is wrong: sign in again
  | "no-credits" // 402: too few Foundry credits
  | "wait" //      429: slow down or the email is locked for a while
  | "refused" //   400, 404, 409: the request itself isn't accepted (the message says why)
  | "not-open" //  503: the service's AI or email isn't set up yet
  | "broken"; //   anything else: 5xx, or an answer that isn't the service's

/** The service said no, or couldn't be reached. `status` is 0 when there was no answer. */
export class FoundryError extends UserError {
  readonly foundryError = true;
  constructor(
    message: string,
    public status: number,
    public kind: FoundryFailure,
  ) {
    super(message);
    this.name = "FoundryError";
  }
}

/** A FoundryError from any copy of the code (see user-error.ts for why `instanceof` isn't enough). */
export function isFoundryError(e: unknown): e is FoundryError {
  return e instanceof FoundryError || (typeof e === "object" && e !== null && (e as { foundryError?: unknown }).foundryError === true);
}

/** The offline wording every screen that needs the service shows (hub and AI), so it reads the same everywhere. */
export const OFFLINE_NOTICE = "This needs the internet and your Foundry Account. Everything else keeps working, and this comes back when the PC is online.";

/** The service's address under the same rule as the hub's: https, or http for this computer only; nothing else in it. */
export function checkCloudUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UserError("The Foundry Account address starts with https://");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new UserError("The Foundry Account address starts with https://");
  if (u.username || u.password || u.search || u.hash) throw new UserError("That Foundry Account address doesn't look right.");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Where the service is for this install. */
export function cloudUrl(): string {
  return checkCloudUrl((process.env.FOUNDRY_CLOUD_URL ?? "").trim() || DEFAULT_CLOUD_URL);
}

export type CloudOptions = {
  /** The service's address; default cloudUrl(). */
  baseUrl?: string;
  /** For tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** The account as the service answers it. `id` never changes: our own records are keyed by it. */
export type FoundryAccount = {
  id: number;
  email: string;
  /** Foundry credits left (what a new request could still use). */
  credits: number;
};
export type SignedIn = { token: string; account: FoundryAccount };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function accountOf(v: unknown): FoundryAccount {
  if (!isRecord(v) || typeof v.id !== "number" || !Number.isSafeInteger(v.id) || v.id < 1 || typeof v.email !== "string") {
    throw new FoundryError("The Foundry Account service answered something this program doesn't understand.", 0, "broken");
  }
  const credits = typeof v.credits === "number" && Number.isFinite(v.credits) ? Math.max(0, Math.floor(v.credits)) : 0;
  return { id: v.id, email: v.email, credits };
}

function failure(status: number, body: unknown): FoundryError {
  // The service's own sentence ({ type: "error", error: { type, message } }), cut short; never anything from the request.
  const raw = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" ? body.error.message.slice(0, 300) : "";
  const said = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : ""; // the service writes "that email and password don't match"; a toast starts with a capital
  if (status === 401) return new FoundryError(said || "Your Foundry Account sign-in has ended. Sign in again.", status, "signed-out");
  if (status === 402) return new FoundryError(said || "Not enough Foundry credits.", status, "no-credits");
  if (status === 429) return new FoundryError(said || "Too many tries. Wait a little and try again.", status, "wait");
  if (status === 503) return new FoundryError(said || "That isn't open on the Foundry Account service yet.", status, "not-open");
  if (status === 400 || status === 404 || status === 409) return new FoundryError(said || "The Foundry Account service didn't accept that.", status, "refused");
  return new FoundryError("The Foundry Account service had a problem. Try again in a minute.", status, "broken");
}

async function call(method: "GET" | "POST", path: string, o: CloudOptions, opts: { token?: string; body?: unknown; ms: number }): Promise<{ json: unknown; headers: Headers }> {
  const base = o.baseUrl ? checkCloudUrl(o.baseUrl) : cloudUrl();
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  let text: string;
  try {
    res = await (o.fetch ?? fetch)(`${base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      redirect: "manual", // a redirect would carry the token somewhere else
      signal: AbortSignal.timeout(o.timeoutMs ?? opts.ms),
    });
    text = await res.text();
  } catch {
    throw new FoundryError(OFFLINE_NOTICE, 0, "offline");
  }
  if (text.length > MAX_ANSWER_BYTES) throw new FoundryError("The Foundry Account service answered more than this program will read.", res.status, "broken");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.status >= 300 && res.status < 400) throw new FoundryError("The Foundry Account service moved. Check its address in Settings.", res.status, "broken");
  if (!res.ok) throw failure(res.status, json);
  return { json, headers: res.headers };
}

function sessionOf(json: unknown): SignedIn {
  if (!isRecord(json) || typeof json.token !== "string" || !/^sfs_[0-9a-f]{64}$/.test(json.token)) {
    throw new FoundryError("The Foundry Account service answered something this program doesn't understand.", 0, "broken");
  }
  return { token: json.token, account: accountOf(json.account) };
}

/** Make a Foundry Account (a new one starts with the service's sign-up credits). The password is sent and never kept. */
export async function signUp(email: string, password: string, o: CloudOptions = {}): Promise<SignedIn> {
  return sessionOf((await call("POST", "/v1/signup", o, { body: { email, password }, ms: QUICK_MS })).json);
}

/** Sign in. A wrong password is a "signed-out" failure; five in a row lock the email for 15 minutes ("wait"). */
export async function signIn(email: string, password: string, o: CloudOptions = {}): Promise<SignedIn> {
  return sessionOf((await call("POST", "/v1/signin", o, { body: { email, password }, ms: QUICK_MS })).json);
}

/** End the session on the service. A session that has already ended is fine. */
export async function signOut(token: string, o: CloudOptions = {}): Promise<void> {
  try {
    await call("POST", "/v1/signout", o, { token, body: {}, ms: QUICK_MS });
  } catch (e) {
    if (isFoundryError(e) && e.kind === "signed-out") return;
    throw e;
  }
}

/** The account and its balance. A "signed-out" failure means the token no longer works. */
export async function getAccount(token: string, o: CloudOptions = {}): Promise<FoundryAccount> {
  return accountOf((await call("GET", "/v1/account", o, { token, ms: QUICK_MS })).json);
}

/** Ask the service to email a password-reset link. It answers the same whether or not the address has an account. */
export async function forgotPassword(email: string, o: CloudOptions = {}): Promise<{ sent: boolean; message: string }> {
  const { json } = await call("POST", "/v1/password/forgot", o, { body: { email }, ms: QUICK_MS });
  return { sent: isRecord(json) && json.sent === true, message: isRecord(json) && typeof json.message === "string" ? json.message.slice(0, 300) : "" };
}

/** An Anthropic Messages request as the service takes it (no streaming; max_tokens 1 to 16,000). */
export type MessagesRequest = {
  model: string;
  max_tokens: number;
  messages: unknown[];
  system?: unknown;
  [key: string]: unknown;
};
export type MessagesAnswer = {
  /** The reply's text blocks joined. */
  text: string;
  stopReason: string | null;
  usage: { input: number; output: number };
  /** Foundry credits left after this request, and what it took. Null if the service didn't say. */
  creditsLeft: number | null;
  creditsSpent: number | null;
  /** The whole reply as Anthropic gave it. */
  raw: Record<string, unknown>;
};

const wholeHeader = (h: Headers, name: string) => {
  const v = h.get(name);
  return v !== null && /^\d{1,12}$/.test(v) ? Number(v) : null;
};

/** One AI request, paid in the account's Foundry credits. Only ever called from the server, with that account's token. */
export async function sendMessages(token: string, request: MessagesRequest, o: CloudOptions = {}): Promise<MessagesAnswer> {
  const { json, headers } = await call("POST", "/v1/messages", o, { token, body: request, ms: AI_MS });
  if (!isRecord(json) || !Array.isArray(json.content)) throw new FoundryError("The Foundry Account service answered something this program doesn't understand.", 0, "broken");
  const text = json.content
    .map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");
  const usage = isRecord(json.usage) ? json.usage : {};
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    text,
    stopReason: typeof json.stop_reason === "string" ? json.stop_reason : null,
    usage: { input: count(usage.input_tokens), output: count(usage.output_tokens) },
    creditsLeft: wholeHeader(headers, "x-stitchfoundry-credits"),
    creditsSpent: wholeHeader(headers, "x-stitchfoundry-spent"),
    raw: json,
  };
}
