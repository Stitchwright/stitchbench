import "server-only";
// What the status hooks need, loaded BEFORE a transaction so a hook never opens a second connection inside one
// (scheduling-messaging-design.md sections 1 and 7.1).
import { db } from "@/lib/db";
import { moduleOn } from "@/lib/module-gate";
import { messagingView, type MessagingView } from "@/lib/messaging/settings";

/**
 * `marketing`: the module is on (abandon notices, reminders, review requests). `notices`: the base notices (ready, parts
 * in) may be queued: always with Marketing, otherwise once the shop has switched email or texts on, so a shop that never
 * set messages up gets no "No message: call them" lines it didn't ask for (pricing-review-2026-10.md, 7 Oct 2026).
 */
export type HookCtx = { marketing: boolean; notices: boolean; ms: MessagingView; tz: string; userName: string | null };

export async function hookContext(shopId: string, userName?: string | null): Promise<HookCtx> {
  const [marketing, ms, shop] = await Promise.all([moduleOn(shopId, "marketing"), messagingView(shopId), db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true } })]);
  return { marketing, notices: marketing || ms.emailOn || ms.smsOn, ms, tz: shop.timeZone, userName: userName ?? null };
}
