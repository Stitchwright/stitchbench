import "server-only";
// What to do with each kind of message from MakerFoundry (docs/plans/makerfoundry-orders-plan.md). The handlers are kept apart from the
// queue (sync.ts) so each package adds its own: a handler gets a message whose body has already been checked against its type and
// version, and answers "applied" (done: the next message of the conversation may go) or "defer" (what it needs hasn't arrived yet:
// try again later, and the ones after it wait). Throwing is the same as "defer" with the error kept.
import { db } from "@/lib/db";
import { takeOrder } from "@/lib/shop-orders/intake";

export type Applied = "applied" | "defer";
export type MessageContext = { shopId: string; messageId: string; sender: string; conversation: string; seq: number; sentAt: Date; body: unknown };
export type Handler = (c: MessageContext) => Promise<Applied>;

const handlers = new Map<string, Handler>();
const key = (type: string, version: number) => `${type}@${version}`;
export function registerHandler(type: string, version: number, h: Handler): void {
  handlers.set(key(type, version), h);
}
export const handlerFor = (type: string, version: number): Handler | undefined => handlers.get(key(type, version));

// The hub gave up delivering one of our messages: kept on it so the order page can say so (a proof the customer never saw can be sent again).
registerHandler("message.expired", 1, async (c) => {
  const b = c.body as { id: string; reason: string };
  await db.syncOut.updateMany({ where: { id: b.id, shopId: c.shopId, expiredAt: null }, data: { expiredAt: new Date(), expiredWhy: b.reason } });
  return "applied";
});

// MakerFoundry's customer paid: the order becomes a decorating order (see intake.ts).
registerHandler("order.placed", 1, async (c) => {
  await takeOrder(c);
  return "applied";
});
