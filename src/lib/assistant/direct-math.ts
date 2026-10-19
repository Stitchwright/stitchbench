// The Assistant's direct AI path, the parts that need no database and no network (src/lib/assistant/direct.ts uses them): which
// model a class uses, token caps, what a call costs a company on its own key, what looks like an Anthropic key, and the
// one-at-a-time-and-hourly rule. Here so the unit tests can run them (docs/plan.md FA-4).
import { UserError } from "@/lib/user-error";
import type { FeatureId } from "./features";
import type { Built } from "./prompts";

export type Cls = Built["cls"];

/** The model each class of work uses; the owner moves every shop to a newer model by changing a variable (as on the hub). */
const CLASSES: Record<Cls, { env: string; fallback: string; maxTokens: number; timeoutMs: number }> = {
  draft: { env: "ASSISTANT_MODEL_DRAFT", fallback: "claude-sonnet-5-5", maxTokens: 1500, timeoutMs: 30_000 },
  suggest: { env: "ASSISTANT_MODEL_SUGGEST", fallback: "claude-sonnet-5-5", maxTokens: 2000, timeoutMs: 30_000 },
  read: { env: "ASSISTANT_MODEL_READ", fallback: "claude-haiku-4-5-20251001", maxTokens: 600, timeoutMs: 30_000 },
  manuals: { env: "ASSISTANT_MODEL_MANUALS", fallback: "claude-opus-5-5", maxTokens: 2500, timeoutMs: 60_000 },
};
// The invoice and packing-slip reader answers JSON for each line of the slip: the read class's cap is too small for it.
const READ_CAPS: Partial<Record<FeatureId, number>> = { read_invoice: 2000 };

export const modelFor = (cls: Cls) => (process.env[CLASSES[cls].env] ?? "").trim() || CLASSES[cls].fallback;
/** How long a call of this class may take (the hub's proxy used the same). */
export const timeoutFor = (cls: Cls) => CLASSES[cls].timeoutMs;
export const maxTokensFor = (cls: Cls, feature: FeatureId, asked: number) => Math.max(1, Math.min(asked, READ_CAPS[feature] ?? CLASSES[cls].maxTokens));

// Dollars per million tokens: input, cache read, output (a 5-minute cache write is 1.25 x input). Unknown ids cost as Sonnet.
const PRICES: Record<string, [number, number, number]> = {
  "claude-haiku-4-5-20251001": [1, 0.1, 5],
  "claude-sonnet-5-5": [2, 0.2, 10],
  "claude-opus-5-5": [4, 0.2, 20],
  "claude-fable-5-1": [10, 0.25, 50],
};
/** Thousandths of a cent, for a company's own key (what it cost them): tokens x dollars per million x 100,000 / 1,000,000. */
export function costMillicents(model: string, t: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }): number {
  const [i, cr, o] = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
  return Math.round(((t.input ?? 0) * i + (t.cacheWrite ?? 0) * i * 1.25 + (t.cacheRead ?? 0) * cr + (t.output ?? 0) * o) / 10);
}


export const KEY_HELP = "An Anthropic key starts with sk-ant- (console.anthropic.com → API keys).";
/** Whether this looks like an Anthropic API key: a prefix and a plausible length, nothing that could carry a header or a line break. */
export const looksLikeAnthropicKey = (k: string) => /^sk-ant-[A-Za-z0-9_-]{16,300}$/.test(k);


// A company asks one thing at a time, and at most this many an hour (the hub's proxy did the same; the account service also
// limits an account to three at once). In memory: a restart forgets, which is fine for a limit that exists to stop a runaway.
const HOURLY = (() => {
  const v = Number((process.env.ASSISTANT_HOURLY_CALLS ?? "").trim());
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 60;
})();
const busy: Set<string> = ((globalThis as unknown as { __assistantBusy?: Set<string> }).__assistantBusy ??= new Set());
const stamps: Map<string, number[]> = ((globalThis as unknown as { __assistantStamps?: Map<string, number[]> }).__assistantStamps ??= new Map());

/** Takes the company's place in line, or says why it can't (one at a time; an hourly cap). Give it back with releaseSlot. */
export function takeSlot(shopId: string, now = Date.now()): UserError | null {
  if (busy.has(shopId)) return new UserError("The Assistant is still answering this company's last question.");
  const recent = (stamps.get(shopId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= HOURLY) return new UserError(`Too many Assistant calls in the last hour (${HOURLY}). Try again later.`);
  recent.push(now);
  stamps.set(shopId, recent);
  busy.add(shopId);
  return null;
}
export function releaseSlot(shopId: string) {
  busy.delete(shopId);
}
