import "server-only";
// Settings → Assistant → "Where the AI comes from" (docs/plan.md FA-4, FOUNDRY_AI=on): Foundry credits, or the company's own
// Anthropic key. The key is sealed (field "anthropicKey", bound to the company) and never shown again, only its last four
// characters so the owner can tell which key is saved. Owners and admins change it; everyone with the module may read.
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { getAccount, isFoundryError } from "@/lib/foundry/cloud";
import { seal, unseal } from "@/lib/messaging/secrets";
import { UserError } from "@/lib/user-error";
import { chooseTransport, KEY_HELP, looksLikeAnthropicKey } from "./direct";

type Actor = { id: string; shopId: string; name: string; role: "OWNER" | "ADMIN" | "TECH" };

export async function saveSource(user: Actor, input: { source: unknown; key: unknown; removeKey: boolean }): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only the shop owner or an admin can change this.");
  const source = input.source === "own" ? "own" : input.source === "foundry" ? "foundry" : null;
  if (!source) throw new UserError("Choose Foundry credits or your own Anthropic key.");
  const typed = typeof input.key === "string" ? input.key.trim() : "";
  if (typed && !looksLikeAnthropicKey(typed)) throw new UserError(`That doesn't look like an Anthropic key. ${KEY_HELP}`);
  const have = await db.assistantSettings.findUnique({ where: { shopId: user.shopId }, select: { ownKey: true } });
  const keep = input.removeKey ? null : (have?.ownKey ?? null);
  const ownKey = typed ? seal(typed, user.shopId, "anthropicKey") : keep;
  if (source === "own" && !ownKey) throw new UserError("Paste your Anthropic key to use it, or choose Foundry credits.");
  await db.assistantSettings.upsert({ where: { shopId: user.shopId }, create: { shopId: user.shopId, aiSource: source, ownKey }, update: { aiSource: source, ownKey } });
  await audit(db, { shopId: user.shopId, id: user.id, name: user.name, role: user.role }, { action: "assistant.source", subjectType: "Shop", subjectId: user.shopId, subjectLabel: source === "own" ? "own Anthropic key" : "Foundry credits" });
}

export type SourceView = {
  source: "foundry" | "own";
  /** The last four characters of the saved key, if one is saved. */
  keyEnds: string | null;
  /** Foundry credits: who is paying, the balance when the service answered, and whether it could be reached. */
  paying: "company" | "person" | null;
  credits: number | null;
  reachable: boolean | null;
};

/** What the settings section shows. Asks the service briefly for the balance; offline shows none and says so. */
export async function sourceView(shopId: string): Promise<SourceView> {
  const s = await db.assistantSettings.findUnique({ where: { shopId }, select: { aiSource: true, ownKey: true } });
  const key = unseal(s?.ownKey ?? null, shopId, "anthropicKey")?.plain ?? null;
  const source = s?.aiSource === "own" ? "own" : "foundry";
  const view: SourceView = { source, keyEnds: key ? key.slice(-4) : null, paying: null, credits: null, reachable: null };
  if (source === "own") return view;
  const c = await chooseTransport(shopId);
  if (!c.ok || c.transport.kind !== "foundry") return view;
  view.paying = c.transport.from;
  try {
    view.credits = (await getAccount(c.transport.token, { timeoutMs: 4000 })).credits;
    view.reachable = true;
  } catch (e) {
    view.reachable = isFoundryError(e) && e.kind !== "offline" ? true : false;
  }
  return view;
}
