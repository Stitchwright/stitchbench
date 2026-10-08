// Shipping labels through Pirate Ship (shop-features-round-2-design.md 9.5, package ship-export): the address box split
// into street, line 2, city, state and ZIP (the name on the first line dropped, one line with commas, ZIP+4, "USA"), the
// guesswork flagged, the rows in Pirate Ship's layout, only paid orders to post without tracking, tenant.
//   npm run check scripts/checks/ship-export.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { PIRATE_SHIP_HEADER, pirateShipRows, splitAddress } from "@/lib/ship-export";
import { ordersToShip, pirateShipFile } from "@/lib/ship-orders";
import { checkShop, cleanup } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

async function main() {
  assert.deepEqual(splitAddress("Jane Doe\n12 Elm St\nApt 4\nSpringfield, IL 62704", "Jane Doe"), { street: "12 Elm St", line2: "Apt 4", city: "Springfield", state: "IL", zip: "62704", country: "US", sure: true });
  assert.deepEqual(splitAddress("12 Elm St, Springfield, IL 62704-1234", "Jane"), { street: "12 Elm St", line2: "", city: "Springfield", state: "IL", zip: "62704-1234", country: "US", sure: true });
  assert.deepEqual(splitAddress("12 Elm St\nSpringfield\nil. 62704\nUSA"), { street: "12 Elm St", line2: "", city: "Springfield", state: "IL", zip: "62704", country: "US", sure: true });
  assert.deepEqual(splitAddress("12 Elm St Springfield IL 62704"), { street: "", line2: "", city: "12 Elm St Springfield", state: "IL", zip: "62704", country: "US", sure: false });
  assert.equal(splitAddress("Somewhere in Canada").sure, false);
  assert.equal(splitAddress("1 Rue X, Paris, ZZ 75001").sure, false, "not a US state");
  ok("addresses split: name dropped, lines or commas, ZIP+4, a lower-case state, USA; guesswork flagged");

  const { rows, unsure } = pirateShipRows([
    { number: 7, name: "Jane Doe", email: "j@x.test", phone: "555-0101", address: "12 Elm St\nSpringfield, IL 62704", items: [{ description: "Walking foot", qty: 1 }, { description: "Thread", qty: 3 }] },
    { number: 8, name: "Bob", email: null, phone: null, address: "somewhere", items: [] },
  ]);
  assert.deepEqual(rows[0], PIRATE_SHIP_HEADER);
  assert.deepEqual(rows[1].slice(0, 12), ["Jane Doe", "", "12 Elm St", "", "Springfield", "IL", "62704", "US", "j@x.test", "555-0101", "#7", "1 x Walking foot; 3 x Thread"]);
  assert.deepEqual(unsure, [8]);
  ok("the rows in Pirate Ship's layout, one per order, the unsure ones named");

  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    const mk = (n: number, o: Record<string, unknown>) =>
      db.webOrder.create({ data: { shopId: a.shopId, number: n, name: `Buyer ${n}`, address: "1 Main St\nTown, NY 10001", fulfil: "ship", status: "PAID", subtotalCents: 1000, taxCents: 0, totalCents: 1000, tokenHash: `chk-${a.shopId}-${n}`, ...o } });
    await mk(1, {});
    await mk(2, { tracking: "1Z999" });
    await mk(3, { fulfil: "pickup" });
    await mk(4, { status: "PENDING" });
    await mk(5, { status: "DONE" });
    assert.deepEqual((await ordersToShip(a.shopId)).map((o) => o.number), [1], "paid, to post, no tracking yet");
    const f = await pirateShipFile(a.shopId);
    assert.equal(f.rows.length, 2);
    assert.equal(f.rows[1][6], "10001");
    assert.deepEqual(await ordersToShip(b.shopId), [], "tenant: B gets none of A's orders");
    assert.equal((await pirateShipFile(b.shopId)).rows.length, 1);
    ok("only paid orders to post without a tracking number; tenant: B's file has none of A's");
  } finally {
    await cleanup();
  }
  console.log(`ship-export.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
