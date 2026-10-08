// Layaway (tax-machine-sales-layaway-design.md section 4): the shop's defaults, a start that holds a machine and a stock
// item and takes the deposit through the register, the minimum deposit and the tech's price rule, the payment plan,
// payments (and a voided one), behind on payments, the pick-up at that day's tax rate (the warranty from that day, the
// payments used up, the stock moves), voiding the pick-up (held again), a cancel by the shop's rule into store credit,
// the books' Customer Deposits, a crafted layaway line refused, and the tenant section. Through completeSaleAs.
//   npm run check scripts/checks/layaway.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { balanced, buildBooks } from "@/lib/books";
import { DEFAULT_BOOKS } from "@/lib/books-accounts";
import { cancelLayawayAs, depositsHeld, layawaySettings, layawayView, payLayawayAs, pickUpLayawayAs, pickUpQuote, saveLayawaySettingsFor, startLayawayAs } from "@/lib/layaway";
import { behind, cancelSplit, layawayPlan } from "@/lib/layaway-math";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import type { CurrentUser } from "@/lib/session";
import { receiveUnitsFor, unitsForSaleFor } from "@/lib/units/units";
import { addDays } from "@/lib/zoned";
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

const cash = (amountCents: number) => ({ method: "CASH" as const, amountCents });

async function main() {
  const a = await checkShop({ retail: true, repair: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 5 } });
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Layaway Lucy", phone: "555-0120" } });
    const [u1] = await receiveUnitsFor(user(a), form({ kind: "sewing", brand: "Janome", model: "Skyline S9", condition: "NEW", priceCents: "1000.00", serials: "S9-1" }));
    const part = await db.part.create({ data: { shopId: a.shopId, partNumber: "EXT-TBL", description: "Extension table", priceCents: 5000, qtyOnHand: 5, numberKeys: ["EXTTBL"], kind: "ACCESSORY" } });

    // 1. Defaults (owner's answer 3) and the math.
    const s0 = await layawaySettings(a.shopId);
    assert.deepEqual([s0.depositPct, s0.days, s0.every, s0.feeCents, s0.feePct, s0.refund], [10, 90, "2w", 0, 0, "credit"]);
    const plan = layawayPlan("2026-10-07", "2027-01-05", "2w", 100_000);
    assert.equal(plan.length, 7);
    assert.equal(plan.at(-1)!.due, "2027-01-05");
    assert.equal(plan.reduce((x, p) => x + p.cents, 0), 100_000);
    assert.equal(layawayPlan("2026-01-31", "2026-04-30", "month", 300).map((p) => p.due).join(" "), "2026-02-28 2026-03-31 2026-04-30");
    assert.deepEqual(cancelSplit(5000, 1000, 10), { fee: 1500, back: 3500 });
    assert.deepEqual(cancelSplit(500, 1000, 0), { fee: 500, back: 0 });
    await expectError("a tech saving settings", () => saveLayawaySettingsFor(tech(a), form({ depositPct: "20" })), /owner or admin/);
    ok("defaults: 10% down, 90 days, every 2 weeks, no fee, back as store credit; the plan splits evenly to the last day; the cancel split");

    // 2. Start: a machine and two extension tables, $1,100 + 5% = $1,155; at least $110 down.
    const items = [
      { stockUnitId: u1, qty: 1, unitPriceCents: 100_000 },
      { partId: part.id, qty: 2, unitPriceCents: 5000 },
    ];
    await expectError("deposit under 10%", () => startLayawayAs(user(a), { customerId: cust.id, lines: items, depositCents: 10_000, tender: cash(10_000) }), /at least \$110\.00/);
    await expectError("no customer", () => startLayawayAs(user(a), { customerId: null, lines: items, depositCents: 20_000, tender: cash(20_000) }), /customer/);
    await expectError("a tech changing a price", () => startLayawayAs(tech(a), { customerId: cust.id, lines: [{ ...items[0], unitPriceCents: 90_000 }], depositCents: 20_000, tender: cash(20_000) }), /owner or admin/);
    const st = await startLayawayAs(user(a), { customerId: cust.id, lines: items, depositCents: 20_000, tender: cash(20_000), clientKey: "layaway-start-key-0001" });
    const again = await startLayawayAs(user(a), { customerId: cust.id, lines: items, depositCents: 20_000, tender: cash(20_000), clientKey: "layaway-start-key-0001" });
    assert.equal(again.layawayId, st.layawayId, "sent twice: one layaway");
    assert.equal(await db.layaway.count({ where: { shopId: a.shopId } }), 1);
    const unit = await db.stockUnit.findUniqueOrThrow({ where: { id: u1 } });
    assert.ok(unit.status === "HELD" && unit.layawayId === st.layawayId);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand, 3);
    assert.equal(await db.stockMove.count({ where: { partId: part.id, reason: "HELD" } }), 1);
    const depLine = await db.saleLine.findFirstOrThrow({ where: { saleId: st.saleId } });
    assert.ok(depLine.kind === "LAYAWAY" && !depLine.taxable && depLine.layawayId === st.layawayId);
    let v = (await layawayView(a.shopId, st.layawayId))!;
    assert.deepEqual([v.priceCents, v.taxCents, v.owedCents, v.paidCents, v.leftCents], [110_000, 5500, 115_500, 20_000, 95_500]);
    assert.equal(v.plan.reduce((x, p) => x + p.cents, 0), 95_500);
    assert.deepEqual(await unitsForSaleFor(a.shopId, "S9-1"), [], "a held machine isn't for sale");
    await expectError("selling the held machine", () => completeSaleAs(user(a), { customerId: cust.id, lines: [{ description: "", qty: 1, unitPriceCents: 100_000, taxable: true, stockUnitId: u1 }], tenders: [cash(105_000)] }), /isn't in stock/);
    ok("started: the machine HELD, two tables off the shelf, the $200 deposit a layaway line (untaxed); the plan splits $955; a repeat makes one; held items can't be sold");

    // 3. Payments, a voided one, behind.
    const p1 = await payLayawayAs(user(a), { layawayId: st.layawayId, amountCents: 30_000, tender: cash(30_000) });
    await expectError("paying more than is left", () => payLayawayAs(user(a), { layawayId: st.layawayId, amountCents: 70_000, tender: cash(70_000) }), /Only \$655\.00 is left/);
    await voidSaleAs(user(a), p1.saleId, "wrong amount");
    v = (await layawayView(a.shopId, st.layawayId))!;
    assert.equal(v.paidCents, 20_000, "a voided payment no longer counts");
    await payLayawayAs(user(a), { layawayId: st.layawayId, amountCents: 25_000, tender: cash(25_000) });
    v = (await layawayView(a.shopId, st.layawayId))!;
    const late = behind({ plan: v.plan, depositMinCents: v.depositMinCents, dueBy: v.dueBy, paidCents: v.paidCents, owedCents: v.owedCents }, addDays(v.plan[2].due, 1));
    assert.equal(late, v.plan[0].cents + v.plan[1].cents + v.plan[2].cents - 25_000);
    assert.equal(behind({ plan: v.plan, depositMinCents: v.depositMinCents, dueBy: v.dueBy, paidCents: v.paidCents, owedCents: v.owedCents }, addDays(v.dueBy, 1)), v.leftCents, "past the last day: everything left");
    assert.equal(await depositsHeld(a.shopId), 45_000);
    ok("payments count, a voided one doesn't, overpaying is refused; behind on the plan, and everything left after the last day");

    // 4. Pick up after the rate changed: the day's rate, the payments used up, the rest paid now.
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 6 } });
    const q = await pickUpQuote(a.shopId, st.layawayId);
    assert.deepEqual([q.taxCents, q.paidCents, q.dueCents], [6600, 45_000, 110_000 + 6600 - 45_000]);
    const pu = await pickUpLayawayAs(user(a), { layawayId: st.layawayId, tender: cash(q.dueCents) });
    const sale = await db.sale.findUniqueOrThrow({ where: { id: pu.saleId }, include: { lines: true } });
    assert.ok(sale.taxRatePct === 6 && sale.taxCents === 6600 && sale.totalCents === q.dueCents);
    assert.ok(sale.lines.every((l) => l.layawayId === st.layawayId));
    assert.equal(sale.lines.find((l) => l.kind === "LAYAWAY")!.qty, -1);
    const sold = await db.stockUnit.findUniqueOrThrow({ where: { id: u1 } });
    assert.ok(sold.status === "SOLD" && sold.layawayId === null && sold.warrantyUntil && sold.soldAt!.getTime() === sale.createdAt.getTime(), "the warranty starts on the pick-up day");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand, 3);
    assert.equal(await db.stockMove.count({ where: { partId: part.id, reason: "SOLD" } }), 1, "the tables count as sold on the pick-up day");
    v = (await layawayView(a.shopId, st.layawayId))!;
    assert.ok(v.status === "COMPLETED" && v.saleId === pu.saleId);
    assert.equal(await depositsHeld(a.shopId), 0, "the payments are used up");
    await expectError("voiding a payment of a finished layaway", async () => {
      const pay = await db.saleLine.findFirstOrThrow({ where: { layawayId: st.layawayId, kind: "LAYAWAY", qty: 1, sale: { status: "COMPLETED" } } });
      await voidSaleAs(user(a), pay.saleId, "x");
    }, /picked up: void that sale first/);
    ok("picked up at the day's rate (6%), the payments used up, the rest paid; the machine sold with its warranty from that day; the tables sold");

    // 5. Void the pick-up: open again, the machine held again, the tables off the shelf again.
    await voidSaleAs(user(a), pu.saleId, "rung up early");
    v = (await layawayView(a.shopId, st.layawayId))!;
    assert.ok(v.status === "OPEN" && v.saleId === null && v.paidCents === 45_000);
    const back = await db.stockUnit.findUniqueOrThrow({ where: { id: u1 } });
    assert.ok(back.status === "HELD" && back.layawayId === st.layawayId && back.warrantyUntil === null);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand, 3);
    assert.equal(await depositsHeld(a.shopId), 45_000);
    ok("voiding the pick-up: the layaway open again with its payments, the machine held again, the tables still off the shelf");

    // 6. Cancel by the shop's rule: $10 fee, the rest as store credit; the items back on sale.
    await saveLayawaySettingsFor(user(a), form({ depositPct: "10", days: "90", every: "2w", feeCents: "$10", feePct: "0", refund: "credit" }));
    await expectError("a tech cancelling", () => cancelLayawayAs(tech(a), { layawayId: st.layawayId }), /owner or admin/);
    const c = await cancelLayawayAs(user(a), { layawayId: st.layawayId });
    assert.deepEqual([c.feeCents, c.backCents], [1000, 44_000]);
    const credit = await db.giftCard.findFirstOrThrow({ where: { shopId: a.shopId, customerId: cust.id, kind: "credit" } });
    assert.equal(credit.balanceCents, 44_000);
    assert.equal((await db.stockUnit.findUniqueOrThrow({ where: { id: u1 } })).status, "IN_STOCK");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand, 5);
    v = (await layawayView(a.shopId, st.layawayId))!;
    assert.ok(v.status === "CANCELLED" && v.cancelFeeCents === 1000);
    assert.equal(await depositsHeld(a.shopId), 0);
    ok("cancelled: $10 kept, $440 as store credit, the machine and tables back on sale, nothing held");

    // 7. The books: Customer Deposits in and out, every day balanced; a crafted layaway line is refused.
    const books = await buildBooks(a.shopId, "America/New_York", new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000), DEFAULT_BOOKS);
    assert.ok(books.days.every(balanced));
    assert.equal(books.unbalancedSales, 0);
    const dep = books.days.flatMap((d) => d.lines).filter((l) => l.account === "Customer Deposits");
    assert.equal(dep.reduce((x, l) => x + l.creditCents - l.debitCents, 0), 0, "deposits in, used and given back: nothing left in the account");
    await expectError("a layaway line from the browser", () => completeSaleAs(user(a), { customerId: cust.id, lines: [{ description: "x", qty: -1, unitPriceCents: 50_000, taxable: false, layawayKind: "LAYAWAY" }], tenders: [] }), /one thing/);
    ok("the books post layaway money to Customer Deposits and balance; a crafted layaway line is refused");

    // 8. Tenant: B can't see, pay, pick up or cancel A's layaway, nor hold A's machine.
    assert.equal(await layawayView(b.shopId, st.layawayId), null);
    await expectError("B pays A's", () => payLayawayAs(user(b), { layawayId: st.layawayId, amountCents: 100, tender: cash(100) }), /not found/);
    await expectError("B picks up A's", () => pickUpLayawayAs(user(b), { layawayId: st.layawayId }), /not found/);
    await expectError("B cancels A's", () => cancelLayawayAs(user(b), { layawayId: st.layawayId }), /not found/);
    const bc = await db.customer.create({ data: { shopId: b.shopId, name: "B Buyer" } });
    await expectError("B holds A's machine", () => startLayawayAs(user(b), { customerId: bc.id, lines: [{ stockUnitId: u1, qty: 1, unitPriceCents: 100_000 }], depositCents: 20_000, tender: cash(20_000) }), /isn't in stock/);
    await expectError("B uses A's customer", () => startLayawayAs(user(b), { customerId: cust.id, lines: [{ partId: part.id, qty: 1, unitPriceCents: 5000 }], depositCents: 1000, tender: cash(1000) }), /customer/);
    ok("tenant: B's calls with A's ids are refused; A's rows are untouched");
  } finally {
    await cleanup();
  }
  console.log(`layaway.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
