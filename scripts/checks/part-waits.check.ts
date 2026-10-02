// Parts a ticket is waiting for (online-and-parts-design.md section 1, package parts-in): recording a wait (a stocked
// part by number or a description) moves the ticket to Waiting on parts; receiving queues one parts_in message per
// ticket naming every part received together, marks only queued waits as noticed, and puts the ticket back on the
// bench when asked and nothing else is on order; without Marketing nothing is sent; reopen within the hour cancels
// the queued message; cancel; the worker's still-wanted reasons; the tenant section.
//   npm run check scripts/checks/part-waits.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { modelKey } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { addWaitFor, cancelWaitFor, openWaits, partsInStillWanted, partsWords, receiveWaitsFor, reopenWaitFor, waitsForTicket } from "@/lib/part-waits";
import { stillWanted } from "@/lib/notices/hooks";
import { checkShop, cleanup, clearKick, messagingFor, withSink, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

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

let n = 8000;
async function ticket(shopId: string, customerId: string | null, status: "ON_BENCH" | "WAITING_PARTS" | "COLLECTED" = "ON_BENCH") {
  const m = await db.machine.create({ data: { shopId, customerId, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
  return db.ticket.create({ data: { shopId, number: n++, status, machineId: m.id, customerId, intake: {} } });
}
const status = async (id: string) => (await db.ticket.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
const messages = (shopId: string, ticketId: string) => db.outMessage.findMany({ where: { shopId, ticketId, kind: "parts_in" }, orderBy: { createdAt: "asc" } });

async function main() {
  await withSink();
  const a = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
  const b = await checkShop({ repair: true, modules: ["marketing"] });
  const plain = await checkShop({ repair: true }); // no Marketing
  try {
    await messagingFor(a.shopId, { email: true });
    await messagingFor(b.shopId, { email: true });
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Wendy Waits", email: "wendy@example.test", phone: "555-0120", notifyBy: "email" } });
    const bobbin = await db.part.create({ data: { shopId: a.shopId, partNumber: "BC-700", description: "Bobbin case", numberKeys: ["BC700"], supplier: "Sewing Parts Online", qtyOnHand: 0, priceCents: 1600 } });

    // Words.
    assert.equal(partsWords(["a bobbin case"]), "a bobbin case");
    assert.equal(partsWords(["a bobbin case", "a feed dog"]), "a bobbin case and a feed dog");
    assert.equal(partsWords(["x", "y", "z"]), "x, y and z");
    ok("partsWords joins one, two and three parts the way a person would");

    // 1. Recording: by part number (description and supplier come from the part), the ticket goes to Waiting on parts.
    const t1 = await ticket(a.shopId, cust.id);
    const w1 = await addWaitFor(user(a), t1.id, form({ partNumber: "bc-700", qty: "1", markWaiting: "on", expectedOn: "2026-10-09" }));
    let waits = await waitsForTicket(a.shopId, t1.id);
    assert.equal(waits.length, 1);
    assert.ok(waits[0].partId === bobbin.id && waits[0].description === "Bobbin case" && waits[0].supplier === "Sewing Parts Online" && waits[0].expectedOn === "2026-10-09");
    assert.equal(await status(t1.id), "WAITING_PARTS");
    // A second part by description only, for the same ticket; the status stays.
    const w2 = await addWaitFor(user(a), t1.id, form({ description: "Feed dog assembly", qty: "1", supplier: "Janome" }));
    assert.equal((await waitsForTicket(a.shopId, t1.id)).length, 2);
    assert.equal(await status(t1.id), "WAITING_PARTS");
    await expectError("unknown part number", () => addWaitFor(user(a), t1.id, form({ partNumber: "NOPE-1" })), /No part numbered NOPE-1/);
    await expectError("nothing said", () => addWaitFor(user(a), t1.id, form({ qty: "1" })), /Say which part/);
    await expectError("bad quantity", () => addWaitFor(user(a), t1.id, form({ description: "x", qty: "0" })), /Quantity/);
    const closed = await ticket(a.shopId, cust.id, "COLLECTED");
    await expectError("closed ticket", () => addWaitFor(user(a), closed.id, form({ description: "x" })), /closed/);
    ok("a wait by part number fills in the part, its description and supplier; by description alone too; the ticket goes to Waiting on parts; refusals");

    // The on-order list, grouped by supplier; narrowed to one part.
    const all = await openWaits(a.shopId);
    assert.deepEqual(all.map((w) => w.id).sort(), [w1, w2].sort());
    assert.deepEqual((await openWaits(a.shopId, { partId: bobbin.id })).map((w) => w.id), [w1]);
    assert.deepEqual((await openWaits(a.shopId, { supplier: "janome" })).map((w) => w.id), [w2]);
    ok("openWaits lists the company's open waits, narrowed by part or supplier");

    // 2. Receiving one of two: the message names that part; the ticket stays Waiting on parts (the other is still out).
    const r1 = await receiveWaitsFor(user(a), [w1], form({ backOnBench: "on" }));
    assert.equal(r1.received, 1);
    assert.equal(r1.queued, true);
    assert.match(r1.words, /Received it\. The customer hears the part is in\./);
    let msgs = await messages(a.shopId, t1.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].channel, "email");
    assert.equal(msgs[0].status, "QUEUED");
    assert.match(msgs[0].body, /The part we ordered for your Janome MC6700P \(ticket \d+\) came in: Bobbin case\./);
    assert.doesNotMatch(msgs[0].body, /Feed dog/);
    assert.equal(msgs[0].refType, "wait");
    assert.equal(msgs[0].refId, w1);
    assert.equal(await status(t1.id), "WAITING_PARTS", "the feed dog is still on order");
    waits = await waitsForTicket(a.shopId, t1.id);
    assert.ok(waits.find((w) => w.id === w1)!.receivedAt && waits.find((w) => w.id === w1)!.noticedAt && waits.find((w) => w.id === w1)!.receivedBy === a.user.name);
    assert.equal(waits.find((w) => w.id === w2)!.receivedAt, null);
    await expectError("received twice", () => receiveWaitsFor(user(a), [w1]), /already marked received/);
    ok("receiving one part queues one parts_in email naming it; the ticket waits for the other; a second receipt is refused");

    // Still wanted: yes; after "not received after all" the queued message is cancelled and the reason says so.
    assert.equal(await stillWanted(msgs[0]), null);
    await reopenWaitFor(user(a), w1);
    msgs = await messages(a.shopId, t1.id);
    assert.equal(msgs[0].status, "CANCELLED");
    assert.equal(await partsInStillWanted(msgs[0]), "Not received after all");
    assert.equal((await waitsForTicket(a.shopId, t1.id)).find((w) => w.id === w1)!.receivedAt, null);
    await expectError("reopen what isn't received", () => reopenWaitFor(user(a), w1), /isn't marked received/);
    ok("'Not received after all' within the hour reopens the wait and cancels the queued message");

    // 3. Receiving both at once with a done-by date: one message naming both, the ticket back on the bench.
    const r2 = await receiveWaitsFor(user(a), [w1, w2], form({ backOnBench: "on", eta: "2026-10-12" }));
    assert.equal(r2.received, 2);
    msgs = await messages(a.shopId, t1.id);
    const live = msgs.filter((m) => m.status === "QUEUED");
    assert.equal(live.length, 1);
    assert.match(live[0].body, /came in: Bobbin case and Feed dog assembly\. We expect to have it done by Oct 12\./);
    assert.equal(await status(t1.id), "ON_BENCH");
    assert.equal(await stillWanted(live[0]), null);
    ok("receiving both together: one message names both parts and the done-by date; the ticket is back on the bench");

    // A closed ticket's queued message is cancelled by the worker.
    await db.ticket.update({ where: { id: t1.id }, data: { status: "COLLECTED" } });
    assert.equal(await partsInStillWanted(live[0]), "The ticket has closed");
    assert.equal(await partsInStillWanted({ shopId: a.shopId, refType: "wait", refId: "nope", ticketId: t1.id }), "The wait is gone");
    ok("partsInStillWanted: the ticket closed, the wait gone");

    // 4. No address: received and marked, but no message; the words say to call.
    const quiet = await db.customer.create({ data: { shopId: a.shopId, name: "Quiet Quinn", notifyBy: "" } });
    const t2 = await ticket(a.shopId, quiet.id, "WAITING_PARTS");
    const w3 = await addWaitFor(user(a), t2.id, form({ description: "Belt" }));
    const r3 = await receiveWaitsFor(user(a), [w3], form({ backOnBench: "on" }));
    assert.equal(r3.queued, false);
    assert.match(r3.words, /no email or mobile number on file: call them/);
    // A notice to someone with no address leaves a SKIPPED row (the Messages page shows why), nothing to send.
    const skipped = await messages(a.shopId, t2.id);
    assert.deepEqual(skipped.map((m) => m.status), ["SKIPPED"]);
    assert.equal((await waitsForTicket(a.shopId, t2.id))[0].noticedAt, null);
    assert.equal(await status(t2.id), "ON_BENCH");
    ok("a customer with no address: the wait is received, only a SKIPPED row is left, the words say to call, the ticket still goes back on the bench");

    // 5. Without Marketing: recorded and received, nothing sent, "call them".
    const pc = await db.customer.create({ data: { shopId: plain.shopId, name: "Plain Pat", email: "pat@example.test", notifyBy: "email" } });
    const t3 = await ticket(plain.shopId, pc.id);
    const w4 = await addWaitFor(user(plain), t3.id, form({ description: "Motor brushes", markWaiting: "on" }));
    assert.equal(await status(t3.id), "WAITING_PARTS");
    const r4 = await receiveWaitsFor(user(plain), [w4], form({ backOnBench: "on" }));
    assert.equal(r4.queued, false);
    assert.match(r4.words, /Marketing is off, so nothing was sent/);
    assert.equal(await db.outMessage.count({ where: { shopId: plain.shopId } }), 0);
    assert.equal(await status(t3.id), "ON_BENCH");
    ok("without Marketing: the wait list works, nothing is sent, the words say to call");

    // 6. Cancel: closed with the reason; the status is left alone.
    const t4 = await ticket(a.shopId, cust.id, "WAITING_PARTS");
    const w5 = await addWaitFor(user(a), t4.id, form({ description: "Discontinued knob" }));
    await cancelWaitFor(user(a), w5, form({ why: "discontinued" }));
    const c5 = await db.partWait.findUniqueOrThrow({ where: { id: w5 } });
    assert.ok(c5.cancelledAt && /Cancelled: discontinued/.test(c5.note ?? ""));
    assert.equal(await status(t4.id), "WAITING_PARTS");
    assert.equal((await openWaits(a.shopId, { ticketId: t4.id })).length, 0);
    await expectError("cancel twice", () => cancelWaitFor(user(a), w5), /already closed/);
    ok("cancelling a wait closes it with the reason and leaves the ticket's status for staff");

    // 7. Tenant: B with A's ticket and waits.
    const before = await snapshot(a.shopId, ["PartWait", "Ticket", "OutMessage"]);
    await expectNotFound("addWaitFor(B, A's ticket)", () => addWaitFor(user(b), t4.id, form({ description: "x" })));
    await expectError("receiveWaitsFor(B, A's wait)", () => receiveWaitsFor(user(b), [w2]), /aren't waits of this shop|already marked received/);
    await expectError("reopenWaitFor(B, A's wait)", () => reopenWaitFor(user(b), w2), /isn't marked received/);
    await expectError("cancelWaitFor(B, A's wait)", () => cancelWaitFor(user(b), w5), /already closed/);
    assert.deepEqual(await openWaits(b.shopId), []);
    assert.deepEqual(await waitsForTicket(b.shopId, t1.id), []);
    assertUnchanged("tenant", before, await snapshot(a.shopId, ["PartWait", "Ticket", "OutMessage"]));
    ok("tenant: B's calls with A's ticket and waits change nothing of A's");
  } finally {
    clearKick();
    await cleanup();
  }
  console.log(`part-waits.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
