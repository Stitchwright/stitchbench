import "dotenv/config";
// The shop's side of StitchHub's v2 queue for MakerFoundry orders (docs/plans/makerfoundry-orders-plan.md package 1; src/lib/shop-orders/):
// hello and the 426 "please update", polling with a stored cursor, storing before acknowledging, dedupe by message id, applying one
// conversation in seq order (a later message waits; a gap is given up on after a day), a shop back after 3 days offline, a restart
// between storing and acknowledging, the outbox (the same id and seq sent again, a refusal for good kept, the order kept), and message.expired.
// The hub is a stand-in with the real hub's routes and shapes (scripts/checks/orders-hub.ts); the bodies are the fixtures shared with StitchHub.
//   npm run check scripts/checks/orders-sync.check.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { registerHandler } from "@/lib/shop-orders/handlers";
import { enqueue } from "@/lib/shop-orders/outbox";
import { applyWaiting, flushOutbox, syncShop } from "@/lib/shop-orders/sync";
import { makeCompany, removeCompany } from "./tenant";
import { startOrdersHub } from "./orders-hub";

const fixture = (n: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/shop-orders", n), "utf8"));
const DAY = 86_400_000;
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

async function main() {
  const hub = await startOrdersHub();
  const A = await makeCompany("Orders sync A", { kind: "retail" });
  const B = await makeCompany("Orders sync B", { kind: "retail" });
  const applied: string[] = [];
  // Stand-ins for the handlers later packages add: they record the order a conversation's messages were applied in.
  registerHandler("order.placed", 1, async (c) => (applied.push(`${c.shopId === A.shopId ? "A" : "B"}:${c.conversation}:${c.seq}:placed`), "applied"));
  registerHandler("proof.answer", 1, async (c) => {
    if (!applied.some((a) => a.startsWith(`${c.shopId === A.shopId ? "A" : "B"}:${c.conversation}:`))) return "defer"; // an answer for an order not here yet
    applied.push(`${c.shopId === A.shopId ? "A" : "B"}:${c.conversation}:${c.seq}:answer`);
    return "applied";
  });
  const placed = () => fixture("order.placed.v1.valid.json");
  const answer = (n = 1) => ({ proof: n, answer: "approved" });
  const run = async (shopId: string) => {
    const r = await syncShop(shopId);
    assert.ok(!("busy" in r), "no other run was going");
    return r;
  };

  try {
    await db.shopOrdersSync.create({ data: { shopId: A.shopId, optedIn: true } });
    await db.shopOrdersSync.create({ data: { shopId: B.shopId, optedIn: true } });

    // ----- hello -----
    await run(A.shopId);
    const h = hub.hellos.at(-1) as { shop: string; app: string; version: string; types: Record<string, number[]> };
    assert.equal(h.shop, A.shopId, "speaks for the company (X-Shop-Ref)");
    assert.equal(h.app, "stitchshop");
    assert.match(h.version, /^\d+\.\d+\.\d+/);
    assert.deepEqual(h.types["order.placed"], [1]);
    assert.ok(!("catalog" in h.types), "only what it understands is listed, not what it sends");
    assert.match(hub.calls.at(-1)?.client ?? "", /^stitchshop\/\d+\.\d+\.\d+/, "X-Client on every call");
    assert.equal(hub.calls.at(-1)?.auth, "Bearer ik_check");
    ok("hello lists what this program understands, with X-Client and X-Shop-Ref");

    // ----- 426: too old -----
    hub.knobs.minClient = "99.0.0";
    await db.shopOrdersSync.update({ where: { shopId: A.shopId }, data: { helloAt: null } });
    const before = hub.calls.length;
    const r426 = await run(A.shopId);
    assert.match(String(r426.skipped), /newer StitchShop/);
    assert.match((await db.shopOrdersSync.findUniqueOrThrow({ where: { shopId: A.shopId } })).upgradeNeeded ?? "", /newer/);
    const callsWhileOld = hub.calls.slice(before).filter((c) => c.path !== "/v2/hello");
    assert.equal(callsWhileOld.length, 0, "nothing else is asked of a hub that said please update");
    hub.knobs.minClient = null;
    await db.shopOrdersSync.update({ where: { shopId: A.shopId }, data: { helloAt: null } });
    await run(A.shopId);
    assert.equal((await db.shopOrdersSync.findUniqueOrThrow({ where: { shopId: A.shopId } })).upgradeNeeded, null, "and it carries on once updated");
    ok("a 426 stops everything but hello and is shown; an update resumes it");

    // ----- offline for 3 days, then everything arrives in order -----
    const t3 = new Date(Date.now() - 3 * DAY);
    const ids = [
      hub.put(A.shopId, { type: "order.placed", conversation: "o-1", seq: 1, body: placed(), createdAt: t3 }),
      hub.put(A.shopId, { type: "order.placed", conversation: "o-2", seq: 1, body: placed(), createdAt: t3 }),
      hub.put(A.shopId, { type: "proof.answer", conversation: "o-1", seq: 2, body: answer(), createdAt: t3 }),
    ];
    hub.put(A.shopId, { type: "order.placed", conversation: "o-lapsed", seq: 1, body: placed(), createdAt: t3, expiresAt: new Date(Date.now() - DAY) }); // the hub gave up on this one
    const r3 = await run(A.shopId);
    assert.equal(r3.polled, 3, "the lapsed one is never offered");
    assert.deepEqual(applied.filter((a) => a.startsWith("A:o-1:")), ["A:o-1:1:placed", "A:o-1:2:answer"], "each order's messages in seq order");
    assert.deepEqual(applied.filter((a) => a.startsWith("A:o-2:")), ["A:o-2:1:placed"]);
    for (const id of ids) assert.equal(hub.stateOf(A.shopId, id), "acked");
    assert.equal(applied.some((a) => a.includes("o-lapsed")), false, "an expired order is never created");
    const cur = (await db.shopOrdersSync.findUniqueOrThrow({ where: { shopId: A.shopId } })).cursor;
    assert.notEqual(cur, "0", "the cursor moved");
    ok("a shop offline for 3 days catches up: all that is still good, in order, acknowledged; the expired one never arrives");

    // ----- duplicate delivery -----
    const dup = hub.put(A.shopId, { type: "order.placed", conversation: "o-3", seq: 1, body: placed() });
    await run(A.shopId);
    hub.replay(A.shopId, dup);
    hub.replay(A.shopId, dup);
    await run(A.shopId);
    assert.equal(applied.filter((a) => a.startsWith("A:o-3:")).length, 1, "applied once");
    assert.equal(await db.syncIn.count({ where: { shopId: A.shopId, messageId: dup } }), 1, "stored once");
    ok("the same message delivered three times is applied once");

    // ----- out of order: seq 3 before seq 2 -----
    hub.put(A.shopId, { type: "order.placed", conversation: "o-4", seq: 1, body: placed() });
    const late = hub.put(A.shopId, { type: "proof.answer", conversation: "o-4", seq: 3, body: answer(2) });
    await run(A.shopId);
    assert.deepEqual(applied.filter((a) => a.startsWith("A:o-4:")), ["A:o-4:1:placed"], "seq 3 waits for seq 2");
    assert.equal((await db.syncIn.findFirstOrThrow({ where: { shopId: A.shopId, messageId: late } })).appliedAt, null);
    assert.equal(hub.stateOf(A.shopId, late), "acked", "but the hub is told it is held here, so it never gives up on it");
    hub.put(A.shopId, { type: "proof.answer", conversation: "o-4", seq: 2, body: answer(1) });
    await run(A.shopId);
    assert.deepEqual(applied.filter((a) => a.startsWith("A:o-4:")), ["A:o-4:1:placed", "A:o-4:2:answer", "A:o-4:3:answer"], "then both, in seq order");
    ok("out-of-order messages are held, acknowledged, and applied in seq order when the gap fills");

    // ----- a gap that never fills is given up on after a day, and shown -----
    hub.put(A.shopId, { type: "order.placed", conversation: "o-5", seq: 1, body: placed() });
    hub.put(A.shopId, { type: "proof.answer", conversation: "o-5", seq: 4, body: answer() });
    await run(A.shopId);
    assert.equal(applied.filter((a) => a.startsWith("A:o-5:")).length, 1);
    await db.syncIn.updateMany({ where: { shopId: A.shopId, conversation: "o-5", seq: 4 }, data: { receivedAt: new Date(Date.now() - 25 * 3600_000) } });
    await applyWaiting(A.shopId);
    assert.equal(applied.filter((a) => a.startsWith("A:o-5:")).length, 2, "applied after a day");
    assert.equal((await db.syncInSeq.findFirstOrThrow({ where: { shopId: A.shopId, conversation: "o-5" } })).gapped, true, "and marked as having a gap");
    ok("a gap older than a day is given up on and marked");

    // ----- a handler that isn't ready defers; the ones after wait; nothing is lost -----
    hub.put(A.shopId, { type: "proof.answer", conversation: "o-6", seq: 1, body: answer() }); // the order hasn't been created yet
    hub.put(A.shopId, { type: "proof.answer", conversation: "o-6", seq: 2, body: answer(2) });
    await run(A.shopId);
    assert.equal(applied.filter((a) => a.startsWith("A:o-6:")).length, 0, "an answer for an order not here yet waits");
    hub.put(A.shopId, { type: "order.placed", conversation: "o-6", seq: 3, body: placed() });
    await db.syncIn.updateMany({ where: { shopId: A.shopId, conversation: "o-6" }, data: { nextTryAt: null } });
    ok("a message whose order isn't here yet defers and blocks nothing outside its conversation");

    // ----- restart between storing and acknowledging -----
    hub.knobs.failAcks = 1;
    const x = hub.put(A.shopId, { type: "order.placed", conversation: "o-7", seq: 1, body: placed() });
    await run(A.shopId).catch(() => {});
    assert.equal((await db.syncIn.findFirstOrThrow({ where: { shopId: A.shopId, messageId: x } })).ackedAt, null, "stored, hub not told");
    assert.notEqual(hub.stateOf(A.shopId, x), "acked");
    await run(A.shopId);
    assert.equal(hub.stateOf(A.shopId, x), "acked", "told on the next run");
    assert.equal(applied.filter((a) => a.startsWith("A:o-7:")).length, 1, "and applied once");
    ok("a failed acknowledgement is repeated next run; the message is neither lost nor applied twice");

    // ----- unknown and bad messages are skipped, with a reason, and don't stop the rest -----
    const unk = hub.put(A.shopId, { type: "order.refund", conversation: "o-8", seq: 1, body: {} });
    const badBody = placed();
    (badBody.customer as Record<string, unknown>).email = "pat@example.com";
    const bad = hub.put(A.shopId, { type: "order.placed", conversation: "o-9", seq: 1, body: badBody });
    hub.put(A.shopId, { type: "order.placed", conversation: "o-10", seq: 1, body: placed() });
    await run(A.shopId);
    const su = await db.syncIn.findFirstOrThrow({ where: { shopId: A.shopId, messageId: unk } });
    const sb = await db.syncIn.findFirstOrThrow({ where: { shopId: A.shopId, messageId: bad } });
    assert.equal(su.result, "skipped");
    assert.match(su.error ?? "", /doesn't know/);
    assert.equal(sb.result, "skipped");
    assert.match(sb.error ?? "", /personal_contact/);
    assert.equal(applied.filter((a) => a.startsWith("A:o-10:")).length, 1, "the next order was applied");
    assert.equal(hub.stateOf(A.shopId, unk), "acked");
    ok("a type this program doesn't know and a body that fails its checks are skipped with the reason; the rest go on");

    // ----- each company's queue is its own -----
    hub.put(B.shopId, { type: "order.placed", conversation: "o-b", seq: 1, body: placed() });
    await run(B.shopId);
    assert.equal(applied.filter((a) => a.startsWith("B:")).length, 1);
    assert.equal(await db.syncIn.count({ where: { shopId: B.shopId } }), 1);
    assert.equal(await db.syncIn.count({ where: { shopId: B.shopId, conversation: { in: ["o-1", "o-2", "o-3"] } } }), 0, "B holds none of A's messages");
    ok("two companies on one install have separate queues, cursors and sequences");

    // ----- the outbox -----
    const sent = await db.$transaction(async (tx) => [await enqueue(tx, A.shopId, { conversation: "o-1", type: "order.status", body: { status: "received" } }), await enqueue(tx, A.shopId, { conversation: "o-1", type: "order.status", body: { status: "approved" } })]);
    assert.deepEqual(sent.map((s) => s.seq), [1, 2], "seq counts per conversation");
    await assert.rejects(() => db.$transaction((tx) => enqueue(tx, A.shopId, { conversation: "o-1", type: "order.status", body: { status: "received", note: "call me on 401 555 0100" } })), /Not queued/, "a body with a phone number is never queued");
    hub.knobs.postStatuses.push({ status: 503, error: "busy" });
    const f1 = await flushOutbox(A.shopId);
    assert.equal(f1.sent, 0, "a busy hub: nothing sent, and nothing after the first one goes first");
    await db.syncOut.updateMany({ where: { shopId: A.shopId }, data: { nextTryAt: null } });
    const f2 = await flushOutbox(A.shopId);
    assert.equal(f2.sent, 2);
    assert.deepEqual((hub.posted as { seq: number; id: string }[]).map((p) => p.seq), [1, 2], "in seq order");
    assert.deepEqual((hub.posted as { id: string }[]).map((p) => p.id), sent.map((s) => s.id), "with the ids they were made with");
    const env = hub.posted[0] as { to: string; type: string; version: number; conversation: string; created_at: string; expires_at: string };
    assert.equal(env.to, "service:makerfoundry");
    assert.ok(Date.parse(env.expires_at) > Date.now());
    assert.equal((await flushOutbox(A.shopId)).sent, 0, "sent once");
    hub.knobs.postStatuses.push({ status: 409, error: "There is no order with that reference", code: "no_such_order" });
    await db.$transaction((tx) => enqueue(tx, A.shopId, { conversation: "o-gone", type: "order.status", body: { status: "ready" } }));
    const f3 = await flushOutbox(A.shopId);
    assert.equal(f3.dead, 1, "refused for good: kept, shown, not retried");
    assert.equal((await flushOutbox(A.shopId)).sent, 0);
    hub.knobs.offline = true;
    await db.$transaction((tx) => enqueue(tx, A.shopId, { conversation: "o-2", type: "order.status", body: { status: "ready" } }));
    assert.equal((await flushOutbox(A.shopId)).sent, 0);
    const waiting = await db.syncOut.findFirstOrThrow({ where: { shopId: A.shopId, conversation: "o-2" } });
    assert.equal(waiting.sentAt, null);
    assert.ok(waiting.nextTryAt, "no connection: kept, tried again later");
    hub.knobs.offline = false;
    Object.assign((globalThis as unknown as { __hubNet: object }).__hubNet, { offlineSince: null, checkedAt: 0, lastOk: Date.now() }); // the program remembers the hub was out of reach for a few seconds
    ok("the outbox keeps the order, sends the same ids and seqs again, keeps a refusal for good, and survives no connection");

    // ----- the hub gave up on a message of ours -----
    hub.put(A.shopId, { from: "hub", type: "message.expired", conversation: "o-1", seq: 1, body: { id: sent[1].id, type: "order.status", conversation: "o-1", reason: "expired" } });
    await run(A.shopId);
    const gone = await db.syncOut.findUniqueOrThrow({ where: { id: sent[1].id } });
    assert.ok(gone.expiredAt);
    assert.equal(gone.expiredWhy, "expired");
    ok("message.expired from the hub is kept on the message it is about");
    console.log(`orders-sync: ${steps} steps ok`);
  } finally {
    await hub.close();
    for (const s of [A, B]) await removeCompany(s.shopId).catch(() => {});
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
