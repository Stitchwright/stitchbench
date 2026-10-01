import "server-only";
// What the status hooks need, loaded BEFORE a transaction so a hook never opens a second connection inside one
// (scheduling-messaging-design.md sections 1 and 7.1).
import { db } from "@/lib/db";
import { moduleOn } from "@/lib/module-gate";
import { messagingView, type MessagingView } from "@/lib/messaging/settings";

export type HookCtx = { marketing: boolean; ms: MessagingView; tz: string; userName: string | null };

export async function hookContext(shopId: string, userName?: string | null): Promise<HookCtx> {
  const [marketing, ms, shop] = await Promise.all([moduleOn(shopId, "marketing"), messagingView(shopId), db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true } })]);
  return { marketing, ms, tz: shop.timeZone, userName: userName ?? null };
}
