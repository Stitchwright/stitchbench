import "server-only";
// The program's one way to the model: through StitchHub (ai-assistant-scope.md 2.2). The Anthropic key lives on the hub
// only; this sends { shopRef, tz, feature, model class, system, messages, image?, key } to POST /v1/assistant with the
// install key and logs what happened as an AssistantCall (the company's own record, redacted exactly as sent). Nothing
// here is called on its own: only the actions in src/actions/assistant.ts call it, for a button a person pressed.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { hubJoined, hubFetch, hubOfflineSince, HubError } from "@/lib/hub";
import { getModules, hasModule } from "@/lib/modules";
import { shopTimeZone } from "@/lib/shop-zone";
import { UserError } from "@/lib/user-error";
import type { Prisma } from "@/generated/prisma/client";
import { FEATURES, OFFLINE_MESSAGE, type FeatureGroup, type FeatureId } from "./features";
import { maskSerials } from "./redact";
import type { Built, Source } from "./prompts";

/** ASSISTANT=off on a server stops every call (the MESSAGES=off pattern); the check scripts point the hub address at a stand-in instead. */
export const assistantSwitchedOff = () => (process.env.ASSISTANT ?? "").toLowerCase() === "off";

export type Availability = { ok: true } | { ok: false; why: "off" | "no-hub" | "offline" | "module" | "feature"; message: string };

/**
 * Whether an "Ask" button works now: the hub is joined and was reachable at the last call (the layout's offline pill
 * reads the same flag), and for the paid features the module is active. The plate reader needs no module (20 free
 * reads a month, counted on the hub), so it passes `module: false`. A feature switched off in Settings is hidden too.
 */
export async function assistantAvailable(shopId: string, o: { module?: boolean; group?: FeatureGroup } = {}): Promise<Availability> {
  if (assistantSwitchedOff()) return { ok: false, why: "off", message: "The Assistant is switched off on this server." };
  if (o.module !== false && !(await hasModule(shopId, "assistant"))) return { ok: false, why: "module", message: "The Assistant isn't turned on for this company." };
  if (o.group) {
    const s = await db.assistantSettings.findUnique({ where: { shopId } });
    const on = !s ? true : o.group === "draft" ? s.draftOn : o.group === "causes" ? s.causesOn : o.group === "manuals" ? s.manualsOn : o.group === "parts" ? s.partsOn : s.plateOn;
    if (!on) return { ok: false, why: "feature", message: "This part of the Assistant is switched off in Settings → Assistant." };
  }
  if (!(await hubJoined())) return { ok: false, why: "no-hub", message: OFFLINE_MESSAGE };
  if (hubOfflineSince() != null) return { ok: false, why: "offline", message: OFFLINE_MESSAGE };
  return { ok: true };
}

/** The text of the company's current `assistant` license key (what the hub checks), or null: no key, or switched on by the administrator. */
export async function assistantKeyText(shopId: string): Promise<string | null> {
  const s = (await getModules(shopId)).states.assistant;
  if (s.source !== "key" || !s.keyId) return null;
  return (await db.license.findUnique({ where: { shopId_keyId: { shopId, keyId: s.keyId } }, select: { key: true } }))?.key ?? null;
}

export type CallTarget = { ticketId?: string; repairJobId?: string; machineId?: string; partId?: string };
export type Photo = { mediaType: "image/jpeg" | "image/png" | "image/webp"; data: string }; // data: base64

type HubAnswer = {
  text: string;
  stopReason: string | null;
  usage: { input: number; cacheRead: number; output: number };
  costMillicents: number;
  model: string;
  free?: boolean;
  month?: string;
  calls?: number;
  limit?: number;
};

const MAX_PHOTO_CHARS = 215_000;
// The hub's own limit is 30 s a try (60 s for manuals) with one retry: wait longer than that.
const WAIT_MS = 75_000;

/** Records the failed call and says it in the person's words. Never throws anything else. */
async function logFailure(shopId: string, userId: string | null, feature: FeatureId, target: CallTarget, built: Built, error: string, ms: number) {
  await db.assistantCall
    .create({
      data: { shopId, feature, byUserId: userId, ...target, model: "", request: requestJson(built), response: "", error: error.slice(0, 300), ms },
    })
    .catch((e) => console.error("assistant log:", e instanceof Error ? e.message : e));
}

const requestJson = (built: Built, photo?: Photo): Prisma.InputJsonValue => ({
  system: built.system,
  messages: built.messages.map((m) => ({ role: m.role, content: m.content })),
  maxTokens: built.maxTokens,
  ...(photo ? { image: { mediaType: photo.mediaType, bytes: Math.floor((photo.data.length * 3) / 4), sha256: crypto.createHash("sha256").update(photo.data).digest("hex").slice(0, 16) } } : {}),
});

/**
 * One call. Checks the Assistant can be reached (the caller has already checked the module), sends it, logs it, and
 * returns the logged row. A failure is logged with its error and thrown as a UserError (one plain toast); what the tech
 * typed stays where it was.
 */
export async function runAssistant(o: {
  shopId: string;
  userId: string | null;
  built: Built;
  target?: CallTarget;
  photo?: Photo;
  /** Serials that must not appear in the logged answer (design decision 4). */
  serials?: readonly (string | null | undefined)[];
  /** Serials found in the answer itself (the plate reader's): masked in the log too. */
  serialsFrom?: (text: string) => string[];
  /** The plate reader works without the module: the hub counts 20 free reads a month. */
  needsModule?: boolean;
}) {
  const { shopId, userId, built, photo } = o;
  const target = o.target ?? {};
  const feature = built.feature;
  const group = FEATURES[feature].group;
  const avail = await assistantAvailable(shopId, { module: o.needsModule !== false, group });
  if (!avail.ok) throw new UserError(avail.message);
  if (photo && photo.data.length > MAX_PHOTO_CHARS) throw new UserError("That photo is too large to send. Take it again a little closer, or from a smaller size.");

  const started = Date.now();
  let answer: HubAnswer;
  try {
    const key = (await assistantKeyText(shopId)) ?? "";
    const r = await hubFetch("/v1/assistant", {
      method: "POST",
      shopRef: shopId,
      signal: AbortSignal.timeout(WAIT_MS),
      json: {
        shopRef: shopId,
        tz: await shopTimeZone(shopId),
        feature,
        model: built.cls,
        system: built.system,
        messages: built.messages,
        maxTokens: built.maxTokens,
        ...(photo ? { image: { mediaType: photo.mediaType, data: photo.data } } : {}),
        ...(key ? { key } : {}),
      },
    });
    answer = (await r.json()) as HubAnswer;
  } catch (e) {
    const ms = Date.now() - started;
    const message = e instanceof HubError ? e.message : e instanceof UserError ? OFFLINE_MESSAGE : e instanceof Error && e.name === "TimeoutError" ? "The Assistant took too long to answer. Try again." : "The Assistant couldn't answer just now. Try again in a minute.";
    await logFailure(shopId, userId, feature, target, built, message, ms);
    if (e instanceof HubError && e.status === 402) await noteMonth(shopId, e.message);
    throw new UserError(message);
  }
  const ms = Date.now() - started;
  if (answer.stopReason === "refusal" || typeof answer.text !== "string") {
    const message = "The Assistant declined to answer this one. Try rewording the notes.";
    await logFailure(shopId, userId, feature, target, built, `stop: ${answer.stopReason ?? "no text"}`, ms);
    throw new UserError(message);
  }
  const row = await db.assistantCall.create({
    data: {
      shopId,
      feature,
      byUserId: userId,
      ...target,
      model: String(answer.model ?? "").slice(0, 80),
      request: requestJson(built, photo),
      response: maskSerials(answer.text, [...(o.serials ?? []), ...(o.serialsFrom?.(answer.text) ?? [])]),
      sources: (built.sources ?? []) as unknown as Prisma.InputJsonValue,
      inputTokens: answer.usage?.input ?? 0,
      cacheTokens: answer.usage?.cacheRead ?? 0,
      outputTokens: answer.usage?.output ?? 0,
      costMillicents: answer.costMillicents ?? 0,
      ms,
    },
  });
  if (answer.month && typeof answer.calls === "number") {
    await db.shop.update({ where: { id: shopId }, data: { assistantMonth: answer.month, assistantCalls: answer.calls, ...(typeof answer.limit === "number" ? { assistantLimit: answer.limit } : {}) } }).catch(() => {});
  }
  return { row, text: answer.text, free: answer.free === true };
}

/** A refusal for the month's allowance: the local count follows the hub's (the Settings page shows it offline). */
async function noteMonth(shopId: string, message: string) {
  const m = /used this month's (\d+)/.exec(message);
  if (!m) return;
  await db.shop.update({ where: { id: shopId }, data: { assistantCalls: Number(m[1]), assistantLimit: Number(m[1]) } }).catch(() => {});
}

export type { Source };
