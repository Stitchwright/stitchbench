import "server-only";
// The register's quiet lines for a chosen customer (shop-features-round-2-design.md section 1), read in one go: special
// orders waiting for her (1.2). Every query by shopId; a customer of another company reads as nothing.
import { db } from "@/lib/db";
import { waitingForCustomer } from "@/lib/special-orders";

export type WaitingOrder = { id: string; number: number; partId: string | null; partNumber: string | null; description: string; qty: number; unit: string | null; priceCents: number; paidCents: number };

export type CustomerExtras = {
  name: string;
  specialOrders: WaitingOrder[];
};

export async function customerExtrasFor(shopId: string, customerId: string): Promise<CustomerExtras | null> {
  const c = await db.customer.findFirst({ where: { id: customerId, shopId }, select: { id: true, name: true } });
  if (!c) return null;
  const orders = await waitingForCustomer(shopId, c.id);
  return {
    name: c.name,
    specialOrders: orders.map((o) => ({ id: o.id, number: o.number, partId: o.partId, partNumber: o.partNumber, description: o.description, qty: o.qty, unit: o.unit, priceCents: o.priceCents, paidCents: o.paidCents })),
  };
}
