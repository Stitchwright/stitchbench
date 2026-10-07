import "server-only";
// "Ship it to her from there" (shop-features-round-2-design.md 7.3): the sale is made at this store with her address;
// the store that has the item gets a "Ship this" job, the same as an online order to ship (Online orders, Mark shipped
// with the tracking number, which goes on the sale and to her). The stock comes off that store's shelf with the sale,
// so it isn't sold there meanwhile. Kept apart from the register's own code (it builds on the online shop's orders).
import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { seal } from "@/lib/messaging/secrets";
import { orderUrl, sha256, type OrderItem } from "@/lib/shop/online-shop";
import { lineNet } from "@/lib/register-math";

export type ShipLine = { partId: string | null; partNumber: string | null; description: string; qty: number; unit: string | null; unitPriceCents: number; discountCents: number; taxable: boolean };

/** One "Ship this" job per store the sale ships from (PAID, to ship), each naming the sale. Returns the jobs' numbers. */
export async function makeShipJobs(a: { shopId: string; saleId: string; saleNumber: number; customerId: string; address: string; taxRatePct: number; byStore: Map<string, ShipLine[]>; userId: string; at: Date }): Promise<number[]> {
  const customer = await db.customer.findFirst({ where: { id: a.customerId, shopId: a.shopId }, select: { id: true, name: true, phone: true, email: true, notifyBy: true } });
  if (!customer) return [];
  const out: number[] = [];
  for (const [storeId, lines] of a.byStore) {
    const items: OrderItem[] = lines.map((l) => ({ partId: l.partId, partNumber: l.partNumber, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents, taxable: l.taxable }));
    const subtotal = lines.reduce((x, l) => x + lineNet({ qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents, taxable: l.taxable }), 0);
    const taxable = lines.filter((l) => l.taxable).reduce((x, l) => x + lineNet({ qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents, taxable: true }), 0);
    const tax = Math.round((taxable * a.taxRatePct) / 100);
    const token = crypto.randomBytes(32).toString("base64url");
    const id = crypto
      .randomUUID()
      .replace(/-/g, "")
      .slice(0, 25)
      .replace(/^[0-9]/, "c");
    const made = await db.$transaction(async (tx) => {
      const sh = await tx.shop.update({ where: { id: a.shopId }, data: { nextWebOrderNumber: { increment: 1 } }, select: { nextWebOrderNumber: true } });
      return tx.webOrder.create({
        data: {
          id,
          shopId: a.shopId,
          locationId: storeId,
          number: sh.nextWebOrderNumber - 1,
          status: "PAID",
          source: "store",
          customerId: customer.id,
          name: customer.name.slice(0, 120),
          phone: customer.phone,
          email: customer.email,
          notify: customer.notifyBy,
          fulfil: "ship",
          address: a.address.slice(0, 500),
          items: items as unknown as Prisma.InputJsonValue,
          subtotalCents: subtotal,
          shipCents: 0,
          taxCents: tax,
          totalCents: subtotal + tax,
          payVia: "own",
          taxVia: "rate",
          tokenHash: sha256(token),
          linkSealed: seal(orderUrl(token), a.shopId, `orderLink:${id}`),
          saleId: a.saleId,
          note: `Sold at the counter, sale #${a.saleNumber}: ship from this store.`,
          createdById: a.userId,
          paidAt: a.at,
          createdAt: a.at,
        },
        select: { number: true },
      });
    });
    out.push(made.number);
  }
  return out;
}

/** A sale voided: its "Ship this" jobs not shipped yet are cancelled (the stock went back with the void). */
export async function cancelShipJobs(tx: Prisma.TransactionClient, shopId: string, saleId: string, at: Date): Promise<void> {
  await tx.webOrder.updateMany({ where: { shopId, saleId, source: "store", status: { in: ["PAID", "READY"] } }, data: { status: "CANCELLED", cancelledAt: at, staffNote: "The sale was voided." } });
}
