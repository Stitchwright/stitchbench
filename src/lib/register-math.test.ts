// Unit tests for the register's money maths (npm run test:unit). The same functions run in the browser while ringing up
// and on the server when the sale is saved, so a one-cent drift here is a sale the register and the books disagree on.
import test from "node:test";
import assert from "node:assert/strict";
import { discountBase, inEighths, lineNet, orderDiscountShares, qtyText, roundCents, saleTotals, tenderProblem, yards, type Tender } from "./register-math";

const line = (qty: number, unitPriceCents: number, extra: { taxable?: boolean; discountCents?: number; discountable?: boolean } = {}) => ({
  qty,
  unitPriceCents,
  taxable: true,
  ...extra,
});
const cash = (amountCents: number): Tender => ({ method: "CASH", amountCents });
const card = (amountCents: number): Tender => ({ method: "CARD", amountCents });

test("half a cent rounds away from zero, so a return mirrors its sale", () => {
  assert.equal(roundCents(649.5), 650);
  assert.equal(roundCents(-649.5), -650);
  assert.equal(roundCents(2.5), 3);
  assert.equal(roundCents(-2.5), -3);
  assert.equal(roundCents(0.49), 0);
  assert.ok(Object.is(roundCents(-0.4), 0), "not negative zero");
});

test("line totals: quantity times price, less the line discount, mirrored for returns", () => {
  assert.equal(lineNet(line(3, 499)), 1497);
  assert.equal(lineNet(line(2, 1000, { discountCents: 300 })), 1700);
  assert.equal(lineNet(line(-2, 1000, { discountCents: 300 })), -1700);
  // Fabric in eighths: 2 3/8 yd at $12.99
  assert.equal(lineNet(line(2.375, 1299)), 3085);
  // A half yard at $12.99 is 649.5 cents: the sale and its return are the same size
  assert.equal(lineNet(line(0.5, 1299)), 650);
  assert.equal(lineNet(line(-0.5, 1299)), -650);
});

test("sales tax: only on taxable lines, rounded to the cent", () => {
  const t = saleTotals([line(1, 1000), line(1, 500, { taxable: false })], 0, 8.25);
  assert.equal(t.subtotal, 1500);
  assert.equal(t.tax, 83); // 82.5 rounds up
  assert.equal(t.total, 1583);
  assert.equal(saleTotals([line(1, 1000)], 0, 0).tax, 0);
});

test("a return refunds exactly what the same sale charged", () => {
  for (const [qty, price, rate] of [
    [0.5, 1299, 6.35], // 6.35 is not exact in binary
    [1, 1000, 7.25], // tax of exactly 72.5 cents
    [0.125, 999, 8.875],
    [3, 333, 8.25],
    [2.375, 1299, 4.5],
  ] as const) {
    const sale = saleTotals([line(qty, price)], 0, rate);
    const back = saleTotals([line(-qty, price)], 0, rate);
    assert.equal(back.subtotal, -sale.subtotal, `subtotal ${qty} x ${price}`);
    assert.equal(back.tax, -sale.tax, `tax ${qty} x ${price} at ${rate}%`);
    assert.equal(back.total, -sale.total, `total ${qty} x ${price} at ${rate}%`);
  }
  const half = saleTotals([line(0.5, 1299)], 0, 6.35);
  assert.deepEqual([half.subtotal, half.tax, half.total], [650, 41, 691]);
  assert.equal(saleTotals([line(1, 1000)], 0, 7.25).tax, 73);
  assert.equal(saleTotals([line(-1, 1000)], 0, 7.25).tax, -73);
});

test("tax uses the rate's own cents, not binary float dust", () => {
  // 6.35% of $10.00 is 63.5 cents; a float rate times 1000 gives 63.49999...
  assert.equal(saleTotals([line(1, 1000)], 0, 6.35).tax, 64);
  assert.equal(saleTotals([line(1, 100_000)], 0, 8.875).tax, 8875);
});

test("a whole-sale discount comes off what is bought and lowers the taxable amount in proportion", () => {
  // $100 taxable + $50 not taxable, $30 off: taxable share of the discount is 2/3 of it ($20), so tax is 8% of $80
  const t = saleTotals([line(1, 10000), line(1, 5000, { taxable: false })], 3000, 8);
  assert.equal(t.orderDiscount, 3000);
  assert.equal(t.tax, 640);
  assert.equal(t.total, 12640);
});

test("a whole-sale discount leaves returns and repair bills alone, and never goes past what is bought", () => {
  const t = saleTotals([line(1, 10000), line(-1, 2000), line(1, 12000, { taxable: false, discountable: false })], 1000, 8);
  // subtotal 100 - 20 + 120; tax on (100 - 20 - the 10 discount) at 8%
  assert.equal(t.subtotal, 20000);
  assert.equal(t.orderDiscount, 1000);
  assert.equal(t.tax, 560);
  assert.equal(t.total, 19560);
  assert.equal(discountBase([line(1, 10000), line(-1, 2000), line(1, 12000, { discountable: false })]), 10000);
  const all = saleTotals([line(1, 1000)], 5000, 0);
  assert.equal(all.orderDiscount, 1000);
  assert.equal(all.total, 0);
});

test("the shares of a whole-sale discount add up to the discount exactly", () => {
  const lines = [line(1, 333), line(1, 333), line(1, 334), line(-1, 500)];
  const shares = orderDiscountShares(lines, 100);
  assert.equal(shares.reduce((a, n) => a + n, 0), 100);
  assert.equal(shares[3], 0, "a return gets no share");
});

test("payments: only cash gives change, and a sale is paid in full", () => {
  const t = saleTotals([line(1, 1000), line(1, 500, { taxable: false })], 0, 8.25, [card(1000), cash(1000)]);
  assert.deepEqual([t.total, t.paid, t.change, t.due], [1583, 2000, 417, 0]);
  assert.equal(tenderProblem(t, [card(1000), cash(1000)]), null);
  // $15 on a card for a $10 sale can't be change
  const over = saleTotals([line(1, 1000)], 0, 0, [card(1500)]);
  assert.match(tenderProblem(over, [card(1500)]) ?? "", /Only cash gives change/);
  const short = saleTotals([line(1, 1000)], 0, 0, [cash(400)]);
  assert.equal(tenderProblem(short, [cash(400)]), "Still due: $6.00.");
  // Paid in full, but with a negative payment among them
  const mixed = saleTotals([line(1, 1000)], 0, 0, [cash(1100), cash(-100)]);
  assert.match(tenderProblem(mixed, [cash(1100), cash(-100)]) ?? "", /positive/);
});

test("a refund is paid out in full, in negative amounts", () => {
  const total = saleTotals([line(-1, 532)], 0, 0);
  assert.equal(total.total, -532);
  assert.equal(tenderProblem({ ...total, paid: -532 }, [cash(-532)]), null);
  assert.equal(tenderProblem({ ...total, paid: -300 }, [cash(-300)]), "Still to refund: $2.32.");
  assert.match(tenderProblem({ ...total, paid: -1000 }, [cash(-1000)]) ?? "", /Refunded \$4\.68 too much/);
  assert.match(tenderProblem({ ...total, paid: -532 }, [cash(300), cash(-832)]) ?? "", /negative/);
  assert.equal(saleTotals([line(-1, 532)], 0, 0, [cash(-532)]).change, 0);
});

test("fabric is cut in eighths of a yard", () => {
  assert.ok(inEighths(2.375));
  assert.ok(inEighths(0.125));
  assert.ok(!inEighths(2.3751));
  assert.ok(!inEighths(0.3333));
  assert.equal(yards(2.375), "2 3/8");
  assert.equal(yards(0.5), "1/2");
  assert.equal(yards(1.75), "1 3/4");
  assert.equal(yards(3), "3");
  assert.equal(yards(-1.25), "-1 1/4");
  assert.equal(qtyText(0.5, "yd"), "1/2 yd");
  assert.equal(qtyText(3, null), "3");
  // Sums of eighths are exact, so counts never drift
  let sold = 0;
  for (let i = 0; i < 100; i++) sold += 0.375;
  assert.equal(sold, 37.5);
});
