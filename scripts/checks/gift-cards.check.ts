// Gift cards (later-round-1-design.md section 2): sold at the register as an untaxed line, spent in part as a tender that
// checks and reduces the balance atomically, voids and removed payments putting it back, paying out in cash, the owner's
// and admin's tools, the read-only rule, and one company never seeing another's cards.
//   npm run check scripts/checks/gift-cards.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { AUDIT_ACTIONS } from "@/lib/audit-list";
import { addExistingCardAs, adjustCardAs, cardWithEntries, findCard, limitLookups, moveCardAs } from "@/lib/gift-cards";
import { GIFT_MAX_CENTS, GIFT_MIN_CENTS, lastFour, newGiftCardNumber, parseCardNumber } from "@/lib/gift-card-number";
import { addPaymentFor, removePaymentFor } from "@/lib/payments";
import { completeSaleAs, voidSaleAs, type SaleInput } from "@/lib/register-sale";
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

const cardLine = (mode: "new" | "printed" | "load" | "cashout", cents: number, number?: string) => ({ giftCard: { mode, number }, description: "Gift card", qty: mode === "cashout" ? -1 : 1, unitPriceCents: cents, taxable: false });
const cash = (cents: number) => ({ method: "CASH" as const, amountCents: cents });

/** Every card of the company: the ledger sums to the balance, nothing below 0. */
async function ledgerHolds(shopId: string, what: string) {
  const cards = await db.giftCard.findMany({ where: { shopId }, include: { entries: true } });
  for (const c of cards) {
    assert.equal(c.entries.reduce((s, e) => s + e.amountCents, 0), c.balanceCents, `${what}: ledger equals balance for ${c.number}`);
    assert.ok(c.balanceCents >= 0, `${what}: ${c.number} below zero`);
  }
  return cards.length;
}

let n = 9700;
async function ticket(shopId: string, customerId: string | null = null) {
  const m = await db.machine.create({ data: { shopId, customerId, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
  return db.ticket.create({ data: { shopId, number: n++, status: "ON_BENCH", machineId: m.id, customerId, intake: {} } });
}

async function main() {
  const a = await checkShop({ repair: true, retail: true });
  const b = await checkShop({ repair: true, retail: true });
  const owner = a.user;
  const tech: CurrentUser = { ...a.user, role: "TECH" };
  const admin: CurrentUser = { ...a.user, role: "ADMIN" };
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 6 } });
    const part = await db.part.create({ data: { shopId: a.shopId, partNumber: "GC-P1", description: "Needle pack", priceCents: 1000, qtyOnHand: 100, numberKeys: [] } });
    const goods = (qty: number, unit = 1000): SaleInput["lines"][number] => ({ partId: part.id, description: "x", qty, unitPriceCents: unit, taxable: true });

    // ---------- numbers ----------
    const num = newGiftCardNumber();
    assert.match(num, /^GC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]$/);
    assert.equal(new Set(Array.from({ length: 500 }, newGiftCardNumber)).size, 500, "500 numbers, no repeats");
    assert.deepEqual(parseCardNumber(num), { kind: "gc", number: num });
    assert.deepEqual(parseCardNumber(num.toLowerCase().replace(/-/g, " ")), { kind: "gc", number: num }, "case, spaces and dashes don't matter");
    // every single wrong character in the body is caught
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const flat = num.replace(/-/g, "").slice(2);
    for (let i = 0; i < flat.length; i++) {
      const other = alphabet[(alphabet.indexOf(flat[i]) + 1) % 32];
      assert.equal(parseCardNumber(`GC${flat.slice(0, i)}${other}${flat.slice(i + 1)}`).kind, "gc-bad", `a wrong character at ${i} is caught`);
    }
    assert.deepEqual(parseCardNumber("ab-1234 cd"), { kind: "printed", number: "AB1234CD" });
    assert.equal(parseCardNumber("123").kind, "none");
    assert.equal(parseCardNumber("").kind, "none");
    assert.equal(lastFour(num), flat.slice(-4));
    ok("numbers: GC- plus 12 random characters and a check character; any mistyped character is caught; printed numbers read the same way");

    // ---------- sell ----------
    const sold = await completeSaleAs(owner, { lines: [cardLine("new", 5000)], tenders: [cash(5000)] });
    assert.equal(sold.cards?.length, 1);
    assert.equal(sold.cards![0].what, "sold");
    const c1 = await db.giftCard.findFirstOrThrow({ where: { shopId: a.shopId, id: sold.cards![0].cardId } });
    assert.equal(c1.balanceCents, 5000);
    assert.equal(c1.kind, "gift");
    assert.equal(c1.status, "active");
    const sale1 = await db.sale.findFirstOrThrow({ where: { id: sold.saleId }, include: { lines: true } });
    assert.equal(sale1.taxCents, 0, "a gift card is untaxed even at 6%");
    assert.equal(sale1.totalCents, 5000);
    assert.equal(sale1.lines[0].taxable, false);
    assert.equal(sale1.lines[0].giftCardId, c1.id);
    const sellEntry = (await db.giftCardEntry.findMany({ where: { cardId: c1.id } }))[0];
    assert.equal(sellEntry.reason, "SOLD");
    assert.equal(sellEntry.amountCents, 5000);
    assert.equal(sellEntry.saleId, sold.saleId);
    assert.equal(sellEntry.saleLineId, sale1.lines[0].id);
    assert.equal(await db.auditEntry.count({ where: { shopId: a.shopId, action: "giftcard.sell", subjectId: c1.id } }), 1);

    // untaxed and never discounted next to goods: the sale discount comes off the goods only
    const mixed = await completeSaleAs(owner, { lines: [cardLine("new", 2500), goods(1)], orderDiscountCents: 100, tenders: [cash(5000)] });
    const mixedSale = await db.sale.findFirstOrThrow({ where: { id: mixed.saleId }, include: { lines: true } });
    const gl = mixedSale.lines.find((l) => l.giftCardId)!;
    assert.equal(gl.discountCents, 0);
    assert.equal(mixedSale.discountCents, 100);
    assert.equal(mixedSale.taxCents, Math.round(((1000 - 100) * 6) / 100), "tax on the goods only, after their discount");
    assert.equal(mixedSale.totalCents, 2500 + 900 + 54);
    ok("sell: a card line is untaxed, never discounted, one card per line; the card, its SOLD entry and its audit entry commit with the sale");

    // limits, roles, pre-printed, load
    await expectError("under the minimum", () => completeSaleAs(owner, { lines: [cardLine("new", GIFT_MIN_CENTS - 1)], tenders: [cash(GIFT_MIN_CENTS)] }), /from \$5\.00 to \$500\.00/);
    await expectError("over the maximum", () => completeSaleAs(owner, { lines: [cardLine("new", GIFT_MAX_CENTS + 1)], tenders: [cash(GIFT_MAX_CENTS + 1)] }), /from \$5\.00 to \$500\.00/);
    await expectError("two at once", () => completeSaleAs(owner, { lines: [{ ...cardLine("new", 1000), qty: 2 }], tenders: [cash(2000)] }), /one at a time/);
    await expectError("a gift line that is also an item", () => completeSaleAs(owner, { lines: [{ ...cardLine("new", 1000), partId: part.id }], tenders: [cash(1000)] }), /only be one thing/);
    const techSale = await completeSaleAs(tech, { lines: [cardLine("new", 1000)], tenders: [cash(1000)] });
    assert.equal(techSale.cards?.length, 1, "any role can sell a card");
    const printed = await completeSaleAs(owner, { lines: [cardLine("printed", 3000, " ab-123456 ")], tenders: [cash(3000)] });
    assert.equal(printed.cards![0].number, "AB123456");
    await expectError("a number already used", () => completeSaleAs(owner, { lines: [cardLine("printed", 3000, "AB123456")], tenders: [cash(3000)] }), /already in use/);
    await expectError("a number that looks like ours", () => completeSaleAs(owner, { lines: [cardLine("printed", 3000, num)], tenders: [cash(3000)] }), /looks like one the program makes/);
    await expectError("too short", () => completeSaleAs(owner, { lines: [cardLine("printed", 3000, "12")], tenders: [cash(3000)] }), /printed on the card/);
    const loaded = await completeSaleAs(owner, { lines: [cardLine("load", 2000, c1.number)], tenders: [cash(2000)] });
    assert.equal(loaded.cards![0].what, "loaded");
    assert.equal((await db.giftCard.findUniqueOrThrow({ where: { id: c1.id } })).balanceCents, 7000);
    await expectError("load a number that isn't a card", () => completeSaleAs(owner, { lines: [cardLine("load", 2000, newGiftCardNumber())], tenders: [cash(2000)] }), /not found/);
    await expectError("a wrong check character", () => completeSaleAs(owner, { lines: [cardLine("load", 2000, `${num.slice(0, -1)}${num.endsWith("0") ? "1" : "0"}`)], tenders: [cash(2000)] }), /isn't right/);
    assert.equal((await db.sale.count({ where: { shopId: a.shopId } })), 5, "refused sales left nothing behind");
    ok("sell and load: limits $5 to $500, one at a time, any role, pre-printed numbers (used or look-alike refused), loading adds to the balance");

    // ---------- spend, partly ----------
    const stock0 = (await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand;
    // $12 of goods at 6% = $12.72; a card holding $70 pays $12.72 of it... and part by cash
    const s1 = await completeSaleAs(owner, { lines: [goods(1, 1200)], tenders: [{ method: "GIFT", amountCents: 1000, cardNumber: c1.number.toLowerCase() }, cash(272)] });
    const bal = async (id: string) => (await db.giftCard.findUniqueOrThrow({ where: { id } })).balanceCents;
    assert.equal(await bal(c1.id), 6000);
    const sale2 = await db.sale.findFirstOrThrow({ where: { id: s1.saleId } });
    const t1 = (sale2.tenders as { method: string; amountCents: number; cardId?: string; last4?: string; leftCents?: number; cardNumber?: string }[])[0];
    assert.equal(t1.cardId, c1.id);
    assert.equal(t1.last4, lastFour(c1.number));
    assert.equal(t1.leftCents, 6000);
    assert.equal(t1.cardNumber, undefined, "the full number isn't kept in the sale");
    const red = await db.giftCardEntry.findFirstOrThrow({ where: { cardId: c1.id, reason: "REDEEMED" } });
    assert.equal(red.amountCents, -1000);
    assert.equal(red.saleId, s1.saleId);
    await expectError("more than the total", () => completeSaleAs(owner, { lines: [goods(1, 1200)], tenders: [{ method: "GIFT", amountCents: 1500, cardNumber: c1.number }] }), /can't be more than the total/);
    // the card holds $60.00: a sale of $100 can't take $70 from it
    await expectError("more than the card holds", () => completeSaleAs(owner, { lines: [goods(1, 10000)], tenders: [{ method: "GIFT", amountCents: 6500, cardNumber: c1.number }, cash(4100)] }), /has only \$60\.00 left/);
    assert.equal(await bal(c1.id), 6000, "the failed sale moved nothing");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand, stock0 - 1, "and took no stock");
    await expectError("no number", () => completeSaleAs(owner, { lines: [goods(1)], tenders: [{ method: "GIFT", amountCents: 1060 }] }), /Scan or type the card number/);
    await expectError("an unknown number", () => completeSaleAs(owner, { lines: [goods(1)], tenders: [{ method: "GIFT", amountCents: 1060, cardNumber: newGiftCardNumber() }] }), /not found/);
    await expectError("a store credit tender on a gift card", () => completeSaleAs(owner, { lines: [goods(1)], tenders: [{ method: "CREDIT", amountCents: 1060, cardNumber: c1.number }] }), /gift card number/);
    ok("spend: a partial gift card tender takes its amount off the card and the receipt keeps what is left; too much, no number, unknown, wrong kind: refused, nothing moves");

    // ---------- two registers at once ----------
    const race = await completeSaleAs(owner, { lines: [cardLine("new", 1000)], tenders: [cash(1000)] });
    const raceCard = race.cards![0];
    const stockBefore = (await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand;
    const tries = Array.from({ length: 8 }, () => completeSaleAs(owner, { lines: [goods(1, 300)], tenders: [{ method: "GIFT", amountCents: 318, cardNumber: raceCard.number }] }).then(() => "ok" as const, (e) => (isUserError(e) ? (e as Error).message : `crash ${e}`)));
    const results = await Promise.all(tries);
    const won = results.filter((r) => r === "ok").length;
    assert.equal(won, 3, `exactly three $3.18 spends fit in $10.00 (got ${won}): ${JSON.stringify(results)}`);
    for (const r of results.filter((x) => x !== "ok")) assert.match(r, /has only \$/, "the losers are told what is left");
    assert.equal(await bal(raceCard.cardId), 1000 - 3 * 318, "balance exact");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand, stockBefore - 3, "only the winners took stock");
    assert.equal(await db.giftCardEntry.count({ where: { cardId: raceCard.cardId, reason: "REDEEMED" } }), 3);
    await ledgerHolds(a.shopId, "after the race");
    // a sale and a ticket payment at once on the same card
    const rt = await ticket(a.shopId);
    const rc = (await completeSaleAs(owner, { lines: [cardLine("new", 500)], tenders: [cash(500)] })).cards![0];
    const mix = await Promise.all([
      completeSaleAs(owner, { lines: [goods(1, 300)], tenders: [{ method: "GIFT", amountCents: 318, cardNumber: rc.number }] }).then(() => "ok", (e) => (isUserError(e) ? "refused" : `crash ${e}`)),
      addPaymentFor(owner, rt.id, { amountCents: 300, method: "GIFT", note: null, card: rc.number }).then(() => "ok", (e) => (isUserError(e) ? "refused" : `crash ${e}`)),
    ]);
    assert.deepEqual([...mix].sort(), ["ok", "refused"], "a sale and a ticket payment can't both take the last of a card");
    await ledgerHolds(a.shopId, "after the mixed race");
    ok("two registers at once: the guarded update lets exactly as many spends through as the card holds; losers are told what is left and leave no stock or ledger line");

    // ---------- ticket payments ----------
    const tk = await ticket(a.shopId);
    await addPaymentFor(owner, tk.id, { amountCents: 2000, method: "GIFT", note: "front desk", card: c1.number });
    const pay = await db.payment.findFirstOrThrow({ where: { ticketId: tk.id } });
    assert.equal(pay.method, "GIFT");
    assert.match(pay.note ?? "", /front desk · Gift card ending/);
    assert.equal(await bal(c1.id), 4000);
    const pe = await db.giftCardEntry.findFirstOrThrow({ where: { paymentId: pay.id } });
    assert.equal(pe.amountCents, -2000);
    assert.equal(pe.ticketId, tk.id);
    await expectError("no number on a ticket", () => addPaymentFor(owner, tk.id, { amountCents: 500, method: "GIFT", note: null, card: null }), /Scan or type the card number/);
    await expectError("more than the card", () => addPaymentFor(owner, tk.id, { amountCents: 9000, method: "GIFT", note: null, card: c1.number }), /has only \$40\.00 left/);
    assert.equal(await db.payment.count({ where: { ticketId: tk.id } }), 1, "the refused payment left no payment");
    await removePaymentFor(owner, pay.id);
    assert.equal(await bal(c1.id), 6000, "removing the payment puts the amount back");
    const back = await db.giftCardEntry.findFirstOrThrow({ where: { cardId: c1.id, reason: "VOID", ticketId: tk.id } });
    assert.equal(back.amountCents, 2000);
    await expectError("removed twice", () => removePaymentFor(owner, pay.id), /already removed/);
    assert.equal(await bal(c1.id), 6000);
    // money back onto a gift card from a ticket (a refund)
    await addPaymentFor(owner, tk.id, { amountCents: -500, method: "GIFT", note: null, card: c1.number });
    assert.equal(await bal(c1.id), 6500);
    await expectError("a tech can't refund", () => addPaymentFor(tech, tk.id, { amountCents: -500, method: "GIFT", note: null, card: c1.number }), /owner or an admin/);
    await expectNotFound("another company's ticket", () => addPaymentFor(b.user, tk.id, { amountCents: 500, method: "GIFT", note: null, card: c1.number }));
    ok("ticket payments: Gift card as a method takes the balance in the payment's transaction; removing it puts it back once; refunds go onto the card");

    // ---------- void ----------
    const stock1 = (await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand;
    const vs = await completeSaleAs(owner, { lines: [goods(1, 2000)], tenders: [{ method: "GIFT", amountCents: 2000, cardNumber: c1.number }, cash(120)] });
    assert.equal(await bal(c1.id), 4500);
    await voidSaleAs(owner, vs.saleId, "mistake");
    assert.equal(await bal(c1.id), 6500, "voiding restores what the sale spent");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand, stock1);
    assert.ok(await db.giftCardEntry.findFirst({ where: { cardId: c1.id, saleId: vs.saleId, reason: "VOID", amountCents: 2000 } }));
    await expectError("void twice", () => voidSaleAs(owner, vs.saleId, "again"), /already void/);
    assert.equal(await bal(c1.id), 6500);
    // a sale that sold a card: void while unspent goes through (the card goes void), after a spend it is refused
    const vsold = await completeSaleAs(owner, { lines: [cardLine("new", 4000)], tenders: [cash(4000)] });
    const vcard = vsold.cards![0];
    await voidSaleAs(owner, vsold.saleId, "wrong amount");
    const vc = await db.giftCard.findUniqueOrThrow({ where: { id: vcard.cardId } });
    assert.equal(vc.balanceCents, 0);
    assert.equal(vc.status, "void");
    await expectError("spending a void card", () => completeSaleAs(owner, { lines: [goods(1)], tenders: [{ method: "GIFT", amountCents: 500, cardNumber: vcard.number }, cash(620)] }), /has only \$0\.00 left|is void/);
    const used = await completeSaleAs(owner, { lines: [cardLine("new", 4000)], tenders: [cash(4000)] });
    await completeSaleAs(owner, { lines: [goods(1, 1000)], tenders: [{ method: "GIFT", amountCents: 1000, cardNumber: used.cards![0].number }, cash(60)] });
    await expectError("void a sale whose card was spent", () => voidSaleAs(owner, used.saleId, "x"), /has been used; \$30\.00 is left\. Return what's left instead/);
    assert.equal((await db.sale.findUniqueOrThrow({ where: { id: used.saleId } })).status, "COMPLETED", "still complete");
    assert.equal(await bal(used.cards![0].cardId), 3000, "and the card untouched");
    assert.equal(await db.auditEntry.count({ where: { shopId: a.shopId, action: "sale.void", subjectId: used.saleId } }), 0, "and no void in the audit log");
    // a load voided: the amount comes off
    const ld = await completeSaleAs(owner, { lines: [cardLine("load", 1000, c1.number)], tenders: [cash(1000)] });
    assert.equal(await bal(c1.id), 7500);
    await voidSaleAs(owner, ld.saleId, "wrong card");
    assert.equal(await bal(c1.id), 6500);
    ok("void: a sale that spent a card gives it back; a sale that sold or loaded one takes it off, and is refused once it has been spent (nothing changes, no audit entry)");

    // ---------- pay out in cash ----------
    const co = (await completeSaleAs(owner, { lines: [cardLine("new", 2000)], tenders: [cash(2000)] })).cards![0];
    await expectError("a tech can't pay out", () => completeSaleAs(tech, { lines: [cardLine("cashout", 0, co.number)], tenders: [cash(-2000)] }), /owner or an admin/);
    await expectError("payout is cash", () => completeSaleAs(owner, { lines: [cardLine("cashout", 0, co.number)], tenders: [{ method: "CARD", amountCents: -2000 }] }), /paid out in cash/);
    const out = await completeSaleAs(admin, { lines: [cardLine("cashout", 99999, co.number)], tenders: [cash(-2000)] });
    const outSale = await db.sale.findFirstOrThrow({ where: { id: out.saleId }, include: { lines: true } });
    assert.equal(outSale.totalCents, -2000, "the server's figure, not the browser's");
    assert.equal(outSale.lines[0].taxable, false);
    assert.equal(await bal(co.cardId), 0);
    assert.ok(await db.giftCardEntry.findFirst({ where: { cardId: co.cardId, reason: "CASHED_OUT", amountCents: -2000, saleId: out.saleId } }));
    await expectError("nothing left", () => completeSaleAs(owner, { lines: [cardLine("cashout", 0, co.number)], tenders: [cash(0)] }), /nothing left/);
    assert.equal(await db.auditEntry.count({ where: { shopId: a.shopId, action: "giftcard.cashout", subjectId: co.cardId } }), 1);
    await voidSaleAs(owner, out.saleId, "paid out by mistake");
    assert.equal(await bal(co.cardId), 2000, "voiding a payout puts the balance back");
    ok("pay out in cash: a negative card line with a cash refund, priced by the server, owner or admin, drawer and tender totals right; void restores");

    // ---------- admin tools ----------
    await expectError("a tech can't add a card", () => addExistingCardAs(tech, { number: "OLDPAPER1", amountCents: 2500 }), /owner or an admin/);
    const old = await addExistingCardAs(admin, { number: "old-paper 1", amountCents: 2500 });
    assert.equal(old.number, "OLDPAPER1");
    assert.equal((await db.giftCardEntry.findFirstOrThrow({ where: { cardId: old.id } })).reason, "OPENING");
    assert.equal(await bal(old.id), 2500);
    await expectError("a number twice", () => addExistingCardAs(admin, { number: "OLDPAPER1", amountCents: 100 }), /already in use/);
    await expectError("adjust: admin refused", () => adjustCardAs(admin, old.id, 1000, "x"), /Only the owner/);
    await expectError("adjust: a reason is required", () => adjustCardAs(owner, old.id, 1000, " "), /say why/);
    await adjustCardAs(owner, old.id, 1000, "counted wrong");
    assert.equal(await bal(old.id), 1000);
    const adj = await db.giftCardEntry.findFirstOrThrow({ where: { cardId: old.id, reason: "ADJUSTED" } });
    assert.equal(adj.amountCents, -1500);
    assert.equal(adj.note, "counted wrong");
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Cardholder", phone: "5550100" } });
    await db.giftCard.update({ where: { id: old.id }, data: { customerId: cust.id } });
    const moved = await moveCardAs(admin, old.id, null, "lost it");
    assert.notEqual(moved.number, old.number);
    assert.equal(moved.customerId, cust.id, "the customer goes with the balance");
    assert.equal(await bal(moved.id), 1000);
    const oldRow = await db.giftCard.findUniqueOrThrow({ where: { id: old.id } });
    assert.equal(oldRow.balanceCents, 0);
    assert.equal(oldRow.status, "void");
    await expectError("the old number is dead", () => completeSaleAs(owner, { lines: [goods(1)], tenders: [{ method: "GIFT", amountCents: 500, cardNumber: old.number }, cash(620)] }), /has only \$0\.00 left|is void/);
    await expectError("move a void card", () => moveCardAs(admin, old.id, null, "again"), /already void/);
    await expectError("a tech can't move", () => moveCardAs(tech, moved.id, null, "x"), /owner or an admin/);
    // A card sold, then moved to a new number: voiding the sale takes the money off the new number (and voids it).
    const soldThenMoved = await completeSaleAs(owner, { lines: [cardLine("new", 1500)], tenders: [cash(1500)] });
    const smCard = await db.giftCard.findFirstOrThrow({ where: { shopId: a.shopId, number: soldThenMoved.cards![0].number } });
    const smNew = await moveCardAs(admin, smCard.id, null, "lost it");
    await voidSaleAs(owner, soldThenMoved.saleId, "sold by mistake");
    const smAfter = await db.giftCard.findUniqueOrThrow({ where: { id: smNew.id } });
    assert.deepEqual([smAfter.balanceCents, smAfter.status], [0, "void"], "the money came off the new number");
    for (const action of ["giftcard.opening", "giftcard.adjust", "giftcard.move"] as const) {
      assert.ok(AUDIT_ACTIONS[action]);
      assert.ok(await db.auditEntry.findFirst({ where: { shopId: a.shopId, action } }), `${action} is in the audit log`);
    }
    ok("owner and admin tools: add an existing card (OPENING), adjust (owner, reason), move a lost card (customer follows), each in the audit log");

    // ---------- the lookup page's reads ----------
    const full = await cardWithEntries(a.shopId, c1.id);
    assert.ok(full && full.entries.length >= 5);
    assert.equal((await findCard(db, a.shopId, c1.number)).id, c1.id);
    const u = { ...owner, id: `limit-${Date.now()}` };
    for (let i = 0; i < 40; i++) limitLookups(u.id);
    assert.throws(() => limitLookups(u.id), /Too many card lookups/);
    ok("lookups: a card with its ledger; per-person rate limit");

    // ---------- the books agree ----------
    const count = await ledgerHolds(a.shopId, "A");
    assert.ok(count >= 8);
    await assert.rejects(() => db.giftCard.update({ where: { id: c1.id }, data: { balanceCents: -1 } }), /GiftCard_balance_nonneg|check constraint/);
    ok(`the ledger sums to the balance on all ${count} cards, nothing below zero (and the database refuses a negative balance)`);

    // ---------- read-only ----------
    const l = await checkShop({ repair: true, retail: true });
    const lpart = await db.part.create({ data: { shopId: l.shopId, partNumber: "L-1", description: "x", priceCents: 1000, qtyOnHand: 50, numberKeys: [] } });
    const lcard = (await completeSaleAs(l.user, { lines: [cardLine("new", 5000)], tenders: [cash(5000)] })).cards![0];
    const ltk = await ticket(l.shopId);
    await addPaymentFor(l.user, ltk.id, { amountCents: 1000, method: "GIFT", note: null, card: lcard.number });
    const lpay = await db.payment.findFirstOrThrow({ where: { ticketId: ltk.id } });
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    await grantDevLicense(l.shopId, ["base"], { from: day(60), until: day(20), grace: 14, plan: "m", issuedAt: new Date(Date.now() - 60 * 86_400_000) });
    await expectError("selling a card while read-only", () => completeSaleAs(l.user, { lines: [cardLine("new", 5000)], tenders: [cash(5000)] }), /read-only|ended|lapsed|subscription|key/i);
    await expectError("spending a card while read-only", () => completeSaleAs(l.user, { lines: [{ partId: lpart.id, description: "x", qty: 1, unitPriceCents: 1000, taxable: true }], tenders: [{ method: "GIFT", amountCents: 1000, cardNumber: lcard.number }] }), /read-only|ended|lapsed|subscription|key/i);
    await expectError("a ticket payment from a card while read-only", () => addPaymentFor(l.user, ltk.id, { amountCents: 500, method: "GIFT", note: null, card: lcard.number }), /read-only|ended|lapsed|subscription|key/i);
    const cashPay = await addPaymentFor(l.user, ltk.id, { amountCents: 500, method: "CASH", note: null });
    void cashPay;
    // money back and payouts still go through
    const lout = await completeSaleAs(l.user, { lines: [cardLine("cashout", 0, lcard.number)], tenders: [cash(-4000)] });
    assert.equal((await db.giftCard.findUniqueOrThrow({ where: { id: lcard.cardId } })).balanceCents, 0, "a payout works while read-only");
    void lout;
    await removePaymentFor(l.user, lpay.id);
    assert.equal(await db.giftCardEntry.count({ where: { cardId: lcard.cardId, reason: "VOID" } }), 1, "removing a card payment works while read-only");
    ok("read-only: selling, loading and spending a card are refused; cash payments, payouts and removing a payment go through");

    // ---------- tenant ----------
    const before = { cards: await rowsOf("GiftCard", a.shopId), entries: await rowsOf("GiftCardEntry", a.shopId), sales: await rowsOf("Sale", a.shopId) };
    await expectNotFound("find A's card as B", () => findCard(db, b.shopId, c1.number));
    await expectNotFound("A's card by id as B", async () => cardWithEntries(b.shopId, c1.id));
    await expectNotFound("spend A's card in B's sale", async () => {
      await db.part.create({ data: { shopId: b.shopId, partNumber: "B-1", description: "x", priceCents: 1000, qtyOnHand: 5, numberKeys: [] } });
      const bp = await db.part.findFirstOrThrow({ where: { shopId: b.shopId, partNumber: "B-1" } });
      return completeSaleAs(b.user, { lines: [{ partId: bp.id, description: "x", qty: 1, unitPriceCents: 1000, taxable: true }], tenders: [{ method: "GIFT", amountCents: 1000, cardNumber: c1.number }] });
    });
    await expectNotFound("load A's card in B's sale", () => completeSaleAs(b.user, { lines: [cardLine("load", 1000, c1.number)], tenders: [cash(1000)] }));
    await expectNotFound("cash out A's card as B", () => completeSaleAs(b.user, { lines: [cardLine("cashout", 0, c1.number)], tenders: [cash(-1)] }));
    await expectNotFound("adjust A's card as B", () => adjustCardAs(b.user, c1.id, 0, "x"));
    await expectNotFound("move A's card as B", () => moveCardAs(b.user, c1.id, null, "x"));
    // the same printed number may exist in two companies
    await completeSaleAs(b.user, { lines: [cardLine("printed", 1000, "AB123456")], tenders: [cash(1000)] });
    assert.deepEqual({ cards: await rowsOf("GiftCard", a.shopId), entries: await rowsOf("GiftCardEntry", a.shopId), sales: await rowsOf("Sale", a.shopId) }, before, "A's rows are exactly as before");
    ok("tenant: B's lookups, spends, loads, payouts, adjustments and moves of A's cards all say not found, and A's rows are unchanged; the same printed number can live in two companies");
  } finally {
    await cleanup();
  }
  console.log(`\ngift cards check: ${steps} groups passed`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
