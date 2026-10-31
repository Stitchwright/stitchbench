import "dotenv/config";
// Taking orders from MakerFoundry (docs/plans/makerfoundry-orders-plan.md package 2; src/lib/shop-orders/online.ts): the opt-in
// (refused until there is something to sell and a hub; the hub told), the catalogue built from the garments and decoration prices and
// published (the garment's own price and the decoration's, pickup only until the shop ships, the pick-up address, shipping by the piece), every edit publishing the new one in place of any not yet sent, who may
// change it, and one company never touching another's list. The hub is a stand-in (scripts/checks/orders-hub.ts).
//   npm run check scripts/checks/online-orders.check.ts
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { parseBody } from "@/lib/shop-orders/contract";
import { removeOfferFor, removeProductFor, saveOfferFor, saveProductFor, saveShippingFor, setOnlineOrdersFor } from "@/lib/shop-orders/online";
import { flushOutbox } from "@/lib/shop-orders/sync";
import type { CurrentUser } from "@/lib/session";
import { expectNotFound, makeCompany, removeCompany } from "./tenant";
import { startOrdersHub } from "./orders-hub";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
const refused = async (what: string, fn: () => Promise<unknown>, re: RegExp) => {
  await assert.rejects(fn, (e: Error) => re.test(e.message), what);
};
const tee = { sku: "TEE-01", name: "Heavy cotton tee", colours: "Black, Navy", sizes: "S, M, L, XL", blank: "9.00" };
const chest = { method: "embroidery", placement: "Left chest", breaks: "1: 12.00\n12: 10.00", setup: "25", maxStitches: "8000" };
type Catalog = { products: { sku: string; methods: { placements: string[]; price_breaks: { min: number; cents: number }[]; setup_cents: number }[] }[]; shop: { ships: boolean; pickup: boolean; address?: Record<string, string> }; shipping: { flat_cents: number; per_extra_piece_cents?: number; free_over_cents?: number } };
const ADDRESS = { pickup: "on", pa_line1: "210 Main Street", pa_city: "Elmwood", pa_region: "OH", pa_postcode: "44001", pa_country: "US" };
const catalogs = (hub: Awaited<ReturnType<typeof startOrdersHub>>) => (hub.posted as { type: string; body: Catalog }[]).filter((p) => p.type === "catalog");

async function main() {
  const hub = await startOrdersHub();
  const A = await makeCompany("Online A", { kind: "retail" });
  const B = await makeCompany("Online B", { kind: "retail" });
  try {
    // The decorating module on for both (a dev license that started two days ago), as the other checks do.
    const { grantDevLicense } = await import("../license/dev");
    for (const c of [A, B]) await grantDevLicense(c.shopId, ["decorating"], { from: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) });
    const tech: CurrentUser = { ...A.user, role: "TECH" };

    // ----- who may -----
    await refused("a tech can't change it", () => saveProductFor(tech, form(tee)), /owner or admin/);
    await refused("a tech can't opt in", () => setOnlineOrdersFor(tech, form({ on: "on", maxOpen: "50" })), /owner or admin/);
    ok("only an owner or admin changes what the shop sells online");

    // ----- the opt-in needs something to sell, and a hub -----
    await refused("nothing to sell", () => setOnlineOrdersFor(A.user, form({ on: "on", maxOpen: "50" })), /at least one garment and one decoration/);
    assert.equal(hub.optins.length, 0, "the hub is not told of a shop with nothing to sell");
    await saveProductFor(A.user, form(tee));
    await saveOfferFor(A.user, form(chest));
    assert.equal(catalogs(hub).length, 0, "nothing is published while the shop is not taking orders");
    // MakerFoundry pays the shop through the owner's linked Foundry Account and doesn't offer a shop without one.
    await refused("no Foundry Account", () => setOnlineOrdersFor(A.user, form({ on: "on", maxOpen: "50" })), /Link the owner's login to a Foundry Account/);
    const techLogin = await db.user.findFirstOrThrow({ where: { shopId: A.shopId, role: "OWNER" } });
    // Only the owner's link counts: a technician's linked account, or a retired owner login's, is not who the shop is paid through.
    await db.user.create({ data: { shopId: A.shopId, email: `tech-${Date.now()}@stitchbench.test`, name: "Tech", passwordHash: "x", role: "TECH", foundryId: 7_000_001 } });
    await db.user.create({ data: { shopId: A.shopId, email: `old-${Date.now()}@stitchbench.test`, name: "Old owner", passwordHash: "x", role: "OWNER", active: false, foundryId: 7_000_002 } });
    await refused("only the owner's link counts", () => setOnlineOrdersFor(A.user, form({ on: "on", maxOpen: "50" })), /Link the owner's login to a Foundry Account/);
    await db.user.update({ where: { id: techLogin.id }, data: { foundryId: 9_000_000 + Math.floor(Math.random() * 90_000) } }); // the owner links an account
    const account = (await db.user.findUniqueOrThrow({ where: { id: techLogin.id } })).foundryId!;
    // Pick-up is on until it is switched off, and then the pick-up address is needed: sales tax on a pick-up order is worked out from it.
    await refused("pick-up without an address", () => setOnlineOrdersFor(A.user, form({ on: "on", maxOpen: "50" })), /pick-up address/);
    await refused("a pick-up address needs a zip", () => saveShippingFor(A.user, form({ ...ADDRESS, pa_postcode: "" })), /address \(street, town and zip\)/);
    await saveShippingFor(A.user, form(ADDRESS));
    await refused("a bad maximum", () => setOnlineOrdersFor(A.user, form({ on: "on", maxOpen: "0" })), /whole number/);
    hub.knobs.optinStatuses.push({ status: 404, error: "unknown service" });
    await refused("a hub that has no MakerFoundry", () => setOnlineOrdersFor(A.user, form({ on: "on", maxOpen: "50" })), /doesn't take MakerFoundry orders/);
    assert.equal((await db.shopOrdersSync.findUniqueOrThrow({ where: { shopId: A.shopId } })).optedIn, false, "not opted in when the hub refused");
    ok("opting in needs a garment and a decoration, and is not recorded if the hub says no");

    // ----- opt in: the hub is told, the catalogue goes out -----
    const said = await setOnlineOrdersFor(A.user, form({ on: "on", maxOpen: "50" }));
    assert.match(said, /Published: 1 garment/);
    assert.deepEqual(hub.optins.at(-1), { shop: A.shopId, service: "makerfoundry", enabled: true, maxOpen: 50 });
    const first = catalogs(hub).at(-1);
    assert.ok(first, "the catalogue was posted");
    assert.ok(parseBody("catalog", 1, first.body, "shop").ok, "and it passes the contract");
    const m = first.body.products[0].methods[0];
    assert.deepEqual(m.price_breaks, [{ min: 1, cents: 1200 }, { min: 12, cents: 1000 }], "the decoration alone");
    assert.equal((first.body.products[0] as unknown as { cents: number }).cents, 900, "and the garment's own price beside it");
    assert.equal((first.body.shop as unknown as { account: number }).account, account, "the owner's linked Foundry Account is who MakerFoundry pays");
    assert.deepEqual(first.body.shop.address, { line1: "210 Main Street", city: "Elmwood", region: "OH", postcode: "44001", country: "US" }, "the pick-up address goes with pick-up");
    assert.equal(m.setup_cents, 2500);
    assert.deepEqual(m.placements, ["Left chest"]);
    assert.equal(first.body.shop.ships, false);
    assert.equal(first.body.shop.pickup, true);
    assert.equal(first.body.shipping.flat_cents, 0);
    const row = await db.shopOrdersSync.findUniqueOrThrow({ where: { shopId: A.shopId } });
    assert.ok(row.optedIn && row.maxOpen === 50 && row.catalogPublishedAt);
    ok("opting in tells the hub and publishes the catalogue (the garment and the decoration priced apart), with the pick-up address");

    // ----- an edit publishes the new one in place of any not yet sent -----
    hub.knobs.offline = true;
    await saveOfferFor(A.user, form({ method: "embroidery", placement: "Full back", breaks: "1: 20.00", setup: "25", maxStitches: "" }));
    await saveOfferFor(A.user, form({ method: "embroidery", placement: "Right chest", breaks: "1: 12.00\n12: 10.00", setup: "25", maxStitches: "8000" }));
    const pending = await db.syncOut.findMany({ where: { shopId: A.shopId, type: "catalog", sentAt: null, deadAt: null } });
    assert.equal(pending.length, 1, "only the latest catalogue waits; the one before it was replaced");
    assert.equal((await db.syncOut.count({ where: { shopId: A.shopId, type: "catalog", deadAt: { not: null }, error: "Replaced by a newer catalogue." } })), 1);
    hub.knobs.offline = false;
    Object.assign((globalThis as unknown as { __hubNet: object }).__hubNet, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
    await flushOutbox(A.shopId);
    const latest = catalogs(hub).at(-1);
    assert.deepEqual(latest?.body.products[0].methods.map((x) => x.placements).sort(), [["Full back"], ["Left chest", "Right chest"]], "placements with the same prices share an entry");
    assert.ok(catalogs(hub).length >= 2);
    ok("an edit publishes the new catalogue and replaces one still waiting to be sent (e.g. while the hub was out of reach)");

    // ----- shipping by the piece, and pick-up with its address -----
    await saveShippingFor(A.user, form({ ...ADDRESS, ships: "on", shipping: "8.99", perExtra: "0.50", freeOver: "300" }));
    const shipped = catalogs(hub).at(-1);
    assert.ok(shipped?.body.shop.ships);
    assert.deepEqual(shipped.body.shipping, { flat_cents: 899, per_extra_piece_cents: 50, free_over_cents: 30000 }, "one piece, each extra piece, free over an amount");
    await saveShippingFor(A.user, form({ ...ADDRESS, shipping: "8.99", perExtra: "0.50", freeOver: "300" }));
    const picked = catalogs(hub).at(-1);
    assert.ok(!picked?.body.shop.ships && picked?.body.shipping.flat_cents === 0 && picked.body.shipping.per_extra_piece_cents === undefined, "unticked: pick-up only, no shipping prices");
    await saveShippingFor(A.user, form({ ships: "on", shipping: "8.99", perExtra: "0", freeOver: "0" }));
    const noPickup = catalogs(hub).at(-1);
    assert.ok(noPickup?.body.shop.ships && !noPickup.body.shop.pickup && noPickup.body.shop.address === undefined, "no pick-up, no address published");
    await refused("neither", () => saveShippingFor(A.user, form({})), /shipping or pick-up/);
    await refused("bad shipping", () => saveShippingFor(A.user, form({ ...ADDRESS, ships: "on", shipping: "abc" })), /dollars/);
    await refused("bad extra shipping", () => saveShippingFor(A.user, form({ ...ADDRESS, ships: "on", shipping: "8", perExtra: "-1" })), /dollars/);
    await saveShippingFor(A.user, form(ADDRESS));
    ok("shipping is by the piece (one piece, each extra, free over an amount), pick-up publishes its address, and neither is refused");

    // ----- bad input -----
    await refused("a bad code", () => saveProductFor(A.user, form({ ...tee, sku: "-x" })), /Code/);
    await refused("no sizes", () => saveProductFor(A.user, form({ ...tee, sizes: "" })), /colours and the sizes/);
    await refused("a bad price", () => saveProductFor(A.user, form({ ...tee, blank: "free" })), /dollars/);
    await refused("bad breaks", () => saveOfferFor(A.user, form({ ...chest, breaks: "12: 10" })), /first line has to start at 1|1 piece/);
    await refused("bad method", () => saveOfferFor(A.user, form({ ...chest, method: "dtg" })), /embroidery or screen print/);
    await refused("bad stitches", () => saveOfferFor(A.user, form({ ...chest, maxStitches: "12" })), /stitches/);
    ok("odd input is refused with a plain reason");

    // ----- removing the last garment: not published, the earlier catalogue stands -----
    const before = catalogs(hub).length;
    const mine = await db.onlineProduct.findFirstOrThrow({ where: { shopId: A.shopId } });
    const said2 = await removeProductFor(A.user, mine.id);
    assert.match(said2, /Not published/);
    assert.equal(catalogs(hub).length, before, "an empty catalogue is never sent");
    ok("removing the last garment is not published; customers keep the earlier catalogue");

    // ----- one company can't touch another's list -----
    await saveProductFor(B.user, form(tee));
    await saveOfferFor(B.user, form(chest));
    const bProduct = await db.onlineProduct.findFirstOrThrow({ where: { shopId: B.shopId } });
    const bOffer = await db.onlineOffer.findFirstOrThrow({ where: { shopId: B.shopId } });
    await expectNotFound("A removes B's garment", () => removeProductFor(A.user, bProduct.id).then(() => true));
    await expectNotFound("A removes B's decoration", () => removeOfferFor(A.user, bOffer.id).then(() => true));
    assert.equal(await db.onlineProduct.count({ where: { shopId: B.shopId } }), 1);
    assert.equal(hub.posted.filter((p) => JSON.stringify(p).includes(B.shopId)).length, 0, "B's list is in none of A's catalogues");
    ok("one company's list is its own");

    // ----- stopping -----
    const off = await setOnlineOrdersFor(A.user, form({ on: "off", maxOpen: "50" }));
    assert.match(off, /No new orders/);
    assert.equal(hub.optins.at(-1)?.enabled, false);
    assert.equal((await db.shopOrdersSync.findUniqueOrThrow({ where: { shopId: A.shopId } })).optedIn, false);
    ok("stopping tells the hub; orders already open carry on");
    console.log(`online-orders: ${steps} steps ok`);
  } finally {
    await hub.close();
    for (const c of [A, B]) await removeCompany(c.shopId).catch(() => {});
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
