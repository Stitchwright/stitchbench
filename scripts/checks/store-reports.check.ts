// Reports per store and combined (shop-features-round-2-design.md 7.4) and "Ask your shop" naming a store (7.5): sales,
// tickets and top customers for one store or both; the sales tax report per store (each store's rate); the books export
// an entry a day per store, tagged with its name (QuickBooks Location / Class), and unchanged with one store; the ask's
// pick keeps a store from the company's list only, and runs the report for that store.
//   npm run -s check scripts/checks/store-reports.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { completeSaleAs } from "@/lib/register-sale";
import { monthRange, todayIn } from "@/lib/time-zone";
import { salesReport } from "@/lib/reports/sales";
import { taxReport } from "@/lib/reports/tax";
import { ticketsReport, topCustomers } from "@/lib/reports/tickets";
import { buildBooks, toIif, toJournalCsvRows } from "@/lib/books";
import { DEFAULT_BOOKS } from "@/lib/books-accounts";
import { checkChoice } from "@/lib/reports/registry-defs";
import { runReport } from "@/lib/reports/registry";
import { addStoreFor } from "@/lib/stores-admin";
import { activeStores } from "@/lib/stores";
import { checkShop, cleanup } from "./lib";
import { assertUnchanged, snapshot } from "./tenant";

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

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    const A = a.shopId;
    const tz = "America/New_York";
    await db.shop.update({ where: { id: A }, data: { taxRatePct: 5 } });
    const part = await db.part.create({ data: { shopId: A, partNumber: "SR-1", description: "Rotary cutter", priceCents: 2000, kind: "NOTION", numberKeys: ["SR1"], qtyOnHand: 50 } });
    const jane = await db.customer.create({ data: { shopId: A, name: "Jane Reports" } });
    const line = (qty: number) => ({ partId: part.id, description: "Rotary cutter", qty, unitPriceCents: 2000, taxable: true });

    // One store first: the books look exactly as before (no Location column, one entry a day).
    await completeSaleAs(a.user, { lines: [line(1)], tenders: [{ method: "CASH", amountCents: 2100 }] });
    const { start, end } = monthRange(todayIn(tz), todayIn(tz), tz);
    const one = await buildBooks(A, tz, start, end, DEFAULT_BOOKS);
    assert.equal(one.days.length, 1);
    assert.equal(one.days[0].store, undefined);
    assert.ok(/^SB-\d{8}$/.test(one.days[0].number));
    assert.ok(!toJournalCsvRows(one.days)[0].includes("Location"));
    assert.ok(!toIif(one.days).includes("CLASS"));
    ok("one store: the books are as before (one entry a day, no Location or Class column)");

    const fl = await addStoreFor(a.user, form({ name: "Florida", mainName: "Boston", taxRatePct: "7" }));
    const main = (await activeStores(A)).find((s) => s.main)!;
    const atFl: CurrentUser = { ...a.user, locationId: fl.id };
    await completeSaleAs(atFl, { customerId: jane.id, lines: [line(2)], tenders: [{ method: "CASH", amountCents: 4280 }] });
    await completeSaleAs({ ...a.user, locationId: main.id }, { lines: [line(1)], tenders: [{ method: "CASH", amountCents: 2100 }] });

    // ---------- sales per store and both ----------
    const both = await salesReport(A, tz, start, end, "day");
    const boston = await salesReport(A, tz, start, end, "day", main);
    const florida = await salesReport(A, tz, start, end, "day", fl);
    assert.equal(both.totals.counter, 8000);
    assert.equal(boston.totals.counter, 4000, "the main store's sales (the one before stores existed too)");
    assert.equal(florida.totals.counter, 4000);
    assert.equal(florida.totals.tax, 280);
    assert.equal(boston.totals.tax, 200);
    const top = await topCustomers(A, start, end, 20, main);
    assert.equal(top.length, 0, "Jane bought at Florida, not Boston");
    assert.equal((await topCustomers(A, start, end, 20, fl))[0]?.name, "Jane Reports");
    const tk = await ticketsReport(A, start, end, new Date(), fl);
    assert.ok(tk, "the tickets report runs for one store");
    ok("sales per store and together (Boston $40 at 5%, Florida $40 at 7%); top customers per store");

    // ---------- sales tax per store ----------
    const tFl = await taxReport(A, tz, start, end, fl);
    const tBo = await taxReport(A, tz, start, end, main);
    assert.deepEqual(tFl.rates.map((r) => [r.ratePct, r.taxable, r.tax]), [[7, 4000, 280]]);
    assert.deepEqual(tBo.rates.map((r) => [r.ratePct, r.taxable, r.tax]), [[5, 4000, 200]]);
    ok("the sales tax report per store: each store's own rate, sales and tax");

    // ---------- the books: an entry a day per store, tagged ----------
    const two = await buildBooks(A, tz, start, end, DEFAULT_BOOKS);
    assert.equal(two.days.length, 2);
    assert.deepEqual(two.days.map((d) => d.store).sort(), ["Boston", "Florida"]);
    assert.ok(two.days.every((d) => /^SB-\d{8}-[12]$/.test(d.number)));
    const csvRows = toJournalCsvRows(two.days);
    assert.equal(csvRows[0].at(-1), "Location");
    assert.ok(csvRows.slice(1).every((r) => r.at(-1) === "Boston" || r.at(-1) === "Florida"));
    assert.ok(toIif(two.days).startsWith("!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO\tCLASS"));
    for (const d of two.days) assert.equal(d.lines.reduce((x, l) => x + l.debitCents - l.creditCents, 0), 0, "each store's entry balances");
    ok("the books export: one balanced entry a day per store, its name in Location (Online) and Class (Desktop)");

    // ---------- ask your shop names a store ----------
    const today = todayIn(tz);
    const stores = ["Boston", "Florida"];
    const c1 = checkChoice({ report: "best_sellers", store: "the Florida store" }, today, [], stores);
    assert.equal(c1 && c1.report !== "none" ? c1.params.store : "x", "Florida");
    const c2 = checkChoice({ report: "best_sellers", store: "Paris" }, today, [], stores);
    assert.equal(c2 && c2.report !== "none" ? (c2.params.store ?? null) : "x", null, "a store the company doesn't have: all stores");
    const c3 = checkChoice({ report: "best_sellers", store: "Florida" }, today, [], []);
    assert.equal(c3 && c3.report !== "none" ? (c3.params.store ?? null) : "x", null, "one store: no store setting");
    const r = await runReport(A, "best_sellers", { from: today, to: today, kind: null, collection: null, top: 10, store: "Florida" });
    assert.match(r.title, /at Florida/);
    assert.match(r.rows[0]?.[1] ?? "", /^2/, "Florida sold 2");
    const rAll = await runReport(A, "best_sellers", { from: today, to: today, kind: null, collection: null, top: 10 });
    assert.match(rAll.rows[0]?.[1] ?? "", /^4/, "both stores sold 4");
    ok("Ask your shop: a store the question names (from the company's list only) runs the report for it; none = both stores");

    // ---------- tenant ----------
    const snap = await snapshot(A, ["Sale", "Location"]);
    const bSales = await salesReport(b.shopId, tz, start, end, "day", fl);
    assert.equal(bSales.totals.counter, 0, "B asking with A's store sees nothing of A's");
    const bTax = await taxReport(b.shopId, tz, start, end, fl);
    assert.equal(bTax.rates.length, 0);
    const bAsk = await runReport(b.shopId, "best_sellers", { from: today, to: today, kind: null, collection: null, top: 10, store: "Florida" });
    assert.equal(bAsk.rows.length, 0);
    assertUnchanged("company A", snap, await snapshot(A, ["Sale", "Location"]));
    ok("tenant: B's reports with A's store or store name show nothing of A's");

    console.log(`store-reports.check: ${steps} groups passed`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
