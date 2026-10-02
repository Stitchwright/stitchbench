// Partner pickup runs (scheduling-messaging-design.md 15.9 acceptance 2). Pure: canDo for every status x side x action,
// planOutcome. DB: two companies on this install linked as repair / retail; messages relayed by reading PartnerOutbox
// and applying them on the other company with applyRun; the two flows (a machine going, a fixed one coming back), replays,
// a third link's pickup.done, a plan from the non-owner, an old DONE, pushFeatures once, cancelJob on a collected job.
//   npm run check scripts/checks/partner-runs.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { hookContext } from "@/lib/notices/context";
import { applyRun, pushFeatures, type JobEvent } from "@/lib/partners";
import { canDo, planOutcome, type RunAction, type RunState, type Side } from "@/lib/partner-runs";
import { cancelRunAs, defaultStart, okRunAs, proposeRunAs, recordRunAs, rideJobs } from "@/lib/partner-run-actions";
import { zonedTime } from "@/lib/zoned";
import { checkShop, cleanup, clearKick, linkPair, messagingFor, withSink, type CheckShop } from "./lib";

const NY = "America/New_York";
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
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

/** The partner's side of a link row (what applyRun gets as `from`). */
const partnerSideOf = (side: string): Side => (side === "repair" ? "retail" : "repair");

/** Relays every unsent run message of `from` on `linkId` to `to`, applying each one as the hub would; returns how many. */
async function relay(from: CheckShop, to: CheckShop, linkId: string, o: { twice?: boolean; at?: Date } = {}): Promise<number> {
  const rows = await db.partnerOutbox.findMany({ where: { shopId: from.shopId, linkId, sentAt: null, type: { startsWith: "pickup." } }, orderBy: { createdAt: "asc" } });
  const link = await db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: to.shopId, id: linkId } } });
  const fromLink = await db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: from.shopId, id: linkId } } });
  for (const r of rows) {
    const d = r.data as Record<string, unknown>;
    const at = o.at ?? (d.at ? new Date(String(d.at)) : new Date());
    const ctx = await hookContext(to.shopId);
    for (let i = 0; i < (o.twice ? 2 : 1); i++) {
      await db.$transaction((tx) => applyRun(tx, to.shopId, link, fromLink.side as Side, r.type, d, at, ctx), { timeout: 30_000 });
    }
    await db.partnerOutbox.update({ where: { id: r.id }, data: { sentAt: new Date() } });
  }
  clearKick();
  return rows.length;
}

async function customer(shopId: string) {
  return db.customer.create({ data: { shopId, name: `Cust ${uniq()}`, kind: "RETAIL", notifyBy: "email", email: `c-${uniq()}@a.test` }, select: { id: true } });
}

/** A partner job on both sides: the sewing shop's retail row and the repair shop's row with a ticket. */
async function pairJob(retail: CheckShop, repair: CheckShop, linkId: string, o: { retailStatus: string; ticketStatus: string; backAt?: Date | null }) {
  const id = `chkjob${crypto.randomBytes(8).toString("hex")}`;
  const cust = await customer(retail.shopId);
  const tag = String(100 + n++);
  await db.repairJob.create({ data: { id, shopId: retail.shopId, linkId, side: "retail", tag, status: o.retailStatus, customerId: cust.id, customerName: "Mary S.", brand: "Bernina", model: "B770", backAt: o.backAt ?? null } });
  const model = `B${uniq()}`;
  const m = await db.machine.create({ data: { shopId: repair.shopId, brand: "Bernina", model, modelKey: model.toUpperCase() } });
  const t = await db.ticket.create({ data: { shopId: repair.shopId, number: 9000 + n++, machineId: m.id, status: o.ticketStatus as never, jobType: "BENCH" } });
  await db.repairJob.create({ data: { id, shopId: repair.shopId, linkId, side: "repair", tag, status: o.retailStatus, customerName: "Mary S.", brand: "Bernina", model: "B770", ticketId: t.id } });
  return { id, ticketId: t.id, customerId: cust.id, tag };
}

function pureChecks() {
  const sides: Side[] = ["repair", "retail"];
  const actions: RunAction[] = ["change", "ok", "cancel", "record"];
  const mk = (over: Partial<RunState>): RunState => ({ status: "SCHEDULED", ownerSide: "retail", rev: 2, okRev: null, collectedAt: null, deliveredAt: null, ...over });
  // every status x side x action
  for (const status of ["SCHEDULED", "CANCELLED", "DONE"] as const) {
    for (const side of sides) {
      for (const action of actions) {
        const r = canDo(mk({ status }), side, action, "Fix-It");
        const owner = side === "retail";
        let want: boolean;
        if (status === "SCHEDULED") want = action === "change" ? owner : action === "ok" ? !owner : true;
        else if (status === "CANCELLED") want = false;
        else want = action === "record"; // DONE: the other side may still record what it received
        assert.equal(r === null, want, `${status} ${side} ${action}: ${r}`);
      }
    }
  }
  assert.equal(canDo(mk({}), "repair", "change", "Fix-It"), "Only Fix-It, who scheduled it, can change this run. Cancel it with a note instead.");
  assert.equal(canDo(mk({ okRev: 2 }), "repair", "ok"), "You've OK'd it already.");
  assert.equal(canDo(mk({ okRev: 1 }), "repair", "ok"), null, "an OK of an older plan doesn't count");
  assert.equal(canDo(mk({ status: "DONE" }), "retail", "cancel"), "This run is done.");
  assert.equal(canDo(mk({ status: "DONE", collectedAt: "x" }), "repair", "record"), "You've recorded this run already.");
  assert.equal(canDo(mk({ status: "DONE", collectedAt: "x" }), "retail", "record"), null, "the other list is still open");
  assert.equal(canDo(null, "retail", "ok"), "Run not found.");
  const plan = { id: "r", rev: 3, ownerSide: "retail" as Side, startsAt: "2027-03-02T15:00:00Z", endsAt: null, driver: "repair" as Side, collect: [], deliver: [], note: null, name: "x", at: "2027-03-01T15:00:00Z" };
  assert.equal(planOutcome(null, plan, "retail"), "create");
  assert.equal(planOutcome(null, plan, "repair"), "ignore", "a plan from the non-owner");
  assert.equal(planOutcome(mk({ rev: 2 }), plan, "retail"), "update");
  assert.equal(planOutcome(mk({ rev: 3 }), plan, "retail"), "ignore", "the same rev again");
  assert.equal(planOutcome(mk({ rev: 4 }), plan, "retail"), "ignore", "an older rev");
  assert.equal(planOutcome(mk({ status: "DONE", rev: 1 }), plan, "retail"), "ignore", "a plan for a DONE run");
  assert.equal(planOutcome(mk({ ownerSide: "repair", rev: 1 }), plan, "retail"), "ignore", "a run the other side owns");
  ok("canDo for every status x side x action; planOutcome: non-owner, same or older rev, DONE run, another owner -> ignored");
}

async function main() {
  const t0 = Date.now();
  try {
    pureChecks();
    await withSink();
    const retail = await checkShop({ retail: true, modules: ["scheduling", "marketing"], tz: NY });
    await messagingFor(retail.shopId, { email: true });
    const repair = await checkShop({ repair: true, modules: [], tz: NY });
    const linkId = await linkPair(repair.shopId, retail.shopId);
    await db.partnerLink.updateMany({ where: { id: linkId }, data: { features: ["pickup"] } });
    const retailLink = await db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: retail.shopId, id: linkId } } });
    void partnerSideOf;

    // defaultStart: the partnership's pickup day
    assert.equal(zonedTime("2027-03-02", 600, NY).getTime(), defaultStart("Tuesday", NY, new Date("2027-02-25T15:00:00Z")).getTime(), "the next Tuesday at 10:00");
    assert.equal(zonedTime("2027-02-26", 600, NY).getTime(), defaultStart(null, NY, new Date("2027-02-25T15:00:00Z")).getTime(), "no day: tomorrow at 10:00");
    ok("defaultStart: the next pickup day, else tomorrow, 10:00 shop time");

    // ---- flow 1: a machine waiting at the sewing shop goes to the repair shop
    const going = await pairJob(retail, repair, linkId, { retailStatus: "AT_SHOP_AWAITING_PICKUP", ticketStatus: "AT_SHOP_AWAITING_PICKUP" });
    const ride = await rideJobs(retail.shopId, retailLink);
    assert.deepEqual(ride.collect.map((j) => j.id), [going.id]);
    assert.deepEqual(ride.deliver, []);
    const runId = await proposeRunAs(user(retail), linkId, fd({ date: "2027-03-02", start: "10:00", end: "11:00", driver: "repair", collect: [going.id], note: "Side door please" }));
    clearKick();
    let mine = await db.partnerRun.findUniqueOrThrow({ where: { shopId_id: { shopId: retail.shopId, id: runId } } });
    assert.equal(mine.ownerSide, "retail");
    assert.equal(mine.rev, 1);
    await expectError("the same job twice", () => proposeRunAs(user(retail), linkId, fd({ date: "2027-03-03", start: "10:00", driver: "repair", collect: [going.id] })), /is already on the run on Tue, Mar 2\.$/);
    // The repair shop (no Scheduling) receives the plan, OKs it, records what the driver took.
    assert.equal(await relay(retail, repair, linkId), 1);
    let theirs = await db.partnerRun.findUnique({ where: { shopId_id: { shopId: repair.shopId, id: runId } } });
    assert.ok(theirs && theirs.status === "SCHEDULED" && theirs.ownerSide === "retail" && theirs.collect[0] === going.id && theirs.note === "Side door please", "the plan arrived");
    await expectError("the repair shop can't change it", () => cancelRunAs(user(repair), linkId, runId, fd({})), /^Say why, so Check .* knows\.$/);
    await okRunAs(user(repair), linkId, runId);
    clearKick();
    await expectError("OK twice", () => okRunAs(user(repair), linkId, runId), /^You've OK'd it already\.$/);
    assert.equal(await relay(repair, retail, linkId, { twice: true }), 1);
    mine = await db.partnerRun.findUniqueOrThrow({ where: { shopId_id: { shopId: retail.shopId, id: runId } } });
    assert.equal(mine.okRev, 1, "the OK reached the sewing shop (applied twice: still rev 1)");
    await recordRunAs(user(repair), linkId, runId, fd({ jobIds: [going.id] }));
    clearKick();
    assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: going.ticketId } })).status, "IN_TRUCK", "the repair shop's ticket is in the truck");
    theirs = await db.partnerRun.findUniqueOrThrow({ where: { shopId_id: { shopId: repair.shopId, id: runId } } });
    assert.equal(theirs.status, "DONE");
    assert.deepEqual(theirs.collected, [going.id]);
    await expectError("record twice", () => recordRunAs(user(repair), linkId, runId, fd({ jobIds: [going.id] })), /^You've recorded this run already\.$/);
    assert.equal(await relay(repair, retail, linkId, { twice: true }), 1);
    mine = await db.partnerRun.findUniqueOrThrow({ where: { shopId_id: { shopId: retail.shopId, id: runId } } });
    assert.deepEqual(mine.collected, [going.id]);
    assert.ok(mine.collectedAt);
    const retailJob = await db.repairJob.findUniqueOrThrow({ where: { shopId_id: { shopId: retail.shopId, id: going.id } } });
    assert.equal(retailJob.status, "AT_SHOP_AWAITING_PICKUP", "the sewing shop's status waits for the repair shop's job.update");
    assert.equal(((retailJob.events as JobEvent[]) ?? []).filter((e) => /Handed to the driver/.test(e.note ?? "")).length, 1, "one 'Handed to the driver' line, although the message was applied twice");
    ok("flow 1: the sewing shop schedules, the repair shop (no Scheduling) OKs and records the pickup; the ticket is IN_TRUCK, the job says handed to the driver; replays change nothing");

    // ---- cancelJob on a collected job is refused (the retail side)
    // cancelJob needs a session; the rule it applies is checked directly:
    const taken = await db.partnerRun.findFirst({ where: { shopId: retail.shopId, linkId, collected: { has: going.id } } });
    assert.ok(taken, "the run that took it is findable from the job id (what cancelJob checks)");
    ok("a job in a run's collected list is found (cancelJob refuses it: 'It went to the repair shop on the run of ...')");

    // ---- flow 2: a fixed machine comes back; the sewing shop records it delivered
    const back = await pairJob(retail, repair, linkId, { retailStatus: "READY_IN_TRUCK", ticketStatus: "READY_IN_TRUCK" });
    const ride2 = await rideJobs(retail.shopId, retailLink);
    assert.deepEqual(ride2.deliver.map((j) => j.id), [back.id]);
    const run2 = await proposeRunAs(user(retail), linkId, fd({ date: "2027-03-05", start: "14:00", driver: "retail", deliver: [back.id] }));
    clearKick();
    assert.equal(await relay(retail, repair, linkId), 1);
    await recordRunAs(user(retail), linkId, run2, fd({ jobIds: [back.id] }));
    clearKick();
    const retailBack = await db.repairJob.findUniqueOrThrow({ where: { shopId_id: { shopId: retail.shopId, id: back.id } } });
    assert.ok(retailBack.backAt, "back at the counter");
    const notices = await db.outMessage.findMany({ where: { shopId: retail.shopId, repairJobId: back.id, kind: "ready" } });
    assert.equal(notices.length, 1, "one ready notice queued (Marketing on)");
    assert.equal(await relay(retail, repair, linkId, { twice: true }), 1);
    assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: back.ticketId } })).status, "READY_FOR_PICKUP", "the repair shop's ticket moved off 'in truck'");
    const theirs2 = await db.partnerRun.findUniqueOrThrow({ where: { shopId_id: { shopId: repair.shopId, id: run2 } } });
    assert.equal(theirs2.status, "DONE");
    assert.deepEqual(theirs2.delivered, [back.id]);
    ok("flow 2: a fixed machine comes back; the sewing shop records it: backAt, one ready notice; the repair ticket goes READY_FOR_PICKUP; applied twice, no change");

    // ---- a third company's link naming these job ids changes nothing; a plan from the non-owner is ignored
    const stranger = await checkShop({ retail: true, modules: [] });
    const otherLink = await linkPair(repair.shopId, stranger.shopId);
    const repairOther = await db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: repair.shopId, id: otherLink } } });
    const before = await db.ticket.findUniqueOrThrow({ where: { id: going.ticketId } });
    const ctx = await hookContext(repair.shopId);
    await db.$transaction((tx) => applyRun(tx, repair.shopId, repairOther, "retail", "pickup.plan", { id: "run-x", rev: 1, ownerSide: "retail", startsAt: "2027-03-02T15:00:00Z", collect: [], deliver: [going.id, back.id], name: "x", at: new Date().toISOString() }, new Date(), ctx));
    await db.$transaction((tx) => applyRun(tx, repair.shopId, repairOther, "retail", "pickup.done", { id: "run-x", side: "retail", list: [going.id, back.id], name: "x", at: new Date().toISOString() }, new Date(), ctx));
    assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: going.ticketId } })).status, before.status, "another partnership's run can't touch these jobs");
    const repairLink = await db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: repair.shopId, id: linkId } } });
    await db.$transaction((tx) => applyRun(tx, repair.shopId, repairLink, "retail", "pickup.plan", { id: runId, rev: 9, ownerSide: "repair", startsAt: "2027-03-02T15:00:00Z", collect: [], deliver: [], name: "x", at: new Date().toISOString() }, new Date(), ctx));
    assert.equal((await db.partnerRun.findUniqueOrThrow({ where: { shopId_id: { shopId: repair.shopId, id: runId } } })).rev, 1, "a plan claiming the other owner is ignored");
    ok("a third company's run naming these job ids changes nothing; a plan from the non-owner side is ignored");

    // ---- a DONE whose `at` is 30 days old still applies
    const old = await pairJob(retail, repair, linkId, { retailStatus: "AT_SHOP_AWAITING_PICKUP", ticketStatus: "AT_SHOP_AWAITING_PICKUP" });
    const at30 = new Date(Date.now() - 30 * 86_400_000);
    const start30 = new Date(at30.getTime() + 3_600_000);
    await db.$transaction((tx) => applyRun(tx, retail.shopId, retailLink, "repair", "pickup.plan", { id: "run-old", rev: 1, ownerSide: "repair", startsAt: start30.toISOString(), collect: [old.id], deliver: [], name: "x", at: at30.toISOString() }, at30, ctx));
    await db.$transaction((tx) => applyRun(tx, retail.shopId, retailLink, "repair", "pickup.done", { id: "run-old", side: "repair", list: [old.id], name: "x", at: at30.toISOString() }, at30, ctx));
    const oldRun = await db.partnerRun.findUniqueOrThrow({ where: { shopId_id: { shopId: retail.shopId, id: "run-old" } } });
    assert.equal(oldRun.status, "DONE");
    assert.equal(oldRun.collectedAt?.getTime(), at30.getTime());
    ok("a plan and a DONE whose `at` is 30 days old still apply (checked against their own time)");

    // ---- pushFeatures: caps.update once, not again while unchanged
    await db.partnerOutbox.deleteMany({ where: { shopId: { in: [retail.shopId, repair.shopId] }, type: "caps.update" } });
    await db.partnerLink.updateMany({ where: { id: linkId }, data: { featuresHash: null } });
    await pushFeatures();
    const sent1 = await db.partnerOutbox.count({ where: { shopId: retail.shopId, linkId, type: "caps.update" } });
    assert.equal(sent1, 1);
    await pushFeatures();
    assert.equal(await db.partnerOutbox.count({ where: { shopId: retail.shopId, linkId, type: "caps.update" } }), 1, "not sent again while unchanged");
    ok("pushFeatures sends caps.update once per link and not again while unchanged");

    // ---- Scheduling off: scheduling refused; OK / cancel / record still work (checked above for the repair shop)
    await expectError("Scheduling off", () => proposeRunAs(user(repair), linkId, fd({ date: "2027-03-09", start: "10:00", driver: "repair", collect: [] })), /./);
    const older = await checkShop({ retail: true, modules: ["scheduling"] });
    const olderLink = await linkPair(repair.shopId, older.shopId);
    await db.partnerLink.updateMany({ where: { id: olderLink, shopId: older.shopId }, data: { features: [] } });
    await expectError("partner can't take runs", () => proposeRunAs(user(older), olderLink, fd({ date: "2027-03-09", start: "10:00", driver: "repair", collect: [] })), /program is an older version that can't take runs yet/);
    ok("without Scheduling a run can't be scheduled; a partner without the feature is told to update");

    console.log(`partner-runs.check: ${steps} groups passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

void (null as unknown as Prisma.InputJsonValue);
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
