import "server-only";
// The Assistant's AI without StitchHub's proxy (docs/plan.md FA-4, FOUNDRY_AI=on). Two ways, chosen per company in Settings →
// Assistant: Foundry credits (the default: the Foundry Account service's /v1/messages, with the account's token, paid in
// credits) or the company's own Anthropic key. SiteSentrix's own Anthropic key is never here: it lives only in the account
// service. The same model classes, prompts, token caps and one retry as the hub's proxy had (stitchhub src/assistant.mjs), so
// the features can't tell the difference.
import { db } from "@/lib/db";
import { isFoundryError, OFFLINE_NOTICE, sendMessages, type FoundryError } from "@/lib/foundry/cloud";
import { foundryTokenFor, NOT_LINKED, SIGNED_OUT } from "@/lib/foundry/link";
import { currentFoundrySession, foundryTokenOf } from "@/lib/foundry/session";
import { foundryLinkMode } from "@/lib/foundry/mode";
import { unseal } from "@/lib/messaging/secrets";
import { UserError } from "@/lib/user-error";
import { OFFLINE_MESSAGE, type FeatureId } from "./features";
import { costMillicents, KEY_HELP, looksLikeAnthropicKey, maxTokensFor, modelFor, releaseSlot, takeSlot, timeoutFor, type Cls } from "./direct-math";

export { costMillicents, KEY_HELP, looksLikeAnthropicKey, maxTokensFor, modelFor, releaseSlot, takeSlot };

/** The one model the account service offers so far; a class whose model it refuses is asked of this instead (see viaFoundry). */
const foundryFallbackModel = () => (process.env.FOUNDRY_AI_FALLBACK_MODEL ?? "").trim() || "claude-opus-5-5";
const unoffered: Set<string> = ((globalThis as unknown as { __foundryUnoffered?: Set<string> }).__foundryUnoffered ??= new Set());

const ANTHROPIC_BASE = () => (process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com").replace(/\/+$/, "");

export type Transport = { kind: "foundry"; token: string; from: "company" | "person"; shopId: string } | { kind: "own"; key: string };
export type Chosen = { ok: true; transport: Transport } | { ok: false; why: "foundry" | "own-key"; message: string };

/**
 * Who pays for this company's next call: its own Anthropic key when the company chose that, else Foundry credits. Credits are
 * the company's linked account (desktop, Settings → Foundry Account) first, else the Foundry session of the person who is
 * signed in (hosted). Reads only the database and this request's cookie: no network, so "available?" costs nothing.
 */
export async function chooseTransport(shopId: string): Promise<Chosen> {
  const s = await db.assistantSettings.findUnique({ where: { shopId }, select: { aiSource: true, ownKey: true } });
  if (s?.aiSource === "own") {
    const key = unseal(s.ownKey, shopId, "anthropicKey")?.plain;
    if (!key) return { ok: false, why: "own-key", message: "Add your Anthropic key in Settings → Assistant, or switch to Foundry credits." };
    return { ok: true, transport: { kind: "own", key } };
  }
  const company = await foundryTokenFor(shopId);
  if (company) return { ok: true, transport: { kind: "foundry", token: company, from: "company", shopId } };
  const person = await personToken();
  if (person) return { ok: true, transport: { kind: "foundry", token: person, from: "person", shopId } };
  const link = await db.foundryLink.findUnique({ where: { shopId }, select: { state: true } });
  if (link) return { ok: false, why: "foundry", message: SIGNED_OUT };
  const message = foundryLinkMode() !== "off" ? NOT_LINKED : "Sign in with a Foundry Account to use the Assistant with Foundry credits, or add your own Anthropic key in Settings → Assistant.";
  return { ok: false, why: "foundry", message };
}

/** The Foundry session this browser holds (hosted editions), or null; never throws (outside a request there is no cookie). */
async function personToken(): Promise<string | null> {
  try {
    const s = await currentFoundrySession();
    return s ? await foundryTokenOf(s) : null;
  } catch {
    return null;
  }
}

export type Payload = {
  cls: Cls;
  feature: FeatureId;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  photo?: { mediaType: string; data: string };
};
export type Answer = {
  text: string;
  stopReason: string | null;
  usage: { input: number; cacheRead: number; output: number };
  costMillicents: number;
  model: string;
  /** Foundry credits taken (Foundry credits only). */
  credits: number | null;
};

function body(p: Payload, model: string) {
  const messages = p.messages.map((m, i) =>
    i === p.messages.length - 1 && p.photo
      ? { role: "user", content: [{ type: "image", source: { type: "base64", media_type: p.photo.mediaType, data: p.photo.data } }, { type: "text", text: m.content }] }
      : m,
  );
  return { model, max_tokens: maxTokensFor(p.cls, p.feature, p.maxTokens), messages, ...(p.system ? { system: [{ type: "text", text: p.system, cache_control: { type: "ephemeral" } }] } : {}) };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a failed Foundry request says, in words a person can act on. */
function foundryWords(e: FoundryError): string {
  switch (e.kind) {
    case "offline":
      return OFFLINE_NOTICE;
    case "signed-out":
      return "Your Foundry Account sign-in has ended. Sign in again, then try this again.";
    case "no-credits":
      return "Not enough Foundry credits for this. Buy more in your Foundry Account, or use your own Anthropic key in Settings → Assistant.";
    case "not-open":
      return "Foundry credits aren't open for the Assistant yet. Use your own Anthropic key in Settings → Assistant.";
    case "wait":
    case "refused":
      return e.message;
    default:
      return "The Assistant couldn't answer just now. Try again in a minute.";
  }
}

async function viaFoundry(t: Extract<Transport, { kind: "foundry" }>, p: Payload): Promise<Answer> {
  const timeoutMs = Math.round(timeoutFor(p.cls) * 1.5);
  let model = unoffered.has(modelFor(p.cls)) ? foundryFallbackModel() : modelFor(p.cls);
  let again = true; // one retry, for a busy or broken moment (as the hub's proxy did)
  for (;;) {
    try {
      const a = await sendMessages(t.token, body(p, model), { timeoutMs });
      const u = (a.raw.usage ?? {}) as Record<string, unknown>;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
      return {
        text: a.text,
        stopReason: a.stopReason,
        usage: { input: n(u.input_tokens) + n(u.cache_creation_input_tokens), cacheRead: n(u.cache_read_input_tokens), output: a.usage.output },
        costMillicents: 0,
        model: typeof a.raw.model === "string" ? a.raw.model : model,
        credits: a.creditsSpent,
      };
    } catch (e) {
      if (!isFoundryError(e)) throw e;
      // The service offers only some models. Ask for the one it offers instead, and remember, so the next call doesn't ask twice.
      if (e.kind === "refused" && /isn't offered/.test(e.message) && model !== foundryFallbackModel()) {
        unoffered.add(model);
        model = foundryFallbackModel();
        continue;
      }
      if (e.kind === "broken" && again) {
        again = false;
        await pause(400);
        continue;
      }
      if (e.kind === "signed-out" && t.from === "company") await db.foundryLink.updateMany({ where: { shopId: t.shopId }, data: { state: "signed-out", checkedAt: new Date() } }).catch(() => undefined);
      throw new UserError(foundryWords(e));
    }
  }
}

async function viaOwnKey(t: Extract<Transport, { kind: "own" }>, p: Payload): Promise<Answer> {
  const model = modelFor(p.cls);
  const timeoutMs = timeoutFor(p.cls);
  const call = () =>
    fetch(`${ANTHROPIC_BASE()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": t.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body(p, model)),
      redirect: "manual", // the key would go with a redirect
      signal: AbortSignal.timeout(timeoutMs),
    });
  let res: Response | null = await call().catch(() => null);
  if (!res || res.status === 429 || res.status >= 500) {
    await pause(400);
    res = await call().catch(() => null);
  }
  if (!res) throw new UserError(OFFLINE_MESSAGE);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const said = typeof (json?.error as { message?: unknown } | undefined)?.message === "string" ? String((json?.error as { message: string }).message) : "";
    if (res.status === 401 || res.status === 403) throw new UserError("Anthropic refused your key. Check it in Settings → Assistant.");
    if (res.status === 402 || /credit balance/i.test(said)) throw new UserError("Your Anthropic account is out of credit. Add some at console.anthropic.com, or switch to Foundry credits in Settings → Assistant.");
    if (res.status === 429) throw new UserError("Anthropic is busy, or your key has hit its limit. Try again in a minute.");
    if (res.status === 400) throw new UserError("Anthropic didn't accept that request. Try again with a shorter note.");
    throw new UserError("The Assistant couldn't answer just now. Try again in a minute.");
  }
  if (!json || !Array.isArray(json.content)) throw new UserError("The Assistant couldn't answer just now. Try again in a minute.");
  const answerText = (json.content as { type?: unknown; text?: unknown }[]).map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
  const u = (json.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const tokens = { input: n(u.input_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), output: n(u.output_tokens) };
  return {
    text: answerText,
    stopReason: typeof json.stop_reason === "string" ? json.stop_reason : null,
    usage: { input: tokens.input + tokens.cacheWrite, cacheRead: tokens.cacheRead, output: tokens.output },
    costMillicents: costMillicents(model, tokens),
    model,
    credits: null,
  };
}

/** One request by the chosen way. Throws a UserError in plain words for anything that goes wrong. */
export function callModel(t: Transport, p: Payload): Promise<Answer> {
  return t.kind === "foundry" ? viaFoundry(t, p) : viaOwnKey(t, p);
}
