// Shipping labels through Shippo (shop-features-round-2-design.md 9.5, package shippo), against the Shippo mock
// (scripts/test-mail/shippo-mock.mjs; never a real label): the settings (owner or admin, a Shippo key sealed, where
// parcels ship from filled from the shop's address, on needs both), rates for a paid order to post (the address split,
// the weight typed or the usual box's, cheapest first; an unreadable or refused address said), buying (owner or admin,
// once an order: the label, carrier, cost and tracking on it, the Pirate Ship export leaving it out), off, tenant.
//   npm run check scripts/checks/shippo.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { unseal } from "@/lib/messaging/secrets";
import { buyLabelFor, ratesFor, saveShippoSettingsFor, shippoSettings } from "@/lib/shippo";
import { ordersToShip } from "@/lib/ship-orders";
import { startShippoMock } from "../test-mail/shippo-mock.mjs";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
async function expectError(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}
const KEY = "shippo_test_abcdef123456";
const FROM = { fromName: "Quilt Corner", fromStreet: "5 Main St", fromCity: "Springfield", fromState: "il", fromZip: "62701", fromPhone: "555-0100" };

async function main() {
  const mock = await startShippoMock({ port: 0 });
  process.env.SHIPPO_API_BASE = `http://127.0.0.1:${mock.port}`;
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { address: "5 Main St, Springfield, IL 62701", phone: "555-0100" } });
    const order = (n: number, o: Record<string, unknown> = {}) =>
      db.webOrder.create({ data: { shopId: a.shopId, number: n, name: `Buyer ${n}`, phone: "555-0111", address: `Buyer ${n}\n12 Elm St\nChicago, IL 60601`, fulfil: "ship", status: "PAID", subtotalCents: 1000, taxCents: 0, totalCents: 1000, tokenHash: `shp-${a.shopId}-${n}`, ...o } });
    const o1 = await order(1);
    const o2 = await order(2, { address: "somewhere nice" });
    const o3 = await order(3, { address: "1 Nowhere Rd\nNowhere, IL 00000" });

    // 1. Settings.
    let s = await shippoSettings(a.shopId);
    assert.deepEqual([s.on, s.hasKey, s.from.street1, s.from.city, s.from.state, s.from.zip], [false, false, "5 Main St", "Springfield", "IL", "62701"], "filled from the shop's address");
    await expectError("a tech", () => saveShippoSettingsFor(tech(a), fd({ ...FROM, on: "on", shippoKey: KEY })), /owner or admin/);
    await expectError("a bad key", () => saveShippoSettingsFor(a.user, fd({ ...FROM, shippoKey: "sk_test_123" })), /shippo_live_/);
    await expectError("on without a key", () => saveShippoSettingsFor(a.user, fd({ ...FROM, on: "on" })), /Paste your Shippo API key/);
    await expectError("on without a ZIP", () => saveShippoSettingsFor(a.user, fd({ ...FROM, fromZip: "", on: "on", shippoKey: KEY })), /parcels ship from/);
    await saveShippoSettingsFor(a.user, fd({ ...FROM, on: "on", shippoKey: KEY, weightOz: "20" }));
    s = await shippoSettings(a.shopId);
    assert.deepEqual([s.on, s.hasKey, s.testMode, s.from.state, s.parcel.weightOz, s.parcel.lengthIn], [true, true, true, "IL", 20, 12]);
    const sealed = (await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).shippoKeySealed!;
    assert.notEqual(sealed, KEY);
    assert.equal(unseal(sealed, a.shopId, "shippoKey")?.plain, KEY);
    ok("settings: owner or admin, a Shippo key sealed, ship-from filled from the shop and checked, the usual box");

    // 2. Rates.
    const rates = await ratesFor(tech(a), o1.id, fd({ weightOz: "24" }));
    assert.deepEqual(rates.map((r) => [r.carrier, r.service, r.cents]), [["USPS", "Ground Advantage", 540], ["USPS", "Priority Mail", 985], ["UPS", "Ground", 1120]]);
    const sent = [...mock.shipments.values()][0] as { address_to: { street1: string; city: string; state: string; zip: string }; parcels: { weight: string }[]; address_from: { state: string } };
    assert.deepEqual([sent.address_to.street1, sent.address_to.city, sent.address_to.state, sent.address_to.zip, sent.parcels[0].weight, sent.address_from.state], ["12 Elm St", "Chicago", "IL", "60601", "24", "IL"]);
    await expectError("an address that can't be split", () => ratesFor(a.user, o2.id, null), /couldn't be read for a label/);
    await expectError("an address with no rates", () => ratesFor(a.user, o3.id, null), /No rates for that address \(Address not found\.\)/);
    ok("rates: the order's address split, the weight typed (a tech may ask), cheapest first; bad addresses said in words");

    // 3. Buying.
    await expectError("a tech buys", () => buyLabelFor(tech(a), o1.id, rates[0].id), /owner or admin/);
    assert.match(await buyLabelFor(a.user, o1.id, rates[0].id), /Label bought \(\$5.40\)/);
    const got = await db.webOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.ok(got.labelUrl?.endsWith(".pdf") && got.tracking?.startsWith("9400") && got.shippoTxId?.startsWith("tx_"));
    assert.deepEqual([got.labelCarrier, got.labelCents], ["USPS Ground Advantage", 540]);
    await expectError("twice", () => buyLabelFor(a.user, o1.id, rates[1].id), /already has a label/);
    assert.equal(mock.transactions.length, 1);
    assert.ok(!(await ordersToShip(a.shopId)).some((o) => o.id === o1.id), "the Pirate Ship export leaves it out");
    ok("buying: owner or admin, once an order; the label, carrier, cost and tracking on the order; out of the Pirate Ship export");

    // 4. Off; tenant.
    await saveShippoSettingsFor(a.user, fd(FROM));
    await expectError("off", () => ratesFor(a.user, o2.id, null), /labels are off/);
    await saveShippoSettingsFor(b.user, fd({ ...FROM, on: "on", shippoKey: KEY }));
    await expectNotFound("B asks rates for A's order", () => ratesFor(b.user, o3.id, null));
    await expectNotFound("B buys for A's order", () => buyLabelFor(b.user, o2.id, rates[1].id));
    ok("off: refused; tenant: B can't get rates or buy for A's orders");
  } finally {
    await cleanup();
    await mock.close();
  }
  console.log(`shippo.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
