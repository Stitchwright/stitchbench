// Special orders and pre-orders (shop-features-round-2-design.md 1.2): the settings and the default deposit; taking
// one (the deposit a DEPOSIT line, untaxed; a tech's price refused; sent twice, made once; a pre-order on a coming-soon
// item); a payment and the balance as a pay link; "Order it" onto the supplier's draft; the order received marks the
// oldest here, holds the quantity and queues the "it's here" message (never twice); the pick-up at the register (the
// order's price, the deposits off, the held stock released then sold; a tech can; the browser's deposit line checked);
// voiding the pick-up; cancels by the rule (store credit, kept as income) and undo; the books; the tenant section.
//   npm run -s check scripts/checks/special-orders.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { ensureMainStore } from "@/lib/stores";
import { isUserError } from "@/lib/action";
import { balanced, buildBooks } from "@/lib/books";
import { DEFAULT_BOOKS } from "@/lib/books-accounts";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { receiveOrderFor, sendOrderFor } from "@/lib/fabric-orders";
import { saveShopSettingsFor } from "@/lib/shop/online-shop";
import {
  askForBalancesAs,
  cancelSpecialOrderAs,
  defaultDeposit,
  markHereFor,
  orderThemFor,
  payTowardAs,
  saveSpecialOrderSettingsFor,
  sendBalanceLinkAs,
  specialOrderCounts,
  specialOrderDepositsHeld,
  specialOrderSettings,
  specialOrdersFor,
  specialOrderView,
  takeSpecialOrderAs,
  undoCancelFor,
  arrivedFor,
  expireUnpaidPreorders,
  waitingForCustomer,
} from "@/lib/special-orders";
import { checkShop, cleanup, clearKick, messagingFor, withSink } from "./lib";
import { expectNotFound, RUN } from "./tenant";
import { startStripeMock } from "../test-mail/stripe-mock.mjs";
import { handleWebhook } from "@/lib/shop/online-shop";
import { signWebhook } from "@/lib/shop/stripe";
import { openPayLink } from "@/lib/pay-links";

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

const cash = (amountCents: number) => ({ method: "CASH" as const, amountCents });
const WHSEC = "whsec_specialorder123456";

async function main() {
  await withSink();
  const mock = await startStripeMock({ port: 0, webhookBase: null, webhookSecret: WHSEC });
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.PUBLIC_URL = "http://localhost:3999";
  // A base shop (no Marketing): "it's here" (order_in) is in the base since 7 Oct 2026.
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const tech = { ...a.user, role: "TECH" as const };
  try {
    await messagingFor(a.shopId, { email: true });
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 5 } });
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Special", email: "jane.so@example.test", notifyBy: "email" } });
    const ann = await db.customer.create({ data: { shopId: a.shopId, name: "Ann Nomessages", phone: "555-0101", notifyBy: "none" } });
    const charm = await db.part.create({ data: { shopId: a.shopId, partNumber: "TP-CHARM", description: "Tula Pink Untamed charm pack", priceCents: 3000, qtyOnHand: 0, numberKeys: ["TPCHARM"], kind: "FABRIC", supplier: "FreeSpirit" } });

    // 1. Settings and the default deposit.
    const s0 = await specialOrderSettings(a.shopId);
    assert.deepEqual([s0.depositPct, s0.depositCents, s0.rule, s0.days], [0, 0, "credit", 30]);
    await expectError("a tech saving settings", () => saveSpecialOrderSettingsFor(tech, form({ depositHow: "pct", depositPct: "20" })), /owner or admin/);
    await saveSpecialOrderSettingsFor(a.user, form({ depositHow: "amount", depositAmount: "$10", rule: "credit", days: "30" }));
    assert.equal(defaultDeposit(await specialOrderSettings(a.shopId), 6300), 1000);
    assert.equal(defaultDeposit({ depositPct: 20, depositCents: 0 }, 6300), 1260);
    ok("defaults: no deposit, store credit back, 30 days; a set amount or a percent; techs can't change them");

    // 2. Taking one.
    await expectError("no customer", () => takeSpecialOrderAs(a.user, { customerId: null, partId: charm.id, qty: 2, priceCents: 3000, tender: cash(1000) }), /customer first/);
    await expectError("a tech's own price", () => takeSpecialOrderAs(tech, { customerId: jane.id, partId: charm.id, qty: 2, priceCents: 2500, tender: cash(1000) }), /owner or admin/);
    await expectError("a tech typing a thing", () => takeSpecialOrderAs(tech, { customerId: jane.id, description: "A pattern", priceCents: 2500, tender: cash(1000) }), /owner or admin/);
    const t1 = await takeSpecialOrderAs(a.user, { customerId: jane.id, partId: charm.id, qty: 2, priceCents: 3000, tender: cash(1000), clientKey: "special-order-key-0001" });
    const again = await takeSpecialOrderAs(a.user, { customerId: jane.id, partId: charm.id, qty: 2, priceCents: 3000, tender: cash(1000), clientKey: "special-order-key-0001" });
    assert.equal(again.id, t1.id, "sent twice: one order");
    let v = (await specialOrderView(a.shopId, t1.id))!;
    assert.deepEqual([v.status, v.number, v.kind, v.depositCents, v.paidCents, v.owedCents, v.leftCents], ["WAITING", 1001, "ORDER", 1000, 1000, 6300, 5300]);
    const dep = await db.saleLine.findFirstOrThrow({ where: { saleId: t1.saleId! } });
    assert.ok(dep.kind === "DEPOSIT" && !dep.taxable && dep.specialOrderId === t1.id);
    const typed = await takeSpecialOrderAs(a.user, { customerId: ann.id, description: "Kaffe Fassett book", priceCents: 2995, depositCents: 0 });
    assert.equal(typed.saleId, null, "no deposit: no sale");
    await db.part.update({ where: { id: charm.id }, data: { comingSoonOn: "2026-11-01" } });
    const pre = await takeSpecialOrderAs(a.user, { customerId: ann.id, partId: charm.id, qty: 1, priceCents: 3000, tender: cash(1000) });
    v = (await specialOrderView(a.shopId, pre.id))!;
    assert.ok(v.kind === "PREORDER" && v.expectedOn === "2026-11-01");
    await db.part.update({ where: { id: charm.id }, data: { comingSoonOn: null } });
    await expectError("a crafted deposit line", () => completeSaleAs(a.user, { customerId: jane.id, lines: [{ description: "x", qty: 1, unitPriceCents: 500, taxable: false, specialOrderId: t1.id, depositKind: "DEPOSIT" }], tenders: [cash(500)] }), /one thing/);
    ok("taken: the $10 deposit a DEPOSIT line, untaxed; a repeat makes one; typed with no deposit; a pre-order on a coming-soon item; refusals");

    // 3. A payment, and the balance as a pay link paid online (money held, not a sale).
    await expectError("paying too much", () => payTowardAs(a.user, { id: t1.id, amountCents: 9000, tender: cash(9000) }), /Only \$53\.00/);
    await payTowardAs(a.user, { id: t1.id, amountCents: 300, tender: cash(300) });
    await saveShopSettingsFor(a.user, form({ slug: `check-${RUN}-so`, pickup: "on", shipRate: "0", payVia: "own", stripeKey: "sk_test_so1234567890", stripeWebhook: WHSEC }));
    assert.match(await sendBalanceLinkAs(a.user, t1.id), /\$50\.00/);
    const link = await db.webOrder.findFirstOrThrow({ where: { shopId: a.shopId, source: "staff", specialOrderIds: { has: t1.id } } });
    assert.equal(link.taxCents, 0, "money toward an order isn't taxed");
    const token = (await import("@/lib/messaging/secrets")).unseal(link.linkSealed, a.shopId, `orderLink:${link.id}`)!.plain.split("/shop/o/")[1];
    await openPayLink(token);
    const sid = (await db.webOrder.findUniqueOrThrow({ where: { id: link.id } })).stripeSessionId!;
    const sess = await mock.pay(sid);
    const body = JSON.stringify({ id: "evt_so1", type: "checkout.session.completed", data: { object: sess } });
    await handleWebhook(a.shopId, body, signWebhook(body, WHSEC));
    const paidLink = await db.webOrder.findUniqueOrThrow({ where: { id: link.id } });
    assert.ok(paidLink.status === "DONE" && paidLink.saleId, "the link is paid and done");
    v = (await specialOrderView(a.shopId, t1.id))!;
    assert.deepEqual([v.paidCents, v.leftCents], [6300, 0]);
    assert.equal((await db.saleLine.findFirstOrThrow({ where: { saleId: paidLink.saleId! } })).kind, "DEPOSIT");
    await expectError("pre-order balances by a tech", () => askForBalancesAs(tech, charm.id), /owner or admin/);
    assert.match(await askForBalancesAs(a.user, charm.id), /Sent 1 pay link; 1 paid in full/);
    ok("a payment at the counter and the rest by pay link: both money held (DEPOSIT), untaxed; Ask for the balances skips an order paid in full");

    // 4. Order it; the order received marks it here, holds it, tells her; a second arrival doesn't tell her twice.
    const told = await orderThemFor(a.user, [t1.id, pre.id, typed.id]);
    assert.match(told, /Added to order #\d+ \(FreeSpirit, 1 line\)/);
    const po = await db.purchaseOrder.findFirstOrThrow({ where: { shopId: a.shopId, status: "DRAFT" }, include: { lines: true } });
    assert.equal(po.lines[0].qty, 3, "both orders for the charm pack on one line");
    v = (await specialOrderView(a.shopId, t1.id))!;
    assert.ok(v.status === "ORDERED" && v.poLineId === po.lines[0].id);
    assert.equal((await specialOrderView(a.shopId, typed.id))!.status, "ORDERED");
    await sendOrderFor(a.user, po.id, "manual");
    const words = await receiveOrderFor(a.user, po.id, form({ [`yards.${po.lines[0].id}`]: "2" }));
    assert.match(words, /Special order marked here and held\. The customer hears it's here\./);
    v = (await specialOrderView(a.shopId, t1.id))!;
    assert.ok(v.status === "HERE" && v.heldQty === 2 && v.noticedAt);
    assert.equal((await specialOrderView(a.shopId, pre.id))!.status, "ORDERED", "only what came: the next order waits");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: charm.id } })).qtyOnHand, 0, "2 came, 2 held for her");
    const msg = await db.outMessage.findFirstOrThrow({ where: { shopId: a.shopId, kind: "order_in", refId: t1.id } });
    assert.match(msg.body, /Tula Pink Untamed charm pack is here/);
    assert.match(msg.body, /paid in full/);
    const w2 = await receiveOrderFor(a.user, po.id, form({ [`yards.${po.lines[0].id}`]: "1" }));
    assert.match(w2, /Call Ann Nomessages/, "a customer who takes no messages goes on the call list");
    assert.equal(await db.outMessage.count({ where: { shopId: a.shopId, kind: "order_in" } }), 1);
    assert.equal((await specialOrderCounts(a.shopId)).call, 1);
    assert.match(await markHereFor(a.user, typed.id), /marked here/);
    ok("ordered onto the supplier's draft (one line for both); received: the oldest here and held, the message once; no-messages customers to call; a typed order marked here by hand");

    // 4b. Stock arriving at one store doesn't mark here an order waiting at another (review fix): the words say where.
    await ensureMainStore(db, a.shopId);
    const flStore = await db.location.create({ data: { shopId: a.shopId, name: "Florida" } });
    const flOrder = await takeSpecialOrderAs(a.user, { customerId: ann.id, partId: charm.id, qty: 1, priceCents: 3000, depositCents: 0 });
    await db.specialOrder.update({ where: { id: flOrder.id }, data: { locationId: flStore.id } });
    const qtyBefore = (await db.part.findUniqueOrThrow({ where: { id: charm.id } })).qtyOnHand;
    const flWords = await arrivedFor(a.user, [{ partId: charm.id, qty: 1 }]);
    assert.match(flWords, /waits at Florida/);
    assert.equal((await specialOrderView(a.shopId, flOrder.id))!.status, "WAITING", "not marked here: the stock is at the main store");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: charm.id } })).qtyOnHand, qtyBefore, "nothing held");
    await db.specialOrder.delete({ where: { id: flOrder.id } });
    await db.location.delete({ where: { id: flStore.id } });
    ok("stock received at one store leaves an order waiting at another store as it is, and says where it waits");

    // 4c. An online pre-order whose deposit was never paid is cancelled by the sweep (it would hold arriving stock).
    const old = new Date(Date.now() - 3 * 86_400_000);
    const unpaidPre = await db.specialOrder.create({ data: { shopId: a.shopId, number: 9001, customerId: ann.id, kind: "PREORDER", partId: charm.id, description: "Charm pack", qty: 1, priceCents: 3000, depositCents: 1000, note: "Pre-ordered online", createdAt: old } });
    assert.ok((await expireUnpaidPreorders()) >= 1);
    assert.equal((await db.specialOrder.findUniqueOrThrow({ where: { id: unpaidPre.id } })).status, "CANCELLED");
    assert.notEqual((await specialOrderView(a.shopId, pre.id))!.status, "CANCELLED", "a pre-order with its deposit paid stays");
    await db.specialOrder.delete({ where: { id: unpaidPre.id } });
    ok("an online pre-order never paid is cancelled by the sweep; one with its deposit paid stays");

    // 5. Picked up at the register by a tech: the order's price, the deposits off, the held stock released then sold.
    const waiting = await waitingForCustomer(a.shopId, jane.id);
    assert.equal(waiting.length, 1);
    await expectError("the browser's deposit wrong", () => completeSaleAs(tech, { customerId: jane.id, lines: [{ partId: charm.id, specialOrderId: t1.id, description: "", qty: 2, unitPriceCents: 3000, taxable: true }, { description: "Deposit", qty: -1, unitPriceCents: 1000, taxable: false, specialOrderId: t1.id, depositUsed: true }], tenders: [] }), /changed/);
    const pu = await completeSaleAs(tech, {
      customerId: jane.id,
      lines: [
        { partId: charm.id, specialOrderId: t1.id, description: "x", qty: 1, unitPriceCents: 1, taxable: true },
        { description: "Deposit", qty: -1, unitPriceCents: 6300, taxable: false, specialOrderId: t1.id, depositUsed: true },
      ],
      tenders: [],
    });
    const sale = await db.sale.findUniqueOrThrow({ where: { id: pu.saleId }, include: { lines: true } });
    assert.equal(sale.totalCents, 0, "paid in full beforehand");
    const item = sale.lines.find((l) => l.partId)!;
    assert.ok(item.qty === 2 && item.unitPriceCents === 3000 && item.taxable && item.specialOrderId === t1.id);
    assert.equal(sale.lines.find((l) => l.kind === "DEPOSIT")!.unitPriceCents, 6300);
    v = (await specialOrderView(a.shopId, t1.id))!;
    assert.ok(v.status === "DONE" && v.saleId === pu.saleId && v.heldQty === 0);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: charm.id } })).qtyOnHand, 0);
    await expectError("picking it up twice", () => completeSaleAs(a.user, { customerId: jane.id, lines: [{ partId: charm.id, specialOrderId: t1.id, description: "", qty: 2, unitPriceCents: 3000, taxable: true }], tenders: [cash(6300)] }), /isn't here yet/);
    await expectError("voiding a payment of a finished order", () => voidSaleAs(a.user, t1.saleId!, "x"), /picked up: void that sale first/);
    ok("picked up by a tech at the order's price, the $63 paid coming off; the order done and the held pair sold; the browser's deposit line checked");

    // 6. Void the pick-up: here and held again.
    await voidSaleAs(a.user, pu.saleId, "wrong customer");
    v = (await specialOrderView(a.shopId, t1.id))!;
    assert.ok(v.status === "HERE" && v.heldQty === 2 && v.paidCents === 6300);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: charm.id } })).qtyOnHand, 0);
    ok("voiding the pick-up: here again, held again, the money still hers");

    // 7. Cancel by the rule: store credit back; kept as income for a non-refundable item; undo within the day.
    await expectError("a tech cancelling with money on it", () => cancelSpecialOrderAs(tech, { id: t1.id }), /owner or admin/);
    const c1 = await cancelSpecialOrderAs(a.user, { id: t1.id });
    assert.equal(c1.backCents, 6300);
    const credit = await db.giftCard.findFirstOrThrow({ where: { shopId: a.shopId, customerId: jane.id, kind: "credit" } });
    assert.equal(credit.balanceCents, 6300);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: charm.id } })).qtyOnHand, 2, "back on the shelf");
    await expectError("a tech undoing a cancel that moved money", () => undoCancelFor(tech, t1.id), /owner or admin/);
    await undoCancelFor(a.user, t1.id);
    v = (await specialOrderView(a.shopId, t1.id))!;
    assert.ok(v.status === "HERE" && v.heldQty === 2 && v.paidCents === 6300);
    assert.equal((await db.giftCard.findUniqueOrThrow({ where: { id: credit.id } })).balanceCents, 0, "the credit comes back off");
    const c2 = await cancelSpecialOrderAs(a.user, { id: t1.id, rule: "keep", reason: "changed her mind" });
    assert.equal(c2.keptCents, 6300);
    const kept = await db.saleLine.findFirstOrThrow({ where: { saleId: c2.saleId!, kind: "DEPOSIT_KEPT" } });
    assert.equal(kept.unitPriceCents, 6300);
    assert.equal(await db.auditEntry.count({ where: { shopId: a.shopId, action: "specialorder.keep" } }), 1);
    ok("cancelled: $63 as store credit (the pair back on the shelf); undo puts it all back; cancelled again keeping the deposit as income");

    // 8. The books and the deposits held.
    const books = await buildBooks(a.shopId, "America/New_York", new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000), DEFAULT_BOOKS);
    assert.ok(books.days.every(balanced));
    assert.equal(books.unbalancedSales, 0);
    const held = await specialOrderDepositsHeld(a.shopId);
    const depAcct = books.days.flatMap((d) => d.lines).filter((l) => l.account === "Customer Deposits").reduce((x, l) => x + l.creditCents - l.debitCents, 0);
    assert.equal(depAcct, held, "Customer Deposits matches the open orders' money");
    assert.equal(held, 1000, "only the pre-order's $10 is still held");
    ok("the books balance; Customer Deposits holds exactly the open orders' deposits");

    // 9. Tenant.
    assert.equal(await specialOrderView(b.shopId, pre.id), null);
    assert.deepEqual(await specialOrdersFor(b.shopId), []);
    await expectNotFound("B pays A's", () => payTowardAs(b.user, { id: pre.id, amountCents: 100, tender: cash(100) }));
    await expectNotFound("B cancels A's", () => cancelSpecialOrderAs(b.user, { id: pre.id }));
    await expectNotFound("B marks A's here", () => markHereFor(b.user, pre.id));
    await expectNotFound("B undoes A's", () => undoCancelFor(b.user, t1.id));
    await expectNotFound("B takes one for A's customer", () => takeSpecialOrderAs(b.user, { customerId: jane.id, description: "x", priceCents: 100, depositCents: 0 }));
    await expectNotFound("B picks up A's at its register", () => completeSaleAs(b.user, { customerId: null, lines: [{ specialOrderId: pre.id, description: "", qty: 1, unitPriceCents: 0, taxable: true }], tenders: [] }));
    assert.equal((await specialOrderView(a.shopId, pre.id))!.status, "HERE");
    ok("tenant: another company can't see, pay, cancel, mark, undo, pick up or take one for A's customer");

    console.log(`special-orders.check: ${steps} groups passed`);
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
