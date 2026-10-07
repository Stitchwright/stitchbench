// Customer answers on the booking page (shop-features-round-2-design.md 5.6, package customer-answers):
//   1. the wording (pure): a sentence per status with no price, hours in words, forgiving ticket and phone input, the
//      sorting request redacted and its answer read (anything unclear goes to a person)
//   2. off until the shop turns it on (owners and admins; the cap checked); the public route says 404 while off
//   3. Is my machine ready: the ticket number and the last four digits of the phone on it, both must match; another
//      company's ticket, a wrong number or wrong digits all say the same; never a price or what was found
//   4. Hours, Classes with seats (never the fee; a full class left out), Book a drop-off (booking off: call us)
//   5. a typed question: without the Assistant the buttons only (no call); with it, one customer_question call (suggest)
//      sorts it and the program answers; past the day's cap, the buttons only and no call
//   6. "for a person": saved with her contact (one is needed); the staff list's Answered and Undo; another company's
//      question not found
//   npm run -s check scripts/checks/customer-answers.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { answersShop, BUTTONS_ONLY, classesAnswer, dropoffAnswer, hoursAnswer, leaveQuestion, markQuestionFor, questionsFor, saveCustomerAnswersFor, statusAnswer, typedQuestion, typedToday } from "@/lib/customer-answers";
import { buildSortQuestion, hoursWords, last4Of, NOT_FOUND_STATUS, parseSort, PASSED_ON, statusWords, ticketNumberOf } from "@/lib/customer-answers-words";
import { POST as askRoute } from "@/app/api/book/[slug]/ask/route";
import { RUN } from "./tenant";
import { assistantOn, expectUserError, ok, startAssistantHub, stepCount } from "./assistant-hub";
import { checkShop, cleanup } from "./lib";

const DAY = 86_400_000;
const route = (slug: string, body: unknown) =>
  askRoute(new Request(`http://localhost/api/book/${slug}/ask`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.9.8.7" }, body: JSON.stringify(body) }), { params: Promise.resolve({ slug }) });

async function main() {
  // ===== 1. pure =====
  assert.equal(last4Of("(555) 123-4567"), "4567");
  assert.equal(last4Of("12"), null);
  assert.equal(ticketNumberOf("#0051"), 51);
  assert.equal(ticketNumberOf("ticket 7"), 7);
  assert.equal(ticketNumberOf("none"), null);
  const statuses = ["AT_SHOP_AWAITING_PICKUP", "IN_TRUCK", "ON_BENCH", "WAITING_CUSTOMER_OK", "WAITING_PARTS", "READY_IN_TRUCK", "READY_FOR_PICKUP", "COLLECTED", "ABANDONED", "RETURNED_UNREPAIRED"] as const;
  for (const s of statuses) {
    const w = statusWords({ status: s, number: 51, noun: "sewing machine", closedOn: "Mon, Oct 6" });
    assert.match(w, /ticket #51/, s);
    assert.ok(!/\$|\d+\.\d\d/.test(w), `${s}: no price`);
  }
  assert.equal(statusWords({ status: "READY_FOR_PICKUP", number: 51, noun: "vacuum", closedOn: null }), "Your vacuum (ticket #51) is ready for pickup.");
  assert.equal(hoursWords([]), null);
  assert.equal(
    hoursWords([2, 3, 4, 5, 6].map((day) => ({ day, from: "10:00", to: "17:00" })).concat([{ day: 0, from: "12:00", to: "16:30" }])),
    "We're open Sunday, 12 pm to 4:30 pm; Tuesday to Saturday, 10 am to 5 pm.",
  );
  const sort = buildSortQuestion("Is my machine ready? I'm Pat Quill, 555-123-4567, pat@example.com", { names: ["Pat Quill"] });
  assert.deepEqual([sort.feature, sort.cls], ["customer_question", "suggest"]);
  assert.ok(!/Pat Quill|555-123|pat@example/.test(JSON.stringify(sort)));
  assert.deepEqual(parseSort('{"topic":"status","ticket":"#51"}'), { topic: "status", ticket: 51 });
  assert.deepEqual(parseSort('{"topic":"prices"}'), { topic: "person", ticket: null });
  assert.deepEqual(parseSort("nonsense"), { topic: "person", ticket: null });
  ok("the wording: no price in any status, hours in words, forgiving input, the request redacted, unclear goes to a person");

  // ===== 2. off until turned on =====
  const a = await checkShop({ retail: true, repair: true });
  const b = await checkShop({ retail: true, repair: true });
  const slugA = `cq-${RUN}-a`.toLowerCase();
  const slugB = `cq-${RUN}-b`.toLowerCase();
  await db.shop.update({ where: { id: a.shopId }, data: { bookingSlug: slugA, phone: "555-000-1111" } });
  await db.shop.update({ where: { id: b.shopId }, data: { bookingSlug: slugB } });
  assert.equal((await answersShop(slugA))?.on, false, "off by default");
  assert.equal((await route(slugA, { kind: "hours" })).status, 404, "the route answers nothing while off");
  await expectUserError("a tech", () => saveCustomerAnswersFor({ ...a.user, role: "TECH" }, { on: true, cap: 20, hours: [], hoursNote: null }), /owner or an admin/);
  await expectUserError("a silly cap", () => saveCustomerAnswersFor(a.user, { on: true, cap: 5000, hours: [], hoursNote: null }), /0 to 200/);
  await saveCustomerAnswersFor(a.user, { on: true, cap: 2, hours: [1, 2, 3, 4, 5].map((day) => ({ day, from: "09:30", to: "17:00" })), hoursNote: "Closed on holidays." });
  const shopA = (await answersShop(slugA))!;
  assert.equal(shopA.on, true);
  assert.equal(shopA.cap, 2);
  ok("off until an owner or admin turns it on; the route 404s while off");

  // ===== 3. Is my machine ready =====
  const pat = await db.customer.create({ data: { shopId: a.shopId, name: "Pat Quill", phone: "(555) 123-4567", email: "pat@example.com" } });
  const machine = await db.machine.create({ data: { shopId: a.shopId, brand: "Janome", model: "MC6700P", modelKey: "MC6700P", kind: "sewing" } });
  await db.ticket.create({ data: { shopId: a.shopId, number: 51, machineId: machine.id, customerId: pat.id, status: "READY_FOR_PICKUP", diagnosis: "SECRET-DIAGNOSIS", lines: { create: [{ kind: "LABOR", description: "Clean", qty: 1, unitPriceCents: 8900 }] } } });
  const patB = await db.customer.create({ data: { shopId: b.shopId, name: "Bea", phone: "555-999-4567" } });
  const machineB = await db.machine.create({ data: { shopId: b.shopId, brand: "Brother", model: "X", modelKey: "X" } });
  await db.ticket.create({ data: { shopId: b.shopId, number: 52, machineId: machineB.id, customerId: patB.id, status: "READY_FOR_PICKUP" } });
  const s1 = await statusAnswer(shopA, "#51", "4567");
  assert.deepEqual(s1, { answer: "Your machine (ticket #51) is ready for pickup.", found: true });
  assert.ok(!/89|SECRET/.test(s1.answer));
  assert.deepEqual(await statusAnswer(shopA, "51", "0000"), { answer: NOT_FOUND_STATUS, found: false });
  assert.deepEqual(await statusAnswer(shopA, "52", "4567"), { answer: NOT_FOUND_STATUS, found: false }, "another company's ticket number");
  assert.equal((await statusAnswer(shopA, "", "4567")).found, false);
  const viaRoute = await route(slugA, { kind: "status", ticket: "51", last4: "555-123-4567" });
  assert.equal((await viaRoute.json()).answer, "Your machine (ticket #51) is ready for pickup.");
  ok("Is my machine ready: both must match; anything else says the same; no price, no diagnosis");

  // ===== 4. hours, classes, drop-off =====
  assert.equal(hoursAnswer(shopA), "We're open Monday to Friday, 9:30 am to 5 pm. Closed on holidays.");
  assert.equal(hoursAnswer({ openHours: [], hoursNote: null, phone: null }), "Please call the shop for our hours.");
  const soon = new Date(Date.now() + 5 * DAY);
  const open = await db.shopClass.create({ data: { shopId: a.shopId, title: "Binding basics", seats: 4, feeCents: 4500, online: true, firstAt: soon, lastAt: soon, meetings: { create: [{ shopId: a.shopId, startsAt: soon, endsAt: new Date(soon.getTime() + 7_200_000) }] } } });
  const full = await db.shopClass.create({ data: { shopId: a.shopId, title: "Full class FULLONE", seats: 1, online: true, firstAt: soon, lastAt: soon, meetings: { create: [{ shopId: a.shopId, startsAt: soon, endsAt: new Date(soon.getTime() + 7_200_000) }] } } });
  await db.enrollment.create({ data: { shopId: a.shopId, classId: full.id, name: "Someone", feeCents: 0 } });
  const cls = await classesAnswer(shopA);
  assert.equal(cls.classes.length, 1);
  assert.equal(cls.classes[0].title, "Binding basics");
  assert.equal(cls.classes[0].seatsLeft, 4);
  assert.ok(!/\$|45/.test(cls.answer) && !cls.answer.includes("FULLONE"), "no fee, no full class");
  void open;
  const drop = await dropoffAnswer(shopA);
  assert.equal(drop.bookingOpen, false);
  assert.equal(drop.answer, "Call us at 555-000-1111. We'll find a time for you to bring it in.");
  ok("hours in words with the note; classes with seats and no fee; drop-off says call us while booking is off");

  // ===== 5. typed questions =====
  assert.deepEqual(await typedQuestion(shopA, "When are you open?"), { topic: null, ticket: null, answer: BUTTONS_ONLY }, "no Assistant: the buttons only");
  const hub = await startAssistantHub((rec) => {
    if (!rec.system.startsWith("You sort a customer's question")) return "?";
    if (/open/i.test(rec.userText)) return '{"topic":"hours","ticket":null}';
    if (/ready/i.test(rec.userText)) return '{"topic":"status","ticket":"51"}';
    return '{"topic":"person","ticket":null}';
  });
  try {
    await assistantOn(a.shopId);
    assert.equal(hub.calls.length, 0);
    const t1 = await typedQuestion(shopA, "When are you open on Monday?");
    assert.deepEqual(t1, { topic: "hours", ticket: null, answer: "We're open Monday to Friday, 9:30 am to 5 pm. Closed on holidays." });
    assert.deepEqual([hub.calls[0].body.feature, hub.calls[0].body.model], ["customer_question", "suggest"]);
    const t2 = await typedQuestion(shopA, "Is ticket 51 ready? Pat Quill 555-123-4567");
    assert.deepEqual([t2.topic, t2.ticket], ["status", 51]);
    assert.match(t2.answer, /last four digits/);
    assert.ok(!/Pat Quill|555-123/.test(hub.lastSent()), "no name or phone in the request");
    assert.equal(await typedToday(shopA), 2);
    const t3 = await typedQuestion(shopA, "How much is a service?");
    assert.deepEqual(t3, { topic: null, ticket: null, answer: BUTTONS_ONLY }, "past the cap of 2: buttons only");
    assert.equal(hub.calls.length, 2, "no call past the cap");
    const logged = await db.assistantCall.findMany({ where: { shopId: a.shopId, feature: "customer_question" } });
    assert.ok(logged.every((l) => l.byUserId === null), "logged as the public page's, no person");
    ok("typed questions: sorted by one call, answered by the program; past the cap, the buttons and no call");
  } finally {
    await hub.close();
  }

  // ===== 6. for a person =====
  await expectUserError("no contact", () => leaveQuestion(shopA, { name: "Pat", contact: "", text: "Do you sell Bernina feet?" }), /phone number or email/);
  assert.equal(await leaveQuestion(shopA, { name: "Pat", contact: "pat@example.com", text: "Do you sell Bernina feet?" }), PASSED_ON);
  const viaLeave = await route(slugA, { kind: "leave", name: "Lee", contact: "555-222-3333", text: "Can you fix a Featherweight?" });
  assert.equal((await viaLeave.json()).answer, PASSED_ON);
  const q = await questionsFor(a.shopId);
  assert.equal(q.open.length, 2);
  await expectUserError("another company's question", () => markQuestionFor(b.user, q.open[0].id, true), /not found/);
  await markQuestionFor(a.user, q.open[0].id, true);
  assert.equal((await questionsFor(a.shopId)).open.length, 1);
  await markQuestionFor(a.user, q.open[0].id, false);
  assert.equal((await questionsFor(a.shopId)).open.length, 2, "Undo puts it back");
  assert.equal((await questionsFor(b.shopId)).open.length, 0);
  const bShop = (await answersShop(slugB))!;
  await expectUserError("B is off", () => leaveQuestion(bShop, { name: "x", contact: "x@y.z", text: "hello there" }), /aren't answered here/);
  ok("for a person: saved with a contact; Answered and Undo; another company's not found; a shop that's off refuses");

  console.log(`customer-answers check: ${stepCount()} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await db.$disconnect();
  });
