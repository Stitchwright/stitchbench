import "server-only";
// The scheduling and messaging features' one door to the paid-modules platform (scheduling-messaging-design.md 6.1):
// pages, actions and workers call these, never src/lib/modules.ts directly, so a change there is fixed in one file.
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { hasModule, navGates, requireModule, shopsWithModule } from "@/lib/modules";

export type ModuleKey = "scheduling" | "marketing";
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
  const [scheduling, marketing] = await Promise.all([gateFor(shopId, "scheduling"), gateFor(shopId, "marketing")]);
  return { scheduling, marketing };
}

/** Throws the modules package's UserError unless new work is allowed. */
export async function requireOn(user: CurrentUser, key: ModuleKey): Promise<void> {
  await requireModule(user, key);
}

/** The shops (all, or the given ones) where the module is on now. */
export async function shopsWith(key: ModuleKey, shopIds?: string[]): Promise<string[]> {
  return shopsWithModule(key, shopIds);
}
