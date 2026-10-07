// House charge accounts (shop-features-round-2-design.md 9.4, package house-accounts): off by default and only the owner
// turns them on; an account (limit, terms; owner or admin), "On account" at the register (her open account, within the
// limit; refused for a customer without one or a closed one), the void taking the charge off, a ticket's "Invoice (on
// account)" payment going on it (and its removal coming off), payments (check number) and their undo, the aging (oldest
// paid first), the month's statement, the books (receivable), merge and delete, tenant.
//   npm run check scripts/checks/house-accounts.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { addPaymentFor, removePaymentFor } from "@/lib/payments";
import { buildBooks, balanced } from "@/lib/books";
import { DEFAULT_BOOKS } from "@/lib/books-accounts";
import { customerDeletePlan, mergeCustomersFor } from "@/lib/merge";
import { agingOf, balanceOf, statementOf } from "@/lib/house-accounts-math";
import { accountOf, accountsOwed, saveAccountFor, setHouseAccountsOnFor, statementFor, takeAccountPaymentFor, undoAccountEntryFor } from "@/lib/house-accounts";
import { addMonths, ymdOf } from "@/lib/zoned";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const as = (s: CheckShop, role: "ADMIN" | "TECH"): CurrentUser => ({ ...s.user, role });
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
const DAY = 86_400_000;

async function main() {
  const now = new Date("2026-10-07T12:00:00Z");
  const e = (kind: string, amountCents: number, daysAgo: number, voided = false) => ({ kind, amountCents, at: new Date(+now - daysAgo * DAY), voidedAt: voided ? now : null });
  const es = [e("CHARGE", 10000, 100), e("CHARGE", 5000, 45), e("PAYMENT", 12000, 10), e("CHARGE", 3000, 5), e("CHARGE", 999, 1, true)];
  assert.equal(balanceOf(es), 6000);
  assert.deepEqual(agingOf(es, now), { current: 3000, d30: 3000, d60: 0, d90: 0, total: 6000 }, "the payment paid the oldest first");
  assert.deepEqual(agingOf([e("PAYMENT", 500, 1)], now), { current: -500, d30: 0, d60: 0, d90: 0, total: -500 }, "a credit balance");
  const st = statementOf(es, new Date(+now - 30 * DAY), now);
  assert.deepEqual([st.opening, st.charges, st.payments, st.closing], [15000, 3000, 12000, 6000]);
  ok("the balance, the aging (oldest paid first, a credit) and a month's statement");

  const a = await checkShop({ retail: true, repair: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const school = await db.customer.create({ data: { shopId: a.shopId, name: "Hill School", phone: "555-0160", email: "office@hill.test" } });
    const walkin = await db.customer.create({ data: { shopId: a.shopId, name: "Walk In", phone: "555-0161" } });
    const sale = (customerId: string | null, cents: number, method: "ACCOUNT" | "CASH" = "ACCOUNT") => completeSaleAs(a.user, { customerId, lines: [{ description: "Needles", qty: 1, unitPriceCents: cents, taxable: true }], tenders: [{ method, amountCents: cents }] });

    // 1. The switch and the account.
    await expectError("off", () => saveAccountFor(a.user, school.id, fd({ limit: "500" })), /House accounts are off/);
    await expectError("an admin turns it on", () => setHouseAccountsOnFor(as(a, "ADMIN"), true), /Only the owner/);
    await setHouseAccountsOnFor(a.user, true);
    await expectError("a tech opens one", () => saveAccountFor(as(a, "TECH"), school.id, fd({})), /owner or admin/);
    await saveAccountFor(as(a, "ADMIN"), school.id, fd({ limit: "$500", terms: "30" }));
    let acct = (await accountOf(a.shopId, school.id))!;
    assert.deepEqual([acct.limitCents, acct.termsDays, acct.status, acct.balanceCents], [50000, 30, "OPEN", 0]);
    ok("off until the owner turns it on; an account opened by an admin with a $500 limit, 30 days");

    // 2. The register.
    await expectError("no customer", () => sale(null, 1000), /Pick the customer/);
    await expectError("no account", () => sale(walkin.id, 1000), /no house account/);
    const s1 = await sale(school.id, 30000);
    await expectError("over the limit", () => sale(school.id, 25000), /over her \$500.00 limit: she owes \$300.00/);
    const s2 = await sale(school.id, 10000);
    acct = (await accountOf(a.shopId, school.id))!;
    assert.equal(acct.balanceCents, 40000);
    await voidSaleAs(a.user, s2.saleId, "wrong");
    assert.equal((await accountOf(a.shopId, school.id))!.balanceCents, 30000, "the void takes the charge off");
    await completeSaleAs(a.user, { customerId: school.id, lines: [{ description: "Needles", qty: -1, unitPriceCents: 5000, taxable: true }], tenders: [{ method: "ACCOUNT", amountCents: -5000 }] });
    assert.equal((await accountOf(a.shopId, school.id))!.balanceCents, 25000, "a refund to the account");
    void s1;
    ok("On account: her account only, within the limit; the void takes it off; a refund goes back on it");

    // 3. A ticket put on account.
    const m = await db.machine.create({ data: { shopId: a.shopId, brand: "Brother", model: "XL", modelKey: "XL", customerId: school.id } });
    const t = await db.ticket.create({ data: { shopId: a.shopId, number: 901, machineId: m.id, customerId: school.id } });
    await addPaymentFor(a.user, t.id, { amountCents: 8900, method: "INVOICE", note: null });
    assert.equal((await accountOf(a.shopId, school.id))!.balanceCents, 33900);
    const p = await db.payment.findFirstOrThrow({ where: { ticketId: t.id } });
    await removePaymentFor(a.user, p.id);
    assert.equal((await accountOf(a.shopId, school.id))!.balanceCents, 25000, "the payment's removal takes it off");
    await addPaymentFor(a.user, t.id, { amountCents: 8900, method: "INVOICE", note: null });
    ok("a repair's \"Invoice (on account)\" goes on her account; removing it takes it off");

    // 4. Payments, aging, statement.
    acct = (await accountOf(a.shopId, school.id))!;
    await expectError("check without number", () => takeAccountPaymentFor(as(a, "TECH"), acct.id, fd({ amount: "100", method: "CHECK" })), /check number/);
    await takeAccountPaymentFor(as(a, "TECH"), acct.id, fd({ amount: "100", method: "CHECK", note: "2041" }));
    acct = (await accountOf(a.shopId, school.id))!;
    assert.equal(acct.balanceCents, 23900);
    const payment = acct.entries.find((x) => x.kind === "PAYMENT")!;
    await expectError("a tech undoes", () => undoAccountEntryFor(as(a, "TECH"), payment.id), /owner or admin/);
    await undoAccountEntryFor(a.user, payment.id);
    assert.equal((await accountOf(a.shopId, school.id))!.balanceCents, 33900);
    await takeAccountPaymentFor(a.user, acct.id, fd({ amount: "100", method: "CASH" }));
    const owed = await accountsOwed(a.shopId);
    assert.deepEqual([owed.length, owed[0].name, owed[0].aging.total, owed[0].aging.current], [1, "Hill School", 23900, 23900]);
    const month = ymdOf(new Date(), "America/New_York").slice(0, 7);
    const s = (await statementFor(a.shopId, acct.id, month))!;
    assert.deepEqual([s.opening, s.charges, s.payments, s.closing], [0, 30000 - 5000 + 8900, 10000, 23900]);
    assert.equal((await statementFor(a.shopId, acct.id, addMonths(`${month}-01`, -1)!.slice(0, 7)))!.closing, 0);
    ok("payments (a check needs its number) and their undo by an owner; owed to us by age; this month's statement");

    // 5. Books.
    const books = await buildBooks(a.shopId, "America/New_York", new Date(Date.now() - DAY), new Date(Date.now() + DAY), DEFAULT_BOOKS);
    for (const d of books.days) assert.ok(balanced(d));
    const net = books.days.flatMap((d) => d.lines).filter((l) => l.account === "Accounts Receivable").reduce((x, l) => x + l.debitCents - l.creditCents, 0);
    assert.equal(net, 23900, "what she owes is receivable");
    ok("the books: what she owes sits in accounts receivable");

    // 6. Merge, delete, tenant.
    const dup = await db.customer.create({ data: { shopId: a.shopId, name: "Hill School dup", phone: "555-0162" } });
    await saveAccountFor(a.user, dup.id, fd({}));
    await sale(dup.id, 1000);
    await mergeCustomersFor(a.user, dup.id, school.id, "Hill School dup");
    assert.equal((await accountOf(a.shopId, school.id))!.balanceCents, 24900, "the duplicate's charges join her account");
    assert.ok((await customerDeletePlan(a.user, school.id)).blockers.some((x) => /house account owes \$249.00/.test(x)));
    await setHouseAccountsOnFor(b.user, true);
    await expectNotFound("B opens an account for A's customer (on)", () => saveAccountFor(b.user, school.id, fd({})));
    await expectNotFound("B takes a payment on A's account", () => takeAccountPaymentFor(b.user, acct.id, fd({ amount: "1", method: "CASH" })));
    await expectNotFound("B undoes A's entry", () => undoAccountEntryFor(b.user, payment.id));
    assert.equal(await statementFor(b.shopId, acct.id, month), null);
    assert.deepEqual(await accountsOwed(b.shopId), []);
    const bc = await db.customer.create({ data: { shopId: b.shopId, name: "B cust", phone: "1" } });
    await expectError("B charges with no account", () => completeSaleAs(b.user, { customerId: bc.id, lines: [{ description: "x", qty: 1, unitPriceCents: 100, taxable: true }], tenders: [{ method: "ACCOUNT", amountCents: 100 }] }), /no house account/);
    ok("a merge joins the accounts; the delete waits while she owes; tenant: B can't open, pay, undo, read A's");
  } finally {
    await cleanup();
  }
  console.log(`house-accounts.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
