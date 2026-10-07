// Pay links sent by staff (shop-features-round-2-design.md 1.3): what a shop needs first, the refusals (no customer, a
// tech typing an amount), the link made (tax, 14 days, the message queued), the customer's Pay button (an open Stripe
// page reused, a new one after it ran out), paid by the webhook into a sale with tender "Paid online" (money only: done
// at once; with an item: paid, stock off), a link run out and one taken back, and the tenant section.
//   npm run -s check scripts/checks/pay-links.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { cancelPayLinkFor, makePayLinkFor, openPayLink, payLinkProblem, payLinksFor, resendPayLinkFor } from "@/lib/pay-links";
import { expireStaleOrders, handleWebhook, orderByToken, saveShopSettingsFor } from "@/lib/shop/online-shop";
import { signWebhook } from "@/lib/shop/stripe";
import { checkShop, cleanup, clearKick, messagingFor, withSink } from "./lib";
import { expectNotFound, RUN } from "./tenant";
import { startStripeMock } from "../test-mail/stripe-mock.mjs";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

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

const KEY = "sk_test_paylink1234567890";
const WHSEC = "whsec_paylink1234567890";
const tokenOf = (link: string) => link.split("/shop/o/")[1];

async function main() {
  await withSink();
  const mock = await startStripeMock({ port: 0, webhookBase: null, webhookSecret: WHSEC });
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.PUBLIC_URL = "http://localhost:3999";
  delete process.env.STRIPE_SECRET_KEY;
  // A base shop (no Marketing): pay links are in the base since 7 Oct 2026.
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await messagingFor(a.shopId, { email: true });
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 5 } });
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Paylink", email: "jane@example.test", notifyBy: "email" } });
    const part = await db.part.create({ data: { shopId: a.shopId, partNumber: "PL-1", description: "Walking foot", priceCents: 4000, qtyOnHand: 3, numberKeys: ["PL1"], kind: "ACCESSORY" } });

    // 1. What a shop needs first; the refusals.
    assert.match((await payLinkProblem(a.shopId)) ?? "", /Stripe key/);
    await saveShopSettingsFor(a.user, form({ slug: `check-${RUN}-pl`, pickup: "on", shipRate: "0", payVia: "own", stripeKey: KEY, stripeWebhook: WHSEC }));
    assert.equal(await payLinkProblem(a.shopId), null);
    const line = { description: "Balance on the Tula Pink kit", unitPriceCents: 3495, taxable: true };
    await expectError("no customer", () => makePayLinkFor(a.user, { customerId: null, lines: [line] }), /customer/);
    await expectError("nothing on it", () => makePayLinkFor(a.user, { customerId: jane.id, lines: [] }), /paying for/);
    await expectError("a tech typing an amount", () => makePayLinkFor({ ...a.user, role: "TECH" }, { customerId: jane.id, lines: [line] }), /owner or admin/);
    await expectError("a tech changing an item's price", () => makePayLinkFor({ ...a.user, role: "TECH" }, { customerId: jane.id, lines: [{ partId: part.id, unitPriceCents: 100 }] }), /owner or admin/);
    await expectError("too small", () => makePayLinkFor(a.user, { customerId: jane.id, lines: [{ description: "x", unitPriceCents: 10 }] }), /\$0\.50/);
    ok("needs the shop's Stripe key first; refuses no customer, no lines, a tech's typed amount or price, under $0.50");

    // 2. Made and sent.
    const now = new Date();
    const r1 = await makePayLinkFor(a.user, { customerId: jane.id, lines: [line], note: "Thanks!" }, { now });
    const o1 = await db.webOrder.findUniqueOrThrow({ where: { id: r1.orderId } });
    assert.ok(o1.source === "staff" && o1.status === "PENDING" && o1.createdById === a.user.id && !o1.stripeSessionId);
    assert.deepEqual([o1.subtotalCents, o1.taxCents, o1.totalCents], [3495, 175, 3670]);
    assert.equal(Math.round((o1.expiresAt!.getTime() - now.getTime()) / 86_400_000), 14);
    assert.match(r1.told, /Sent to her by email/);
    const msg = await db.outMessage.findFirstOrThrow({ where: { shopId: a.shopId, refType: "web_order", refId: o1.id } });
    assert.ok(msg.body.includes(r1.link) && msg.body.includes("$36.70"), "the message carries the link and the total");
    assert.ok(msg.kind === "pay_link" && msg.purpose === "notice", "a pay link is its own base notice kind");
    const view = (await orderByToken(tokenOf(r1.link)))!;
    assert.ok(view.payLink && view.status === "PENDING");
    ok("a link made on a base shop (no Marketing): taxed lines at the shop's rate, 14 days, the pay_link email queued with the link and the total");

    // 3. The Pay button: one Stripe page, reused; paid by the webhook into a sale; money only is done at once.
    const url1 = await openPayLink(tokenOf(r1.link), now);
    const url1b = await openPayLink(tokenOf(r1.link), now);
    assert.equal(url1, url1b, "an open page is reused");
    const sid = (await db.webOrder.findUniqueOrThrow({ where: { id: o1.id } })).stripeSessionId!;
    const sess = await mock.pay(sid);
    const body = JSON.stringify({ id: "evt_pl1", type: "checkout.session.completed", data: { object: sess } });
    assert.equal((await handleWebhook(a.shopId, body, signWebhook(body, WHSEC), now)).status, 200);
    const paid = await db.webOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.ok(paid.status === "DONE" && paid.saleId && paid.paidAt, "money only: done at once");
    const sale = await db.sale.findUniqueOrThrow({ where: { id: paid.saleId! }, include: { lines: true } });
    assert.ok(sale.totalCents === 3670 && sale.taxCents === 175 && sale.customerId === jane.id);
    assert.deepEqual(sale.tenders, [{ method: "ONLINE", amountCents: 3670, note: `Pay link #${o1.number}` }]);
    assert.ok(sale.lines.length === 1 && sale.lines[0].taxable && sale.lines[0].description === line.description);
    await expectError("paying again", () => openPayLink(tokenOf(r1.link), now), /paid already/);
    ok("Pay opens one Stripe page (reused); paid, the sale is in the books with tender Paid online and the link is done");

    // 4. An item: paid waits to be picked up, stock comes off. Its page ran out: the link stays open, a new page is made.
    const r2 = await makePayLinkFor(a.user, { customerId: jane.id, lines: [{ partId: part.id, unitPriceCents: 4000, qty: 1 }], send: "none" }, { now });
    assert.match(r2.told, /Copy the link/);
    await openPayLink(tokenOf(r2.link), now);
    const first = (await db.webOrder.findUniqueOrThrow({ where: { id: r2.orderId } })).stripeSessionId!;
    const expired = { ...mock.sessions.get(first), status: "expired" };
    mock.sessions.get(first).status = "expired";
    const ebody = JSON.stringify({ id: "evt_pl2", type: "checkout.session.expired", data: { object: expired } });
    await handleWebhook(a.shopId, ebody, signWebhook(ebody, WHSEC), now);
    const after = await db.webOrder.findUniqueOrThrow({ where: { id: r2.orderId } });
    assert.ok(after.status === "PENDING", "a pay link outlives its Stripe page");
    await openPayLink(tokenOf(r2.link), now);
    const second = (await db.webOrder.findUniqueOrThrow({ where: { id: r2.orderId } })).stripeSessionId!;
    assert.notEqual(second, first);
    const s2 = await mock.pay(second);
    const b2 = JSON.stringify({ id: "evt_pl3", type: "checkout.session.completed", data: { object: s2 } });
    await handleWebhook(a.shopId, b2, signWebhook(b2, WHSEC), now);
    const p2 = await db.webOrder.findUniqueOrThrow({ where: { id: r2.orderId } });
    assert.ok(p2.status === "PAID" && p2.saleId, "with an item: paid, to pick up");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand, 2);
    ok("an item on a link: paid waits for pickup and the stock comes off; an expired Stripe page leaves the link open and a new one is made");

    // 5. Run out; taken back; sent again.
    const r3 = await makePayLinkFor(a.user, { customerId: jane.id, lines: [line], days: 1, send: "none" }, { now });
    await expireStaleOrders(new Date(now.getTime() + 2 * 86_400_000));
    assert.equal((await db.webOrder.findUniqueOrThrow({ where: { id: r3.orderId } })).status, "CANCELLED");
    await expectError("a run out link", () => openPayLink(tokenOf(r3.link), now), /cancelled/);
    const r4 = await makePayLinkFor(a.user, { customerId: jane.id, lines: [line], send: "none" }, { now });
    await expireStaleOrders(new Date(now.getTime() + 3 * 3_600_000));
    assert.equal((await db.webOrder.findUniqueOrThrow({ where: { id: r4.orderId } })).status, "PENDING", "the online shop's two-hour rule doesn't touch a pay link");
    assert.match(await resendPayLinkFor(a.user, r4.orderId, now), /Sent to her/);
    await cancelPayLinkFor(a.user, r4.orderId, now);
    await expectError("taking it back twice", () => cancelPayLinkFor(a.user, r4.orderId, now), /cancelled already/);
    await expectError("paying a taken back link", () => openPayLink(tokenOf(r4.link), now), /cancelled/);
    const list = await payLinksFor(a.shopId);
    assert.equal(list.length, 4);
    ok("a link past its day is cancelled (not by the two-hour rule); sent again; taken back and then refused");

    // 6. Tenant.
    const r5 = await makePayLinkFor(a.user, { customerId: jane.id, lines: [line], send: "none" }, { now });
    await expectNotFound("B sends A's link again", () => resendPayLinkFor(b.user, r5.orderId, now));
    await expectNotFound("B takes A's link back", () => cancelPayLinkFor(b.user, r5.orderId, now));
    await saveShopSettingsFor(b.user, form({ slug: `check-${RUN}-plb`, pickup: "on", shipRate: "0", payVia: "own", stripeKey: KEY, stripeWebhook: "whsec_bbbbbbbbbbbb" }));
    await expectNotFound("B makes a link for A's customer", () => makePayLinkFor(b.user, { customerId: jane.id, lines: [line] }));
    assert.deepEqual(await payLinksFor(b.shopId), []);
    assert.equal((await db.webOrder.findUniqueOrThrow({ where: { id: r5.orderId } })).status, "PENDING");
    ok("tenant: another company can't send, take back or list A's links, nor make one for A's customer");

    console.log(`pay-links.check: ${steps} groups passed`);
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
