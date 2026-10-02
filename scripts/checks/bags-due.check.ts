// "Bags due" (modules-design.md 10.c′, package vac-bags-due): a bagged unit sold 200 days ago is due with the 180-day
// default; bags bought for it, bags on its repair ticket, bags on a sale with no vacuum picked (one bagged vacuum only),
// snooze, stop, bagless and unanswered vacuums, the one-off send through Marketing (consent, contacted marks, dedupe),
// bagsDueStillWanted's reasons, and the tenant section.
//   npm run check scripts/checks/bags-due.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { modelKey } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { bagsDue, bagsDueCount, bagsDueStillWanted, markCalledFor, saveBagDaysFor, sendBagRemindersFor, snoozeBagsFor, stopBagsFor } from "@/lib/vac/bags-due";
import { checkShop, cleanup, clearKick, messagingFor, withSink, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

const DAY = 86_400_000;
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

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

/** A bagged vacuum owned by the customer, sold here `soldDaysAgo` days ago (null: never sold here). */
async function vacuum(shopId: string, customerId: string, o: { brand?: string; model?: string; serial: string; bagged?: string | null; soldDaysAgo?: number | null }) {
  const details = o.bagged === null ? {} : { bagged: o.bagged ?? "Bagged", bagType: "Type Y" };
  const m = await db.machine.create({ data: { shopId, customerId, brand: o.brand ?? "Hoover", model: o.model ?? "UH70120", modelKey: modelKey(o.model ?? "UH70120"), serial: o.serial, equipment: "VACUUM", kind: "vacuum", details } });
  if (o.soldDaysAgo != null) await db.stockUnit.create({ data: { shopId, machineId: m.id, status: "SOLD", condition: "NEW", soldAt: daysAgo(o.soldDaysAgo), priceCents: 29900, soldNetCents: 29900 } });
  return m;
}

let saleNo = 5000;
/** A completed sale with one line (bags or not), for a vacuum or with none picked. */
async function sale(shopId: string, customerId: string, o: { description: string; machineId?: string | null; daysAgo: number; partId?: string | null }) {
  saleNo += 1;
  return db.sale.create({
    data: {
      shopId,
      number: saleNo,
      customerId,
      subtotalCents: 1500,
      taxCents: 0,
      totalCents: 1500,
      taxRatePct: 0,
      createdAt: daysAgo(o.daysAgo),
      lines: { create: [{ description: o.description, qty: 1, unitPriceCents: 1500, taxable: true, machineId: o.machineId ?? null, partId: o.partId ?? null }] },
    },
  });
}

async function main() {
  const sink = await withSink();
  void sink;
  const a = await checkShop({ retail: true, repair: true, modules: ["vac", "marketing"] });
  const b = await checkShop({ retail: true, modules: ["vac", "marketing"] });
  const c = await checkShop({ retail: true }); // no modules
  const noMarketing = await checkShop({ retail: true, modules: ["vac"] });
  try {
    await messagingFor(a.shopId, { email: true });
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Pat Bagley", phone: "555-0102", email: "pat@example.test", notifyBy: "email" } });
    const v1 = await vacuum(a.shopId, cust.id, { serial: "BD-1", soldDaysAgo: 200 });
    const list = () => bagsDue(a.shopId, new Date(), { offers: false });

    // Due with the 180-day default: sold 200 days ago, due 20 days ago.
    let rows = await list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].machineId, v1.id);
    assert.equal(rows[0].overdue, true);
    assert.equal(rows[0].bagType, "Type Y");
    assert.ok(Math.abs(rows[0].lastBagsAt.getTime() - daysAgo(200).getTime()) < 5000);
    assert.equal(await bagsDueCount(a.shopId), 1);
    ok("a bagged vacuum sold 200 days ago is due (overdue) with the 180-day default");

    // Bags bought 10 days ago for that vacuum clear it; a non-bag line doesn't.
    const belt = await sale(a.shopId, cust.id, { description: "Hoover belt", machineId: v1.id, daysAgo: 5 });
    assert.equal((await list()).length, 1, "a belt isn't bags");
    const bagSale = await sale(a.shopId, cust.id, { description: "Hoover Type Y bags (3)", machineId: v1.id, daysAgo: 10 });
    assert.equal((await list()).length, 0);
    await db.sale.deleteMany({ where: { id: { in: [belt.id, bagSale.id] } } });
    assert.equal((await list()).length, 1);
    // A part that meets a "Vacuum bag" cross-reference entry counts even when its words don't say bag.
    await db.xPart.upsert({ where: { id: "vck-bd-bag" }, create: { id: "vck-bd-bag", name: "Hoover Type Y", kind: "SUPPLY", category: "Vacuum bag", numbers: [{ brand: "Hoover", number: "4010100Y" }], numberKeys: ["4010100Y"], fits: [], fitKeys: [], sources: [], updatedAt: new Date() }, update: {} });
    const bagPart = await db.part.create({ data: { shopId: a.shopId, partNumber: "4010100Y", description: "Hoover Type Y (3 pack)", numberKeys: ["4010100Y"], kind: "SUPPLY", priceCents: 1500 } });
    const xrefSale = await sale(a.shopId, cust.id, { description: "Hoover Type Y (3 pack)", machineId: v1.id, daysAgo: 10, partId: bagPart.id });
    assert.equal((await list()).length, 0);
    await db.sale.delete({ where: { id: xrefSale.id } });
    ok("bags rung up for the vacuum (by the word, or by a part that meets a Vacuum bag entry) move the date; a belt doesn't");

    // A bag PART line on its repair ticket clears it too.
    const ticket = await db.ticket.create({ data: { shopId: a.shopId, number: 9101, machineId: v1.id, customerId: cust.id, status: "COLLECTED", lines: { create: [{ kind: "PART", description: "Type Y bags", qty: 1, unitPriceCents: 1500, taxable: true, createdAt: daysAgo(12) }] } } });
    assert.equal((await list()).length, 0);
    await db.ticket.delete({ where: { id: ticket.id } });
    assert.equal((await list()).length, 1);
    ok("bags on the vacuum's repair ticket count as the last bags");

    // Bags on a sale with no vacuum picked: count when the customer has one bagged vacuum, not when they have two.
    const loose = await sale(a.shopId, cust.id, { description: "Vacuum bags", machineId: null, daysAgo: 8 });
    assert.equal((await list()).length, 0, "one bagged vacuum: the loose bags were for it");
    const v2 = await vacuum(a.shopId, cust.id, { serial: "BD-2", model: "C3", brand: "Miele", soldDaysAgo: null });
    rows = await list();
    assert.equal(rows.length, 1, "two bagged vacuums: the loose bags say nothing, and the second has no date of its own");
    assert.equal(rows[0].machineId, v1.id);
    await db.sale.delete({ where: { id: loose.id } });
    await db.machine.delete({ where: { id: v2.id } });
    ok("bags on a sale with no vacuum picked count only when the customer has one bagged vacuum");

    // Snooze hides it; stop hides it.
    await snoozeBagsFor(user(a), v1.id);
    assert.equal((await list()).length, 0);
    await db.vacCare.update({ where: { machineId: v1.id }, data: { snoozedUntil: daysAgo(1) } });
    assert.equal((await list()).length, 1, "a snooze that passed");
    await stopBagsFor(user(a), v1.id);
    assert.equal((await list()).length, 0);
    await stopBagsFor(user(a), v1.id, false);
    assert.equal((await list()).length, 1);
    // Called: off the list until the next due date.
    await markCalledFor(user(a), v1.id, form({ note: "left a message" }));
    assert.equal((await list()).length, 0);
    const care = await db.vacCare.findUniqueOrThrow({ where: { machineId: v1.id } });
    assert.equal(care.contactedBy, a.user.name);
    assert.equal(care.contactNote, "left a message");
    await db.vacCare.update({ where: { machineId: v1.id }, data: { contactedAt: null, contactedBy: null, contactNote: null } });
    ok("snooze, stop and 'called' each take the vacuum off the list; a passed snooze and 'start again' put it back");

    // Bagless or unanswered: never listed. Not sold here and no bags: not listed either.
    await vacuum(a.shopId, cust.id, { serial: "BD-3", bagged: "Bagless", soldDaysAgo: 300 });
    await vacuum(a.shopId, cust.id, { serial: "BD-4", bagged: null, soldDaysAgo: 300 });
    await vacuum(a.shopId, cust.id, { serial: "BD-5", soldDaysAgo: null });
    rows = await list();
    assert.deepEqual(
      rows.map((r) => r.machineId),
      [v1.id],
    );
    // The window: due in 10 days is listed as "due soon"; due in 20 days isn't.
    const soon = await db.customer.create({ data: { shopId: a.shopId, name: "Soon Due" } });
    const v6 = await vacuum(a.shopId, soon.id, { serial: "BD-6", soldDaysAgo: 170 });
    const later = await db.customer.create({ data: { shopId: a.shopId, name: "Later Due" } });
    await vacuum(a.shopId, later.id, { serial: "BD-7", soldDaysAgo: 160 });
    rows = await list();
    assert.deepEqual(
      rows.map((r) => [r.machineId, r.overdue]),
      [
        [v1.id, true],
        [v6.id, false],
      ],
    );
    // The days setting moves everything.
    await saveBagDaysFor(user(a), form({ bagReminderDays: "90" }));
    assert.equal((await list()).length, 3);
    await expectError("days out of range", () => saveBagDaysFor(user(a), form({ bagReminderDays: "10" })), /30 to 730/);
    await saveBagDaysFor(user(a), form({ bagReminderDays: "180" }));
    ok("bagless, unanswered and never-bought vacuums are never listed; the 14-day window and the days setting work");

    // The one-off send: one bags_due row per due vacuum with an address and consent; contacted marks only where queued.
    // Soon Due has no email or phone: skipped and still on the list. The offer line comes from the finder's stock.
    const r1 = await sendBagRemindersFor(user(a));
    assert.deepEqual(r1, { queued: 1, skipped: 1, already: 0 });
    const msgs = await db.outMessage.findMany({ where: { shopId: a.shopId, kind: "bags_due" } });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].customerId, cust.id);
    assert.equal(msgs[0].refId, v1.id);
    assert.equal(msgs[0].status, "QUEUED");
    assert.match(msgs[0].dedupeKey ?? "", /^bags_due:.+:\d{4}-\d{2}-\d{2}:email$/);
    assert.match(msgs[0].body, /Hoover UH70120/);
    assert.match(msgs[0].body, /about 6 months/);
    assert.match(msgs[0].body, /We have Hoover Type Y in stock\./, "the stocked bag is offered");
    const careAfter = await db.vacCare.findUniqueOrThrow({ where: { machineId: v1.id } });
    assert.ok(careAfter.contactedAt && careAfter.contactedBy === "message");
    assert.equal(await db.vacCare.count({ where: { machineId: v6.id } }), 0, "the skipped one isn't marked contacted");
    rows = await list();
    assert.deepEqual(
      rows.map((r) => r.machineId),
      [v6.id],
    );
    // A second send: nothing new (the sent one is off the list; the other still has no address).
    assert.deepEqual(await sendBagRemindersFor(user(a)), { queued: 0, skipped: 1, already: 0 });
    assert.equal(await db.outMessage.count({ where: { shopId: a.shopId, kind: "bags_due" } }), 1);
    // The dedupe itself: clear the contacted mark and send again on the same due date.
    await db.vacCare.update({ where: { machineId: v1.id }, data: { contactedAt: null, contactedBy: null } });
    assert.deepEqual(await sendBagRemindersFor(user(a)), { queued: 0, skipped: 1, already: 1 });
    assert.equal(await db.outMessage.count({ where: { shopId: a.shopId, kind: "bags_due" } }), 1);
    // Without Marketing: refused.
    await expectError("no marketing", () => sendBagRemindersFor(user(noMarketing)), /Marketing module/);
    ok("the send queues one bags_due per due vacuum with consent and an address, marks only those contacted, and never twice for one due date");

    // Still wanted?
    const row = { shopId: a.shopId, refId: v1.id, createdAt: msgs[0].createdAt };
    assert.equal(await bagsDueStillWanted(row), null);
    await stopBagsFor(user(a), v1.id);
    assert.equal(await bagsDueStillWanted(row), "Reminders stopped");
    await stopBagsFor(user(a), v1.id, false);
    await snoozeBagsFor(user(a), v1.id);
    assert.equal(await bagsDueStillWanted(row), "Snoozed");
    await db.vacCare.update({ where: { machineId: v1.id }, data: { snoozedUntil: null } });
    const bought = await sale(a.shopId, cust.id, { description: "Hoover Type Y bags (3)", machineId: v1.id, daysAgo: 0 });
    assert.equal(await bagsDueStillWanted(row), "They bought bags");
    await db.sale.delete({ where: { id: bought.id } });
    assert.equal(await bagsDueStillWanted({ ...row, refId: "nope" }), "The vacuum is gone");
    assert.equal(await bagsDueStillWanted({ shopId: b.shopId, refId: v1.id, createdAt: new Date() }), "The vacuum is gone", "another company's vacuum");
    const cc = await db.customer.create({ data: { shopId: c.shopId, name: "No Module" } });
    const cv = await vacuum(c.shopId, cc.id, { serial: "BD-C1", soldDaysAgo: 200 });
    assert.equal(await bagsDueStillWanted({ shopId: c.shopId, refId: cv.id, createdAt: new Date() }), "Vac Shop is off");
    ok("bagsDueStillWanted: stopped, snoozed, bought bags, the vacuum gone, Vac Shop off");

    // Tenant: B with A's machine.
    // VacCare has no id column (machineId is its key), so tenant.ts's snapshot can't order it: compared on its own.
    const careRows = () => db.vacCare.findMany({ where: { shopId: a.shopId }, orderBy: { machineId: "asc" } }).then((r) => JSON.stringify(r));
    const [before, careBefore] = await Promise.all([snapshot(a.shopId, ["Machine"]), careRows()]);
    await expectNotFound("markCalledFor(B, A's vacuum)", () => markCalledFor(user(b), v1.id, form({})));
    await expectNotFound("snoozeBagsFor(B, A's vacuum)", () => snoozeBagsFor(user(b), v1.id));
    await expectNotFound("stopBagsFor(B, A's vacuum)", () => stopBagsFor(user(b), v1.id));
    assert.deepEqual(await bagsDue(b.shopId), []);
    assertUnchanged("tenant", before, await snapshot(a.shopId, ["Machine"]));
    assert.equal(await careRows(), careBefore, "A's VacCare rows unchanged");
    ok("tenant: B's marks on A's vacuum answer 'Vacuum not found.' and A's VacCare rows are unchanged");
  } finally {
    clearKick();
    await db.xPart.deleteMany({ where: { id: "vck-bd-bag" } });
    await cleanup();
  }
  console.log(`bags-due.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
