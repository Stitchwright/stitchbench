// Clubs (fabric-smarts-design.md section 4a, package F7): starting and changing clubs (validation, the Block of the Month
// series), members, the pay-at-pickup path (marked paid by hand, with no Stripe keys), card billing on the shop's own Stripe
// (a Stripe Customer, a subscription-mode checkout at the club's monthly price, the bill day) against the Stripe mock, the
// webhook (checkout completed, invoice paid and failed, subscription paused and cancelled; replays; wrong secret; another
// shop's secret), pause, resume and cancel (Stripe first, so a Stripe failure changes nothing here), the monthly pick list
// (ship or pickup, done, undone, payment standing), club money posted to the register's books (pay at pickup by
// method, take back, one sale per Stripe invoice, refunds void, deleting a customer stops the subscription), and the tenant section.
//   npm run check scripts/checks/clubs.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { seal } from "@/lib/messaging/secrets";
import { signWebhook } from "@/lib/shop/stripe";
import { deleteCustomerFor, mergeCustomersFor } from "@/lib/merge";
import { registerTakenCents } from "@/lib/register-day";
import { handleWebhook } from "@/lib/shop/online-shop";
import {
  addMemberFor,
  cancelMemberFor,
  cardBillingFor,
  cardLinkFor,
  clubFor,
  clubsFor,
  closeClubFor,
  markPaidFor,
  markPickDoneFor,
  monthOf,
  nextAnchor,
  pauseMemberFor,
  pickListFor,
  resumeMemberFor,
  saveClubFor,
  saveMemberFor,
  setMonthFor,
  takeBackPaidFor,
  undoPickFor,
} from "@/lib/clubs";
import { startStripeMock } from "../test-mail/stripe-mock.mjs";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
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

const KEY = "sk_test_clubcheck1234567890";
const WHSEC = "whsec_clubcheck1234567890";
const WHSEC_B = "whsec_othershop1234567890";

async function main() {
  const mock = await startStripeMock({ port: 0, webhookBase: null, webhookSecret: WHSEC });
  const goodBase = `http://127.0.0.1:${mock.port}`;
  process.env.STRIPE_API_BASE = goodBase;
  process.env.PUBLIC_URL = "http://localhost:3999";
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const TZ = "America/New_York";
  const month = monthOf(new Date(), TZ);
  const lastMonth = monthOf(new Date(Date.now() - 35 * 86_400_000), TZ);
  const mk = (shopId: string, name: string, extra: Record<string, unknown> = {}) => db.customer.create({ data: { shopId, name, email: `${name.toLowerCase().replace(/\W+/g, "")}@club.example`, phone: "555-0100", address: "1 Quilt Ln, Springfield", ...extra } });
  const c1 = await mk(a.shopId, "Pat Pickup");
  const c2 = await mk(a.shopId, "Cara Card");
  const c3 = await mk(a.shopId, "Sam Ship");
  const c4 = await mk(a.shopId, "Dee Dashboard");
  const cb = await mk(b.shopId, "Bea Other");
  const send = (body: unknown, secret = WHSEC, who = a.shopId, at = new Date()) => {
    const raw = JSON.stringify(body);
    return handleWebhook(who, raw, signWebhook(raw, secret, at), at);
  };
  try {
    // 1. Starting and changing clubs.
    await expectError("no name", () => saveClubFor(user(a), null, fd({ name: "", price: "40" })), /name/);
    await expectError("no price", () => saveClubFor(user(a), null, fd({ name: "FQ", price: "" })), /monthly price/i);
    await expectError("price under 50 cents", () => saveClubFor(user(a), null, fd({ name: "FQ", price: "0.25" })), /\$0\.50/);
    await expectError("price not money", () => saveClubFor(user(a), null, fd({ name: "FQ", price: "forty" })), /dollars and cents/);
    await expectError("bill day 31", () => saveClubFor(user(a), null, fd({ name: "FQ", price: "40", billDay: "31" })), /1 to 28/);
    await expectError("bad kind", () => saveClubFor(user(a), null, fd({ name: "FQ", price: "40", kind: "WINE" })), /kind/);
    const series = await db.kitSeries.create({ data: { shopId: a.shopId, name: "BOM 2027", months: 12 } });
    const seriesB = await db.kitSeries.create({ data: { shopId: b.shopId, name: "B's BOM", months: 12 } });
    await expectError("series on a non-BOM club", () => saveClubFor(user(a), null, fd({ name: "FQ", price: "40", kind: "FAT_QUARTER", seriesId: series.id })), /Only a Block of the Month/);
    await expectError("another company's series", () => saveClubFor(user(a), null, fd({ name: "BOM", price: "30", kind: "BOM", seriesId: seriesB.id })), /not found/i);
    const fq = await saveClubFor(user(a), null, fd({ name: "Fat Quarter of the Month", kind: "FAT_QUARTER", price: "40", fulfil: "PICKUP" }));
    const row = await db.club.findUniqueOrThrow({ where: { id: fq.id } });
    assert.deepEqual([row.monthlyCents, row.kind, row.fulfil, row.billDay, row.shopId], [4000, "FAT_QUARTER", "PICKUP", null, a.shopId]);
    const bom = await saveClubFor(user(a), null, fd({ name: "Block of the Month", kind: "BOM", price: "27.50", fulfil: "SHIP", billDay: "5", seriesId: series.id }));
    assert.equal((await db.club.findUniqueOrThrow({ where: { id: bom.id } })).monthlyCents, 2750);
    await saveClubFor(user(a), fq.id, fd({ name: "Fat Quarter Club", kind: "FAT_QUARTER", price: "42", fulfil: "PICKUP" }));
    assert.equal((await clubFor(a.shopId, fq.id))!.monthlyCents, 4200);
    await saveClubFor(user(a), fq.id, fd({ name: "Fat Quarter Club", kind: "FAT_QUARTER", price: "40", fulfil: "PICKUP" }));
    assert.deepEqual((await clubsFor(a.shopId)).map((c) => [c.name, c.monthlyCents, c.active]).sort(), [["Block of the Month", 2750, 0], ["Fat Quarter Club", 4000, 0]]);
    ok("clubs: name, price (dollars, at least 50 cents), bill day 1 to 28, kind and series checked; a series only on Block of the Month and only the shop's own; price changes save");

    // 2. Pay at pickup (no Stripe keys yet).
    const card0 = await cardBillingFor(a.shopId);
    assert.equal(card0.ready, false);
    assert.match(card0.why!, /your own Stripe account/);
    await expectError("card billing without keys", () => addMemberFor(user(a), fq.id, fd({ customerId: c1.id, billing: "STRIPE" })), /own Stripe account/);
    assert.match(await addMemberFor(user(a), fq.id, fd({ customerId: c1.id, billing: "PAY_AT_PICKUP", fulfil: "PICKUP" })), /Pat Pickup is in Fat Quarter Club, paying at pickup/);
    await expectError("twice", () => addMemberFor(user(a), fq.id, fd({ customerId: c1.id })), /already in/);
    const m1 = await db.clubMember.findFirstOrThrow({ where: { clubId: fq.id, customerId: c1.id } });
    assert.deepEqual([m1.status, m1.billing, m1.fulfil, m1.paidMonth, m1.stripeSubscriptionId], ["ACTIVE", "PAY_AT_PICKUP", "PICKUP", null, null]);
    let list = (await pickListFor(a.shopId, fq.id, month))!;
    assert.deepEqual(list.rows.map((r) => [r.name, r.fulfil, r.paid, r.failed, r.awaitingCard, r.doneAt]), [["Pat Pickup", "PICKUP", false, false, false, null]]);
    assert.equal(await db.clubPick.count({ where: { shopId: a.shopId } }), 0, "reading the pick list makes no rows");
    assert.match(await setMonthFor(user(a), fq.id, month, fd({ what: "Six fat quarters, Bali blues" })), /Six fat quarters/);
    assert.equal((await pickListFor(a.shopId, fq.id, month))!.what!.text, "Six fat quarters, Bali blues");
    // Handed over before paying: done, and the answer says the money is still owed.
    assert.match(await markPickDoneFor(user(a), fq.id, m1.id, month, null), /picked up\. They haven't paid this month yet/);
    await expectError("done twice", () => markPickDoneFor(user(a), fq.id, m1.id, month, null), /already marked done/);
    list = (await pickListFor(a.shopId, fq.id, month))!;
    assert.deepEqual([list.rows[0].doneAt !== null, list.rows[0].doneFulfil, list.summary.done, list.summary.unpaid], [true, "PICKUP", 1, 1]);
    assert.match(await undoPickFor(user(a), fq.id, m1.id, month), /back on the list/);
    await expectError("undo what isn't done", () => undoPickFor(user(a), fq.id, m1.id, month), /isn't marked done/);
    assert.match(await markPaidFor(user(a), fq.id, m1.id, month), /marked paid/);
    await expectError("paid twice", () => markPaidFor(user(a), fq.id, m1.id, month), /already marked paid/);
    assert.match(await markPickDoneFor(user(a), fq.id, m1.id, month, null), /picked up\.$/);
    list = (await pickListFor(a.shopId, fq.id, month))!;
    assert.deepEqual([list.rows[0].paid, list.summary.unpaid, list.summary.done], [true, 0, 1]);
    // Next month: the same member is on a fresh list, unpaid and not done.
    const next = monthOf(new Date(Date.now() + 33 * 86_400_000), TZ);
    const nl = (await pickListFor(a.shopId, fq.id, next))!;
    assert.deepEqual([nl.rows.length, nl.rows[0].paid, nl.rows[0].doneAt, nl.what], [1, false, null, null]);
    // Pause: off the list (nothing done there); resume; cancel: gone, and added again later they start fresh.
    assert.match(await pauseMemberFor(user(a), m1.id), /is paused\./);
    assert.equal((await pickListFor(a.shopId, fq.id, next))!.rows.length, 0, "a paused member isn't on a month they haven't had");
    assert.equal((await pickListFor(a.shopId, fq.id, month))!.rows.length, 1, "a paused member who got this month's stays on it");
    await expectError("pause twice", () => pauseMemberFor(user(a), m1.id), /isn't active/);
    assert.match(await resumeMemberFor(user(a), m1.id), /active again/);
    await expectError("resume an active member", () => resumeMemberFor(user(a), m1.id), /isn't paused/);
    assert.match(await cancelMemberFor(user(a), m1.id), /is cancelled\.$/);
    await expectError("cancel twice", () => cancelMemberFor(user(a), m1.id), /already cancelled/);
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m1.id } })).status, "CANCELLED");
    assert.match(await addMemberFor(user(a), fq.id, fd({ customerId: c1.id })), /Pat Pickup is in/);
    const m1b = await db.clubMember.findUniqueOrThrow({ where: { id: m1.id } });
    assert.deepEqual([m1b.status, m1b.paidMonth, m1b.cancelledAt], ["ACTIVE", null, null], "a cancelled member who joins again is the same row, fresh");
    await expectError("close with members", () => closeClubFor(user(a), fq.id, true), /still active or paused/);
    // Block of the Month: members join the series' roster too.
    await addMemberFor(user(a), bom.id, fd({ customerId: c4.id, fulfil: "SHIP" }));
    assert.equal(await db.kitSeriesMember.count({ where: { shopId: a.shopId, seriesId: series.id, customerId: c4.id } }), 1);
    const kit = await db.kit.create({ data: { shopId: a.shopId, name: "Month 1 kit", seriesId: series.id, seriesMonth: 1 } });
    const kitB = await db.kit.create({ data: { shopId: b.shopId, name: "B's kit" } });
    assert.match(await setMonthFor(user(a), bom.id, month, fd({ kitId: kit.id })), /Month 1 kit/);
    assert.equal((await pickListFor(a.shopId, bom.id, month))!.kits.length, 1);
    await expectError("another company's kit", () => setMonthFor(user(a), bom.id, month, fd({ kitId: kitB.id })), /not found/i);
    assert.match(await setMonthFor(user(a), bom.id, month, fd({})), /Cleared/);
    ok("pay at pickup: no Stripe keys -> card refused with the reason; marked paid by hand, once; done and undone; paused members leave months they haven't had; cancel then re-add starts fresh; Block of the Month members join the series roster; the month's words and kit");

    // 3. Card billing on the shop's own Stripe.
    await db.shop.update({ where: { id: a.shopId }, data: { stripeKeySealed: seal(KEY, a.shopId, "stripeKey"), stripeWebhookSealed: seal(WHSEC, a.shopId, "stripeWebhook") } });
    assert.deepEqual(await cardBillingFor(a.shopId), { ready: true, why: null });
    await addMemberFor(user(a), fq.id, fd({ customerId: c2.id, billing: "STRIPE", fulfil: "SHIP" }));
    const m2 = await db.clubMember.findFirstOrThrow({ where: { clubId: fq.id, customerId: c2.id } });
    assert.deepEqual([m2.billing, m2.fulfil, m2.stripeSubscriptionId], ["STRIPE", "SHIP", null]);
    assert.equal((await clubFor(a.shopId, fq.id))!.members.find((m) => m.id === m2.id)!.awaitingCard, true);
    assert.equal((await pickListFor(a.shopId, fq.id, month))!.rows.find((r) => r.memberId === m2.id)!.awaitingCard, true);
    await expectError("markPaid for a card member", () => markPaidFor(user(a), fq.id, m2.id, month), /pays by card/);
    await expectError("card link for a pay-at-pickup member", () => cardLinkFor(user(a), m1.id), /pays at pickup/);
    const now = new Date();
    const url = await cardLinkFor(user(a), m2.id, now);
    assert.match(url, new RegExp(`^${goodBase}/pay/cs_test_`));
    assert.equal(mock.customers.size, 1);
    const cust = [...mock.customers.values()][0];
    assert.deepEqual([cust.name, cust.email, cust.metadata.shopId, cust.metadata.memberId], ["Cara Card", "caracard@club.example", a.shopId, m2.id]);
    const sess = [...mock.sessions.values()][0];
    assert.equal(sess.mode, "subscription");
    assert.equal(sess.customer, cust.id);
    assert.equal(sess.client_reference_id, m2.id);
    const line = sess.line_items.data[0];
    assert.deepEqual([line.price_data.unit_amount, line.quantity, line.price_data.recurring.interval], ["4000", 1, "month"], "$40 a month");
    assert.equal(sess.metadata.endpoint, a.shopId);
    assert.equal(sess.billing_cycle_anchor, null, "no bill day: each member's own sign-up day");
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } })).stripeCustomerId, cust.id);
    await cardLinkFor(user(a), m2.id, now);
    assert.equal(mock.customers.size, 1, "the Stripe Customer is made once");
    assert.equal(mock.sessions.size, 1, "the same request replays the same page");
    // A bill day fixes the first period.
    assert.equal(nextAnchor(5, new Date("2026-10-06T10:00:00Z")), Date.UTC(2026, 10, 5, 12) / 1000);
    assert.equal(nextAnchor(8, new Date("2026-10-06T10:00:00Z")), Date.UTC(2026, 9, 8, 12) / 1000);
    assert.equal(nextAnchor(6, new Date("2026-10-06T10:00:00Z")), Date.UTC(2026, 10, 6, 12) / 1000, "today or tomorrow: next month, never a same-day anchor");
    await addMemberFor(user(a), bom.id, fd({ customerId: c3.id, billing: "STRIPE", fulfil: "SHIP" }));
    const m3 = await db.clubMember.findFirstOrThrow({ where: { clubId: bom.id, customerId: c3.id } });
    await cardLinkFor(user(a), m3.id, now);
    const bomSess = [...mock.sessions.values()].find((s) => s.client_reference_id === m3.id)!;
    assert.equal(bomSess.billing_cycle_anchor, nextAnchor(5, now));
    assert.equal(bomSess.line_items.data[0].price_data.unit_amount, "2750");
    ok("card billing: needs the shop's own keys; a Stripe Customer (once) and a subscription-mode checkout at the club's price with the member and shop in its metadata; a bill day sets the anchor, never the same day");

    // 4. The webhook: signed by the shop's secret, tied to the member.
    const paidSess = (await mock.pay(sess.id))!;
    assert.equal(paidSess.mode, "subscription");
    const subId = paidSess.subscription as string;
    assert.match(subId, /^sub_/);
    const completed = mock.event("checkout.session.completed", paidSess);
    const bad = await send(completed, "whsec_wrongwrongwrong1");
    assert.equal(bad.status, 400, "a wrong secret is refused");
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } })).stripeSubscriptionId, null);
    assert.deepEqual(await send(completed), { status: 200, body: "ok" });
    let r2 = await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } });
    assert.deepEqual([r2.stripeSubscriptionId, r2.stripeCustomerId, r2.paidMonth, r2.payFailedAt, r2.status], [subId, cust.id, month, null, "ACTIVE"]);
    assert.deepEqual(await send(completed), { status: 200, body: "ok" }, "a replay changes nothing");
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } })).paidMonth, month);
    assert.equal((await clubFor(a.shopId, fq.id))!.members.find((m) => m.id === m2.id)!.awaitingCard, false);
    await expectError("card link once the subscription runs", () => cardLinkFor(user(a), m2.id), /already running/);
    // A failed monthly payment is flagged everywhere; the next paid one clears it, and an old invoice never lowers the month.
    const failed = mock.invoice(subId, "failed")!;
    assert.deepEqual(await send(failed), { status: 200, body: "ok" });
    r2 = await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } });
    assert.ok(r2.payFailedAt);
    const firstFail = r2.payFailedAt!.getTime();
    assert.equal((await pickListFor(a.shopId, fq.id, month))!.rows.find((r) => r.memberId === m2.id)!.failed, true);
    assert.equal((await pickListFor(a.shopId, fq.id, month))!.summary.failed, 1);
    assert.equal((await clubsFor(a.shopId)).find((c) => c.id === fq.id)!.failed, 1);
    assert.equal((await clubFor(a.shopId, fq.id))!.failed, 1);
    await send(mock.invoice(subId, "failed")!);
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } })).payFailedAt!.getTime(), firstFail, "a second failure keeps the first date");
    assert.match(await markPickDoneFor(user(a), fq.id, m2.id, month, fd({ tracking: "1Z999" })), /shipped\. Their card payment failed: ask for a new card/);
    assert.equal((await db.clubPick.findFirstOrThrow({ where: { memberId: m2.id, month } })).tracking, "1Z999");
    await undoPickFor(user(a), fq.id, m2.id, month);
    const oldPaid = mock.invoice(subId, "paid", { at: new Date(Date.now() - 35 * 86_400_000) })!;
    await send(oldPaid);
    r2 = await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } });
    assert.deepEqual([r2.payFailedAt, r2.paidMonth], [null, month], "paid clears the flag; an invoice from last month keeps the later month");
    // Paid for a later month moves it forward.
    await send(mock.invoice(subId, "paid", { at: new Date(Date.now() + 33 * 86_400_000) })!);
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } })).paidMonth, next);
    await expectError("change billing with a subscription running", () => saveMemberFor(user(a), m2.id, fd({ billing: "PAY_AT_PICKUP" })), /subscription running/);
    ok("webhook: a wrong secret is refused; checkout completed ties the subscription and Customer to the member and marks the month paid; failed payments are flagged on the member, the pick list and the club (first date kept); paid clears them; replays and old invoices change nothing wrongly");

    // 5. Pause, resume, cancel: Stripe first.
    assert.match(await pauseMemberFor(user(a), m2.id), /paused: no card charges until you resume/);
    assert.deepEqual(mock.subscriptions.get(subId).pause_collection, { behavior: "void" });
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } })).status, "PAUSED");
    assert.equal((await pickListFor(a.shopId, fq.id, next))!.rows.some((r) => r.memberId === m2.id), false);
    assert.match(await resumeMemberFor(user(a), m2.id), /active again/);
    assert.equal(mock.subscriptions.get(subId).pause_collection, null);
    // Stripe unreachable: nothing changes here.
    process.env.STRIPE_API_BASE = "http://127.0.0.1:1";
    await expectError("pause with Stripe down", () => pauseMemberFor(user(a), m2.id), /Couldn't reach the card processor/);
    await expectError("cancel with Stripe down", () => cancelMemberFor(user(a), m2.id), /Couldn't reach the card processor/);
    process.env.STRIPE_API_BASE = goodBase;
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } })).status, "ACTIVE", "a Stripe failure leaves the member as they were");
    // Paused or resumed from Stripe's dashboard.
    await send(mock.event("customer.subscription.updated", { ...mock.subscriptions.get(subId), pause_collection: { behavior: "void" } }));
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } })).status, "PAUSED");
    await send(mock.event("customer.subscription.updated", { ...mock.subscriptions.get(subId), pause_collection: null }));
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } })).status, "ACTIVE");
    // A pick not yet done goes with a cancelled member; a done one stays as history.
    await markPickDoneFor(user(a), fq.id, m2.id, next, null);
    await db.clubPick.create({ data: { shopId: a.shopId, clubId: fq.id, memberId: m2.id, month: lastMonth } });
    assert.match(await cancelMemberFor(user(a), m2.id), /cancelled and their card subscription is stopped/);
    assert.equal(mock.subscriptions.get(subId).status, "canceled");
    r2 = await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } });
    assert.deepEqual([r2.status, r2.payFailedAt !== null], ["CANCELLED", false]);
    assert.equal(await db.clubPick.count({ where: { memberId: m2.id, month: lastMonth } }), 0, "unfinished picks are removed");
    assert.equal(await db.clubPick.count({ where: { memberId: m2.id, month: next } }), 1, "a done pick stays as history");
    assert.equal((await pickListFor(a.shopId, fq.id, next))!.rows.some((r) => r.memberId === m2.id), true, "and still shows on its month");
    // Stripe's own cancellation event arrives afterwards (and one for a member cancelled in Stripe's dashboard).
    assert.deepEqual(await send(mock.event("customer.subscription.deleted", mock.subscriptions.get(subId))), { status: 200, body: "ok" });
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m2.id } })).status, "CANCELLED");
    const s3 = (await mock.pay(bomSess.id))!;
    await send(mock.event("checkout.session.completed", s3));
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m3.id } })).stripeSubscriptionId, s3.subscription);
    await send(mock.event("customer.subscription.deleted", mock.subscriptions.get(s3.subscription)));
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m3.id } })).status, "CANCELLED", "cancelled in Stripe's dashboard: cancelled here");
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m1b.id } })).status, "ACTIVE", "no other member is touched");
    ok("pause, resume and cancel go to Stripe first (a Stripe failure changes nothing here); pausing or cancelling in Stripe's dashboard is mirrored; unfinished picks go with a cancelled member, done ones stay");

    // 6. The pick list: ship or pickup, done, counts.
    await addMemberFor(user(a), fq.id, fd({ customerId: c3.id, billing: "PAY_AT_PICKUP", fulfil: "SHIP" }));
    const m3b = await db.clubMember.findFirstOrThrow({ where: { clubId: fq.id, customerId: c3.id } });
    await saveMemberFor(user(a), m3b.id, fd({ fulfil: "PICKUP", note: "Tuesdays" }));
    await saveMemberFor(user(a), m3b.id, fd({ fulfil: "SHIP" }));
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m3b.id } })).note, "Tuesdays", "a save without a note box keeps the note");
    await saveMemberFor(user(a), m1b.id, fd({ billing: "STRIPE" }));
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: m1b.id } })).billing, "STRIPE");
    await saveMemberFor(user(a), m1b.id, fd({ billing: "PAY_AT_PICKUP" }));
    list = (await pickListFor(a.shopId, fq.id, month))!;
    assert.deepEqual(list.rows.map((r) => r.name).sort(), ["Pat Pickup", "Sam Ship"].sort(), "active members, plus any who got this month's and left");
    assert.deepEqual([list.summary.pickup, list.summary.ship, list.summary.done], [0, 1, 1], "Pat already got this month's before leaving and rejoining: that stays as history");
    assert.match(await markPickDoneFor(user(a), fq.id, m3b.id, month, fd({ tracking: "9400111" })), /shipped\./);
    list = (await pickListFor(a.shopId, fq.id, month))!;
    assert.deepEqual([list.rows[list.rows.length - 1].name, list.rows[list.rows.length - 1].tracking, list.summary.done, list.summary.ship], ["Sam Ship", "9400111", 2, 0], "done rows sink to the bottom with their tracking");
    assert.equal(await pickListFor(a.shopId, fq.id, "2026-13"), null);
    ok("pick list: ship or pickup per member, tracking on a shipment, done rows last, counts; a save without a note box keeps the note; billing changes only when allowed");

    // 6b. Club money in the books: each paid month is a register sale; retries post nothing twice; a refund or "take back" voids it.
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 8 } });
    const c5 = await mk(a.shopId, "Bea Books");
    const c6 = await mk(a.shopId, "Cy Cardbooks");
    const bk = (await saveClubFor(user(a), null, fd({ name: "Books Club", kind: "FABRIC", price: "40" }))).id;
    const taken = () => registerTakenCents(a.shopId, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    const saleOf = (id: string) => db.sale.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    const t0 = await taken();
    await addMemberFor(user(a), bk, fd({ customerId: c5.id, billing: "PAY_AT_PICKUP" }));
    const mb = await db.clubMember.findFirstOrThrow({ where: { clubId: bk, customerId: c5.id } });
    await markPaidFor(user(a), bk, mb.id, month, fd({ method: "CHECK" }));
    let pays = await db.clubPayment.findMany({ where: { memberId: mb.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(pays.map((p) => [p.month, p.amountCents, p.method, p.invoiceId, p.voidedAt]), [[month, 4000, "CHECK", null, null]]);
    let sale = await saleOf(pays[0].saleId);
    assert.deepEqual([sale.status, sale.totalCents, sale.subtotalCents, sale.taxCents, sale.customerId, sale.shopId], ["COMPLETED", 4000, 3704, 296, c5.id, a.shopId], "the price includes the 8% tax, backed out");
    assert.deepEqual(sale.tenders, [{ method: "CHECK", amountCents: 4000, note: null }]);
    assert.match(sale.lines[0].description, /^Books Club: /);
    assert.equal((await taken()) - t0, 4000, "taken today includes it");
    await expectError("already paid", () => markPaidFor(user(a), bk, mb.id, month, null), /already marked paid/);
    assert.equal(await db.clubPayment.count({ where: { memberId: mb.id } }), 1, "a refused second mark posts nothing");
    assert.match(await takeBackPaidFor(user(a), bk, mb.id, month), /unpaid again and its sale in the register is voided/);
    assert.equal((await saleOf(pays[0].saleId)).status, "VOIDED");
    assert.ok((await db.clubPayment.findUniqueOrThrow({ where: { id: pays[0].id } })).voidedAt);
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: mb.id } })).paidMonth, null);
    assert.equal((await taken()) - t0, 0, "voided: nothing taken");
    await expectError("take back when unpaid", () => takeBackPaidFor(user(a), bk, mb.id, month), /isn't marked paid/);
    await markPaidFor(user(a), bk, mb.id, month, null);
    pays = await db.clubPayment.findMany({ where: { memberId: mb.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(pays.map((p) => [p.method, p.voidedAt === null]), [["CHECK", false], ["CASH", true]], "paid again: a new sale, cash by default");
    assert.notEqual(pays[0].saleId, pays[1].saleId);
    assert.equal((await taken()) - t0, 4000);
    // Card, through Stripe: the checkout's invoice posts the first month; a replay and the invoice events post nothing more.
    await addMemberFor(user(a), bk, fd({ customerId: c6.id, billing: "STRIPE" }));
    const mc = await db.clubMember.findFirstOrThrow({ where: { clubId: bk, customerId: c6.id } });
    await cardLinkFor(user(a), mc.id, new Date());
    const sessC = [...mock.sessions.values()].find((s) => s.client_reference_id === mc.id)!;
    const paidC = (await mock.pay(sessC.id))!;
    const subC = paidC.subscription as string;
    const invId = `in_bookscheck${Date.now()}`;
    const invoicePaid = (type: string, id: string, extra: Record<string, unknown>, at = Date.now()) => mock.event(type, { object: "invoice", id, subscription: subC, customer: paidC.customer, amount_paid: 4000, created: Math.floor(at / 1000), ...extra });
    const completedC = mock.event("checkout.session.completed", { ...paidC, invoice: invId, payment_intent: "pi_bookscheck1" });
    await send(completedC);
    await send(completedC);
    await send(invoicePaid("invoice.paid", invId, { payment_intent: "pi_bookscheck1" }));
    await send(invoicePaid("invoice.payment_succeeded", invId, { payment_intent: "pi_bookscheck1" }));
    pays = await db.clubPayment.findMany({ where: { memberId: mc.id } });
    assert.equal(pays.length, 1, "one invoice, one sale, however many events");
    assert.deepEqual([pays[0].month, pays[0].amountCents, pays[0].method, pays[0].invoiceId, pays[0].paymentIntent], [month, 4000, "CARD", invId, "pi_bookscheck1"]);
    sale = await saleOf(pays[0].saleId);
    assert.deepEqual([sale.clientKey, sale.totalCents, sale.taxCents, sale.customerId, (sale.tenders as { method: string }[])[0].method], [`club-inv-${invId}`, 4000, 0, c6.id, "CARD"], "Stripe's own tax (none) stands in for the shop's rate");
    assert.equal((await taken()) - t0, 8000);
    // The next month's invoice posts its own sale (twice sent: once); one with tax reported by Stripe records that tax.
    const nextInvId = `in_booksnext${Date.now()}`;
    await send(invoicePaid("invoice.paid", nextInvId, {}, Date.now() + 33 * 86_400_000));
    await send(invoicePaid("invoice.paid", nextInvId, {}, Date.now() + 33 * 86_400_000));
    const taxInvId = `in_bookstax${Date.now()}`;
    await send(invoicePaid("invoice.paid", taxInvId, { tax: 296 }, Date.now() + 64 * 86_400_000));
    pays = await db.clubPayment.findMany({ where: { memberId: mc.id }, orderBy: { month: "asc" } });
    assert.deepEqual(pays.map((p) => p.invoiceId), [invId, nextInvId, taxInvId]);
    assert.equal(pays[1].month, next);
    const taxSale = await saleOf(pays[2].saleId);
    assert.deepEqual([taxSale.taxCents, taxSale.subtotalCents, taxSale.totalCents], [296, 3704, 4000]);
    await send(mock.invoice(subC, "failed")!);
    assert.equal(await db.clubPayment.count({ where: { memberId: mc.id } }), 3, "a failed payment posts nothing");
    await expectError("take back for a card member", () => takeBackPaidFor(user(a), bk, mc.id, month), /pays by card/);
    // A refund in Stripe: partial changes nothing; a full one voids the sale and rewinds the member's paid month.
    const nextPay = pays[1];
    const refund = (o: Record<string, unknown>) => mock.event("charge.refunded", { object: "charge", amount: 4000, ...o });
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: mc.id } })).paidMonth, pays[2].month);
    assert.deepEqual(await send(refund({ invoice: nextPay.invoiceId, refunded: false, amount_refunded: 1000 })), { status: 200, body: "partial refund" });
    assert.equal((await saleOf(nextPay.saleId)).status, "COMPLETED");
    assert.deepEqual(await send(refund({ invoice: nextPay.invoiceId, refunded: true, amount_refunded: 4000 })), { status: 200, body: "ok" });
    assert.equal((await saleOf(nextPay.saleId)).status, "VOIDED");
    assert.ok((await db.clubPayment.findUniqueOrThrow({ where: { id: nextPay.id } })).voidedAt);
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: mc.id } })).paidMonth, pays[2].month, "paid further ahead: the later month stays");
    assert.deepEqual(await send(refund({ payment_intent: "pi_bookscheck1", refunded: true, amount_refunded: 4000 })), { status: 200, body: "ok" }, "found by the payment intent too");
    assert.equal((await saleOf(pays[0].saleId)).status, "VOIDED");
    assert.equal((await send(refund({ payment_intent: "pi_bookscheck1", refunded: true, amount_refunded: 4000 }))).status, 200, "a replay is harmless");
    assert.equal((await taken()) - t0, 8000, "the cash month and the taxed card month remain; the two refunded card months are out");
    // Deleting the customer stops the card subscription first (nothing is deleted if Stripe can't be reached).
    process.env.STRIPE_API_BASE = "http://127.0.0.1:1";
    await expectError("delete with Stripe down", () => deleteCustomerFor(user(a), c6.id, "Cy Cardbooks"), /couldn't be stopped|Couldn't reach/);
    process.env.STRIPE_API_BASE = goodBase;
    assert.ok(await db.customer.findUnique({ where: { id: c6.id } }), "still there");
    assert.equal((await db.clubMember.findUniqueOrThrow({ where: { id: mc.id } })).status, "ACTIVE");
    await expectError("delete with the wrong name", () => deleteCustomerFor(user(a), c6.id, "someone"), /./);
    assert.notEqual(mock.subscriptions.get(subC).status, "canceled", "a refused delete stopped nothing");
    await deleteCustomerFor(user(a), c6.id, "Cy Cardbooks");
    assert.equal(mock.subscriptions.get(subC).status, "canceled", "the subscription was cancelled at Stripe");
    assert.equal(await db.customer.count({ where: { id: c6.id } }), 0);
    assert.equal(await db.clubMember.count({ where: { id: mc.id } }), 0);
    assert.equal((await db.sale.findUniqueOrThrow({ where: { id: taxSale.id } })).customerId, null, "the club sale stays in the books without the customer");
    assert.equal((await taken()) - t0, 8000);
    // Merging a customer who still pays a club by card is refused (the membership would be deleted with them).
    const c7 = await mk(a.shopId, "Di Dup");
    await addMemberFor(user(a), bk, fd({ customerId: c7.id, billing: "PAY_AT_PICKUP" }));
    await db.clubMember.updateMany({ where: { clubId: bk, customerId: c7.id }, data: { stripeSubscriptionId: "sub_fake_dup" } });
    await expectError("merge a card member", () => mergeCustomersFor(user(a), c7.id, c5.id, "Di Dup"), /still pays for a club by card/);
    ok("club money in the books: paid months are register sales (tax backed out of the price, or Stripe's tax), in taken today; pay at pickup by method, take back voids; one sale per Stripe invoice across checkout and invoice events; failed posts nothing; a full refund voids and rewinds; deleting a customer stops the subscription first; merge refused for card members");

    // 7. Tenant: B with A's ids.
    const tables = ["Club", "ClubMember", "ClubMonth", "ClubPick", "ClubPayment", "Sale", "Customer", "KitSeriesMember", "Shop"];
    const snap = await snapshot(a.shopId, tables);
    const aClub = fq.id;
    const aMember = m3b.id;
    assert.equal(await clubFor(b.shopId, aClub), null);
    assert.equal(await pickListFor(b.shopId, aClub, month), null);
    assert.deepEqual(await clubsFor(b.shopId), []);
    await expectNotFound("saveClubFor(B, A's club)", () => saveClubFor(user(b), aClub, fd({ name: "x", price: "10" })));
    await expectNotFound("closeClubFor(B)", () => closeClubFor(user(b), aClub, true));
    await expectNotFound("addMemberFor(B, A's club)", () => addMemberFor(user(b), aClub, fd({ customerId: cb.id })));
    const bClub = await saveClubFor(user(b), null, fd({ name: "B club", price: "10" }));
    await expectNotFound("addMemberFor(B, A's customer)", () => addMemberFor(user(b), bClub.id, fd({ customerId: c1.id })));
    await expectNotFound("saveMemberFor(B)", () => saveMemberFor(user(b), aMember, fd({ fulfil: "PICKUP" })));
    await expectNotFound("cardLinkFor(B)", () => cardLinkFor(user(b), aMember));
    await expectNotFound("pauseMemberFor(B)", () => pauseMemberFor(user(b), aMember));
    await expectNotFound("resumeMemberFor(B)", () => resumeMemberFor(user(b), aMember));
    await expectNotFound("cancelMemberFor(B)", () => cancelMemberFor(user(b), aMember));
    await expectNotFound("markPickDoneFor(B)", () => markPickDoneFor(user(b), aClub, aMember, month, null));
    await expectNotFound("markPickDoneFor(B, own club, A's member)", () => markPickDoneFor(user(b), bClub.id, aMember, month, null));
    await expectNotFound("undoPickFor(B)", () => undoPickFor(user(b), aClub, aMember, month));
    await expectNotFound("markPaidFor(B)", () => markPaidFor(user(b), aClub, aMember, month));
    await expectNotFound("takeBackPaidFor(B)", () => takeBackPaidFor(user(b), aClub, aMember, month));
    await expectNotFound("setMonthFor(B)", () => setMonthFor(user(b), aClub, month, fd({ what: "x" })));
    // Another shop's webhook secret can't touch A's members, and A's endpoint refuses B's secret.
    await db.shop.update({ where: { id: b.shopId }, data: { stripeKeySealed: seal(KEY, b.shopId, "stripeKey"), stripeWebhookSealed: seal(WHSEC_B, b.shopId, "stripeWebhook") } });
    const s2 = [...mock.subscriptions.values()].find((s) => s.id === subId)!;
    const fail = mock.event("invoice.payment_failed", { object: "invoice", subscription: s2.id, customer: s2.customer, created: Math.floor(Date.now() / 1000) });
    assert.deepEqual(await send(fail, WHSEC_B, b.shopId), { status: 200, body: "no member" });
    assert.equal((await send(fail, WHSEC_B, a.shopId)).status, 400);
    const m3c = await db.clubMember.findFirstOrThrow({ where: { clubId: bom.id, customerId: c3.id } });
    assert.deepEqual(await send(mock.event("customer.subscription.deleted", { object: "subscription", id: m3c.stripeSubscriptionId }), WHSEC_B, b.shopId), { status: 200, body: "no member" });
    assertUnchanged("tenant", snap, await snapshot(a.shopId, tables));
    assert.equal(await db.clubMember.count({ where: { shopId: b.shopId } }), 0);
    ok("tenant: B can't read, change, add to, bill, pause, cancel or mark done anything of A's, and B's webhook secret reaches none of A's members; A's rows are unchanged");
  } finally {
    await mock.close();
    await cleanup();
  }
  console.log(`clubs.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
