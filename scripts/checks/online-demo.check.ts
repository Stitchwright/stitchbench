import "dotenv/config";
// The demo's simulated customer (docs/plans/makerfoundry-orders-plan.md, src/lib/shop-orders/demo.ts): with DEMO_MODE on a button makes the
// order a customer would place from the shop's own garments and prices and takes it in through the same code a real order goes through,
// then pretends the customer's answers, with no hub and no network at all (this check makes any outside request fail). Off a demo the
// buttons refuse. The order page and the rest of the flow (proof, hand-over, the register) work on what the simulation made.
//   npm run check scripts/checks/online-demo.check.ts
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { demoDst, demoPng, simulateCustomerFor, simulateOrderFor } from "@/lib/shop-orders/demo";
import { handOverOnlineOrderFor } from "@/lib/shop-orders/handover";
import { sendOnlineProofFor } from "@/lib/shop-orders/proofs";
import { expectNotFound, makeCompany, removeCompany } from "./tenant";
import { imageType } from "@/lib/decor";
import { readEmbroidery } from "@/lib/embroidery-file";
import { saveOfferFor, saveProductFor, setOnlineOrdersFor } from "@/lib/shop-orders/online";

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

async function main() {
  const A = await makeCompany("Demo sim A", { kind: "retail" });
  const B = await makeCompany("Demo sim B", { kind: "retail" });
  const realFetch = globalThis.fetch;
  const outside: string[] = [];
  try {
    const { grantDevLicense } = await import("../license/dev");
    for (const c of [A, B]) await grantDevLicense(c.shopId, ["decorating"], { from: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) });

    // ----- not a demo: refused -----
    delete process.env.DEMO_MODE;
    await assert.rejects(() => simulateOrderFor(A.user, "pickup"), /only in the demo/);
    ok("outside a demo the simulation is refused");

    // ----- a demo: no network at all -----
    process.env.DEMO_MODE = "on";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      outside.push(String(input));
      throw new Error("no network in the demo check");
    }) as typeof fetch;
    await assert.rejects(() => simulateOrderFor({ ...A.user, role: "TECH" }, "pickup"), /owner or admin/);

    // The generated files are what they say they are.
    assert.equal(imageType(demoPng()), "image/png");
    const info = readEmbroidery("logo.dst", demoDst(1500));
    assert.ok(info.readable && info.stitches === 1500);

    // ----- an order from the shop's own garments and prices -----
    await saveProductFor(A.user, form({ sku: "POLO-1", name: "Pique polo", colours: "Forest, White", sizes: "S, M, L", blank: "14.00" }));
    await saveOfferFor(A.user, form({ method: "embroidery", placement: "Left chest", breaks: "1: 11.00\n4: 9.00", setup: "20", maxStitches: "6000" }));
    const said = await simulateOrderFor(A.user, "pickup");
    assert.match(said, /Pique polos? through MakerFoundry: order #\d+, already paid/);
    const o = await db.decorOrder.findFirstOrThrow({ where: { shopId: A.shopId, source: "MAKERFOUNDRY" }, include: { lines: true, placements: true } });
    assert.equal(o.status, "QUOTED");
    assert.equal(o.lines[0].description, "Pique polo");
    assert.equal(o.lines[0].qty, 6);
    assert.equal(o.quoteCents, (1400 + 900) * 6 + 2000, "the shop's own prices: garment plus decoration at the 4-piece break for 6 pieces, plus set-up");
    assert.equal(o.paidCents, o.quoteCents);
    assert.equal(o.customerId, null);
    assert.equal(o.fulfilment, "PICKUP");
    assert.ok(o.placements[0].fileData && o.placements[0].fileReadable && o.placements[0].stitches === 1500, "the design was checked and read like a real one");
    assert.equal(o.mockupMime, "image/png", "and the customer's picture is the mock-up");
    assert.equal(o.fileError, null);
    ok("a simulated order is taken in with the shop's own prices, files checked and read, already paid");

    // ----- nothing goes out, and nothing waits -----
    assert.deepEqual(outside, [], "no request left the server");
    const out = await db.syncOut.findMany({ where: { shopId: A.shopId } });
    assert.ok(out.length >= 1 && out.every((m) => m.sentAt), "`received` is recorded as sent: nothing waits for a hub that is not there");
    ok("no network and nothing left waiting");

    // ----- a ship order, and a second order is another order -----
    await simulateOrderFor(A.user, "ship");
    const ship = await db.decorOrder.findMany({ where: { shopId: A.shopId, source: "MAKERFOUNDRY", fulfilment: "SHIP" } });
    assert.equal(ship.length, 1);
    assert.equal((ship[0].shipTo as { line1: string }).line1, "1 Demo Lane");
    assert.equal(await db.decorOrder.count({ where: { shopId: A.shopId, source: "MAKERFOUNDRY" } }), 2);
    assert.ok(!JSON.stringify(await db.decorOrder.findMany({ where: { shopId: A.shopId } })).match(/@\w+\.\w+|\d{3}[-. ]\d{3}[-. ]\d{4}/), "no email or phone");
    ok("an order to be shipped carries a made-up address; each press is another order");

    // ----- the proof loop, pretended -----
    await assert.rejects(() => simulateCustomerFor(A.user, o.id, "approved"), /Send a proof first/);
    const sent = await sendOnlineProofFor(A.user, o.id, "Demo proof");
    assert.match(sent, /Proof 1/);
    await simulateCustomerFor(A.user, o.id, "changes");
    let cur = await db.decorOrder.findUniqueOrThrow({ where: { id: o.id } });
    assert.equal(cur.proofAnswer, "changes");
    assert.equal(cur.status, "QUOTED");
    await sendOnlineProofFor(A.user, o.id, null);
    await simulateCustomerFor(A.user, o.id, "approved");
    cur = await db.decorOrder.findUniqueOrThrow({ where: { id: o.id } });
    assert.equal(cur.status, "APPROVED");
    ok("send a proof, the customer asks for changes, a second proof, the customer approves: all without a hub");

    // ----- on to hand-over, booked like a real one -----
    const { setOrderStatusFor } = await import("@/lib/decor");
    await setOrderStatusFor(A.user, o.id, "IN_PRODUCTION");
    await setOrderStatusFor(A.user, o.id, "READY");
    const hand = await handOverOnlineOrderFor(A.user, o.id, null);
    assert.match(hand, /handed over/);
    assert.ok((await db.decorOrder.findUniqueOrThrow({ where: { id: o.id } })).saleId);
    ok("the rest of the flow works on a simulated order: production, ready, handed over and booked paid online");

    // ----- the customer cancels another -----
    const ship0 = ship[0];
    await simulateCustomerFor(A.user, ship0.id, "cancel");
    const cx = await db.decorOrder.findUniqueOrThrow({ where: { id: ship0.id } });
    assert.equal(cx.status, "CANCELLED");
    assert.equal(cx.shipTo, null);
    ok("the customer can cancel; the address goes");

    // ----- the opt-in in a demo needs no hub -----
    const on = await setOnlineOrdersFor(A.user, form({ on: "on", maxOpen: "20" }));
    assert.match(on, /You take orders from MakerFoundry/, "the opt-in works without a hub");
    assert.equal((await db.shopOrdersSync.findUniqueOrThrow({ where: { shopId: A.shopId } })).optedIn, true);
    assert.deepEqual(outside, [], "still no request left the server");
    ok("turning orders on in a demo doesn't call a hub");

    // ----- tenancy -----
    await expectNotFound("B plays A's customer", () => simulateCustomerFor(B.user, o.id, "cancel").then(() => true));
    ok("one company's simulation never touches another's orders");
    console.log(`online-demo: ${steps} steps ok`);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.DEMO_MODE;
    for (const c of [A, B]) await removeCompany(c.shopId).catch(() => {});
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
