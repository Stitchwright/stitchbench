// The card reader at the counter (shop-features-round-2-design.md 4.8, package card-reader), against the Stripe Terminal
// mock (scripts/test-mail/stripe-terminal-mock.mjs; never real money): the settings (owner or admin, a secret key,
// on), pairing the simulated reader (the location made once), a payment sent to the reader, the simulated tap approved
// or declined, cancelling, the sale checked with Stripe (approved, the amount, this shop's, used once; the card's last
// four kept), a return from the receipt refunding the card, a void freeing the payment and its refund from Settings,
// tenant.
//   npm run check scripts/checks/card-reader.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import {
  cancelReaderPaymentFor,
  loosePayments,
  pairReaderFor,
  readerPaymentStatusFor,
  readerSettings,
  refundLoosePaymentFor,
  registerReaders,
  saveReaderSettingsFor,
  simulateTapFor,
  startReaderPaymentFor,
} from "@/lib/card-reader";
import { startTerminalMock } from "../test-mail/stripe-terminal-mock.mjs";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });
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
const KEY = "sk_test_cardreader123456";
let n = 0;
const ck = () => `chk${Date.now().toString(36)}${n++}`;

async function main() {
  const mock = await startTerminalMock({ port: 0 });
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.port}`;
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });

    // 1. Settings and pairing.
    await expectError("a tech", () => saveReaderSettingsFor(tech(a), fd({ on: "on", stripeKey: KEY })), /owner or admin/);
    await expectError("a bad key", () => saveReaderSettingsFor(a.user, fd({ stripeKey: "pk_test_123456789" })), /starts with sk_/);
    await expectError("on without a key", () => saveReaderSettingsFor(a.user, fd({ on: "on" })), /Paste your Stripe secret key/);
    await saveReaderSettingsFor(a.user, fd({ on: "on", stripeKey: KEY }));
    assert.equal(await registerReaders(a.shopId).then((r) => r?.readers.length), 0);
    await expectError("a wrong code", () => pairReaderFor(a.user, fd({ code: "wrong-words-here" })), /refused the request/);
    await pairReaderFor(a.user, fd({ code: "simulated-wpe", label: "Front counter" }));
    const s = await readerSettings(a.shopId);
    assert.deepEqual([s.on, s.hasKey, s.testMode, !!s.locationId, s.readers.length, s.readers[0].deviceType], [true, true, true, true, 1, "simulated_wisepos_e"]);
    const reader = s.readers[0];
    ok("settings: owner or admin, a secret key (test mode), on; pairing the simulated reader by its code (a wrong one refused)");

    // 2. A payment on the reader.
    await expectError("too little", () => startReaderPaymentFor(a.user, reader.id, 10, ck()), /\$0.50/);
    const p1 = await startReaderPaymentFor(a.user, reader.id, 2500, ck());
    assert.equal((await readerPaymentStatusFor(a.user, p1.paymentId)).status, "waiting");
    await simulateTapFor(a.user, p1.paymentId);
    const st = await readerPaymentStatusFor(a.user, p1.paymentId);
    assert.deepEqual([st.status, st.last4, st.amountCents], ["approved", "4242", 2500]);
    const p2 = await startReaderPaymentFor(a.user, reader.id, 1000, ck());
    await simulateTapFor(a.user, p2.paymentId, true);
    const d = await readerPaymentStatusFor(a.user, p2.paymentId);
    assert.deepEqual([d.status, d.message], ["declined", "Your card was declined."]);
    await cancelReaderPaymentFor(a.user, p2.paymentId);
    assert.equal((await readerPaymentStatusFor(a.user, p2.paymentId)).status, "cancelled");
    ok("a payment sent to the reader: waiting, the simulated tap approves (last four 4242); a declined card says so, then cancelled");

    // 3. The sale.
    const line = { description: "Machine service kit", qty: 1, unitPriceCents: 2500, taxable: true };
    await expectError("the amount differs", () => completeSaleAs(a.user, { lines: [{ ...line, unitPriceCents: 3000 }], tenders: [{ method: "CARD", amountCents: 3000, stripeIntent: p1.intentId }] }), /amount doesn't match/);
    await expectError("a declined payment", () => completeSaleAs(a.user, { lines: [{ ...line, unitPriceCents: 1000 }], tenders: [{ method: "CARD", amountCents: 1000, stripeIntent: p2.intentId }] }), /wasn't approved/);
    await expectError("B uses A's payment", () => completeSaleAs(b.user, { lines: [line], tenders: [{ method: "CARD", amountCents: 2500, stripeIntent: p1.intentId }] }), /isn't one of this shop's/);
    const sale = await completeSaleAs(a.user, { lines: [line], tenders: [{ method: "CARD", amountCents: 2500, stripeIntent: p1.intentId }] });
    const row = await db.sale.findFirstOrThrow({ where: { id: sale.saleId } });
    assert.deepEqual((row.tenders as { method: string; last4?: string; stripeIntent?: string }[]).map((t) => [t.method, t.last4, t.stripeIntent]), [["CARD", "4242", p1.intentId]]);
    assert.equal((await db.cardPayment.findUniqueOrThrow({ where: { intentId: p1.intentId } })).saleId, sale.saleId);
    await expectError("used twice", () => completeSaleAs(a.user, { lines: [line], tenders: [{ method: "CARD", amountCents: 2500, stripeIntent: p1.intentId }] }), /already on another sale/);
    ok("the sale: checked with Stripe (the amount, approved, this shop's), the card's last four on the receipt, the payment used once");

    // 4. A return from the receipt refunds the card.
    const ret = await completeSaleAs(a.user, { returnOfSaleId: sale.saleId, lines: [{ ...line, qty: -1 }], tenders: [{ method: "CARD", amountCents: -1000 }, { method: "CASH", amountCents: -1500 }] });
    assert.deepEqual(mock.refunds.map((r) => [r.payment_intent, r.amount]), [[p1.intentId, 1000]]);
    assert.equal((await db.cardPayment.findUniqueOrThrow({ where: { intentId: p1.intentId } })).refundedCents, 1000);
    assert.match((await db.sale.findFirstOrThrow({ where: { id: ret.saleId } })).note ?? "", /\$10.00 refunded to the card on the reader/);
    ok("a return from the receipt: its Card part goes back to the card at Stripe, noted on the return");

    // 5. Void frees the payment; refund it from Settings.
    await voidSaleAs(a.user, ret.saleId, "undo the return");
    await voidSaleAs(a.user, sale.saleId, "wrong");
    const loose = await loosePayments(a.shopId);
    assert.deepEqual(loose.map((l) => l.intentId), [p1.intentId]);
    await expectError("a tech refunds", () => refundLoosePaymentFor(tech(a), loose[0].id), /owner or admin/);
    assert.match(await refundLoosePaymentFor(a.user, loose[0].id), /Refunded \$15.00/);
    const looseId = loose[0].id;
    assert.equal((await loosePayments(a.shopId)).length, 0);
    await expectError("a refunded payment on a new sale", () => completeSaleAs(a.user, { lines: [line], tenders: [{ method: "CARD", amountCents: 2500, stripeIntent: p1.intentId }] }), /was refunded/);
    ok("a void frees the payment; Settings refunds what is left of it to the card (owner or admin); a refunded payment can't pay a new sale");

    // 6. Tenant; off.
    await expectNotFound("B asks about A's payment", () => readerPaymentStatusFor(b.user, p1.paymentId));
    await expectNotFound("B cancels A's payment", () => cancelReaderPaymentFor(b.user, p1.paymentId));
    await expectNotFound("B taps A's reader", () => simulateTapFor(b.user, p1.paymentId));
    await expectNotFound("B refunds A's payment", () => refundLoosePaymentFor(b.user, looseId));
    await saveReaderSettingsFor(b.user, fd({ on: "on", stripeKey: KEY }));
    await expectNotFound("B charges on A's reader", () => startReaderPaymentFor(b.user, reader.id, 1000, ck()));
    assert.deepEqual(await loosePayments(b.shopId), []);
    await saveReaderSettingsFor(a.user, fd({}));
    assert.equal(await registerReaders(a.shopId), null, "off: the register offers no reader");
    await expectError("off", () => startReaderPaymentFor(a.user, reader.id, 1000, ck()), /card reader is off/);
    ok("tenant: B can't read, cancel, tap, refund or charge on A's reader; off, the register has none");
  } finally {
    await cleanup();
    await mock.close();
  }
  console.log(`card-reader.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
