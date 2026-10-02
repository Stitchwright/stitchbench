// The online shop (online-and-parts-design.md section 3, package online-shop): the settings (address, on, pickup and
// shipping, who takes the money with the Stripe keys sealed, order mail in the cap), an item's listing and photos,
// the public store by slug (off, no counter, no keys), the catalog and search, the cart in the address and its
// pricing (the shop's rate, shipping untaxed, free over), checkout (the customer matched or made, a PENDING order,
// the Stripe session whose total is the order's), payment by the webhook and by the return page (once; the sale in
// the books with tender ONLINE, stock off, the "paid" message with the order link), items short of stock at payment
// (sold short, the difference refunded; nothing left: cancelled and refunded), the staff steps (ready, picked up,
// shipped with tracking, cancel and refund with the sale voided and stock back), stale orders, and the tenant section.
//   npm run check scripts/checks/online-shop.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { unseal } from "@/lib/messaging/secrets";
import { saleTotals } from "@/lib/register-math";
import { signWebhook } from "@/lib/shop/stripe";
import {
  addPhotoFor,
  applyPayment,
  cancelOrderFor,
  cartWith,
  catalog,
  catalogItem,
  catalogKinds,
  confirmFromReturn,
  encodeCart,
  expireStaleOrders,
  handleWebhook,
  markDoneFor,
  markReadyFor,
  MAX_LINES,
  orderByToken,
  orderNoticeStillWanted,
  ordersFor,
  parseCart,
  priceCart,
  publicPhoto,
  publicStore,
  removePhotoFor,
  saveListingFor,
  saveShopSettingsFor,
  shopSettings,
  startCheckout,
  type OrderItem,
} from "@/lib/shop/online-shop";
import { MOCK_TAX_RATE, startStripeMock } from "../test-mail/stripe-mock.mjs";
import { checkShop, cleanup, clearKick, messagingFor, withSink } from "./lib";
import { expectNotFound, RUN } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

function form(entries: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
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

const KEY = "sk_test_check1234567890";
const WHSEC = "whsec_check1234567890";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const png = (name = "a.png") => new File([new Uint8Array(PNG)], name, { type: "image/png" });
const cust = (name: string, phone: string | null, email: string | null, notify = "email") => ({ name, phone, email, notify });
const base = (entries: Record<string, string | string[]>) => form({ slug: "", pickup: "on", shipRate: "6.00", payVia: "own", ...entries });

async function main() {
  await withSink();
  const mock = await startStripeMock({ port: 0, webhookBase: null, webhookSecret: WHSEC });
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.PUBLIC_URL = "http://localhost:3999";
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const a = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
  const b = await checkShop({ retail: true });
  const bench = await checkShop({ repair: true }); // no counter
  const slugA = `check-${RUN}-shop`;
  try {
    await messagingFor(a.shopId, { email: true });
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 6.35, phone: "(212) 555-0100", address: "12 Main St" } });
    const now = new Date();

    // 1. Settings.
    await expectError("no counter", () => saveShopSettingsFor(bench.user, base({ slug: `check-${RUN}-bench`, on: "on" })), /Sells over the counter/);
    await expectError("on without a slug", () => saveShopSettingsFor(a.user, base({ on: "on" })), /address first/);
    await expectError("on without keys", () => saveShopSettingsFor(a.user, base({ slug: slugA, on: "on" })), /secret key and the webhook/);
    await expectError("a bad key", () => saveShopSettingsFor(a.user, base({ slug: slugA, stripeKey: "pk_test_notsecret" })), /secret key starts with/);
    await expectError("a bad webhook secret", () => saveShopSettingsFor(a.user, base({ slug: slugA, stripeWebhook: "nope" })), /whsec_/);
    await expectError(
      "neither pickup nor shipping",
      () => saveShopSettingsFor(a.user, base({ slug: slugA, on: "on", pickup: "off", stripeKey: KEY, stripeWebhook: WHSEC })),
      /pickup, shipping or both/,
    );
    await expectError("platform without server keys", () => saveShopSettingsFor(a.user, base({ slug: slugA, payVia: "platform" })), /no account of its own/);
    await expectError("a tech", () => saveShopSettingsFor({ ...a.user, role: "TECH" }, base({ slug: slugA })), /owner or admin/);
    await saveShopSettingsFor(
      a.user,
      base({ slug: slugA, on: "on", shipping: "on", shipRate: "6.00", freeOver: "50", stripeKey: KEY, stripeWebhook: WHSEC, welcome: "Hello!", pickupNote: "Ring the bell.", ordersInCap: "on" }),
    );
    let s = await shopSettings(a.shopId);
    assert.ok(
      s.slug === slugA &&
        s.on &&
        s.pickup &&
        s.shipping &&
        s.shipCents === 600 &&
        s.freeOverCents === 5000 &&
        s.payVia === "own" &&
        s.hasStripeKey &&
        s.hasWebhookSecret &&
        s.welcome === "Hello!" &&
        s.pickupNote === "Ring the bell." &&
        s.ordersInCap,
    );
    const sealedShop = await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { stripeKeySealed: true, stripeWebhookSealed: true } });
    assert.notEqual(sealedShop.stripeKeySealed, KEY);
    assert.equal(unseal(sealedShop.stripeKeySealed, a.shopId, "stripeKey")?.plain, KEY);
    assert.equal(unseal(sealedShop.stripeWebhookSealed, a.shopId, "stripeWebhook")?.plain, WHSEC);
    // Blank keys keep the saved ones; the slug is shared with booking.
    await saveShopSettingsFor(a.user, base({ slug: slugA, on: "on", shipping: "on", shipRate: "6.00", freeOver: "50", pickupNote: "Ring the bell." }));
    s = await shopSettings(a.shopId);
    assert.ok(s.hasStripeKey && s.hasWebhookSecret && !s.ordersInCap);
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { bookingSlug: true } })).bookingSlug, slugA);
    await expectError("B takes A's slug", () => saveShopSettingsFor(b.user, base({ slug: slugA })), /is taken/);
    ok("settings: the refusals (no counter, no address, no keys, bad keys, nothing offered, the platform without keys, a tech); keys sealed and kept when blank; the shared address");

    // 2. Listing and photos.
    const foot = await db.part.create({
      data: {
        shopId: a.shopId,
        partNumber: `WF-${RUN}`,
        description: "Walking foot",
        brand: "Janome",
        fits: "MC6700P, HD3000",
        qtyOnHand: 5,
        priceCents: 2999,
        numberKeys: [`WF${RUN}`.toUpperCase()],
      },
    });
    const bobbins = await db.part.create({
      data: { shopId: a.shopId, partNumber: `BB-${RUN}`, description: "Bobbins, 10 pack", kind: "ACCESSORY", qtyOnHand: 0, priceCents: 899, numberKeys: [`BB${RUN}`.toUpperCase()] },
    });
    const fabric = await db.part.create({
      data: { shopId: a.shopId, partNumber: `FQ-${RUN}`, description: "Quilting cotton, blue", kind: "FABRIC", unit: "yd", qtyOnHand: 10, priceCents: 1200, numberKeys: [`FQ${RUN}`.toUpperCase()] },
    });
    const noPrice = await db.part.create({ data: { shopId: a.shopId, partNumber: `NP-${RUN}`, description: "Mystery part", qtyOnHand: 1, numberKeys: [`NP${RUN}`.toUpperCase()] } });
    const consigned = await db.part.create({
      data: { shopId: a.shopId, partNumber: `CS-${RUN}`, description: "Consigned belt", qtyOnHand: 3, priceCents: 500, consignLinkId: "link-x", consignItemKey: "k", numberKeys: [] },
    });
    await expectError("no price", () => saveListingFor(a.user, noPrice.id, form({ online: "on" })), /price/);
    await expectError("consigned", () => saveListingFor(a.user, consigned.id, form({ online: "on" })), /consigned/);
    await saveListingFor(a.user, foot.id, form({ online: "on", onlineTitle: "Janome walking foot (even feed)", onlineText: "Fits most 7 mm Janome machines." }));
    await saveListingFor(a.user, bobbins.id, form({ online: "on" }));
    await saveListingFor(a.user, fabric.id, form({ online: "on" }));
    // A tech may change the words, not the listing.
    await saveListingFor({ ...a.user, role: "TECH" }, foot.id, form({ online: "off", onlineTitle: "Janome walking foot" }));
    const footRow = await db.part.findUniqueOrThrow({ where: { id: foot.id } });
    assert.ok(footRow.online && footRow.onlineTitle === "Janome walking foot");
    const ph1 = await addPhotoFor(a.user, foot.id, png());
    await addPhotoFor(a.user, foot.id, png("b.png"));
    await addPhotoFor(a.user, foot.id, png("c.png"));
    await addPhotoFor(a.user, foot.id, png("d.png"));
    await expectError("a fifth photo", () => addPhotoFor(a.user, foot.id, png("e.png")), /up to 4/);
    await expectError("not an image", () => addPhotoFor(a.user, foot.id, new File([new Uint8Array([1, 2])], "x.txt", { type: "text/plain" })), /JPEG, PNG or WebP/);
    assert.ok((await publicPhoto(ph1))?.mime === "image/png", "a listed item's photo is public");
    await removePhotoFor(a.user, ph1);
    assert.equal(await publicPhoto(ph1), null);
    assert.equal(await db.partPhoto.count({ where: { partId: foot.id } }), 3);
    ok("listing: needs a price, never consigned; a tech edits the words only; up to four photos, images only, public while listed");

    // 3. The public store, the catalog and search.
    let store = await publicStore(slugA);
    assert.ok(store && store.open && store.id === a.shopId && store.shipCents === 600 && store.freeOverCents === 5000 && store.taxRatePct === 6.35);
    assert.equal(await publicStore("no-such-shop"), null);
    await saveShopSettingsFor(a.user, base({ slug: slugA, shipping: "on", shipRate: "6.00", freeOver: "50", pickupNote: "Ring the bell." })); // off
    assert.equal((await publicStore(slugA))?.open, false);
    await saveShopSettingsFor(a.user, base({ slug: slugA, on: "on", shipping: "on", shipRate: "6.00", freeOver: "50", pickupNote: "Ring the bell." }));
    store = await publicStore(slugA);
    const all = await catalog(a.shopId);
    assert.deepEqual(
      all.map((i) => i.id),
      [foot.id, fabric.id, bobbins.id],
      "listed items, in stock first",
    );
    assert.ok(all[0].title === "Janome walking foot" && all[0].photoId && !all[2].inStock);
    assert.deepEqual(
      (await catalog(a.shopId, { q: `wf-${RUN}` })).map((i) => i.id),
      [foot.id],
      "by number, any case",
    );
    assert.deepEqual(
      (await catalog(a.shopId, { q: "walking janome" })).map((i) => i.id),
      [foot.id],
      "by words",
    );
    assert.deepEqual(
      (await catalog(a.shopId, { q: "HD3000" })).map((i) => i.id),
      [foot.id],
      "by what it fits",
    );
    assert.deepEqual(
      (await catalog(a.shopId, { kind: "FABRIC" })).map((i) => i.id),
      [fabric.id],
      "by kind",
    );
    assert.deepEqual(
      (await catalogKinds(a.shopId)).map((k) => [k.kind, k.n]),
      [
        ["ACCESSORY", 1],
        ["FABRIC", 1],
        ["PART", 1],
      ],
    );
    const item = await catalogItem(a.shopId, foot.id);
    assert.ok(item && item.photoIds.length === 3 && item.text === "Fits most 7 mm Janome machines." && item.fits === "MC6700P, HD3000");
    assert.equal(await catalogItem(a.shopId, noPrice.id), null);
    assert.equal(await catalogItem(b.shopId, foot.id), null, "another shop's item");
    ok("the public store: open only when on with keys; the catalog in stock first, search by number, words, fit and kind; an item with its photos");

    // 4. The cart and its pricing.
    let cart = parseCart(null);
    cart = cartWith(cart, foot.id, 2);
    cart = cartWith(cart, fabric.id, 2.5);
    cart = cartWith(cart, "not-an-id", 1);
    assert.equal(encodeCart(cart), `${foot.id}:2,${fabric.id}:2.5`);
    assert.deepEqual([...parseCart(encodeCart(cart)).entries()], [...cart.entries()]);
    assert.equal(parseCart(`${foot.id}:0,${fabric.id}:abc,${foot.id}:500`).get(foot.id), 99, "capped");
    const big = new Map(Array.from({ length: MAX_LINES }, (_, i) => [`c${String(i).padStart(24, "0")}`, 1]));
    await expectError("too many lines", async () => cartWith(big, foot.id, 1), /up to 30/);
    const pick = await priceCart(store!, cart, "pickup");
    const expect1 = saleTotals(
      [
        { qty: 2, unitPriceCents: 2999, taxable: true },
        { qty: 2.5, unitPriceCents: 1200, taxable: true },
      ],
      0,
      6.35,
    );
    assert.ok(pick.subtotalCents === 8998 && pick.shipCents === 0 && pick.taxCents === expect1.tax && pick.totalCents === expect1.total && pick.problems.length === 0);
    const ship = await priceCart(store!, cart, "ship");
    assert.ok(ship.shipCents === 0 && ship.totalCents === pick.totalCents, "free over $50");
    const small = await priceCart(store!, cartWith(new Map(), foot.id, 1), "ship");
    const expect2 = saleTotals(
      [
        { qty: 1, unitPriceCents: 2999, taxable: true },
        { qty: 1, unitPriceCents: 600, taxable: false },
      ],
      0,
      6.35,
    );
    assert.ok(small.shipCents === 600 && small.taxCents === expect2.tax && small.totalCents === expect2.total, "shipping charged, untaxed");
    const over = await priceCart(store!, cartWith(cartWith(new Map(), foot.id, 7), bobbins.id, 1), "pickup");
    assert.ok(over.problems.some((p) => /only 5 left/i.test(p)) && over.problems.some((p) => /out of stock/.test(p)));
    const gone = await priceCart(store!, cartWith(new Map(), noPrice.id, 1), "pickup");
    assert.ok(gone.lines.length === 0 && gone.problems.length === 1);
    ok("the cart: in the address, capped and bounded; priced as the counter would (the shop's rate, shipping untaxed, free over); stock and unlisted items noted");

    // 5. Checkout.
    await expectError(
      "empty",
      () => startCheckout({ slug: slugA, cart: new Map(), customer: cust("Olivia Online", "2125550199", "olivia@example.test"), fulfil: "pickup", address: null, note: null }, now),
      /empty/,
    );
    await expectError(
      "ship without address",
      () => startCheckout({ slug: slugA, cart, customer: cust("Olivia Online", "2125550199", "olivia@example.test"), fulfil: "ship", address: "", note: null }, now),
      /shipping address/,
    );
    await expectError(
      "over stock",
      () =>
        startCheckout({ slug: slugA, cart: cartWith(new Map(), foot.id, 7), customer: cust("Olivia Online", "2125550199", "olivia@example.test"), fulfil: "pickup", address: null, note: null }, now),
      /only 5 left/i,
    );
    await expectError(
      "no way to reach them",
      () => startCheckout({ slug: slugA, cart, customer: cust("Olivia Online", null, null), fulfil: "pickup", address: null, note: null }, now),
      /mobile number or an email/,
    );
    const r1 = await startCheckout({ slug: slugA, cart, customer: cust("Olivia Online", "(212) 555-0199", "olivia@example.test"), fulfil: "pickup", address: null, note: "Leave at the counter" }, now);
    assert.match(r1.url, new RegExp(`^http://127\\.0\\.0\\.1:${mock.port}/pay/cs_`));
    const o1 = await db.webOrder.findUniqueOrThrow({ where: { id: r1.orderId } });
    assert.ok(
      o1.status === "PENDING" && o1.number === 1001 && o1.totalCents === pick.totalCents && o1.fulfil === "pickup" && o1.note === "Leave at the counter" && o1.stripeSessionId && o1.payVia === "own",
    );
    const c1 = await db.customer.findUniqueOrThrow({ where: { id: o1.customerId! } });
    assert.ok(c1.phone === "+12125550199" && c1.email === "olivia@example.test" && c1.notifyBy === "email" && c1.kind === "RETAIL");
    assert.ok((await db.consentEvent.findMany({ where: { customerId: c1.id } })).some((e) => e.source === "online shop"));
    const sess1 = mock.sessions.get(o1.stripeSessionId!)!;
    assert.ok(sess1 && sess1.amount_total === o1.totalCents && sess1.metadata.endpoint === a.shopId && sess1.metadata.orderId === o1.id && sess1.customer_email === "olivia@example.test");
    assert.match(sess1.success_url, new RegExp(`^http://localhost:3999/shop/o/${r1.token}\\?paid=1$`));
    assert.match(sess1.cancel_url, /\/cart\?c=.*&back=1$/);
    assert.ok((await orderByToken(r1.token))?.status === "PENDING");
    assert.equal(await orderByToken("x".repeat(43)), null);
    ok("checkout: the refusals; a PENDING order with the customer made and the session whose total is the order's");

    // 6. Paid by the webhook, once; a bad signature; the wrong endpoint.
    await mock.pay(sess1.id);
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: sess1 } });
    assert.equal((await handleWebhook(a.shopId, body, "t=1,v1=00", now)).status, 400, "a bad signature");
    assert.equal((await handleWebhook(a.shopId, body, signWebhook(body, "whsec_other"), now)).status, 400, "another secret");
    assert.equal((await handleWebhook("platform", body, signWebhook(body, WHSEC), now)).status, 404, "the platform endpoint has no secret here");
    assert.equal((await handleWebhook(a.shopId, body, signWebhook(body, WHSEC), now)).status, 200);
    const paid1 = await db.webOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.ok(paid1.status === "PAID" && paid1.paidAt && paid1.saleId && paid1.stripeIntent === sess1.payment_intent && paid1.refundedCents === 0);
    const sale1 = await db.sale.findUniqueOrThrow({ where: { id: paid1.saleId! }, include: { lines: true } });
    assert.ok(sale1.totalCents === o1.totalCents && sale1.customerId === c1.id && sale1.status === "COMPLETED");
    assert.deepEqual(sale1.tenders, [{ method: "ONLINE", amountCents: o1.totalCents, note: "Online order #1001" }]);
    assert.equal(sale1.lines.length, 2);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: foot.id } })).qtyOnHand, 3);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: fabric.id } })).qtyOnHand, 7.5);
    const paidMsg = await db.outMessage.findMany({ where: { shopId: a.shopId, refType: "web_order", refId: o1.id } });
    assert.equal(paidMsg.length, 1);
    assert.ok(paidMsg[0].kind === "order_notice" && paidMsg[0].purpose === "notice" && paidMsg[0].channel === "email");
    assert.match(paidMsg[0].body, /order #1001/);
    assert.match(paidMsg[0].body, /Janome walking foot/);
    assert.match(paidMsg[0].body, new RegExp(`http://localhost:3999/shop/o/${r1.token}`));
    assert.match(paidMsg[0].body, /ready to pick up/);
    // Again: nothing changes.
    assert.equal((await handleWebhook(a.shopId, body, signWebhook(body, WHSEC), now)).status, 200);
    assert.equal(await db.sale.count({ where: { shopId: a.shopId } }), 1);
    assert.equal(await db.outMessage.count({ where: { shopId: a.shopId, refType: "web_order" } }), 1);
    assert.equal((await applyPayment(o1.id, { sessionId: sess1.id, intent: null }, now)).applied, false);
    ok("payment by the webhook: the signature checked, the sale in the books with tender ONLINE, stock off, the paid message with the link; applied once");

    // 7. Paid, confirmed by the return page.
    const r2 = await startCheckout(
      {
        slug: slugA,
        cart: cartWith(new Map(), foot.id, 1),
        customer: cust("O. Online", null, "OLIVIA@example.test", "email"),
        fulfil: "ship",
        address: "Olivia Online, 5 Elm St, Albany NY 12207",
        note: null,
      },
      now,
    );
    const o2 = await db.webOrder.findUniqueOrThrow({ where: { id: r2.orderId } });
    assert.ok(o2.customerId === c1.id && o2.shipCents === 600 && o2.fulfil === "ship" && o2.number === 1002, "matched by email, shipping charged");
    await confirmFromReturn(r2.token, now); // not paid yet: nothing
    assert.equal((await db.webOrder.findUniqueOrThrow({ where: { id: o2.id } })).status, "PENDING");
    await mock.pay(o2.stripeSessionId!);
    await confirmFromReturn(r2.token, now);
    const paid2 = await db.webOrder.findUniqueOrThrow({ where: { id: o2.id } });
    assert.ok(paid2.status === "PAID" && paid2.saleId);
    const sale2 = await db.sale.findUniqueOrThrow({ where: { id: paid2.saleId! }, include: { lines: true } });
    assert.ok(sale2.lines.some((l) => l.description === "Shipping" && l.unitPriceCents === 600 && !l.taxable) && sale2.totalCents === o2.totalCents);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: foot.id } })).qtyOnHand, 2);
    ok("payment confirmed from the return page: the shipping line in the sale, untaxed");

    // 8. Short of stock at payment: sold short and the difference refunded; nothing at all: cancelled.
    const r3 = await startCheckout({ slug: slugA, cart: cartWith(new Map(), foot.id, 2), customer: cust("Sam Short", "2125550188", null, "sms"), fulfil: "pickup", address: null, note: null }, now);
    await db.part.update({ where: { id: foot.id }, data: { qtyOnHand: 1 } }); // one sold at the counter meanwhile
    const o3 = await db.webOrder.findUniqueOrThrow({ where: { id: r3.orderId } });
    await mock.pay(o3.stripeSessionId!);
    await confirmFromReturn(r3.token, now);
    const paid3 = await db.webOrder.findUniqueOrThrow({ where: { id: o3.id } });
    const oneTotal = saleTotals([{ qty: 1, unitPriceCents: 2999, taxable: true }], 0, 6.35).total;
    assert.ok(paid3.status === "PAID" && paid3.refundedCents === o3.totalCents - oneTotal && paid3.saleId);
    assert.equal((paid3.items as unknown as OrderItem[])[0].short, 1);
    assert.match(paid3.staffNote ?? "", /refunded for items short/);
    const ref3 = mock.refunds.find((r) => r.payment_intent === paid3.stripeIntent);
    assert.ok(ref3 && ref3.amount === paid3.refundedCents);
    assert.equal((await db.sale.findUniqueOrThrow({ where: { id: paid3.saleId! } })).totalCents, oneTotal);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: foot.id } })).qtyOnHand, 0);
    const msg3 = await db.outMessage.findFirst({ where: { refType: "web_order", refId: o3.id } });
    assert.ok(msg3 && msg3.channel === "sms" && /out of stock; \$\d+\.\d\d goes back/.test(msg3.body), msg3?.body);
    await db.part.update({ where: { id: fabric.id }, data: { qtyOnHand: 2 } });
    const r4 = await startCheckout({ slug: slugA, cart: cartWith(new Map(), fabric.id, 2), customer: cust("Nina None", null, "nina@example.test"), fulfil: "pickup", address: null, note: null }, now);
    await db.part.update({ where: { id: fabric.id }, data: { qtyOnHand: 0 } });
    const o4 = await db.webOrder.findUniqueOrThrow({ where: { id: r4.orderId } });
    await mock.pay(o4.stripeSessionId!);
    await confirmFromReturn(r4.token, now);
    const c4 = await db.webOrder.findUniqueOrThrow({ where: { id: o4.id } });
    assert.ok(c4.status === "CANCELLED" && c4.refundedCents === o4.totalCents && !c4.saleId);
    const msg4 = await db.outMessage.findFirst({ where: { refType: "web_order", refId: o4.id } });
    assert.ok(msg4 && /cancelled/.test(msg4.body) && /goes back to your card/.test(msg4.body));
    assert.equal((await orderByToken(r4.token))?.status, "CANCELLED");
    ok("short of stock at payment: sold short with the difference refunded and said; nothing left: cancelled and refunded");

    // 9. Staff: ready, picked up, shipped, cancel and refund.
    const list = await ordersFor(a.shopId);
    assert.deepEqual(
      list.map((o) => o.number),
      [1003, 1002, 1001],
      "to do: the paid ones, newest first",
    );
    assert.equal((await ordersFor(a.shopId, { all: true })).length, 4);
    await expectError("ready on a shipped order", () => markReadyFor(a.user, o2.id, now), /marked shipped/);
    await markReadyFor(a.user, o1.id, now);
    const ready1 = await db.webOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.ok(ready1.status === "READY" && ready1.readyAt);
    const readyMsg = await db.outMessage.findFirst({ where: { refType: "web_order", refId: o1.id, dedupeKey: { startsWith: `web:${o1.id}:ready` } } });
    assert.ok(readyMsg && /ready to pick up/.test(readyMsg.body) && /Ring the bell/.test(readyMsg.body));
    await expectError("ready twice", () => markReadyFor(a.user, o1.id, now), /ready for pickup/);
    await markDoneFor(a.user, o1.id, {}, now);
    assert.equal((await db.webOrder.findUniqueOrThrow({ where: { id: o1.id } })).status, "DONE");
    assert.equal(await db.outMessage.count({ where: { refType: "web_order", refId: o1.id } }), 2, "picking up sends nothing");
    await markDoneFor(a.user, o2.id, { tracking: "9400 1000 0000" }, now);
    const done2 = await db.webOrder.findUniqueOrThrow({ where: { id: o2.id } });
    assert.ok(done2.status === "DONE" && done2.tracking === "9400 1000 0000");
    const shipMsg = await db.outMessage.findFirst({ where: { refType: "web_order", refId: o2.id, dedupeKey: { startsWith: `web:${o2.id}:shipped` } } });
    assert.ok(shipMsg && /on its way|shipped/.test(shipMsg.body) && /9400 1000 0000/.test(shipMsg.body));
    await expectError("cancel a done order", () => cancelOrderFor(a.user, o1.id, "oops", now), /went out/);
    await expectError("a tech cancels", () => cancelOrderFor({ ...a.user, role: "TECH" }, o3.id, "oops", now), /owner or admin/);
    const footBefore = (await db.part.findUniqueOrThrow({ where: { id: foot.id } })).qtyOnHand;
    await cancelOrderFor(a.user, o3.id, "Customer changed their mind", now);
    const canc3 = await db.webOrder.findUniqueOrThrow({ where: { id: o3.id } });
    assert.ok(canc3.status === "CANCELLED" && canc3.refundedCents === o3.totalCents && /changed their mind/.test(canc3.staffNote ?? ""));
    assert.equal(
      mock.refunds.filter((r) => r.payment_intent === paid3.stripeIntent).reduce((s2, r) => s2 + r.amount, 0),
      o3.totalCents,
      "the rest refunded",
    );
    assert.equal((await db.sale.findUniqueOrThrow({ where: { id: paid3.saleId! } })).status, "VOIDED");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: foot.id } })).qtyOnHand, footBefore + 1, "stock back");
    const cancMsg = await db.outMessage.findFirst({ where: { refType: "web_order", refId: o3.id, dedupeKey: { startsWith: `web:${o3.id}:cancelled` } } });
    assert.ok(cancMsg && /cancelled/.test(cancMsg.body));
    assert.equal(await orderNoticeStillWanted({ refType: "web_order", refId: o3.id, dedupeKey: `web:${o3.id}:ready` }), "the order was cancelled");
    assert.equal(await orderNoticeStillWanted({ refType: "web_order", refId: o3.id, dedupeKey: `web:${o3.id}:cancelled` }), null);
    assert.equal(await orderNoticeStillWanted({ refType: "web_order", refId: "c000000000000000000000000", dedupeKey: null }), "the order is gone");
    assert.deepEqual(
      (await ordersFor(a.shopId)).map((o) => o.number),
      [],
    );
    ok(
      "staff: ready (the customer hears, with the pickup note), picked up, shipped with tracking (the customer hears), cancel and refund (the rest refunded, the sale voided, stock back, the customer hears)",
    );

    // 10. Stale orders.
    const r5 = await startCheckout(
      { slug: slugA, cart: cartWith(new Map(), foot.id, 1), customer: cust("Stale Sam", "2125550177", null, "sms"), fulfil: "pickup", address: null, note: null },
      new Date(now.getTime() - 3 * 3_600_000),
    );
    assert.equal(await expireStaleOrders(now), 1);
    assert.equal((await db.webOrder.findUniqueOrThrow({ where: { id: r5.orderId } })).status, "CANCELLED");
    const expiredBody = JSON.stringify({
      id: "evt_2",
      type: "checkout.session.expired",
      data: { object: mock.sessions.get((await db.webOrder.findUniqueOrThrow({ where: { id: r5.orderId } })).stripeSessionId!) },
    });
    assert.equal((await handleWebhook(a.shopId, expiredBody, signWebhook(expiredBody, WHSEC), now)).status, 200);
    ok("stale orders: a PENDING order two hours old is cancelled; Stripe's expiry event is taken");

    // 11. Tenant: another company's rows are not found.
    await expectNotFound("B marks A's order ready", () => markReadyFor(b.user, o1.id, now));
    await expectNotFound("B cancels A's order", () => cancelOrderFor(b.user, o2.id, "x", now));
    await expectNotFound("B lists A's part", () => saveListingFor(b.user, foot.id, form({ online: "on" })));
    await expectNotFound("B adds a photo to A's part", () => addPhotoFor(b.user, foot.id, png()));
    const phA = (await db.partPhoto.findFirst({ where: { partId: foot.id } }))!;
    await expectError("B removes A's photo", () => removePhotoFor(b.user, phA.id), /gone already/);
    assert.equal(await db.partPhoto.count({ where: { partId: foot.id } }), 3);
    assert.equal((await ordersFor(b.shopId, { all: true })).length, 0);
    // B's webhook secret can't confirm A's order.
    await saveShopSettingsFor(b.user, base({ slug: `check-${RUN}-b`, on: "on", stripeKey: KEY, stripeWebhook: "whsec_bbbbbbbbbbbb" }));
    const r6 = await startCheckout({ slug: slugA, cart: cartWith(new Map(), foot.id, 1), customer: cust("Tess Tenant", "2125550166", null, "sms"), fulfil: "pickup", address: null, note: null }, now);
    const o6 = await db.webOrder.findUniqueOrThrow({ where: { id: r6.orderId } });
    const sess6 = (await mock.pay(o6.stripeSessionId!))!;
    const body6 = JSON.stringify({ id: "evt_3", type: "checkout.session.completed", data: { object: sess6 } });
    const r = await handleWebhook(b.shopId, body6, signWebhook(body6, "whsec_bbbbbbbbbbbb"), now);
    assert.ok(r.status === 200 && r.body === "not this endpoint");
    assert.equal((await db.webOrder.findUniqueOrThrow({ where: { id: o6.id } })).status, "PENDING");
    ok("tenant: another company's orders, parts and photos are not found; a shop's webhook can't confirm another shop's order");

    // 12. Stripe Tax: shipped orders taxed at checkout by Stripe, pickup at the rate; the sale records Stripe's tax; a short line keeps its share.
    process.env.STRIPE_SECRET_KEY = "sk_test_platform1234567";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform1234567";
    await expectError(
      "Stripe Tax through the platform",
      () => saveShopSettingsFor(a.user, base({ slug: slugA, on: "on", shipping: "on", shipRate: "6.00", payVia: "platform", taxVia: "stripe" })),
      /own Stripe account only/,
    );
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await saveShopSettingsFor(a.user, base({ slug: slugA, on: "on", shipping: "on", shipRate: "6.00", taxVia: "stripe", pickupNote: "Ring the bell." }));
    assert.equal((await shopSettings(a.shopId)).taxVia, "stripe");
    const taxStore = (await publicStore(slugA))!;
    assert.equal(taxStore.taxVia, "stripe");
    await db.part.update({ where: { id: foot.id }, data: { qtyOnHand: 10 } });
    const two = cartWith(new Map(), foot.id, 2);
    const pickTax = await priceCart(taxStore, two, "pickup");
    assert.ok(!pickTax.taxAtCheckout && pickTax.taxCents === saleTotals([{ qty: 2, unitPriceCents: 2999, taxable: true }], 0, 6.35).tax, "pickup: the rate");
    const shipTax = await priceCart(taxStore, two, "ship");
    assert.ok(shipTax.taxAtCheckout && shipTax.taxCents === 0 && shipTax.shipCents === 600 && shipTax.totalCents === 5998 + 600, "shipped: before tax");
    const r7 = await startCheckout(
      { slug: slugA, cart: two, customer: cust("Tara Taxed", null, "tara@example.test"), fulfil: "ship", address: "Tara Taxed, 9 Oak St, Hartford CT 06103", note: null },
      now,
    );
    const o7 = await db.webOrder.findUniqueOrThrow({ where: { id: r7.orderId } });
    assert.ok(o7.taxVia === "stripe" && o7.taxCents === 0 && o7.totalCents === 6598);
    const sess7 = mock.sessions.get(o7.stripeSessionId!)!;
    assert.ok(sess7.automatic_tax.enabled && sess7.line_items.data.length === 2, "automatic tax, no tax line of ours");
    assert.equal(sess7.line_items.data[1].price_data.product_data.tax_code, "txcd_92010001", "shipping carries its tax code");
    assert.equal(sess7.line_items.data[0].price_data.tax_behavior, "exclusive");
    const tax7 = Math.round(5998 * MOCK_TAX_RATE) + Math.round(600 * MOCK_TAX_RATE);
    assert.equal(sess7.amount_total, 6598 + tax7);
    // One sold at the counter meanwhile: the short line keeps its share of the tax.
    await db.part.update({ where: { id: foot.id }, data: { qtyOnHand: 1 } });
    await mock.pay(sess7.id);
    await confirmFromReturn(r7.token, now);
    const paid7 = await db.webOrder.findUniqueOrThrow({ where: { id: o7.id } });
    const keptTax7 = Math.round(Math.round(5998 * MOCK_TAX_RATE) / 2) + Math.round(600 * MOCK_TAX_RATE);
    const keptTotal7 = 2999 + 600 + keptTax7;
    assert.ok(paid7.status === "PAID" && paid7.taxCents === tax7 && paid7.totalCents === 6598 + tax7, "the order shows what Stripe charged");
    assert.equal(paid7.refundedCents, 6598 + tax7 - keptTotal7, "the short line and its tax refunded");
    const sale7 = await db.sale.findUniqueOrThrow({ where: { id: paid7.saleId! }, include: { lines: true } });
    assert.ok(sale7.taxCents === keptTax7 && sale7.totalCents === keptTotal7 && sale7.subtotalCents === 3599, `the sale carries Stripe's tax (${sale7.taxCents} / ${sale7.totalCents})`);
    assert.ok(Math.abs(sale7.taxRatePct - (keptTax7 / 2999) * 100) < 0.01, "the effective rate recorded");
    assert.match(sale7.note ?? "", /tax by Stripe Tax/);
    assert.deepEqual(sale7.tenders, [{ method: "ONLINE", amountCents: keptTotal7, note: "Online order #1007" }]);
    const ref7 = mock.refunds.find((r) => r.payment_intent === paid7.stripeIntent);
    assert.equal(ref7?.amount, paid7.refundedCents);
    assert.equal((await orderByToken(r7.token))?.taxVia, "stripe");
    // A pickup order under Stripe Tax: the rate, nothing automatic.
    await db.part.update({ where: { id: foot.id }, data: { qtyOnHand: 5 } });
    const r8 = await startCheckout({ slug: slugA, cart: cartWith(new Map(), foot.id, 1), customer: cust("Pat Pickup", null, "pat@example.test"), fulfil: "pickup", address: null, note: null }, now);
    const o8 = await db.webOrder.findUniqueOrThrow({ where: { id: r8.orderId } });
    const sess8 = mock.sessions.get(o8.stripeSessionId!)!;
    assert.ok(
      o8.taxVia === "rate" && !sess8.automatic_tax.enabled && sess8.amount_total === o8.totalCents && o8.taxCents === saleTotals([{ qty: 1, unitPriceCents: 2999, taxable: true }], 0, 6.35).tax,
    );
    ok("Stripe Tax: own account only; shipped orders taxed by Stripe at checkout (shipping with its code), the sale carrying Stripe's tax and a short line its share; pickup orders at the rate");

    console.log(`online-shop.check: ${steps} groups passed`);
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
