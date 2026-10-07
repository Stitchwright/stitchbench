// Retreats, trunk shows and other events (shop-features-round-2-design.md 4.5): the choices and price math; a retreat made
// with an early-bird price, a deposit, rooms and meals; sign-ups priced with the early-bird and their choices; the deposit
// taken at the counter (a register sale saying non-refundable), the balance asked by pay link and paid by the webhook;
// the register won't take the full fee once part is paid; the balance reminders (14 days before, on the day, never twice,
// not once paid in full); a trunk show's ticket at the door; check-in; the door prize drawing and "draw again"; tenant.
//   npm run -s check scripts/checks/events.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { enrollAs, saveClassAs } from "@/lib/class-actions";
import { balanceDueYmd, choicesFromText, nextAsk, optionsText, parseOptions, pickedChoices, priceToday } from "@/lib/events-math";
import { checkInFor, drawFor, eventView, notPresentFor, runEventReminders, sellDoorTicketFor, sendBalanceLinksFor, sendEventLinkFor, takeEventPaymentFor } from "@/lib/events";
import { eventBalanceStillWanted } from "@/lib/events-wanted";
import { completeSaleAs } from "@/lib/register-sale";
import { handleWebhook, saveShopSettingsFor } from "@/lib/shop/online-shop";
import { openPayLink } from "@/lib/pay-links";
import { unseal } from "@/lib/messaging/secrets";
import { signWebhook } from "@/lib/shop/stripe";
import { checkShop, cleanup, clearKick, messagingFor, withSink } from "./lib";
import { expectNotFound, RUN } from "./tenant";
import { startStripeMock } from "../test-mail/stripe-mock.mjs";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
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

const KEY = "sk_test_events1234567890";
const WHSEC = "whsec_events1234567890";
const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  await withSink();
  const mock = await startStripeMock({ port: 0, webhookBase: null, webhookSecret: WHSEC });
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.PUBLIC_URL = "http://localhost:3999";
  delete process.env.STRIPE_SECRET_KEY;
  const a = await checkShop({ retail: true, modules: ["scheduling", "marketing"] });
  const b = await checkShop({ retail: true, modules: ["scheduling"] });
  try {
    // 1. The math.
    assert.deepEqual(parseOptions("Single +120, Double, Shared +$40.50"), [
      { label: "Single", cents: 12000 },
      { label: "Double", cents: 0 },
      { label: "Shared", cents: 4050 },
    ]);
    assert.equal(optionsText(parseOptions("Single +120, Shared +40.5")), "Single +120, Shared +40.50");
    assert.throws(() => parseOptions("Single, single"), /own name/);
    const ch = choicesFromText({ rooms: "Single +120, Double", meals: "None, All meals +90", dietary: true });
    assert.deepEqual(pickedChoices(ch, { room: "single", meals: "", dietary: " gluten free " }), { picked: { room: "Single", meals: "None", dietary: "gluten free" }, extraCents: 12000 });
    assert.deepEqual(priceToday({ feeCents: 39500, earlyCents: 35000, earlyUntil: "2026-11-01" }, "2026-11-01"), { cents: 35000, early: true });
    assert.deepEqual(priceToday({ feeCents: 39500, earlyCents: 35000, earlyUntil: "2026-11-01" }, "2026-11-02"), { cents: 39500, early: false });
    assert.equal(balanceDueYmd("2027-03-02", 60), "2027-01-01");
    assert.deepEqual(nextAsk({ priceCents: 47000, paidCents: 0, depositCents: 15000 }), { kind: "DEPOSIT", cents: 15000 });
    assert.deepEqual(nextAsk({ priceCents: 47000, paidCents: 15000, depositCents: 15000 }), { kind: "BALANCE", cents: 32000 });
    ok("choices with prices (forgiving, no twins), picks (the first by default), the early-bird price to its day, the balance day, deposit then balance");

    // 2. A retreat: early-bird, deposit, rooms and meals; sign-ups priced.
    await messagingFor(a.shopId, { email: true });
    await saveShopSettingsFor(a.user, fd({ slug: `check-${RUN}-ev`, pickup: "on", shipRate: "0", payVia: "own", stripeKey: KEY, stripeWebhook: WHSEC }));
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const first = new Date(Date.now() + 90 * DAY);
    const early = ymd(new Date(Date.now() + 10 * DAY));
    await expectError("bad rooms", () => saveClassAs(a.user, null, fd({ kind: "RETREAT", title: "x", seats: "10", fee: "395", remind: "never", rooms: "Single, single", date: ymd(first), start: "09:00", end: "17:00" })), /own name/);
    const rid = await saveClassAs(
      a.user,
      null,
      fd({ kind: "RETREAT", title: "Fall Retreat", seats: "2", fee: "395", remind: "never", earlyFee: "350", earlyUntil: early, deposit: "150", balanceDays: "60", rooms: "Double, Single +120", meals: "All meals, None", askDietary: "on", date: ymd(first), start: "09:00", end: "17:00" }),
    );
    const r = await db.shopClass.findUniqueOrThrow({ where: { id: rid } });
    assert.ok(r.kind === "RETREAT" && r.earlyCents === 35000 && r.depositCents === 15000 && !r.depositRefundable && r.balanceDays === 60);
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Retreat", email: "jane-ev@example.test", notifyBy: "email" } });
    const sue = await db.customer.create({ data: { shopId: a.shopId, name: "Sue Retreat", email: "sue-ev@example.test", notifyBy: "email" } });
    await enrollAs(a.user, rid, fd({ customerId: jane.id, choice_room: "Single", choice_meals: "All meals", dietary: "vegetarian" }));
    await enrollAs(a.user, rid, fd({ customerId: sue.id }));
    let v = (await eventView(a.shopId, rid))!;
    const pj = v.people.find((p) => p.customerId === jane.id)!;
    const ps = v.people.find((p) => p.customerId === sue.id)!;
    assert.ok(pj.priceCents === 47000 && pj.choices.room === "Single" && pj.choices.dietary === "vegetarian", "early-bird 350 + single 120");
    assert.ok(ps.priceCents === 35000 && ps.choices.room === "Double");
    assert.deepEqual(pj.next, { kind: "DEPOSIT", cents: 15000 });
    ok("a retreat with an early-bird price, a deposit, rooms and meals; each sign-up priced with the early-bird and her choices");

    // 3. The deposit at the counter; the register then refuses the full fee; the balance by pay link, paid.
    await expectError("a tech typing", () => takeEventPaymentFor({ ...a.user, role: "TECH" }, pj.id, { cents: 1000, method: "CASH" }), /owner or admin/);
    await expectError("more than owed", () => takeEventPaymentFor(a.user, pj.id, { cents: 50000, method: "CASH" }), /owes/);
    const dep = await takeEventPaymentFor(a.user, pj.id, { method: "CARD" });
    const sale = await db.sale.findUniqueOrThrow({ where: { id: dep.saleId }, include: { lines: true } });
    assert.ok(sale.totalCents === 15000 && sale.customerId === jane.id && sale.lines[0].description === "Deposit (non-refundable): Fall Retreat for Jane Retreat");
    await expectError("the register's full fee", () => completeSaleAs(a.user, { customerId: jane.id, lines: [{ enrollmentId: pj.id, description: "x", qty: 1, unitPriceCents: 47000, taxable: false }], tenders: [{ method: "CASH", amountCents: 47000 }] }), /Part of .* is paid/);
    const told = await sendEventLinkFor(a.user, pj.id);
    assert.match(told, /\$320\.00/);
    await expectError("a second link", () => sendEventLinkFor(a.user, pj.id), /already waiting/);
    v = (await eventView(a.shopId, rid))!;
    assert.equal(v.people.find((p) => p.id === pj.id)!.askedCents, 32000);
    const ep = await db.eventPayment.findFirstOrThrow({ where: { enrollmentId: pj.id, webOrderId: { not: null } } });
    const wo = await db.webOrder.findUniqueOrThrow({ where: { id: ep.webOrderId! } });
    const link = unseal(wo.linkSealed, a.shopId, `orderLink:${wo.id}`)!.plain;
    await openPayLink(link.split("/shop/o/")[1]);
    const sess = await mock.pay((await db.webOrder.findUniqueOrThrow({ where: { id: wo.id } })).stripeSessionId!);
    const body = JSON.stringify({ id: "evt_ev1", type: "checkout.session.completed", data: { object: sess } });
    assert.equal((await handleWebhook(a.shopId, body, signWebhook(body, WHSEC))).status, 200);
    v = (await eventView(a.shopId, rid))!;
    const pj2 = v.people.find((p) => p.id === pj.id)!;
    assert.ok(pj2.owingCents === 0 && pj2.paidCents === 47000 && pj2.next === null);
    await expectError("paid in full", () => takeEventPaymentFor(a.user, pj.id, { method: "CASH" }), /paid in full/);
    ok("the deposit at the counter (a sale saying non-refundable); the register won't take the full fee after; the balance by pay link, paid");

    // 4. Balance reminders: 14 days before the due day, on it, never twice; not for one paid in full.
    await takeEventPaymentFor(a.user, ps.id, { method: "CASH" }); // Sue's deposit
    const due = v.dueYmd!;
    const at = (s: string, h = 15) => new Date(`${s}T${String(h).padStart(2, "0")}:00:00Z`);
    const before = await db.outMessage.count({ where: { shopId: a.shopId, refType: "event_balance" } });
    await runEventReminders(new Date(at(due).getTime() - 20 * DAY)); // too early: nothing
    const dayM14 = new Date(at(due).getTime() - 14 * DAY);
    await runEventReminders(dayM14);
    await runEventReminders(dayM14);
    await runEventReminders(at(due));
    const msgs = await db.outMessage.findMany({ where: { shopId: a.shopId, refType: "event_balance" }, orderBy: { createdAt: "asc" } });
    assert.equal(msgs.length - before, 2, "Sue: 14 days before and on the day; Jane paid in full: none");
    assert.ok(msgs.every((m) => m.refId === ps.id) && msgs[0].body.includes("$200.00") && msgs[0].body.includes("Hi Sue"));
    await takeEventPaymentFor(a.user, ps.id, { method: "CASH" });
    assert.equal(await eventBalanceStillWanted(msgs[0]), "Paid in full");
    ok("balance reminders 14 days before the due day and on it, once each, only to those who owe; paid in full, the worker drops them");

    // 5. A trunk show at the door: a ticket sold, checked in; the check-in list; the drawing.
    const tid = await saveClassAs(a.user, null, fd({ kind: "EVENT", title: "Trunk Show", seats: "50", fee: "10", remind: "never", doorFee: "15", date: ymd(new Date(Date.now() + 5 * DAY)), start: "10:00", end: "16:00" }));
    await sellDoorTicketFor(a.user, tid, fd({ customerName: "Door Dora", customerPhone: "555-300-1000", method: "CASH" }));
    await enrollAs(a.user, tid, fd({ customerId: jane.id }));
    await enrollAs(a.user, tid, fd({ customerId: sue.id }));
    let tv = (await eventView(a.shopId, tid))!;
    const dora = tv.people.find((p) => p.name === "Door Dora")!;
    assert.ok(dora.checkedIn && dora.priceCents === 1500 && dora.owingCents === 0, "door price, paid, checked in");
    assert.equal(tv.people.find((p) => p.customerId === jane.id)!.priceCents, 1000, "signed up ahead: the advance price");
    const janeT = tv.people.find((p) => p.customerId === jane.id)!;
    await checkInFor(a.user, janeT.id, true);
    tv = (await eventView(a.shopId, tid))!;
    assert.equal(tv.totals.checkedIn, 2);
    const d1 = await drawFor(a.user, tid, "Fat quarter bundle");
    assert.ok(["Door Dora", "Jane Retreat"].includes(d1.name), "only those checked in");
    const again = await notPresentFor(a.user, d1.id);
    assert.equal(again, "Fat quarter bundle");
    const d2 = await drawFor(a.user, tid, again);
    assert.ok(d2.name !== d1.name && ["Door Dora", "Jane Retreat"].includes(d2.name));
    await expectError("nobody left", () => drawFor(a.user, tid, "Fat quarter bundle"), /drawn already/);
    tv = (await eventView(a.shopId, tid))!;
    assert.deepEqual(tv.draws.map((d) => d.present), [false, true]);
    ok("a trunk show: a door ticket (door price, paid, checked in), the check-in list, a drawing from those here, not present and drawn again");

    // 6. Tenant.
    await expectNotFound("B takes A's payment", () => takeEventPaymentFor(b.user, ps.id, { method: "CASH" }));
    await expectNotFound("B sends A's link", () => sendEventLinkFor(b.user, ps.id));
    await expectNotFound("B asks A's balances", () => sendBalanceLinksFor(b.user, rid));
    await expectNotFound("B checks in at A's event", () => checkInFor(b.user, janeT.id, false));
    await expectNotFound("B draws at A's event", () => drawFor(b.user, tid, "x"));
    await expectNotFound("B marks A's draw", () => notPresentFor(b.user, d2.id));
    await expectNotFound("B sells A's ticket", () => sellDoorTicketFor(b.user, tid, fd({ customerName: "X", customerPhone: "5551112222", method: "CASH" })));
    assert.equal(await eventView(b.shopId, rid), null);
    ok("tenant: another company can't take, ask, check in, draw, mark or sell on A's events, nor see them");

    console.log(`events.check: ${steps} groups passed`);
  } finally {
    clearKick();
    await mock.close();
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
