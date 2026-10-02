// The cross-module gate points (modules-design.md 12.4 and package modules-crossover), with a throwaway company that
// has Vac Shop and Marketing on: the bags_due copy, a queued bags-due message cancelled after "Stop reminders", an
// install's estimate approved by link becoming Booked, what still works after Vac Shop ends (a pre-lapse estimate
// approval, closing out, the refusals), {machine} on installs, the install on the calendar, and service due's skip.
//   npm run check scripts/checks/modules-crossover.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { calendarItems } from "@/lib/calendar";
import { canWorkOn, requireEquipment } from "@/lib/equipment/gate";
import { usableKind } from "@/lib/equipment/shop";
import { answerByToken, recordEstimateAnswerAs, sendEstimateAs } from "@/lib/estimate-links";
import { modelKey } from "@/lib/format";
import { unseal } from "@/lib/messaging/secrets";
import { machinesDue } from "@/lib/messaging/service-due";
import { DEFAULT_TEMPLATES, renderKind } from "@/lib/messaging/templates";
import { loadModules, requireModule } from "@/lib/modules";
import { hookContext } from "@/lib/notices/context";
import { stillWanted } from "@/lib/notices/hooks";
import { ticketVars } from "@/lib/notices/vars";
import type { CurrentUser } from "@/lib/session";
import { changeTicketStatus } from "@/lib/ticket-status";
import { sendBagRemindersFor, stopBagsFor } from "@/lib/vac/bags-due";
import { createSiteJob } from "@/lib/vac/installs";
import { addDays, dayStart, ymdOf } from "@/lib/zoned";
import { checkShop, cleanup, clearKick, messagingFor, withSink, type CheckShop } from "./lib";

const NY = "America/New_York";
const DAY = 86_400_000;
const BASE = "http://127.0.0.1:39997";
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;

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

let n = 7000;
/** A vacuum ticket of the company, waiting for the customer's OK (or another status), with one $100 line. */
async function vacTicket(shopId: string, customerId: string, status: "WAITING_CUSTOMER_OK" | "ON_BENCH" | "COLLECTED", o: { intakeAt?: Date; closedAt?: Date } = {}) {
  const m = await db.machine.create({ data: { shopId, customerId, brand: "Miele", model: "C3", modelKey: modelKey("C3"), equipment: "VACUUM", kind: "vacuum", details: { bagged: "Bagged" } } });
  return db.ticket.create({
    data: { shopId, number: n++, status, machineId: m.id, customerId, taxRatePct: 0, intakeAt: o.intakeAt, closedAt: o.closedAt, lines: { create: [{ kind: "SERVICE", description: "Tune-up", qty: 1, unitPriceCents: 10000, taxable: true }] } },
  });
}

async function main() {
  const prior = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = BASE;
  await withSink();
  const a = await checkShop({ retail: true, repair: true, modules: ["vac", "marketing"] });
  try {
    await messagingFor(a.shopId, { email: true });
    const shopId = a.shopId;
    const cust = await db.customer.create({ data: { shopId, name: "Cross Over", email: "cross@example.test", phone: "555-0110", notifyBy: "email", address: "7 Pine St" } });

    // 1. The bags_due copy fits right after a vacuum sale.
    for (const k of ["bags_due.sms", "bags_due.email"]) assert.doesNotMatch(DEFAULT_TEMPLATES[k], /months since/, k);
    const r = renderKind({ templates: {} }, "bags_due", "sms", { first_name: "Pat", name: "Pat", shop_name: "S", shop_phone: "555", machine: "Hoover UH70120", months: "6", bag_line: " We have Type Y in stock." });
    assert.match(r.body, /time for new bags for your Hoover UH70120\? We have Type Y in stock\./);
    ok("the bags_due default text no longer says 'months since'");

    // 2. A queued bags-due message is cancelled by stillWanted after "Stop reminders".
    const vac = await db.machine.create({ data: { shopId, customerId: cust.id, brand: "Hoover", model: "UH70120", modelKey: "UH70120", equipment: "VACUUM", kind: "vacuum", details: { bagged: "Bagged", bagType: "Type Y" } } });
    await db.stockUnit.create({ data: { shopId, machineId: vac.id, status: "SOLD", condition: "NEW", soldAt: new Date(Date.now() - 200 * DAY), priceCents: 29900, soldNetCents: 29900 } });
    const sent = await sendBagRemindersFor(user(a));
    assert.equal(sent.queued, 1);
    const row = await db.outMessage.findFirstOrThrow({ where: { shopId, kind: "bags_due" } });
    assert.equal(await stillWanted(row), null);
    await stopBagsFor(user(a), vac.id);
    assert.equal(await stillWanted(row), "Reminders stopped");
    ok("a queued bags_due message: still wanted, then cancelled by stillWanted after Stop reminders");

    // 3. An install's estimate approved by link: Quote sent -> Booked (not In progress).
    const install = await db.$transaction((tx) =>
      createSiteJob(tx, { shopId, userId: a.user.id, customerId: cust.id, address: "7 Pine St", startsAt: dayStart(addDays(ymdOf(new Date(), NY), 1), NY), endsAt: new Date(dayStart(addDays(ymdOf(new Date(), NY), 1), NY).getTime() + 7_200_000), contactName: null, contactPhone: null, accessNotes: null, quoteFirst: true, unit: null, serviceItemId: null, notes: null }),
    );
    await db.ticketLine.create({ data: { ticketId: install.ticketId, kind: "LABOR", description: "Install, 6 hours", qty: 6, unitPriceCents: 9500, taxable: false } });
    await sendEstimateAs(user(a), "ticket", install.ticketId, { email: true, sms: false, note: null });
    const link = await db.estimateLink.findFirstOrThrow({ where: { shopId, ticketId: install.ticketId } });
    const token = unseal(link.tokenSealed, shopId, `estimateToken:${link.id}`);
    assert.ok(token, "the link's token opens");
    assert.equal(await answerByToken(token.plain, "APPROVED", null, "check"), "ok");
    const t3 = await db.ticket.findUniqueOrThrow({ where: { id: install.ticketId } });
    assert.equal(t3.status, "AT_SHOP_AWAITING_PICKUP");
    assert.equal(t3.estimateAnswer, "APPROVED");
    assert.equal(t3.approvedCents, 57000);
    ok("approving an install's estimate by link moves it to Booked (AT_SHOP_AWAITING_PICKUP) with the approved amount");

    // 6. {machine} on an install.
    const v = await ticketVars(db, install.ticketId, shopId);
    assert.equal(v?.vars.machine, "central vac install");
    assert.equal(v?.jobType, "SITE");
    ok("ticketVars of an install gives machine 'central vac install'");

    // 7. The install is on the calendar's day.
    const day = dayStart(addDays(ymdOf(new Date(), NY), 1), NY);
    const items = await calendarItems(shopId, day, new Date(day.getTime() + DAY), { shifts: false });
    const inst = items.find((i) => i.kind === "install");
    assert.ok(inst && inst.href === `/tickets/${install.ticketId}` && inst.sub === "7 Pine St");
    ok("calendarItems for the install's day includes an install item linking to its ticket");

    // 8. Service due: a vacuum serviced 13 months ago is due, with its equipment, so the scheduler can ask the gate.
    const old = await vacTicket(shopId, cust.id, "COLLECTED", { intakeAt: new Date(Date.now() - 400 * DAY), closedAt: new Date(Date.now() - 395 * DAY) });
    const due = await machinesDue(shopId, 12, new Date());
    const dueVac = due.find((m) => m.machineId === old.machineId);
    assert.ok(dueVac && dueVac.equipment === "VACUUM");
    assert.equal(await canWorkOn(shopId, "VACUUM"), true);

    // 4-5. Vac Shop ends: a pre-lapse ticket's approval still moves it to the bench; closing out works; new work is refused.
    const waiting = await vacTicket(shopId, cust.id, "WAITING_CUSTOMER_OK", { intakeAt: new Date(Date.now() - 2 * DAY) });
    const open = await vacTicket(shopId, cust.id, "ON_BENCH", { intakeAt: new Date(Date.now() - 2 * DAY) });
    const closed = await vacTicket(shopId, cust.id, "COLLECTED", { intakeAt: new Date(Date.now() - 2 * DAY), closedAt: new Date(Date.now() - DAY) });
    await db.moduleGrant.create({ data: { shopId, module: "vac", mode: "off", byEmail: "check@stitchbench.test" } });
    assert.equal((await loadModules(shopId)).states.vac.status, "lapsed");
    await recordEstimateAnswerAs(user(a), "ticket", waiting.id, { answer: "APPROVED", via: "phone", note: null });
    assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: waiting.id } })).status, "ON_BENCH");
    await expectError("sendEstimate on a collected vacuum ticket", () => sendEstimateAs(user(a), "ticket", closed.id, { email: true, sms: false, note: null }), /switched off|ended on/);
    // Closing out an open pre-lapse ticket: the action's ownTicket(..., "close") skips the work gate, and the status change itself goes through.
    const ctx = await hookContext(shopId, a.user.name);
    const tOpen = await db.ticket.findUniqueOrThrow({ where: { id: open.id } });
    const changed = await db.$transaction((tx) => changeTicketStatus(tx, tOpen, "COLLECTED", new Date(), 90, ctx));
    assert.equal(changed.changed, true);
    assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: open.id } })).status, "COLLECTED");
    await expectError("work on it once collected", () => requireEquipment(user(a), "VACUUM", { ticket: { intakeAt: tOpen.intakeAt, status: "COLLECTED" }, closing: true }), /switched off|ended on/);
    await expectError("a new vacuum check-in", () => requireModule(user(a), "vac"), /switched off|ended on/);
    assert.equal(await usableKind(shopId, "vacuum"), null);
    assert.equal(await canWorkOn(shopId, "VACUUM"), false, "service due's scheduler skips vacuums now (canWorkOn)");
    // A new quote after the end stays where it is when approved: the answer is recorded, the status isn't moved.
    const late = await vacTicket(shopId, cust.id, "WAITING_CUSTOMER_OK");
    await recordEstimateAnswerAs(user(a), "ticket", late.id, { answer: "APPROVED", via: "phone", note: null });
    const tLate = await db.ticket.findUniqueOrThrow({ where: { id: late.id } });
    assert.equal(tLate.status, "WAITING_CUSTOMER_OK");
    assert.equal(tLate.estimateAnswer, "APPROVED");
    ok("after Vac Shop ends: a pre-lapse approval moves the ticket to the bench, a collected ticket can't be sent an estimate, closing out works, new work is refused, a post-lapse approval records the answer only");
  } finally {
    clearKick();
    if (prior === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = prior;
    await cleanup();
  }
  console.log(`modules-crossover.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
