// Customers' used machines on consignment (shop-features-round-2-design.md 9.6, package consign-machines): a machine for
// sale made a customer's (owner or admin; the shop's usual commission or one typed), sold at the register (her payout
// written: the price less the line discount less the commission), paid by check (number needed) and undone, the sale's
// void refused while she is paid and taking the payout back once not, a return before payment taking it back and the
// return's void owing it again, paid in store credit (her card), given back unsold, the statement, the books, the
// customer delete's blockers, tenant.
//   npm run check scripts/checks/consign-machines.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { receiveUnitsFor } from "@/lib/units/units";
import { buildBooks, balanced } from "@/lib/books";
import { DEFAULT_BOOKS } from "@/lib/books-accounts";
import { customerDeletePlan } from "@/lib/merge";
import { consignedUnits, consignorShare, consignorStatement, giveBackFor, payOutFor, payoutsFor, saveConsignDefaultFor, setConsignFor, undoPayoutFor } from "@/lib/consign-machines";
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
const cash = (amountCents: number) => [{ method: "CASH" as const, amountCents }];

async function main() {
  assert.deepEqual([consignorShare(40000, 25), consignorShare(39999, 25), consignorShare(1000, 0), consignorShare(1000, 100)], [30000, 29999, 1000, 0]);
  ok("her share: the price less the shop's commission");

  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const her = await db.customer.create({ data: { shopId: a.shopId, name: "Connie Consignor", phone: "555-0123" } });
    const buyer = await db.customer.create({ data: { shopId: a.shopId, name: "Bea Buyer", phone: "555-0124" } });
    const [u1, u2] = await receiveUnitsFor(a.user, fd({ kind: "sewing", brand: "Bernina", model: "830", condition: "USED", priceCents: "400.00", serials: "BN-1\nBN-2" }));

    // 1. Setting it.
    await expectError("a tech", () => setConsignFor(tech(a), u1, fd({ customerId: her.id })), /owner or admin/);
    await expectError("a bad percent", () => setConsignFor(a.user, u1, fd({ customerId: her.id, pct: "150" })), /0 to 100/);
    await saveConsignDefaultFor(a.user, fd({ pct: "30" }));
    await setConsignFor(a.user, u1, fd({ customerId: her.id, until: "2026-12-31" }));
    await setConsignFor(a.user, u2, fd({ customerId: her.id, pct: "20%" }));
    let units = await consignedUnits(a.shopId);
    assert.deepEqual(units.map((u) => [u.id, u.consignPct, u.consignUntil, u.consignor]), [[u1, 30, "2026-12-31", "Connie Consignor"], [u2, 20, null, "Connie Consignor"]]);
    ok("a machine made hers: the shop's usual 30% or one typed, the give-back day; a tech can't");

    // 2. Sold with a $20 line discount: she gets 70% of $380.
    const s1 = await completeSaleAs(a.user, { customerId: buyer.id, lines: [{ description: "", qty: 1, unitPriceCents: 40000, discountCents: 2000, taxable: true, stockUnitId: u1 }], tenders: cash(38000) });
    let owed = await payoutsFor(a.shopId, { paid: false });
    assert.equal(owed.length, 1);
    assert.deepEqual([owed[0].soldCents, owed[0].pct, owed[0].amountCents, owed[0].consignor], [38000, 30, 26600, "Connie Consignor"]);
    await expectError("check without number", () => payOutFor(a.user, owed[0].id, fd({ method: "CHECK" })), /check number/);
    await payOutFor(a.user, owed[0].id, fd({ method: "CHECK", note: "1042" }));
    await expectError("pay twice", () => payOutFor(a.user, owed[0].id, fd({ method: "CASH" })), /has been paid/);
    await expectError("void while paid", () => voidSaleAs(a.user, s1.saleId, "oops"), /has been paid/);
    await undoPayoutFor(a.user, owed[0].id);
    await voidSaleAs(a.user, s1.saleId, "oops");
    assert.deepEqual(await payoutsFor(a.shopId, { paid: false }), [], "the void took the payout back");
    ok("sold: she is owed the price less discount less commission; paid by check (its number), undone; the void waits for that, then takes it back");

    // 3. Sold again, returned before she was paid, the return voided.
    await completeSaleAs(a.user, { customerId: buyer.id, lines: [{ description: "", qty: 1, unitPriceCents: 40000, taxable: true, stockUnitId: u1 }], tenders: cash(40000) });
    const r = await completeSaleAs(a.user, { customerId: buyer.id, lines: [{ description: "", qty: -1, unitPriceCents: 40000, taxable: true, stockUnitId: u1 }], tenders: cash(-40000) });
    assert.deepEqual(await payoutsFor(a.shopId, { paid: false }), [], "returned unpaid: nothing owed");
    await voidSaleAs(a.user, r.saleId, "kept it after all");
    owed = await payoutsFor(a.shopId, { paid: false });
    assert.deepEqual(owed.map((p) => p.amountCents), [28000], "the return's void: owed again");
    await payOutFor(a.user, owed[0].id, fd({ method: "CREDIT" }));
    const card = await db.giftCard.findFirstOrThrow({ where: { shopId: a.shopId, customerId: her.id, kind: "credit" } });
    assert.equal(card.balanceCents, 28000, "paid in store credit on her card");
    await expectError("undo store credit", () => undoPayoutFor(a.user, owed[0].id), /store credit/);
    ok("a return before payment takes it back, its void owes it again; paid in store credit on her card");

    // 3b. Returned after she was paid (review fix): the shop's own now, so a resale owes her nothing; the return voided: as before.
    const back = await completeSaleAs(a.user, { customerId: buyer.id, lines: [{ description: "", qty: -1, unitPriceCents: 40000, taxable: true, stockUnitId: u1 }], tenders: cash(-40000) });
    assert.equal((await db.stockUnit.findUniqueOrThrow({ where: { id: u1 } })).consignorId, null, "the shop's own");
    await voidSaleAs(a.user, back.saleId, "x");
    assert.equal((await db.stockUnit.findUniqueOrThrow({ where: { id: u1 } })).consignorId, her.id, "the return's void: hers as before (sold, her paid sale stands)");
    ok("returned after she was paid: the shop's own (a resale makes no payout); the return voided, as it was");

    // 4. Given back; the statement; the books; the delete.
    let plan = await customerDeletePlan(a.user, her.id);
    assert.ok(plan.blockers.some((x) => /for sale on consignment/.test(x)), "her machine for sale blocks deleting her");
    await giveBackFor(a.user, u2);
    const m2 = await db.stockUnit.findFirstOrThrow({ where: { id: u2 }, select: { status: true, machine: { select: { customerId: true } } } });
    assert.deepEqual([m2.status, m2.machine.customerId], ["REMOVED", her.id]);
    units = await consignedUnits(a.shopId);
    assert.deepEqual(units, [], "given back: off the list");
    const st = (await consignorStatement(a.shopId, her.id))!;
    assert.deepEqual([st.units.length, st.payouts.length, st.paidCents, st.owedCents], [2, 1, 28000, 0]);
    const books = await buildBooks(a.shopId, "America/New_York", new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000), DEFAULT_BOOKS);
    for (const d of books.days) assert.ok(balanced(d));
    const net = (acct: string) => books.days.flatMap((d) => d.lines).filter((l) => l.account === acct).reduce((x, l) => x + l.debitCents - l.creditCents, 0);
    assert.equal(net("Due to Consignors"), 0, "owed, then paid");
    assert.equal(net("Sales"), -(40000 - 28000), "the shop's income is its commission");
    plan = await customerDeletePlan(a.user, her.id);
    assert.equal(plan.blockers.filter((x) => /consign/.test(x)).length, 0);
    ok("given back unsold (hers again); the statement; the books: owed to her, paid, the shop's income its commission; nothing blocks the delete now");

    // 5. Tenant.
    await expectNotFound("B consigns A's unit", () => setConsignFor(b.user, u1, fd({ customerId: her.id })));
    await expectNotFound("B gives back A's unit", () => giveBackFor(b.user, u2));
    await expectNotFound("B pays A's payout", () => payOutFor(b.user, owed[0].id, fd({ method: "CASH" })));
    await expectNotFound("B undoes A's payout", () => undoPayoutFor(b.user, owed[0].id));
    assert.equal(await consignorStatement(b.shopId, her.id), null);
    assert.deepEqual(await payoutsFor(b.shopId), []);
    const [ub] = await receiveUnitsFor(b.user, fd({ kind: "sewing", brand: "Juki", model: "TL", condition: "USED", priceCents: "100", serials: "J-1" }));
    await expectNotFound("B names A's customer", () => setConsignFor(b.user, ub, fd({ customerId: her.id })));
    ok("tenant: B can't consign, give back, pay, undo, read A's, nor name A's customer as a consignor");
  } finally {
    await cleanup();
  }
  console.log(`consign-machines.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
