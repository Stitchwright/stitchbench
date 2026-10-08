// Financing (tax-machine-sales-layaway-design.md section 5, record only): lenders in settings, a Financing payment at
// the register through completeSaleAs (the lender and approval number required, kept on the sale; no change from it),
// what the lender owes in the books until it is marked paid, voids (refused once the lender paid), the report by
// lender, a lender no longer offered, and the tenant section.
//   npm run check scripts/checks/financing.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { balanced, buildBooks } from "@/lib/books";
import { DEFAULT_BOOKS } from "@/lib/books-accounts";
import { financedReport, listLenders, markFinancedPaidFor, saveLenderFor } from "@/lib/financing";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import type { Tender } from "@/lib/register-math";
import type { CurrentUser } from "@/lib/session";
import { checkShop, cleanup, type CheckShop } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });

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

const DAY = 86_400_000;

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Fran Financed" } });
    const line = (cents: number) => [{ description: "Embroidery machine", qty: 1, unitPriceCents: cents, taxable: false }];

    // 1. Lenders.
    await expectError("a tech", () => saveLenderFor(tech(a), null, form({ name: "Synchrony" })), /owner or admin/);
    await expectError("a bad apply page", () => saveLenderFor(user(a), null, form({ name: "Synchrony", applyUrl: "javascript:x" })), /web address/);
    await saveLenderFor(user(a), null, form({ name: "Synchrony", applyUrl: "https://example.test/apply" }));
    await saveLenderFor(user(a), null, form({ name: "Affirm" }));
    const [affirm, sync] = await listLenders(a.shopId);
    assert.deepEqual([affirm.name, sync.name, sync.applyUrl], ["Affirm", "Synchrony", "https://example.test/apply"]);
    ok("an owner lists lenders with their apply pages; a tech can't");

    // 2. A financed sale: lender and approval required; kept on the sale; financing can't give change.
    const fin = (amountCents: number, o: Partial<Tender> = {}): Tender => ({ method: "FINANCED", amountCents, lenderId: sync.id, note: "APR-1", ...o });
    await expectError("no lender", () => completeSaleAs(user(a), { customerId: cust.id, lines: line(200_000), tenders: [fin(200_000, { lenderId: undefined })] }), /Pick the lender/);
    await expectError("no approval", () => completeSaleAs(user(a), { customerId: cust.id, lines: line(200_000), tenders: [fin(200_000, { note: " " })] }), /approval number/);
    await expectError("more than the total", () => completeSaleAs(user(a), { customerId: cust.id, lines: line(200_000), tenders: [fin(250_000)] }), /Only cash gives change/);
    const s1 = await completeSaleAs(user(a), { customerId: cust.id, lines: line(200_000), tenders: [fin(180_000), { method: "CASH", amountCents: 20_000 }] });
    const sale = await db.sale.findUniqueOrThrow({ where: { id: s1.saleId } });
    const t = (sale.tenders as Tender[]).find((x) => x.method === "FINANCED")!;
    assert.deepEqual([t.lender, t.lenderId, t.note], ["Synchrony", sync.id, "APR-1"]);
    const f1 = await db.financedSale.findFirstOrThrow({ where: { saleId: s1.saleId } });
    assert.ok(f1.amountCents === 180_000 && f1.paidAt === null && f1.approval === "APR-1");
    ok("a financed payment needs the lender and the approval number, gives no change, and is kept on the sale; Synchrony owes $1,800");

    // 3. The books: owed by the lender, then paid.
    const range = () => buildBooks(a.shopId, "America/New_York", new Date(Date.now() - DAY), new Date(Date.now() + DAY), DEFAULT_BOOKS);
    const owed = (bk: Awaited<ReturnType<typeof range>>) => bk.days.flatMap((d) => d.lines).filter((l) => l.account === "Due from Lenders").reduce((x, l) => x + l.debitCents - l.creditCents, 0);
    let bk = await range();
    assert.ok(bk.days.every(balanced) && bk.unbalancedSales === 0);
    assert.equal(owed(bk), 180_000);
    await expectError("a tech marks it paid", () => markFinancedPaidFor(tech(a), f1.id, true), /owner or admin/);
    await markFinancedPaidFor(user(a), f1.id, true);
    await expectError("paid twice", () => markFinancedPaidFor(user(a), f1.id, true), /already marked paid/);
    bk = await range();
    assert.ok(bk.days.every(balanced));
    assert.equal(owed(bk), 0, "the lender's payment clears what it owed");
    ok("the books carry it as Due from Lenders until it is marked paid, then as money in; every day balanced");

    // 4. Voids: refused once paid; fine once marked not paid; the financing voided with it.
    await expectError("void after the lender paid", () => voidSaleAs(user(a), s1.saleId, "x"), /Synchrony has already paid/);
    await markFinancedPaidFor(user(a), f1.id, false);
    await voidSaleAs(user(a), s1.saleId, "rung up twice");
    assert.ok((await db.financedSale.findUniqueOrThrow({ where: { id: f1.id } })).voidedAt);
    bk = await range();
    assert.ok(bk.days.every(balanced));
    assert.equal(owed(bk), 0, "the void takes it out again");
    ok("a sale the lender paid can't be voided until marked not paid; then the void takes its financing with it");

    // 5. The report, and a lender no longer offered.
    const s2 = await completeSaleAs(user(a), { customerId: cust.id, lines: line(90_000), tenders: [fin(90_000, { lenderId: affirm.id, note: "AF-9" })] });
    const r = await financedReport(a.shopId, new Date(Date.now() - DAY), new Date(Date.now() + DAY));
    assert.deepEqual(
      r.unpaid.map((x) => [x.lender, x.amountCents, x.approval, x.customer]),
      [["Affirm", 90_000, "AF-9", "Fran Financed"]],
    );
    assert.deepEqual(r.byLender.find((x) => x.lender === "Affirm"), { lender: "Affirm", count: 1, cents: 90_000, unpaidCents: 90_000 });
    await saveLenderFor(user(a), affirm.id, form({ name: "Affirm" }));
    assert.equal((await listLenders(a.shopId, true)).length, 1, "unticked: not offered");
    await expectError("a lender not offered", () => completeSaleAs(user(a), { customerId: cust.id, lines: line(1000), tenders: [fin(1000, { lenderId: affirm.id })] }), /isn't offered any more/);
    void s2;
    ok("the report lists financed sales by lender and the unpaid ones; a lender no longer offered can't take new payments");

    // 6. Tenant.
    await expectError("B uses A's lender", () => completeSaleAs(user(b), { lines: line(1000), tenders: [fin(1000)] }), /Pick the lender/);
    await expectError("B marks A's paid", () => markFinancedPaidFor(user(b), f1.id, true), /Not found/);
    assert.deepEqual(await listLenders(b.shopId), []);
    assert.deepEqual((await financedReport(b.shopId, new Date(0), new Date(Date.now() + DAY))).unpaid, []);
    await expectError("B changes A's lender", () => saveLenderFor(user(b), sync.id, form({ name: "Mine" })), /not found/);
    ok("tenant: B can't use, change or mark A's lenders and financed sales");
  } finally {
    await cleanup();
  }
  console.log(`financing.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
