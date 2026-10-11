import "server-only";
// The scheduling and messaging features' one door to the add-on modules (scheduling-messaging-design.md 6.1): pages,
// actions and workers call these, never src/lib/modules.ts directly, so a change there is fixed in one file.
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { hasModule, loadModulesMany, navGates, requireModule, shopsWithModule } from "@/lib/modules";
import { baseWritable } from "@/lib/module-info";
import { messagingView } from "@/lib/messaging/settings";

export type ModuleKey = "scheduling" | "marketing" | "assistant";
export type Gate = "on" | "readonly" | "hidden";

export async function moduleOn(shopId: string, key: ModuleKey): Promise<boolean> {
  return hasModule(shopId, key);
}

type GateCache = Map<string, { at: number; hasRecords: boolean }>;
const cache = ((globalThis as unknown as { __gateCache?: GateCache }).__gateCache ??= new Map());
const TTL = 60_000;

/** Whether the shop has any record of the module's kind (cached 60 s per shop and key). */
async function hasRecords(shopId: string, key: ModuleKey): Promise<boolean> {
  const k = `${shopId}:${key}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.hasRecords;
  let found: boolean;
  if (key === "scheduling") {
    const [a, b, c, d, e] = await Promise.all([
      db.shopClass.findFirst({ where: { shopId }, select: { id: true } }),
      db.appointmentType.findFirst({ where: { shopId }, select: { id: true } }),
      db.appointment.findFirst({ where: { shopId }, select: { id: true } }),
      db.shift.findFirst({ where: { shopId }, select: { id: true } }),
      db.partnerRun.findFirst({ where: { shopId }, select: { id: true } }),
    ]);
    found = !!(a || b || c || d || e);
  } else if (key === "assistant") {
    // Its only records are the log of what was asked: it stays readable after the module ends.
    found = !!(await db.assistantCall.findFirst({ where: { shopId }, select: { id: true } }));
  } else {
    const [a, b, c] = await Promise.all([
      db.messagingSettings.findFirst({ where: { shopId }, select: { shopId: true } }),
      db.outMessage.findFirst({ where: { shopId }, select: { id: true } }),
      db.campaign.findFirst({ where: { shopId }, select: { id: true } }),
    ]);
    found = !!(a || b || c);
  }
  cache.set(k, { at: Date.now(), hasRecords: found });
  if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
  return found;
}

/** "on" while the module allows new work; else "readonly" when the shop has records (or the module lapsed); else "hidden". */
export async function gateFor(shopId: string, key: ModuleKey): Promise<Gate> {
  if (await moduleOn(shopId, key)) return "on";
  const nav = await navGates(shopId);
  if (nav[key] === "readonly") return "readonly";
  return (await hasRecords(shopId, key)) ? "readonly" : "hidden";
}

export async function gates(shopId: string): Promise<Record<ModuleKey, Gate>> {
  const [scheduling, marketing, assistant] = await Promise.all([gateFor(shopId, "scheduling"), gateFor(shopId, "marketing"), gateFor(shopId, "assistant")]);
  return { scheduling, marketing, assistant };
}

/**
 * Whether the base notices (ready for pickup, parts in, the estimate) go out: in the base since 7 Oct 2026
 * (pricing-review-2026-10.md), so Marketing on, or email or texts switched on (HookCtx.notices is the same rule).
 */
export async function noticesOn(shopId: string): Promise<boolean> {
  if (await moduleOn(shopId, "marketing")) return true;
  const ms = await messagingView(shopId);
  return ms.emailOn || ms.smsOn;
}

/**
 * Of the given shops, those whose program works now (not read-only, not moving to another install): the worker sends
 * their base notices without Marketing, under the same standing rule as shopsWith().
 */
export async function shopsWithWorkingBase(shopIds: string[]): Promise<string[]> {
  if (!shopIds.length) return [];
  const mods = await loadModulesMany(shopIds);
  return shopIds.filter((id) => {
    const m = mods.get(id);
    return !!m && !m.moving && baseWritable(m.states.base.status);
  });
}

/** Throws the modules package's UserError unless new work is allowed. */
export async function requireOn(user: CurrentUser, key: ModuleKey): Promise<void> {
  await requireModule(user, key);
}

/** The shops (all, or the given ones) where the module is on now. */
export async function shopsWith(key: ModuleKey, shopIds?: string[]): Promise<string[]> {
  return shopsWithModule(key, shopIds);
}
