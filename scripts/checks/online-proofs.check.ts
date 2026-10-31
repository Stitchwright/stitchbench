import "dotenv/config";
// Proofs and cancels for an order paid on MakerFoundry (docs/plans/makerfoundry-orders-plan.md package 5; src/lib/shop-orders/proofs.ts):
// the mock-up goes up as a file by the hub's address and is sent as proof N (with `proof_sent`), the customer's answer comes back (approved
// moves the order on, changes keeps it quoted with their words, an answer to an old proof is ignored), the customer's cancel is applied
// before production and only flagged after, the shop's turning an order down tells MakerFoundry and wipes the address, a proof the hub gave
// up on is shown, and nobody sends another company's proof. The hub is a stand-in (scripts/checks/orders-hub.ts).
//   npm run check scripts/checks/online-proofs.check.ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { setOrderStatusFor, turnDownOrderFor } from "@/lib/decor";
import { onlineNotices, sendOnlineProofFor } from "@/lib/shop-orders/proofs";
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
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 3)]);

async function main() {
  const hub = await startOrdersHub();
  const A = await makeCompany("Proofs A", { kind: "retail" });
  const B = await makeCompany("Proofs B", { kind: "retail" });
  try {
    const { grantDevLicense } = await import("../license/dev");
    for (const c of [A, B]) {
      await grantDevLicense(c.shopId, ["decorating"], { from: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) });
      await db.shopOrdersSync.create({ data: { shopId: c.shopId, optedIn: true } });
    }
    hub.files.set(sha(art), art);
    hub.files.set(sha(PNG), PNG);
    const place = async (conv: string, o: { preview?: boolean; ship?: boolean } = {}) => {
      const b = fixture("order.placed.v1.valid.json");
      b.lines[0].decorations[0].art = { file: "logo.dst", size: art.length, sha256: sha(art) };
      if (o.preview !== false) b.preview = { size: PNG.length, sha256: sha(PNG), type: "image/png" };
      else delete b.preview;
      if (!o.ship) {
        b.fulfilment = "pickup";
        delete b.customer.ship_to;
      }
      hub.put(A.shopId, { type: "order.placed", conversation: conv, seq: 1, body: b });
      await syncShop(A.shopId);
      return db.decorOrder.findFirstOrThrow({ where: { shopId: A.shopId, onlineRef: conv } });
    };
    const posted = (type: string, conv: string) => (hub.posted as { type: string; conversation: string; seq: number; body: Record<string, unknown> }[]).filter((p) => p.type === type && p.conversation === conv);
    const flush = async () => {
      await db.syncOut.updateMany({ where: { shopId: A.shopId, sentAt: null, deadAt: null }, data: { nextTryAt: null } });
      await flushOutbox(A.shopId);
    };
    const answer = async (conv: string, seq: number, body: Record<string, unknown>) => {
      hub.put(A.shopId, { type: "proof.answer", conversation: conv, seq, body });
      await syncShop(A.shopId);
    };

    // ----- sending a proof -----
    const o1 = await place("mf-q0001", { ship: true });
    assert.ok((await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } })).mockupData, "the customer's picture is the first mock-up");
    hub.files.delete(sha(PNG)); // the hub has to be given the picture, not find it already there
    const said = await sendOnlineProofFor(A.user, o1.id, "Here is the first proof.");
    assert.match(said, /Proof 1/);
    assert.deepEqual(hub.knobs.putAsks.at(-1), { shop: A.shopId, conversation: "mf-q0001", sha256: sha(PNG), size: PNG.length, kind: "mockup", type: "image/png" });
    assert.ok(hub.files.get(sha(PNG))?.equals(PNG), "the picture is in the hub's storage, byte for byte");
    await flush();
    const ps = posted("proof.sent", "mf-q0001");
    assert.equal(ps.length, 1);
    assert.deepEqual(ps[0].body, { proof: 1, mockup: { size: PNG.length, sha256: sha(PNG), type: "image/png" }, note: "Here is the first proof." });
    assert.equal(posted("order.status", "mf-q0001").at(-1)?.body.status, "proof_sent");
    const after = await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.equal(after.proofNo, 1);
    assert.equal(after.status, "QUOTED");
    ok("a proof goes up as a file, is sent as proof 1 with its note, and the order is reported as proof_sent");

    // ----- a failed upload sends and changes nothing -----
    hub.files.delete(sha(PNG));
    hub.knobs.putFailures = 1;
    const queued = await db.syncOut.count({ where: { shopId: A.shopId } });
    await assert.rejects(() => sendOnlineProofFor(A.user, o1.id, null), /Nothing was sent|didn't take the picture|couldn't be sent/);
    assert.equal((await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } })).proofNo, 1);
    assert.equal(await db.syncOut.count({ where: { shopId: A.shopId } }), queued, "nothing was queued");
    ok("when the picture can't be put with the hub nothing is sent and nothing changes");

    // ----- the customer asks for changes, a second proof goes out -----
    await answer("mf-q0001", 2, { proof: 1, answer: "changes", note: "Make the logo smaller." });
    const ch = await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.equal(ch.status, "QUOTED", "changes keep it quoted");
    assert.equal(ch.proofAnswer, "changes");
    assert.equal(ch.proofNote, "Make the logo smaller.");
    await sendOnlineProofFor(A.user, o1.id, null);
    assert.equal((await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } })).proofNo, 2);
    assert.equal((await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } })).proofAnswer, null, "waiting on proof 2");
    ok("changes keep the order quoted with the customer's words; a second proof clears the answer");

    // ----- an answer to the old proof says nothing about the new one -----
    await answer("mf-q0001", 3, { proof: 1, answer: "approved" });
    const stale = await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.equal(stale.status, "QUOTED");
    assert.equal(stale.proofAnswer, null);
    ok("an answer to an older proof is ignored");

    // ----- approved moves the order on, and MakerFoundry is told -----
    await answer("mf-q0001", 4, { proof: 2, answer: "approved", note: "Looks great" });
    const ap = await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.equal(ap.status, "APPROVED");
    assert.ok(ap.approvedAt);
    await flush();
    assert.equal(posted("order.status", "mf-q0001").at(-1)?.body.status, "approved");
    await assert.rejects(() => sendOnlineProofFor(A.user, o1.id, null), /before it is approved/);
    ok("approved moves the order to approved and tells MakerFoundry; no proof goes after that");

    // ----- the customer cancels: before production the order is cancelled and the address wiped -----
    const o2 = await place("mf-q0002", { ship: true });
    assert.ok(o2.shipTo);
    hub.put(A.shopId, { type: "order.cancel", conversation: "mf-q0002", seq: 2, body: { by: "customer", why: "Changed my mind" } });
    await syncShop(A.shopId);
    const c2 = await db.decorOrder.findUniqueOrThrow({ where: { id: o2.id } });
    assert.equal(c2.status, "CANCELLED");
    assert.match(c2.turnedDownWhy ?? "", /The customer cancelled: Changed my mind/);
    assert.equal(c2.shipTo, null, "the address is no longer needed");
    // ... once in production it is only flagged
    const o3 = await place("mf-q0003");
    await setOrderStatusFor(A.user, o3.id, "APPROVED");
    await setOrderStatusFor(A.user, o3.id, "IN_PRODUCTION");
    hub.put(A.shopId, { type: "order.cancel", conversation: "mf-q0003", seq: 2, body: { by: "customer", why: "Too slow" } });
    await syncShop(A.shopId);
    const c3 = await db.decorOrder.findUniqueOrThrow({ where: { id: o3.id } });
    assert.equal(c3.status, "IN_PRODUCTION", "work already started is the shop's call");
    assert.match(c3.onlineFlag ?? "", /already in production/);
    ok("the customer's cancel is applied before production and only flagged after it");

    // ----- the shop turns an order down / cancels it -----
    const o4 = await place("mf-q0004", { ship: true });
    const td = await turnDownOrderFor(A.user, o4.id, "We can't make that logo.");
    assert.match(td, /refunds them in full/);
    await flush();
    assert.deepEqual(posted("order.cancel", "mf-q0004").map((p) => p.body), [{ by: "shop", why: "We can't make that logo." }]);
    const t4 = await db.decorOrder.findUniqueOrThrow({ where: { id: o4.id } });
    assert.equal(t4.status, "TURNED_DOWN");
    assert.equal(t4.shipTo, null);
    const o5 = await place("mf-q0005");
    await setOrderStatusFor(A.user, o5.id, "CANCELLED");
    await flush();
    assert.equal(posted("order.cancel", "mf-q0005").length, 1);
    assert.equal(posted("order.cancel", "mf-q0005")[0].body.by, "shop");
    ok("turning an order down or cancelling it tells MakerFoundry (it refunds) and wipes the address");

    // ----- back to quoted tells the truth about the proof -----
    const o6 = await place("mf-q0006");
    await sendOnlineProofFor(A.user, o6.id, null);
    await setOrderStatusFor(A.user, o6.id, "APPROVED");
    await setOrderStatusFor(A.user, o6.id, "QUOTED");
    await flush();
    assert.equal(posted("order.status", "mf-q0006").at(-1)?.body.status, "proof_sent", "a proof is still out, unanswered");
    ok("moving an order back to quoted reports proof_sent while a proof is out");

    // ----- a proof the hub gave up on is shown -----
    const lost = await db.syncOut.findFirstOrThrow({ where: { shopId: A.shopId, conversation: "mf-q0006", type: "proof.sent" } });
    hub.put(A.shopId, { from: "hub", type: "message.expired", conversation: "mf-q0006", seq: 1, body: { id: lost.id, type: "proof.sent", conversation: "mf-q0006", reason: "expired" } });
    await syncShop(A.shopId);
    assert.equal((await onlineNotices(A.shopId, "mf-q0006")).proofLost, true);
    assert.equal((await onlineNotices(A.shopId, "mf-q0001")).proofLost, false);
    ok("a proof the hub gave up delivering is shown on the order, to send again");

    // ----- not a MakerFoundry order, not mine, no picture -----
    const plain = await db.decorOrder.create({ data: { shopId: A.shopId, number: 9999, name: "Walk-in", title: "Polos" } });
    await assert.rejects(() => sendOnlineProofFor(A.user, plain.id, null), /didn't come from MakerFoundry/);
    await expectNotFound("B sends A's proof", () => sendOnlineProofFor(B.user, o6.id, null).then(() => true));
    const nopic = await place("mf-q0007", { preview: false });
    await assert.rejects(() => sendOnlineProofFor(A.user, nopic.id, null), /Add the mock-up picture first/);
    ok("only a MakerFoundry order, only its own company, and only with a picture");
    console.log(`online-proofs: ${steps} steps ok`);
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
