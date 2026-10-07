// Store credit (later-round-1-design.md section 2): given on a return (to the customer's one card, or a slip when there is
// no customer) or by an owner or admin with a reason, spent as a tender or a ticket payment, undone by a void, kept apart
// from gift cards, allowed back in while read-only but not spent, and never seen across companies.
//   npm run check scripts/checks/store-credit.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { giveStoreCreditAs } from "@/lib/gift-cards";
import { newGiftCardNumber } from "@/lib/gift-card-number";
import { addPaymentFor, removePaymentFor } from "@/lib/payments";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { modelKey } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { grantDevLicense } from "../license/dev";
import { checkShop, cleanup } from "./lib";
import { expectNotFound, rowsOf } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
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

let n = 9800;
async function ticket(shopId: string, customerId: string | null) {
  const m = await db.machine.create({ data: { shopId, customerId, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
  return db.ticket.create({ data: { shopId, number: n++, status: "ON_BENCH", machineId: m.id, customerId, intake: {} } });
}

async function main() {
  const a = await checkShop({ repair: true, retail: true });
  const b = await checkShop({ repair: true, retail: true });
  const owner = a.user;
  const tech: CurrentUser = { ...a.user, role: "TECH" };
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const part = await db.part.create({ data: { shopId: a.shopId, partNumber: "SC-1", description: "Thread", priceCents: 1000, qtyOnHand: 50, numberKeys: [] } });
    const ann = await db.customer.create({ data: { shopId: a.shopId, name: "Ann Credit", phone: "5550111" } });
    const bob = await db.customer.create({ data: { shopId: a.shopId, name: "Bob None", phone: "5550122" } });
    const item = (qty: number, unit = 1000) => ({ partId: part.id, description: "x", qty, unitPriceCents: unit, taxable: true });
    const creditOf = (customerId: string) => db.giftCard.findMany({ where: { shopId: a.shopId, customerId, kind: "credit" } });
    const bal = async (id: string) => (await db.giftCard.findUniqueOrThrow({ where: { id } })).balanceCents;
    const sum = async () => (await db.giftCard.findMany({ where: { shopId: a.shopId }, include: { entries: true } })).forEach((c) => {
      assert.equal(c.entries.reduce((s, e) => s + e.amountCents, 0), c.balanceCents, `ledger equals balance for ${c.number}`);
      assert.ok(c.balanceCents >= 0);
    });

    // ---------- from a return ----------
    const r1 = await completeSaleAs(owner, { customerId: ann.id, lines: [item(-3)], tenders: [{ method: "CREDIT", amountCents: -3000 }] });
    const cards = await creditOf(ann.id);
    assert.equal(cards.length, 1, "Ann has one store credit card");
    assert.equal(cards[0].balanceCents, 3000);
    assert.equal(cards[0].kind, "credit");
    assert.equal(r1.cards?.length ?? 0, 0, "a customer's card is not a slip to print");
    const e1 = await db.giftCardEntry.findFirstOrThrow({ where: { cardId: cards[0].id } });
    assert.equal(e1.reason, "REFUNDED_TO");
    assert.equal(e1.saleId, r1.saleId);
    assert.equal(await db.auditEntry.count({ where: { shopId: a.shopId, action: "credit.issue", subjectId: cards[0].id } }), 1);
    // two returns at once for the same customer: still one card
    const bothAtOnce = await Promise.all([
      completeSaleAs(owner, { customerId: bob.id, lines: [item(-1)], tenders: [{ method: "CREDIT", amountCents: -1000 }] }),
      completeSaleAs(owner, { customerId: bob.id, lines: [item(-2)], tenders: [{ method: "CREDIT", amountCents: -2000 }] }),
    ]);
    assert.equal(bothAtOnce.length, 2);
    const bobs = await creditOf(bob.id);
    assert.equal(bobs.length, 1, "two refunds at once make one card");
    assert.equal(bobs[0].balanceCents, 3000);
    await completeSaleAs(owner, { customerId: ann.id, lines: [item(-1)], tenders: [{ method: "CREDIT", amountCents: -1000 }] });
    assert.equal((await creditOf(ann.id)).length, 1, "a second return adds to the same card");
    assert.equal(await bal(cards[0].id), 4000);
    // no customer: a new slip with a number, returned so it can be printed
    const slip = await completeSaleAs(owner, { lines: [item(-2)], tenders: [{ method: "CREDIT", amountCents: -2000 }] });
    assert.equal(slip.cards?.length, 1);
    assert.equal(slip.cards![0].what, "credit");
    assert.equal(slip.cards![0].amountCents, 2000);
    const slipCard = await db.giftCard.findUniqueOrThrow({ where: { id: slip.cards![0].cardId } });
    assert.equal(slipCard.customerId, null);
    assert.equal(slipCard.kind, "credit");
    assert.match(slipCard.number, /^GC-/);
    assert.equal(slipCard.balanceCents, 2000);
    // a refund onto a gift card number is not store credit
    await expectError("a gift card is not store credit", async () => {
      const g = (await completeSaleAs(owner, { lines: [{ giftCard: { mode: "new" as const }, description: "Gift card", qty: 1, unitPriceCents: 1000, taxable: false }], tenders: [{ method: "CASH", amountCents: 1000 }] })).cards![0];
      return completeSaleAs(owner, { lines: [item(-1)], tenders: [{ method: "CREDIT", amountCents: -1000, cardNumber: g.number }] });
    }, /gift card number/);
    ok("from a return: the customer's one card (made once, even with two refunds at once), or a new slip when there is no customer; each in the audit log");

    // ---------- from an admin ----------
    await expectError("a tech can't give credit", () => giveStoreCreditAs(tech, bob.id, 500, "x"), /owner or an admin/);
    await expectError("a reason is required", () => giveStoreCreditAs(owner, bob.id, 500, "  "), /say why/);
    await expectError("an amount", () => giveStoreCreditAs(owner, bob.id, 0, "x"), /from \$0\.01/);
    await expectError("too much", () => giveStoreCreditAs(owner, bob.id, 10_000_000, "x"), /from \$0\.01/);
    await giveStoreCreditAs(owner, bob.id, 500, "Apology for a late repair");
    assert.equal(await bal(bobs[0].id), 3500);
    const given = await db.giftCardEntry.findFirstOrThrow({ where: { cardId: bobs[0].id, reason: "LOADED" } });
    assert.equal(given.note, "Apology for a late repair");
    const au = await db.auditEntry.findFirstOrThrow({ where: { shopId: a.shopId, action: "credit.issue", reason: "Apology for a late repair" } });
    assert.equal(au.amountCents, 500);
    assert.equal(au.userId, owner.id);
    await expectNotFound("a customer of another company", () => giveStoreCreditAs(b.user, ann.id, 500, "x"));
    ok("from an admin: owner or admin, a reason, on the customer's card, in the audit log");

    // ---------- spend ----------
    const s1 = await completeSaleAs(owner, { customerId: ann.id, lines: [item(2)], tenders: [{ method: "CREDIT", amountCents: 1500 }, { method: "CASH", amountCents: 500 }] });
    assert.equal(await bal(cards[0].id), 2500, "the customer's own card, no number typed");
    const st = ((await db.sale.findUniqueOrThrow({ where: { id: s1.saleId } })).tenders as { method: string; last4?: string; leftCents?: number }[])[0];
    assert.equal(st.method, "CREDIT");
    assert.equal(st.leftCents, 2500);
    assert.ok(st.last4);
    await expectError("more than she has", () => completeSaleAs(owner, { customerId: ann.id, lines: [item(5)], tenders: [{ method: "CREDIT", amountCents: 5000 }] }), /has only \$25\.00 left/);
    assert.equal(await bal(cards[0].id), 2500);
    const cy = await db.customer.create({ data: { shopId: a.shopId, name: "Cy Nothing" } });
    await expectError("a customer with no credit", () => completeSaleAs(owner, { customerId: cy.id, lines: [item(1)], tenders: [{ method: "CREDIT", amountCents: 1000 }] }), /no store credit/);
    await expectError("no customer and no number", () => completeSaleAs(owner, { lines: [item(1)], tenders: [{ method: "CREDIT", amountCents: 1000 }] }), /Pick the customer, or scan/);
    // a slip is spent by its number, by anyone
    await completeSaleAs(owner, { lines: [item(1)], tenders: [{ method: "CREDIT", amountCents: 1000, cardNumber: slipCard.number }] });
    assert.equal(await bal(slipCard.id), 1000);
    // a gift card isn't store credit and the other way round
    await expectError("credit tender with a gift number", async () => {
      const g = await db.giftCard.create({ data: { shopId: a.shopId, number: newGiftCardNumber(), kind: "gift", balanceCents: 0 } });
      return completeSaleAs(owner, { lines: [item(1)], tenders: [{ method: "CREDIT", amountCents: 1000, cardNumber: g.number }] });
    }, /gift card number/);
    await expectError("gift tender with a slip number", () => completeSaleAs(owner, { lines: [item(1)], tenders: [{ method: "GIFT", amountCents: 1000, cardNumber: slipCard.number }] }), /store credit number/);
    ok("spend: the customer's own card without a number, a slip by its number; too much, no credit, no customer, wrong kind: refused, nothing moves");

    // ---------- concurrent spends ----------
    const cc = await db.customer.create({ data: { shopId: a.shopId, name: "Race Credit" } });
    await giveStoreCreditAs(owner, cc.id, 1000, "race");
    const results = await Promise.all(Array.from({ length: 6 }, () => completeSaleAs(owner, { customerId: cc.id, lines: [item(1, 300)], tenders: [{ method: "CREDIT", amountCents: 300 }] }).then(() => "ok", (e) => (isUserError(e) ? (e as Error).message : `crash ${e}`))));
    assert.equal(results.filter((r) => r === "ok").length, 3, JSON.stringify(results));
    assert.equal(await bal((await creditOf(cc.id))[0].id), 100);
    await sum();
    ok("two registers at once on one customer's credit: exactly three $3 spends fit in $10");

    // ---------- tickets ----------
    const tk = await ticket(a.shopId, ann.id);
    await addPaymentFor(owner, tk.id, { amountCents: 1000, method: "CREDIT", note: null });
    assert.equal(await bal(cards[0].id), 1500, "the ticket's customer's credit, no number typed");
    const tp = await db.payment.findFirstOrThrow({ where: { ticketId: tk.id } });
    assert.equal(tp.method, "CREDIT");
    assert.match(tp.note ?? "", /Store credit ending/);
    await removePaymentFor(owner, tp.id);
    assert.equal(await bal(cards[0].id), 2500, "removing the payment gives the credit back");
    const tk2 = await ticket(a.shopId, null);
    await expectError("a ticket without a customer needs a number", () => addPaymentFor(owner, tk2.id, { amountCents: 500, method: "CREDIT", note: null, card: null }), /Pick the customer, or scan/);
    // a refund from a ticket becomes credit on the customer, or a slip with its number in the payment's note
    await addPaymentFor(owner, tk.id, { amountCents: -700, method: "CREDIT", note: null });
    assert.equal(await bal(cards[0].id), 3200);
    await addPaymentFor(owner, tk2.id, { amountCents: -900, method: "CREDIT", note: null });
    const slipPay = await db.payment.findFirstOrThrow({ where: { ticketId: tk2.id } });
    assert.match(slipPay.note ?? "", /New store credit slip GC-/);
    await sum();
    ok("tickets: Store credit as a payment method (the customer's card), removable once; a refund becomes credit or a slip whose number is on the payment");

    // ---------- void ----------
    const before = await bal(cards[0].id);
    const vr = await completeSaleAs(owner, { customerId: ann.id, lines: [item(-2)], tenders: [{ method: "CREDIT", amountCents: -2000 }] });
    assert.equal(await bal(cards[0].id), before + 2000);
    await voidSaleAs(owner, vr.saleId, "returned by mistake");
    assert.equal(await bal(cards[0].id), before, "voiding a return takes the credit back off");
    const vr2 = await completeSaleAs(owner, { customerId: ann.id, lines: [item(-2)], tenders: [{ method: "CREDIT", amountCents: -2000 }] });
    const all = await bal(cards[0].id);
    await completeSaleAs(owner, { customerId: ann.id, lines: [item(1, all)], tenders: [{ method: "CREDIT", amountCents: all }] });
    assert.equal(await bal(cards[0].id), 0, "the credit was spent");
    await expectError("void a return whose credit was spent", () => voidSaleAs(owner, vr2.saleId, "x"), /has been used; \$0\.00 is left/);
    assert.equal((await db.sale.findUniqueOrThrow({ where: { id: vr2.saleId } })).status, "COMPLETED");
    assert.equal(await db.auditEntry.count({ where: { shopId: a.shopId, action: "sale.void", subjectId: vr2.saleId } }), 0);
    await sum();
    ok("void: a return that gave credit takes it back while it is unspent; once spent the void is refused and nothing changes");

    // ---------- read-only ----------
    const l = await checkShop({ repair: true, retail: true });
    const lpart = await db.part.create({ data: { shopId: l.shopId, partNumber: "L-1", description: "x", priceCents: 1000, qtyOnHand: 50, numberKeys: [] } });
    const lc = await db.customer.create({ data: { shopId: l.shopId, name: "Lapsed Customer" } });
    await giveStoreCreditAs(l.user, lc.id, 3000, "before it lapsed");
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    await grantDevLicense(l.shopId, ["base"], { from: day(60), until: day(20), grace: 14, plan: "m", issuedAt: new Date(Date.now() - 60 * 86_400_000) });
    await expectError("spending credit while read-only", () => completeSaleAs(l.user, { customerId: lc.id, lines: [{ partId: lpart.id, description: "x", qty: 1, unitPriceCents: 1000, taxable: true }], tenders: [{ method: "CREDIT", amountCents: 1000 }] }), /read-only|ended|lapsed|subscription|key/i);
    const lr = await completeSaleAs(l.user, { customerId: lc.id, lines: [{ partId: lpart.id, description: "x", qty: -1, unitPriceCents: 1000, taxable: true }], tenders: [{ method: "CREDIT", amountCents: -1000 }] });
    assert.ok(lr.saleId, "a return onto store credit goes through while read-only");
    assert.equal((await db.giftCard.findFirstOrThrow({ where: { shopId: l.shopId, customerId: lc.id } })).balanceCents, 4000);
    ok("read-only: spending credit is refused; a return onto store credit is allowed");

    // ---------- tenant ----------
    const snap = { cards: await rowsOf("GiftCard", a.shopId), entries: await rowsOf("GiftCardEntry", a.shopId) };
    await expectNotFound("B's sale with A's customer", () => completeSaleAs(b.user, { customerId: ann.id, lines: [{ description: "x", qty: -1, unitPriceCents: 1000, taxable: true }], tenders: [{ method: "CREDIT", amountCents: -1000 }] }));
    await expectNotFound("B spends A's slip", async () => {
      const bp = await db.part.create({ data: { shopId: b.shopId, partNumber: "B-1", description: "x", priceCents: 1000, qtyOnHand: 5, numberKeys: [] } });
      return completeSaleAs(b.user, { lines: [{ partId: bp.id, description: "x", qty: 1, unitPriceCents: 1000, taxable: true }], tenders: [{ method: "CREDIT", amountCents: 1000, cardNumber: slipCard.number }] });
    });
    await expectNotFound("B pays a ticket with A's credit", async () => {
      const bt = await ticket(b.shopId, null);
      return addPaymentFor(b.user, bt.id, { amountCents: 500, method: "CREDIT", note: null, card: slipCard.number });
    });
    assert.deepEqual({ cards: await rowsOf("GiftCard", a.shopId), entries: await rowsOf("GiftCardEntry", a.shopId) }, snap, "A's rows unchanged");
    assert.equal(await db.giftCard.count({ where: { shopId: b.shopId } }), 0, "B has no cards");
    ok("tenant: B can't use A's customers, slips or credit; A's rows unchanged");
  } finally {
    await cleanup();
  }
  console.log(`\nstore credit check: ${steps} groups passed`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
