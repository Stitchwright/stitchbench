import "dotenv/config";
// Taking an order from MakerFoundry into a decorating order (docs/plans/makerfoundry-orders-plan.md package 3; src/lib/shop-orders/intake.ts),
// end to end through the sync job: the order.placed from the hub becomes a QUOTED, already paid DecorOrder with the customer's art fetched
// and checked, `received` goes back; a duplicate is one order; a bad file or a hub that can't give it leaves the order and is tried again;
// a design bigger than the offer is flagged; the price paid is never re-worked; the register and the email proof are not used; and one
// company's orders are its own. The hub is a stand-in (scripts/checks/orders-hub.ts), the order is the shared fixture.
//   npm run check scripts/checks/online-intake.check.ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { addLineFor, collectOrderFor, sendProofFor } from "@/lib/decor";
import { saveOfferFor, saveProductFor } from "@/lib/shop-orders/online";
import { retryPendingFiles } from "@/lib/shop-orders/intake";
import { syncShop } from "@/lib/shop-orders/sync";
import { expectNotFound, makeCompany, removeCompany } from "./tenant";
import { startOrdersHub } from "./orders-hub";

const fixture = (n: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/shop-orders", n), "utf8"));
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
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
// A DST written from the format's public description: a header, then N one-unit stitch records (see src/lib/embroidery-file.test.ts).
function dst(stitches: number): Buffer {
  const h = `LA:TEST            \rST:${String(stitches).padStart(7)}\rCO:  1\r+X:    0\r-X:    0\r+Y:    0\r-Y:    0\r`;
  const out = Buffer.alloc(512 + stitches * 3 + 3, 0x20);
  out.write(h, 0, "latin1");
  for (let i = 0; i < stitches; i++) out.set([0x01, 0x00, 0x03], 512 + i * 3);
  out.set([0, 0, 0xf3], 512 + stitches * 3);
  return out;
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

type Body = ReturnType<typeof fixture>;
function orderBody(art: Buffer, o: Partial<Body> = {}): Body {
  const b = fixture("order.placed.v1.valid.json");
  b.lines[0].decorations[0].art = { file: "logo.dst", size: art.length, sha256: sha(art) };
  b.preview = { size: PNG.length, sha256: sha(PNG), type: "image/png" };
  return { ...b, ...o };
}

async function main() {
  const hub = await startOrdersHub();
  const A = await makeCompany("Intake A", { kind: "retail" });
  const B = await makeCompany("Intake B", { kind: "retail" });
  try {
    const { grantDevLicense } = await import("../license/dev");
    for (const c of [A, B]) {
      await grantDevLicense(c.shopId, ["decorating"], { from: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) });
      await db.shopOrdersSync.create({ data: { shopId: c.shopId, optedIn: true } });
    }
    await saveProductFor(A.user, form({ sku: "TEE-01", name: "Heavy cotton tee", colours: "Navy", sizes: "M, L", blank: "9.00" }));
    await saveOfferFor(A.user, form({ method: "embroidery", placement: "left chest", breaks: "1: 12.00", setup: "25", maxStitches: "5000" }));
    hub.files.set(sha(PNG), PNG);
    const orders = (shopId: string) => db.decorOrder.findMany({ where: { shopId, source: "MAKERFOUNDRY" }, include: { lines: true, placements: true }, orderBy: { number: "asc" } });
    const send = async (shop: { shopId: string }, conv: string, body: Body, seq = 1) => {
      hub.put(shop.shopId, { type: "order.placed", conversation: conv, seq, body });
      await syncShop(shop.shopId);
    };

    // ----- an order arrives -----
    const art = dst(1200);
    hub.files.set(sha(art), art);
    const pickup = { ...orderBody(art), fulfilment: "pickup" };
    delete pickup.customer.ship_to;
    await send(A, "mf-8f3a0001", pickup);
    const [o1] = await orders(A.shopId);
    assert.ok(o1, "an order was made");
    assert.equal(o1.status, "QUOTED");
    assert.equal(o1.name, "Pat Lee");
    assert.equal(o1.customerId, null, "no customer record: the shop is given no contact");
    assert.equal(o1.onlineRef, "mf-8f3a0001");
    assert.equal(o1.quoteCents, 9000 + 2500, "goods and set-up as paid");
    assert.equal(o1.paidCents, 12300);
    assert.equal(o1.shopGetsCents, 10493);
    assert.equal(o1.feeCents, 1150);
    assert.equal(o1.cardFeeCents, 657);
    assert.equal(o1.taxable, false);
    assert.equal(o1.fulfilment, "PICKUP");
    assert.equal(o1.shipTo, null, "no address for a pickup");
    assert.equal(o1.lines.length, 1);
    assert.equal(o1.lines[0].description, "Heavy cotton tee");
    assert.equal(o1.lines[0].color, "Navy");
    assert.equal(o1.lines[0].sizes, "M 6, L 6");
    assert.equal(o1.lines[0].qty, 12);
    assert.equal(o1.placements.length, 1);
    ok("an order becomes a QUOTED decorating order, already paid, with no customer contact and no address for a pickup");

    // ----- the files were fetched and checked -----
    const [pl] = await db.decorPlacement.findMany({ where: { orderId: o1.id }, select: { fileData: true, stitches: true, fileReadable: true, location: true, method: true } });
    assert.equal(pl.fileData && sha(Buffer.from(pl.fileData)), sha(art), "the design is the file the order named");
    assert.ok(pl.fileReadable);
    assert.equal(pl.stitches, 1200, "read from the file");
    const withMock = await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.equal(withMock.mockupMime, "image/png", "the customer's picture is the mock-up");
    assert.equal(withMock.fileError, null);
    ok("the customer's art and picture are fetched by the hub's address and checked against the order");

    // ----- received goes back, in the same step -----
    const got = hub.posted.filter((p) => (p as { type: string }).type === "order.status") as { conversation: string; seq: number; body: { status: string }; to: string }[];
    assert.deepEqual(got.map((g) => [g.conversation, g.seq, g.body.status, g.to]), [["mf-8f3a0001", 1, "received", "service:makerfoundry"]]);
    ok("`received` is sent back with the order's reference");

    // ----- a duplicate is one order -----
    const dupId = hub.put(A.shopId, { type: "order.placed", conversation: "mf-8f3a0001", seq: 1, body: pickup });
    await syncShop(A.shopId);
    hub.replay(A.shopId, dupId);
    await syncShop(A.shopId);
    assert.equal((await orders(A.shopId)).length, 1);
    assert.equal(hub.posted.filter((p) => (p as { type: string }).type === "order.status").length, 1, "and `received` is sent once");
    // A second message for the same order reference under another id (a sender that lost its record) is also one order, and is applied, not stuck.
    const again = hub.put(A.shopId, { type: "order.placed", conversation: "mf-8f3a0001", seq: 2, body: pickup });
    await syncShop(A.shopId);
    assert.equal((await orders(A.shopId)).length, 1);
    assert.ok((await db.syncIn.findFirstOrThrow({ where: { shopId: A.shopId, messageId: again } })).appliedAt, "and the second message is applied, not left waiting");
    ok("the same order delivered again is one order");

    // ----- a ship order keeps the address, on the order only -----
    const art2 = dst(800);
    hub.files.set(sha(art2), art2);
    await send(A, "mf-8f3a0002", orderBody(art2));
    const ship = (await orders(A.shopId)).find((o) => o.onlineRef === "mf-8f3a0002");
    assert.equal(ship?.fulfilment, "SHIP");
    assert.equal((ship?.shipTo as { line1: string }).line1, "12 Main St");
    assert.ok(!JSON.stringify(await db.decorOrder.findMany({ where: { shopId: A.shopId } })).match(/@|555/), "no email or phone anywhere in the orders");
    ok("a shipped order keeps the shipping address; nothing holds an email or phone");

    // ----- a bad file is not used; the order stands; it is fetched again later -----
    const art3 = dst(900);
    hub.files.set(sha(art3), art3);
    hub.knobs.corruptFiles.add(sha(art3));
    const body3 = orderBody(art3);
    body3.preview = undefined;
    delete body3.preview;
    await send(A, "mf-8f3a0003", body3);
    const o3 = (await orders(A.shopId)).find((o) => o.onlineRef === "mf-8f3a0003");
    assert.ok(o3, "the order is there");
    const p3 = await db.decorPlacement.findFirstOrThrow({ where: { orderId: o3.id } });
    assert.equal(p3.fileData, null, "bytes that are not the file named were not kept");
    const failed = await db.decorOrder.findUniqueOrThrow({ where: { id: o3.id } });
    assert.match(failed.fileError ?? "", /isn't the file the order named/);
    assert.ok(failed.filesNextTryAt, "to be tried again");
    hub.knobs.corruptFiles.delete(sha(art3));
    await db.decorOrder.update({ where: { id: o3.id }, data: { filesNextTryAt: null } });
    await retryPendingFiles(A.shopId);
    assert.ok((await db.decorPlacement.findFirstOrThrow({ where: { orderId: o3.id } })).fileData, "it came on the next try");
    assert.equal((await db.decorOrder.findUniqueOrThrow({ where: { id: o3.id } })).fileError, null);
    ok("a file that isn't the one named is refused; the order stands and the file is fetched on a later try");

    // ----- the hub can't give the file just now -----
    const art4 = dst(700);
    hub.files.set(sha(art4), art4);
    hub.knobs.fileStatuses.push({ status: 503, error: "busy" });
    const body4 = orderBody(art4);
    delete body4.preview;
    await send(A, "mf-8f3a0004", body4);
    const o4 = (await orders(A.shopId)).find((o) => o.onlineRef === "mf-8f3a0004");
    assert.ok(o4, "the order is made even though the file wasn't there");
    assert.equal((await db.decorPlacement.findFirstOrThrow({ where: { orderId: o4.id } })).fileData, null);
    await db.decorOrder.update({ where: { id: o4.id }, data: { filesNextTryAt: null } });
    await retryPendingFiles(A.shopId);
    assert.ok((await db.decorPlacement.findFirstOrThrow({ where: { orderId: o4.id } })).fileData);
    ok("a hub that can't give the file just now leaves the order, and it is fetched later");

    // ----- a design bigger than the offer covers is flagged, not refused -----
    const big = dst(6000);
    hub.files.set(sha(big), big);
    const body5 = orderBody(big);
    delete body5.preview;
    body5.lines[0].decorations[0].placement = "Left chest";
    await send(A, "mf-8f3a0005", body5);
    const o5 = (await orders(A.shopId)).find((o) => o.onlineRef === "mf-8f3a0005");
    assert.match(o5?.onlineFlag ?? "", /6,000 stitches; your offer covers up to 5,000/);
    assert.equal(o5?.status, "QUOTED", "the shop decides");
    ok("a design bigger than the offer is flagged for the shop to read");

    // ----- two lines with different decorations -----
    const art6 = dst(500);
    hub.files.set(sha(art6), art6);
    const body6 = orderBody(art);
    delete body6.preview;
    body6.lines.push({ sku: "TEE-01", colour: "Navy", sizes: { M: 2 }, decorations: [{ method: "embroidery", placement: "Full back", art: { file: "back.dst", size: art6.length, sha256: sha(art6) } }] });
    await send(A, "mf-8f3a0006", body6);
    const o6 = (await orders(A.shopId)).find((o) => o.onlineRef === "mf-8f3a0006");
    assert.equal(o6?.lines.length, 2);
    assert.equal(o6?.placements.length, 2, "each distinct decoration once");
    assert.match(o6?.note ?? "", /Not every line has every decoration/);
    ok("lines with different decorations keep each decoration once, and the note says which line has which");

    // ----- the price paid is never re-worked; the register and the email proof are not for these -----
    const before = (await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } })).quoteCents;
    await addLineFor(A.user, o1.id, form({ description: "Extra tee", qty: "1", garment: "5.00" }));
    assert.equal(await db.decorLine.count({ where: { orderId: o1.id } }), 2, "the line was added");
    assert.equal((await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } })).quoteCents, before, "a change to the order does not move what the customer paid");
    await db.decorOrder.update({ where: { id: o1.id }, data: { status: "READY" } });
    await assert.rejects(() => collectOrderFor(A.user, o1.id, form({ method: "CASH" })), /paid on MakerFoundry/);
    await db.decorOrder.update({ where: { id: o1.id }, data: { status: "QUOTED" } });
    await assert.rejects(() => sendProofFor(A.user, o1.id, { email: true, sms: false, note: null }), /through MakerFoundry|no customer|marketing|Marketing/i);
    ok("the paid price stays; collecting at the register and the email proof are not available for an online order");

    // ----- a body with a customer's email is skipped, with the reason, and makes no order -----
    const leaky = orderBody(art);
    leaky.customer.email = "pat@example.com";
    const count = (await orders(A.shopId)).length;
    hub.put(A.shopId, { type: "order.placed", conversation: "mf-8f3a0007", seq: 1, body: leaky });
    await syncShop(A.shopId);
    assert.equal((await orders(A.shopId)).length, count);
    assert.match((await db.syncIn.findFirstOrThrow({ where: { shopId: A.shopId, conversation: "mf-8f3a0007" } })).error ?? "", /personal_contact/);
    ok("an order body holding a customer's contact details is skipped and makes no order");

    // ----- one company's orders are its own -----
    hub.files.set(sha(art), art);
    await send(B, "mf-8f3a0001", orderBody(art)); // the same reference at another shop is another order
    assert.equal((await orders(B.shopId)).length, 1);
    assert.equal((await orders(A.shopId)).filter((o) => o.onlineRef === "mf-8f3a0001").length, 1);
    await expectNotFound("B reads A's order", async () => (await db.decorOrder.findFirst({ where: { id: o1.id, shopId: B.shopId } })) ?? null);
    ok("two companies are separate, even for the same order reference");
    console.log(`online-intake: ${steps} steps ok`);
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
