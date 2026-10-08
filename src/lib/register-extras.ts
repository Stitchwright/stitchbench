import "server-only";
// The register's quiet lines for a chosen customer (shop-features-round-2-design.md section 1), read in one go: special
// orders waiting for her (1.2), her price group or membership and the machines whose supplies she gets a lifetime
// discount on (1.5). Every query by shopId; a customer of another company reads as nothing.
import { db } from "@/lib/db";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
import { waitingForCustomer } from "@/lib/special-orders";
import { customerGroupFor, ruleCtxFor, type CustomerGroup } from "@/lib/price-groups";
import { birthdayFor, type BirthdayOffer } from "@/lib/birthdays";
import { creditsFor, type TradeUpCredit } from "@/lib/trade-up";

export type WaitingOrder = { id: string; number: number; partId: string | null; partNumber: string | null; description: string; qty: number; unit: string | null; priceCents: number; paidCents: number };

export type CustomerExtras = {
  name: string;
  specialOrders: WaitingOrder[];
  /** Her group, whether in force today, ending soon (with the item that renews it). */
  group: CustomerGroup | null;
  /** Her machines bought here with a lifetime discount on their supplies. */
  lifetime: { machineId: string; pctOff: number }[];
  /** Her birthday offer, when she can use it today (1.6). */
  birthday: (BirthdayOffer & { day: number }) | null;
  /** Repair credits she can take off a machine she buys (1.9). */
  tradeUps: TradeUpCredit[];
};

export async function customerExtrasFor(shopId: string, customerId: string): Promise<CustomerExtras | null> {
  const c = await db.customer.findFirst({ where: { id: customerId, shopId }, select: { id: true, name: true } });
  if (!c) return null;
  const today = ymdOf(new Date(), await shopTimeZone(shopId));
  const [orders, group, ctx, birthday, tradeUps] = await Promise.all([
    waitingForCustomer(shopId, c.id),
    customerGroupFor(shopId, c.id, today),
    ruleCtxFor(shopId, c.id, today),
    birthdayFor(shopId, c.id, today),
    creditsFor(shopId, c.id, today),
  ]);
  return {
    name: c.name,
    specialOrders: orders.map((o) => ({ id: o.id, number: o.number, partId: o.partId, partNumber: o.partNumber, description: o.description, qty: o.qty, unit: o.unit, priceCents: o.priceCents, paidCents: o.paidCents })),
    group,
    lifetime: ctx.lifetime ?? [],
    birthday,
    tradeUps,
  };
}
