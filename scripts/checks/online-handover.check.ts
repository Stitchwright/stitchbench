import "dotenv/config";
// Reporting an online order's progress and handing it over (docs/plans/makerfoundry-orders-plan.md package 4; src/lib/shop-orders/handover.ts):
// each step of the order is told to MakerFoundry in the same transaction (in seq order, with the order's reference), going back a step is
// told too, a hub refusal for good is kept without undoing the step, an order paid online is handed over without taking payment (booked
// as one "Paid online" sale, no tax worked out), pickup is "collected" and a shipped order sends its tracking and loses the customer's address
// after 30 days, and nobody hands over another company's order or one that is not ready. The hub is a stand-in (scripts/checks/orders-hub.ts).
//   npm run check scripts/checks/online-handover.check.ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { setOrderStatusFor, collectOrderFor } from "@/lib/decor";
import { clearShippedAddresses, handOverOnlineOrderFor } from "@/lib/shop-orders/handover";
import { flushOutbox, syncShop } from "@/lib/shop-orders/sync";
import { expectNotFound, makeCompany, removeCompany } from "./tenant";
import { startOrdersHub } from "./orders-hub";

const fixture = (n: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/shop-orders", n), "utf8"));
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const art = Buffer.concat([Buffer.alloc(512, 0x20), Buffer.from([0x01, 0, 0x03, 0, 0, 0xf3])]);

async function main() {
  const hub = await startOrdersHub();
  const A = await makeCompany("Handover A", { kind: "retail" });
  const B = await makeCompany("Handover B", { kind: "retail" });
  try {
    const { grantDevLicense } = await import("../license/dev");
    for (const c of [A, B]) {
      await grantDevLicense(c.shopId, ["decorating"], { from: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) });
      await db.shopOrdersSync.create({ data: { shopId: c.shopId, optedIn: true } });
    }
    await db.shop.update({ where: { id: A.shopId }, data: { taxRatePct: 7 } }); // a shop with sales tax: the paid-online sale must still add none
    hub.files.set(sha(art), art);
    const place = async (conv: string, fulfilment: "ship" | "pickup") => {
      const b = fixture("order.placed.v1.valid.json");
      b.lines[0].decorations[0].art = { file: "logo.dst", size: art.length, sha256: sha(art) };
      delete b.preview;
      b.fulfilment = fulfilment;
      if (fulfilment === "pickup") delete b.customer.ship_to;
      hub.put(A.shopId, { type: "order.placed", conversation: conv, seq: 1, body: b });
      await syncShop(A.shopId);
      return db.decorOrder.findFirstOrThrow({ where: { shopId: A.shopId, onlineRef: conv } });
    };
    const statuses = (conv: string) => (hub.posted as { type: string; conversation: string; seq: number; body: { status: string; tracking?: string } }[]).filter((p) => p.type === "order.status" && p.conversation === conv).map((p) => [p.seq, p.body.status, p.body.tracking]);
    const sendOut = async () => {
      await db.syncOut.updateMany({ where: { shopId: A.shopId, sentAt: null, deadAt: null }, data: { nextTryAt: null } });
      await flushOutbox(A.shopId);
    };

    // ----- each step is told, in order -----
    const pick = await place("mf-p0001", "pickup");
    await setOrderStatusFor(A.user, pick.id, "APPROVED");
    await setOrderStatusFor(A.user, pick.id, "IN_PRODUCTION");
    await setOrderStatusFor(A.user, pick.id, "READY");
    await sendOut();
    assert.deepEqual(statuses("mf-p0001"), [[1, "received", undefined], [2, "approved", undefined], [3, "in_production", undefined], [4, "ready", undefined]]);
    ok("each step of an online order is told to MakerFoundry in seq order, with the order's reference");

    // ----- going back a step is told too -----
    await setOrderStatusFor(A.user, pick.id, "IN_PRODUCTION");
    await setOrderStatusFor(A.user, pick.id, "READY");
    await sendOut();
    assert.deepEqual(statuses("mf-p0001").slice(4).map((s) => s[1]), ["in_production", "ready"], "the customer sees the truth");
    ok("moving an order back a step is told as well");

    // ----- a refusal for good is kept and does not undo the step -----
    const gone = await place("mf-p0002", "pickup");
    hub.knobs.postStatuses.push({ status: 409, error: "There is no order with that reference", code: "no_such_order" });
    await setOrderStatusFor(A.user, gone.id, "APPROVED");
    await sendOut();
    assert.equal((await db.decorOrder.findUniqueOrThrow({ where: { id: gone.id } })).status, "APPROVED", "the shop's own step stands");
    assert.ok((await db.syncOut.count({ where: { shopId: A.shopId, conversation: "mf-p0002", deadAt: { not: null } } })) >= 1, "and the refusal is kept where the owner can see it");
    ok("a hub refusal for good is kept and does not undo the step");

    // ----- not ready, not online, not mine -----
    await assert.rejects(() => handOverOnlineOrderFor(A.user, gone.id, null), /Only a ready order/);
    await assert.rejects(() => collectOrderFor(A.user, pick.id, new FormData()), /paid on MakerFoundry/);
    await expectNotFound("B hands over A's order", () => handOverOnlineOrderFor(B.user, pick.id, null).then(() => true));
    ok("only a ready order, only its own company, and never through the register");

    // ----- pickup: collected, booked as one paid-online sale, no payment taken -----
    const said = await handOverOnlineOrderFor(A.user, pick.id, null);
    assert.match(said, /handed over/);
    const done = await db.decorOrder.findUniqueOrThrow({ where: { id: pick.id } });
    assert.equal(done.status, "COLLECTED");
    assert.ok(done.saleId);
    const sale = await db.sale.findUniqueOrThrow({ where: { id: done.saleId! } });
    assert.equal(sale.totalCents, 9000 + 2500, "goods and set-up as paid");
    assert.equal(sale.taxCents, 0, "no tax is worked out here (still open)");
    assert.deepEqual((sale.tenders as { method: string }[]).map((t) => t.method), ["ONLINE"], "one Paid online payment, no cash");
    await sendOut();
    assert.equal(statuses("mf-p0001").at(-1)?.[1], "collected");
    await assert.rejects(() => handOverOnlineOrderFor(A.user, pick.id, null), /already handed over/);
    assert.equal(await db.sale.count({ where: { shopId: A.shopId, note: { contains: "mf-p0001" } } }), 1, "handing over twice books one sale");
    ok("pickup: collected without taking payment, booked as one Paid online sale, MakerFoundry told");

    // ----- shipped: tracking told, the address kept 30 days then wiped -----
    const sh = await place("mf-s0001", "ship");
    for (const to of ["APPROVED", "IN_PRODUCTION", "READY"]) await setOrderStatusFor(A.user, sh.id, to);
    assert.ok((await db.decorOrder.findUniqueOrThrow({ where: { id: sh.id } })).shipTo, "the address is on the order until it is gone");
    const shipSaid = await handOverOnlineOrderFor(A.user, sh.id, "1Z999AA10123456784");
    assert.match(shipSaid, /shipped/);
    await sendOut();
    assert.deepEqual(statuses("mf-s0001").at(-1), [5, "shipped", "1Z999AA10123456784"]);
    const shipped = await db.decorOrder.findUniqueOrThrow({ where: { id: sh.id } });
    assert.ok(shipped.shippedAt);
    assert.equal(shipped.tracking, "1Z999AA10123456784");
    assert.ok(shipped.shipTo, "still there on day one");
    assert.equal(await clearShippedAddresses(A.shopId), 0);
    await db.decorOrder.update({ where: { id: sh.id }, data: { shippedAt: new Date(Date.now() - 31 * 86_400_000) } });
    assert.equal(await clearShippedAddresses(A.shopId), 1);
    assert.equal((await db.decorOrder.findUniqueOrThrow({ where: { id: sh.id } })).shipTo, null, "the customer's address is gone 30 days after it shipped");
    ok("shipped: the tracking number is told, and the customer's address is wiped 30 days later");

    // ----- the sale failing leaves the order ready and tells nobody -----
    const bad = await place("mf-p0003", "pickup");
    for (const to of ["APPROVED", "IN_PRODUCTION", "READY"]) await setOrderStatusFor(A.user, bad.id, to);
    const outBefore = await db.syncOut.count({ where: { shopId: A.shopId, conversation: "mf-p0003", type: "order.status" } });
    await db.decorOrder.update({ where: { id: bad.id }, data: { quoteCents: 2_000_000_000, setupCents: 0 } }); // a price the register will not book
    await assert.rejects(() => handOverOnlineOrderFor(A.user, bad.id, null));
    const after = await db.decorOrder.findUniqueOrThrow({ where: { id: bad.id } });
    assert.equal(after.status, "READY", "still on the shelf");
    assert.equal(after.saleId, null);
    assert.equal(await db.syncOut.count({ where: { shopId: A.shopId, conversation: "mf-p0003", type: "order.status" } }), outBefore, "and the customer was not told it was collected");
    ok("when the sale can't be booked the order stays ready and nothing is told");
    console.log(`online-handover: ${steps} steps ok`);
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
