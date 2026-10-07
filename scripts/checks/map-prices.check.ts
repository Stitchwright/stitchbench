// Minimum advertised prices (shop-features-round-2-design.md 9.3, package map-prices): setting an item's or a machine's
// MAP (owner or admin), the online catalog and item page showing the MAP and "see price in cart" (the real price never
// in them), the cart at the real price, and the list of prices advertised below a MAP (the item's own, a promotion on
// now or coming, a machine for sale); tenant.
//   npm run check scripts/checks/map-prices.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { belowMap } from "@/lib/map-math";
import { mapProblems, setMapFor } from "@/lib/map-prices";
import { catalog, catalogItem, priceCart, type PublicStore } from "@/lib/shop/online-shop";
import { addDays, ymdOf } from "@/lib/zoned";
import { checkShop, cleanup } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function main() {
  assert.deepEqual([belowMap(399, 499), belowMap(499, 499), belowMap(599, 499), belowMap(null, 499), belowMap(399, null), belowMap(399, 0)], [true, false, false, false, false, false]);
  ok("below the minimum: only a lower price, and only with a minimum set");

  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    const foot = await db.part.create({ data: { shopId: a.shopId, partNumber: "WALK-1", numberKeys: ["WALK1"], description: "Walking foot", kind: "ACCESSORY", brand: "Brother", priceCents: 3999, qtyOnHand: 5, online: true } });
    const thread = await db.part.create({ data: { shopId: a.shopId, partNumber: "TH-1", numberKeys: ["TH1"], description: "Thread", kind: "SUPPLY", priceCents: 899, qtyOnHand: 5, online: true } });
    // 1. Setting it.
    await assert.rejects(() => setMapFor({ ...a.user, role: "TECH" }, "part", foot.id, fd({ map: "49.99" })), (e) => isUserError(e) && /owner or admin/.test((e as Error).message));
    await assert.rejects(() => setMapFor(a.user, "part", foot.id, fd({ map: "abc" })), (e) => isUserError(e) && /dollars/.test((e as Error).message));
    assert.match(await setMapFor(a.user, "part", foot.id, fd({ map: "$49.99" })), /\$49.99/);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: foot.id } })).mapCents, 4999);
    ok("an owner sets the minimum advertised price (a tech can't; forgiving dollars)");

    // 2. Online.
    const items = await catalog(a.shopId);
    const f = items.find((i) => i.id === foot.id)!;
    const t = items.find((i) => i.id === thread.id)!;
    assert.deepEqual([f.priceCents, f.seeInCart, t.priceCents, t.seeInCart], [4999, true, 899, false]);
    assert.ok(!JSON.stringify(items).includes("3999"), "the real price isn't in the catalog");
    const one = (await catalogItem(a.shopId, foot.id))!;
    assert.deepEqual([one.priceCents, one.seeInCart], [4999, true]);
    const store = { id: a.shopId, name: a.name, phone: null, address: null, timeZone: "America/New_York", slug: "x", open: true, welcome: null, pickup: true, shipping: false, shipCents: 0, freeOverCents: null, pickupNote: null, taxRatePct: 0, payVia: "own", taxVia: "rate" } as unknown as PublicStore;
    const cart = await priceCart(store, new Map([[foot.id, 1]]), "pickup");
    assert.equal(cart.lines[0].unitPriceCents, 3999, "the cart shows the real price");
    ok('online: the minimum price with "see price in cart", the real price only in the cart');

    // 3. The list of prices below a minimum.
    const today = ymdOf(new Date(), "America/New_York");
    await db.part.update({ where: { id: foot.id }, data: { priceCents: 5999 } });
    assert.deepEqual(await mapProblems(a.shopId), [], "above the minimum: nothing");
    await db.promotion.create({ data: { shopId: a.shopId, name: "Fall sale", firstDay: addDays(today, 3), lastDay: addDays(today, 10), effect: "PERCENT", value: 25, scope: { brands: ["brother"] } } });
    await db.promotion.create({ data: { shopId: a.shopId, name: "Old sale", firstDay: addDays(today, -20), lastDay: addDays(today, -10), effect: "PERCENT", value: 50, scope: { brands: ["brother"] } } });
    let rows = await mapProblems(a.shopId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].priceCents, 4499);
    assert.match(rows[0].where, /Fall sale.*don't put that price in a flyer/);
    const cust = await db.machine.create({ data: { shopId: a.shopId, brand: "Brother", model: "SE600", modelKey: "SE600", serial: "U1" } });
    const unit = await db.stockUnit.create({ data: { shopId: a.shopId, machineId: cust.id, priceCents: 39900 } });
    await setMapFor(a.user, "unit", unit.id, fd({ map: "449" }));
    rows = await mapProblems(a.shopId);
    assert.ok(rows.some((r) => r.key === `unit:${unit.id}:price` && /don't advertise/.test(r.where)), "the machine's own price is below");
    await setMapFor(a.user, "part", foot.id, fd({ map: "" }));
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: foot.id } })).mapCents, null, "blank clears it");
    ok("the list: a promotion coming that brings an item under (an ended one doesn't), a machine priced under; blank clears");

    // 4. Tenant.
    await expectNotFound("B sets A's item", () => setMapFor(b.user, "part", foot.id, fd({ map: "1" })));
    await expectNotFound("B sets A's machine", () => setMapFor(b.user, "unit", unit.id, fd({ map: "1" })));
    assert.deepEqual(await mapProblems(b.shopId), []);
    ok("tenant: B can't set A's minimums nor see A's list");
  } finally {
    await cleanup();
  }
  console.log(`map-prices.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
