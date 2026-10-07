// The bookkeeping export (later-round-1-design.md 3.4): a journal entry a day that balances to the cent, agrees with the
// reports and the gift card ledger, with the bookkeeper's account names, the IIF readable back, and one company never
// seeing another's days.
//   npm run check scripts/checks/books-export.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { completeSaleAs, voidSaleAs, type SaleInput } from "@/lib/register-sale";
import { modelKey } from "@/lib/format";
import { monthRange } from "@/lib/time-zone";
import { salesReport } from "@/lib/reports/sales";
import { balanced, buildBooks, loadBooks, toIif, toJournalCsvRows, type DayEntry } from "@/lib/books";
import { ACCOUNT_KEYS, accountName, cleanAccount, DEFAULT_BOOKS, readAccounts, type BooksConfig } from "@/lib/books-accounts";
import { checkShop, cleanup } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

const TZ = "America/New_York";
const at = (day: string) => new Date(`${day}T16:00:00Z`);
const cash = (cents: number) => ({ method: "CASH" as const, amountCents: cents });
let n = 9950;

const net = (days: DayEntry[], match: (account: string) => boolean) => days.flatMap((d) => d.lines).filter((l) => match(l.account)).reduce((a, l) => a + l.creditCents - l.debitCents, 0);
const line = (d: DayEntry, account: string) => d.lines.find((l) => l.account === account);

/** A tiny IIF reader: each TRNS..ENDTRNS block as { date, doc, lines: [{ account, amount }] } with the header rows checked. */
function readIif(text: string) {
  const rows = text.split("\r\n").filter(Boolean).map((r) => r.split("\t"));
  assert.deepEqual(rows[0].slice(0, 6), ["!TRNS", "TRNSID", "TRNSTYPE", "DATE", "ACCNT", "AMOUNT"]);
  assert.equal(rows[1][0], "!SPL");
  assert.equal(rows[2][0], "!ENDTRNS");
  const blocks: { date: string; doc: string; lines: { kind: string; account: string; amount: number }[] }[] = [];
  for (const r of rows.slice(3)) {
    if (r[0] === "TRNS") blocks.push({ date: r[3], doc: r[6], lines: [{ kind: "TRNS", account: r[4], amount: Number(r[5]) }] });
    else if (r[0] === "SPL") blocks.at(-1)!.lines.push({ kind: "SPL", account: r[4], amount: Number(r[5]) });
    else assert.equal(r[0], "ENDTRNS");
    if (r[0] === "TRNS" || r[0] === "SPL") assert.equal(r[2], "GENERAL JOURNAL");
  }
  return blocks;
}

async function main() {
  const a = await checkShop({ repair: true, retail: true });
  const b = await checkShop({ repair: true, retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 6 } });
    const p1 = await db.part.create({ data: { shopId: a.shopId, partNumber: "BK-1", description: "Hook", kind: "NOTION", priceCents: 1000, costCents: 400, qtyOnHand: 500, numberKeys: [] } });
    const p2 = await db.part.create({ data: { shopId: a.shopId, partNumber: "BK-2", description: "Spool", kind: "THREAD", priceCents: 2000, costCents: 800, qtyOnHand: 500, numberKeys: [] } });
    const item = (p: typeof p1, qty: number, extra: Partial<SaleInput["lines"][number]> = {}): SaleInput["lines"][number] => ({ partId: p.id, description: "x", qty, unitPriceCents: p.priceCents!, taxable: true, ...extra });
    const put = async (id: string, day: string) => void (await db.sale.update({ where: { id }, data: { createdAt: at(day) } }));

    const s1 = await completeSaleAs(a.user, { lines: [item(p1, 3)], tenders: [cash(3180)] });
    await put(s1.saleId, "2026-03-03");
    const s2 = await completeSaleAs(a.user, { lines: [item(p2, 1)], orderDiscountCents: 500, tenders: [{ method: "CARD", amountCents: 1590 }] });
    await put(s2.saleId, "2026-03-03");
    const s3 = await completeSaleAs(a.user, { lines: [item(p1, 2, { discountCents: 200 })], tenders: [cash(2000)] });
    await put(s3.saleId, "2026-03-04");
    const s4 = await completeSaleAs(a.user, { lines: [item(p1, -1)], tenders: [cash(-1060)] });
    await put(s4.saleId, "2026-03-05");
    const s5 = await completeSaleAs(a.user, { lines: [item(p1, 1)], tenders: [cash(1060)] });
    await put(s5.saleId, "2026-03-06");
    await voidSaleAs(a.user, s5.saleId, "check");
    await db.sale.update({ where: { id: s5.saleId }, data: { voidedAt: at("2026-03-08") } });
    const gift = await completeSaleAs(a.user, { lines: [{ giftCard: { mode: "new" }, description: "Gift card", qty: 1, unitPriceCents: 5000, taxable: false }], tenders: [cash(5000)] });
    await put(gift.saleId, "2026-03-07");
    const card = await db.giftCard.findFirstOrThrow({ where: { shopId: a.shopId } });
    const s7 = await completeSaleAs(a.user, { lines: [item(p2, 1)], tenders: [{ method: "GIFT", amountCents: 2120, cardNumber: card.number }] });
    await put(s7.saleId, "2026-03-09");
    const s8 = await completeSaleAs(a.user, { lines: [item(p1, 1)], tenders: [{ method: "ONLINE", amountCents: 1060 }] }, { paidOnline: true });
    await put(s8.saleId, "2026-03-10");
    await db.giftCardEntry.updateMany({ where: { saleId: gift.saleId }, data: { at: at("2026-03-07") } });
    await db.giftCardEntry.updateMany({ where: { saleId: s7.saleId }, data: { at: at("2026-03-09") } });
    // a balance fixed by hand
    await db.giftCardEntry.create({ data: { shopId: a.shopId, cardId: card.id, at: at("2026-03-15"), amountCents: 1000, reason: "ADJUSTED", note: "check" } });
    await db.giftCard.update({ where: { id: card.id }, data: { balanceCents: { increment: 1000 } } });

    const m = await db.machine.create({ data: { shopId: a.shopId, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
    const ticket = async (o: { status: "COLLECTED" | "RETURNED_UNREPAIRED" | "ON_BENCH"; closed?: string; lines: { kind: "SERVICE" | "LABOR" | "PART"; cents: number; taxable?: boolean }[]; pays: { method: "CASH" | "CARD" | "INVOICE" | "SHOP_COLLECTED"; cents: number; day: string }[] }) => {
      const t = await db.ticket.create({ data: { shopId: a.shopId, number: n++, status: o.status, machineId: m.id, intake: {}, intakeAt: at("2026-02-20"), closedAt: o.closed ? at(o.closed) : null, taxRatePct: 6 } });
      for (const l of o.lines) await db.ticketLine.create({ data: { ticketId: t.id, kind: l.kind, description: l.kind, unitPriceCents: l.cents, taxable: l.taxable ?? true } });
      for (const p of o.pays) await db.payment.create({ data: { ticketId: t.id, method: p.method, amountCents: p.cents, paidAt: at(p.day) } });
    };
    await ticket({ status: "COLLECTED", closed: "2026-03-12", lines: [{ kind: "SERVICE", cents: 8000 }, { kind: "LABOR", cents: 2000, taxable: false }, { kind: "PART", cents: 1000 }], pays: [{ method: "CASH", cents: 5000, day: "2026-02-28" }, { method: "CARD", cents: 6540, day: "2026-03-12" }] });
    await ticket({ status: "RETURNED_UNREPAIRED", closed: "2026-03-20", lines: [{ kind: "SERVICE", cents: 2500 }], pays: [{ method: "INVOICE", cents: 2650, day: "2026-03-20" }] });
    await ticket({ status: "ON_BENCH", lines: [{ kind: "SERVICE", cents: 3000 }], pays: [{ method: "SHOP_COLLECTED", cents: 3000, day: "2026-03-22" }] });

    const mar = monthRange("2026-03-01", "2026-03-31", TZ);
    const cfg = { ...DEFAULT_BOOKS };
    const r = await buildBooks(a.shopId, TZ, mar.start, mar.end, cfg);

    // ---------- every day balances, nothing left over ----------
    assert.equal(r.unbalancedSales, 0, "every sale's lines and payments match to the cent");
    assert.ok(r.days.length >= 9);
    for (const d of r.days) assert.ok(balanced(d), `${d.day} balances`);
    assert.deepEqual(r.days.map((d) => d.number), r.days.map((d) => `SB-${d.day.replace(/-/g, "")}`));
    ok("every day's entry balances to the cent and no sale needed a correction");

    // ---------- hand-worked days ----------
    const d3 = r.days.find((d) => d.day === "2026-03-03")!;
    assert.deepEqual(d3.lines, [
      { account: "Discounts Given", debitCents: 500, creditCents: 0 },
      { account: "Undeposited Funds", debitCents: 4770, creditCents: 0 },
      { account: "Sales", debitCents: 0, creditCents: 5000 },
      { account: "Sales Tax Payable", debitCents: 0, creditCents: 270 },
    ]);
    const d4 = r.days.find((d) => d.day === "2026-03-04")!;
    assert.equal(line(d4, "Undeposited Funds")!.debitCents, 1908, "cash less change");
    assert.equal(line(d4, "Sales")!.creditCents, 2000, "the line discount is shown apart from the sale's price");
    assert.equal(line(d4, "Discounts Given")!.debitCents, 200);
    const d5 = r.days.find((d) => d.day === "2026-03-05")!;
    assert.deepEqual([line(d5, "Sales")!.debitCents, line(d5, "Sales Tax Payable")!.debitCents, line(d5, "Undeposited Funds")!.creditCents], [1000, 60, 1060], "a return is the sale backwards");
    const d7 = r.days.find((d) => d.day === "2026-03-07")!;
    assert.deepEqual(d7.lines, [{ account: "Undeposited Funds", debitCents: 5000, creditCents: 0 }, { account: "Gift Card Liability", debitCents: 0, creditCents: 5000 }], "a gift card sold is a liability, not a sale");
    const d8 = r.days.find((d) => d.day === "2026-03-08")!;
    assert.deepEqual([line(d8, "Sales")!.debitCents, line(d8, "Undeposited Funds")!.creditCents], [1000, 1060], "a void on the day it happened");
    const d9 = r.days.find((d) => d.day === "2026-03-09")!;
    assert.deepEqual([line(d9, "Gift Card Liability")!.debitCents, line(d9, "Sales")!.creditCents], [2120, 2000], "spending a card pays down the liability");
    const d10 = r.days.find((d) => d.day === "2026-03-10")!;
    assert.equal(line(d10, "Stripe Clearing")!.debitCents, 1060);
    const d12 = r.days.find((d) => d.day === "2026-03-12")!;
    assert.deepEqual(d12.lines, [
      { account: "Repair Tickets Clearing", debitCents: 5000, creditCents: 0 },
      { account: "Undeposited Funds", debitCents: 6540, creditCents: 0 },
      { account: "Repair Income - Labor", debitCents: 0, creditCents: 2000 },
      { account: "Repair Income - Parts", debitCents: 0, creditCents: 1000 },
      { account: "Repair Income - Service", debitCents: 0, creditCents: 8000 },
      { account: "Sales Tax Payable", debitCents: 0, creditCents: 540 },
    ], "a repair handed back: the deposit taken earlier is already in the clearing account");
    const d15 = r.days.find((d) => d.day === "2026-03-15")!;
    assert.deepEqual(d15.lines, [{ account: "Gift Card Adjustments", debitCents: 1000, creditCents: 0 }, { account: "Gift Card Liability", debitCents: 0, creditCents: 1000 }]);
    const d20 = r.days.find((d) => d.day === "2026-03-20")!;
    assert.equal(line(d20, "Accounts Receivable")!.debitCents, 2650, "on account");
    assert.equal(line(r.days.find((d) => d.day === "2026-03-22")!, "Due from Partner Shops")!.debitCents, 3000, "collected by the partner");
    assert.equal(r.repairClearingCents, 3000, "Repair Tickets Clearing: the deposit on the machine still in");
    ok("hand-worked days: tenders, discounts, returns, voids, gift cards, online, repairs, on account, partner shops");

    // ---------- agrees with the reports and the gift card ledger ----------
    const rep = await salesReport(a.shopId, TZ, mar.start, mar.end, "month");
    assert.equal(net(r.days, (x) => x === "Sales") - r.days.flatMap((d) => d.lines).filter((l) => l.account === "Discounts Given").reduce((s, l) => s + l.debitCents, 0), rep.totals.counter + rep.totals.online + rep.totals.returns + rep.totals.voids, "sales less discounts equal the report's net sales");
    assert.equal(net(r.days, (x) => x.startsWith("Repair Income")), rep.totals.repairs, "repair income equals the report's repairs");
    assert.equal(net(r.days, (x) => x === "Sales Tax Payable"), rep.totals.tax, "tax equals the report's tax");
    const ledger = await db.giftCardEntry.findMany({ where: { shopId: a.shopId, at: { gte: mar.start, lt: mar.end } } });
    assert.equal(net(r.days, (x) => x === "Gift Card Liability"), ledger.filter((e) => e.reason !== "MOVED").reduce((s, e) => s + e.amountCents, 0), "the liability moved as the ledger did");
    ok("the period agrees with the sales report (sales, repairs, tax) and with the gift card ledger");

    // ---------- the bookkeeper's choices ----------
    const named: BooksConfig = { accounts: { undeposited: "1200 Undeposited", sales: "4000 Sales", salesTax: "2200 Sales Tax" }, byCategory: true, netDiscounts: true, cardClearing: "Card: Clearing" };
    const rn = await buildBooks(a.shopId, TZ, mar.start, mar.end, named);
    const n3 = rn.days.find((d) => d.day === "2026-03-03")!;
    assert.deepEqual(n3.lines, [
      { account: "1200 Undeposited", debitCents: 3180, creditCents: 0 },
      { account: "Card- Clearing", debitCents: 1590, creditCents: 0 },
      { account: "2200 Sales Tax", debitCents: 0, creditCents: 270 },
      { account: "4000 Sales - Notions", debitCents: 0, creditCents: 3000 },
      { account: "4000 Sales - Thread", debitCents: 0, creditCents: 1500 },
    ], "names as set; one sales account per category; discounts netted; a colon would make a sub-account, so it becomes a dash");
    for (const d of rn.days) assert.ok(balanced(d));
    assert.equal(rn.days.flatMap((d) => d.lines).filter((l) => l.account === "Discounts Given").length, 0);
    assert.equal(cleanAccount('A:B\t"C"'), "A-B C");
    assert.deepEqual(readAccounts({ sales: " Revenue ", bogus: "x", salesTax: "", undeposited: 5 }), { sales: "Revenue" });
    assert.equal(accountName(DEFAULT_BOOKS, "stripe"), "Stripe Clearing");
    await db.booksSettings.create({ data: { shopId: a.shopId, accounts: { sales: "Revenue", junk: "x" }, byCategory: true, cardClearing: " Card Clearing ", exportedThrough: "2026-02-28" } });
    const loaded = await loadBooks(a.shopId);
    assert.deepEqual([loaded.accounts, loaded.byCategory, loaded.netDiscounts, loaded.cardClearing, loaded.exportedThrough], [{ sales: "Revenue" }, true, false, "Card Clearing", "2026-02-28"]);
    assert.equal(ACCOUNT_KEYS.length, new Set(ACCOUNT_KEYS.map((x) => x.key)).size);
    ok("account names, one sales account per category, netted discounts and a card account as the bookkeeper set them");

    // ---------- the files ----------
    const csv = toJournalCsvRows(r.days);
    assert.deepEqual(csv[0], ["*JournalNo", "*JournalDate", "*AccountName", "*Debits", "*Credits", "Description", "Name"]);
    assert.equal(csv.slice(1).reduce((s, x) => s + Number(x[3] || 0) - Number(x[4] || 0), 0).toFixed(2), "0.00", "the CSV's debits equal its credits");
    assert.equal(csv[1][1], "03/03/2026");
    assert.equal(csv.slice(1).filter((x) => x[0] === "SB-20260303").length, 4);
    const blocks = readIif(toIif(r.days));
    assert.equal(blocks.length, r.days.length);
    for (const bl of blocks) {
      assert.equal(bl.lines[0].kind, "TRNS");
      assert.ok(bl.lines.slice(1).every((x) => x.kind === "SPL"));
      assert.equal(Math.abs(Math.round(bl.lines.reduce((s, x) => s + x.amount, 0) * 100)), 0, `${bl.doc} balances in the IIF`);
    }
    const iif3 = blocks.find((x) => x.doc === "SB-20260303")!;
    assert.equal(iif3.date, "03/03/2026");
    assert.deepEqual(iif3.lines.map((x) => [x.account, x.amount]), [["Discounts Given", 5], ["Undeposited Funds", 47.7], ["Sales", -50], ["Sales Tax Payable", -2.7]]);
    ok("the CSV and the IIF parse back, balance and carry the same entries");

    // ---------- tenant ----------
    const wide = monthRange("2026-01-01", "2026-12-31", TZ);
    const rb = await buildBooks(b.shopId, TZ, wide.start, wide.end, DEFAULT_BOOKS);
    assert.deepEqual([rb.days.length, rb.unbalancedSales, rb.repairClearingCents], [0, 0, 0]);
    assert.deepEqual(await loadBooks(b.shopId), { ...DEFAULT_BOOKS, exportedThrough: null }, "B never reads A's names");
    ok("tenant: company B's export over A's year is empty and B's names are its own");

    console.log(`\n${steps} books-export checks passed`);
  } finally {
    await cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
