// Live-sale claim list (shop-features-round-2-design.md 4.3): start a sale, claims hold stock (what's left, all claimed,
// fabric in eighths, a tech at the item's price only), take off and undo, send pay links (one per buyer; a new name
// becomes a customer, found by phone if she's there), paid by the webhook (the claims paid, the stock off once), unpaid
// after the hold time: let go (the link taken back, the stock free), and the tenant section.
//   npm run -s check scripts/checks/live-sales.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { claimFor, dropClaimFor, letGoFor, liveHeld, liveSalesFor, liveView, resendBuyerFor, sendLinksFor, setPickFor, startLiveSaleFor, undropClaimFor } from "@/lib/live-sales";
import { handleWebhook, priceCart, publicStore, saveShopSettingsFor } from "@/lib/shop/online-shop";
import { openPayLink } from "@/lib/pay-links";
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

const KEY = "sk_test_livesale1234567890";
const WHSEC = "whsec_livesale1234567890";

async function main() {
  await withSink();
  const mock = await startStripeMock({ port: 0, webhookBase: null, webhookSecret: WHSEC });
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.PUBLIC_URL = "http://localhost:3999";
  delete process.env.STRIPE_SECRET_KEY;
  const a = await checkShop({ retail: true, modules: ["marketing"] });
  const b = await checkShop({ retail: true });
  const tech = { ...a.user, role: "TECH" as const };
  try {
    await messagingFor(a.shopId, { email: true });
    await saveShopSettingsFor(a.user, form({ slug: `check-${RUN}-ls`, pickup: "on", shipRate: "0", payVia: "own", stripeKey: KEY, stripeWebhook: WHSEC }));
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Live", email: "jane-live@example.test", notifyBy: "email" } });
    const sue = await db.customer.create({ data: { shopId: a.shopId, name: "Sue Phone", phone: "(555) 201-3344", email: "sue@example.test", notifyBy: "email" } });
    const charm = await db.part.create({ data: { shopId: a.shopId, partNumber: "LS-1", description: "Tula Pink charm pack", priceCents: 1500, qtyOnHand: 3, numberKeys: ["LS1"], kind: "FABRIC" } });
    const yard = await db.part.create({ data: { shopId: a.shopId, partNumber: "LS-2", description: "Kona White", priceCents: 1000, qtyOnHand: 4, unit: "yd", numberKeys: ["LS2"], kind: "FABRIC" } });

    // 1. Start; claims hold stock.
    const sid = await startLiveSaleFor(a.user, { name: null, holdHours: 48 });
    await expectError("a bad hold", () => startLiveSaleFor(a.user, { holdHours: 0 }), /1 hour/);
    await setPickFor(a.user, sid, yard.id, true);
    await claimFor(a.user, sid, { partId: charm.id, customerId: jane.id, qty: 2 });
    await expectError("more than is left", () => claimFor(a.user, sid, { partId: charm.id, name: "Ann New", qty: 2 }), /Only 1 left/);
    await expectError("no name", () => claimFor(a.user, sid, { partId: charm.id, qty: 1 }), /buyer's name/);
    await expectError("fabric not in eighths", () => claimFor(a.user, sid, { partId: yard.id, name: "Ann New", qty: 1.3 }), /eighths/);
    await expectError("a tech's price", () => claimFor(tech, sid, { partId: charm.id, name: "Ann New", qty: 1, priceCents: 900 }), /owner or admin/);
    const annClaim = await claimFor(tech, sid, { partId: charm.id, name: "Ann New", phone: "555 777 1212", qty: 1 });
    await claimFor(a.user, sid, { partId: yard.id, name: "Sue Phone", phone: "555-201-3344", qty: 1.5, priceCents: 900 });
    await expectError("all claimed", () => claimFor(a.user, sid, { partId: charm.id, name: "Bea", qty: 1 }), /all claimed/);
    assert.equal((await liveHeld(a.shopId)).get(charm.id), 3);
    let v = (await liveView(a.shopId, sid))!;
    assert.ok(v.name.startsWith("Facebook Live, "));
    assert.deepEqual(
      v.picks.map((p) => [p.partNumber, p.left]),
      [["LS-2", 2.5], ["LS-1", 0]],
    );
    assert.equal(v.buyers.length, 3);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: charm.id } })).qtyOnHand, 3, "held, not moved");
    // The online shop doesn't sell what is claimed (review fix): all 3 charm packs claimed, out of stock online; 2.5 yd left.
    await db.part.updateMany({ where: { id: { in: [charm.id, yard.id] } }, data: { online: true } });
    const web = (await publicStore(`check-${RUN}-ls`))!;
    const cartView = await priceCart(web, new Map([[charm.id, 1], [yard.id, 3]]), "pickup");
    assert.deepEqual(cartView.lines.map((l) => [l.partNumber, l.available]), [["LS-1", 0], ["LS-2", 2.5]]);
    assert.equal(cartView.lines[0].problem, "Out of stock");
    assert.ok(cartView.lines[1].problem?.startsWith("Only"));
    await db.part.updateMany({ where: { id: { in: [charm.id, yard.id] } }, data: { online: false } });
    ok("a live sale started; claims hold stock (what's left, all claimed), fabric in eighths, a tech at the item's price, a show price by the owner");

    // 2. Take off and undo.
    await dropClaimFor(a.user, annClaim);
    assert.equal((await liveHeld(a.shopId)).get(charm.id), 2);
    await undropClaimFor(a.user, annClaim);
    assert.equal((await liveHeld(a.shopId)).get(charm.id), 3);
    ok("a claim taken off frees the stock; Undo holds it again");

    // 3. Send pay links: one per buyer; a new name becomes a customer; Sue found by her phone.
    const told = await sendLinksFor(a.user, sid);
    assert.match(told, /Pay links sent to 2 buyers/);
    assert.match(told, /Copy the link for Ann New/, "Ann has a phone but texts aren't set up");
    const claims = await db.liveClaim.findMany({ where: { liveSaleId: sid } });
    assert.ok(claims.every((c) => c.status === "SENT" && c.webOrderId && c.customerId));
    assert.equal(claims.find((c) => c.name === "Sue Phone")!.customerId, sue.id, "found by phone");
    const ann = await db.customer.findFirstOrThrow({ where: { shopId: a.shopId, name: "Ann New" } });
    assert.ok(ann.phone === "555 777 1212" && ann.notifyBy === "sms");
    const janeOrder = await db.webOrder.findUniqueOrThrow({ where: { id: claims.find((c) => c.customerId === jane.id)!.webOrderId! } });
    assert.ok(janeOrder.source === "staff" && janeOrder.subtotalCents === 3000 && janeOrder.note?.includes("Facebook Live"));
    const sueOrder = await db.webOrder.findUniqueOrThrow({ where: { id: claims.find((c) => c.customerId === sue.id)!.webOrderId! } });
    assert.equal(sueOrder.subtotalCents, 1350, "1.5 yd at the show price $9.00");
    assert.equal((await db.liveSale.findUniqueOrThrow({ where: { id: sid } })).status, "CLOSED");
    await expectError("claiming after the end", () => claimFor(a.user, sid, { partId: yard.id, name: "Bea", qty: 1 }), /ended/);
    await expectError("sending again", () => sendLinksFor(a.user, sid), /No claims waiting/);
    assert.match(await resendBuyerFor(a.user, sid, janeOrder.id), /Sent to her/);
    ok("Send pay links: one link per buyer at the claimed prices, a new name made a customer, one found by phone; the show ends");

    // 4. Jane pays: her claims are paid and the stock comes off once.
    const tokenRow = await db.webOrder.findUniqueOrThrow({ where: { id: janeOrder.id } });
    const { unseal } = await import("@/lib/messaging/secrets");
    const link = unseal(tokenRow.linkSealed, a.shopId, `orderLink:${tokenRow.id}`)!.plain;
    await openPayLink(link.split("/shop/o/")[1]);
    const session = await mock.pay((await db.webOrder.findUniqueOrThrow({ where: { id: janeOrder.id } })).stripeSessionId!);
    const body = JSON.stringify({ id: "evt_ls1", type: "checkout.session.completed", data: { object: session } });
    assert.equal((await handleWebhook(a.shopId, body, signWebhook(body, WHSEC))).status, 200);
    v = (await liveView(a.shopId, sid))!;
    assert.equal(v.counts.paid, 1);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: charm.id } })).qtyOnHand, 1, "2 sold");
    assert.equal((await liveHeld(a.shopId)).get(charm.id), 1, "Ann's one still held");
    await expectError("letting a paid one go", () => letGoFor(a.user, sid, janeOrder.id), /Nothing to let go|paid/);
    ok("paid by the webhook: her claims are paid, the stock came off once (the sale), the rest still held");

    // 5. Unpaid after the hold time: Let go of these.
    const later = new Date(Date.now() + 49 * 3_600_000);
    v = (await liveView(a.shopId, sid, later))!;
    const sueBuyer = v.buyers.find((x) => x.name === "Sue Phone")!;
    assert.ok(sueBuyer.overdue);
    await letGoFor(a.user, sid, sueOrder.id);
    assert.equal((await db.webOrder.findUniqueOrThrow({ where: { id: sueOrder.id } })).status, "CANCELLED");
    assert.equal((await liveHeld(a.shopId)).get(yard.id) ?? 0, 0);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: yard.id } })).qtyOnHand, 4);
    const list = await liveSalesFor(a.shopId);
    assert.ok(list[0].id === sid && list[0].paidCents === 3000 && list[0].waiting === 1);
    ok("unpaid after the hold time: Let go takes her link back and frees the stock; the list shows paid and waiting");

    // 6. Tenant.
    const annOrder = claims.find((c) => c.name === "Ann New")!.webOrderId!;
    await expectNotFound("B claims on A's sale", () => claimFor(b.user, sid, { partId: charm.id, name: "X", qty: 1 }));
    const bs = await startLiveSaleFor(b.user, {});
    await expectError("B claims A's item", () => claimFor(b.user, bs, { partId: charm.id, name: "X", qty: 1 }), /Choose the item/);
    await expectNotFound("B lets A's buyer go", () => letGoFor(b.user, sid, annOrder));
    await expectNotFound("B resends A's link", () => resendBuyerFor(b.user, sid, annOrder));
    await expectNotFound("B sends A's links", () => sendLinksFor(b.user, sid));
    await expectNotFound("B takes off A's claim", () => dropClaimFor(b.user, claims[0].id));
    await expectNotFound("B picks for A's sale", () => setPickFor(b.user, sid, charm.id, true));
    assert.equal(await liveView(b.shopId, sid), null);
    assert.equal((await liveSalesFor(b.shopId)).length, 1);
    assert.equal((await db.webOrder.findUniqueOrThrow({ where: { id: annOrder } })).status, "PENDING");
    ok("tenant: another company can't claim, send, let go, resend, take off or pick on A's sale, nor see it");

    console.log(`live-sales.check: ${steps} groups passed`);
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
