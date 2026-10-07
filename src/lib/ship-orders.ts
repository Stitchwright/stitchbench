import "server-only";
// Online orders to ship (shop-features-round-2-design.md 9.5): paid, shipped by post, no tracking number yet. The
// Pirate Ship export reads them; the tracking number is pasted back on each order as before ("Shipped").
import { db } from "@/lib/db";
import { pirateShipRows } from "@/lib/ship-export";

export async function ordersToShip(shopId: string) {
  return db.webOrder.findMany({
    where: { shopId, fulfil: "ship", status: "PAID", tracking: null },
    select: { id: true, number: true, name: true, email: true, phone: true, address: true, items: true },
    orderBy: { number: "asc" },
    take: 500,
  });
}

/** The Pirate Ship file for every order to ship, and the order numbers whose address was split by guesswork. */
export async function pirateShipFile(shopId: string) {
  return pirateShipRows(await ordersToShip(shopId));
}
