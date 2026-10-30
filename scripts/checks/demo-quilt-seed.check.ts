// The Maple Street Quilt Co. demo seed (scripts/demo/seed-demo.ts, docs/demo.md): it runs twice in a row with the same
// result (one company, the same counts), the shelves are stocked (about 150 bolts, a dozen machines, some stock running low),
// the people, classes, gift cards and special orders are there, and --remove takes it all away. Runs the seed script itself,
// so it takes about two minutes and needs a database on this PC.
//   npm run check scripts/checks/demo-quilt-seed.check.ts
// Shares the dev database; the demo company is removed at the end.
import "dotenv/config";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { db } from "@/lib/db";

const NAME = "Maple Street Quilt Co.";
const ok = (what: string) => console.log(`  ok  ${what}`);

function seed(...args: string[]) {
  const r = spawnSync("npx", ["tsx", "scripts/demo/seed-demo.ts", ...args], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
}

async function counts() {
  const shops = await db.shop.findMany({ where: { name: NAME }, select: { id: true } });
  if (shops.length !== 1) return { shops: shops.length };
  const shopId = shops[0].id;
  return {
    shops: 1,
    fabric: await db.part.count({ where: { shopId, kind: "FABRIC" } }),
    machines: await db.part.count({ where: { shopId, partNumber: { startsWith: "MAC-" } } }),
    low: (await db.part.findMany({ where: { shopId }, select: { qtyOnHand: true, reorderAt: true } })).filter((p) => p.qtyOnHand < p.reorderAt).length,
    customers: await db.customer.count({ where: { shopId } }),
    classes: await db.shopClass.count({ where: { shopId } }),
    giftCards: await db.giftCard.count({ where: { shopId } }),
    specialOrders: await db.specialOrder.count({ where: { shopId } }),
  };
}

async function main() {
  try {
    seed();
    const first = await counts();
    assert.equal(first.shops, 1);
    seed();
    const second = await counts();
    assert.deepEqual(second, first, "a second run gives the same shop");
    ok("the seed runs twice in a row and leaves one company with the same counts");

    assert.ok(first.fabric! >= 140, `bolts: ${first.fabric}`);
    assert.ok(first.machines! >= 12, `machines: ${first.machines}`);
    assert.ok(first.low! >= 10, `items running low: ${first.low}`);
    assert.ok(first.customers! >= 19 && first.classes! >= 7 && first.giftCards === 3 && first.specialOrders === 4, JSON.stringify(first));
    ok(`stocked: ${first.fabric} fabric items, ${first.machines} machines for sale, ${first.low} running low; ${first.customers} customers, ${first.classes} classes, ${first.giftCards} gift cards, ${first.specialOrders} special orders`);

    const shop = await db.shop.findFirstOrThrow({ where: { name: NAME }, select: { id: true, bookingSlug: true } });
    assert.equal(shop.bookingSlug, "maple-street");
    const titles = (await db.shopClass.findMany({ where: { shopId: shop.id }, select: { title: true } })).map((c) => c.title);
    for (const t of ["Beginner Log Cabin, 4 weeks", "Free-Motion Quilting Night", "Bag-Making Saturday"]) assert.ok(titles.includes(t), `class ${t}`);
    const people = await db.user.findMany({ where: { shopId: shop.id }, select: { email: true } });
    assert.ok(people.every((u) => /(\.test|example\.com)$/.test(u.email)), "every person is on an invented address (the nightly reset's guard needs it)");
    ok("the three named classes are there, and every person has an invented email address");

    seed("--remove");
    assert.deepEqual(await counts(), { shops: 0 });
    ok("--remove takes the company away");
  } finally {
    await db.shop.deleteMany({ where: { name: NAME } }).catch(() => {});
    await db.$disconnect();
  }
  console.log("demo-quilt-seed.check: 4 steps passed");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
