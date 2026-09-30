// Unit tests for splitting a sold line's charge into exact return lines (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { splitForReturn } from "./sale-return";
import { roundCents } from "./register-math";

test("a charge that divides evenly among its units returns one line", () => {
  assert.deepEqual(splitForReturn(3, 3000), [{ qty: -3, unitPriceCents: 1000 }]);
  assert.deepEqual(splitForReturn(1, 999), [{ qty: -1, unitPriceCents: 999 }]);
  assert.deepEqual(splitForReturn(-2, -2000), [{ qty: 2, unitPriceCents: 1000 }]);
});

test("a fractional quantity (fabric by the yard) always stays one line, rounded to the cent", () => {
  assert.deepEqual(splitForReturn(2.375, 3083), [{ qty: -2.375, unitPriceCents: roundCents(3083 / 2.375) }]);
});

test("a charge that doesn't divide evenly splits into two lines that add back up to the original charge exactly", () => {
  // qty 3 at $10.00 with a $1.00 discount: $29.00 / 3 = $9.666...; one rounded line would refund $29.01, not $29.00.
  const lines = splitForReturn(3, 2900);
  assert.deepEqual(lines, [
    { qty: -2, unitPriceCents: 966 },
    { qty: -1, unitPriceCents: 968 },
  ]);
  assert.equal(lines.reduce((a, l) => a + l.qty * l.unitPriceCents, 0), -2900, "the return refunds exactly what the sale charged");
});

test("the split total matches netCents for a spread of quantities and charges, whatever their sign", () => {
  for (const qty of [2, 3, 4, 5, 7, 11, -2, -3, -5]) {
    for (const netCents of [1, 7, 100, 299, 1001, 12345]) {
      const net = Math.sign(qty) * netCents; // net and qty always agree in sign for a real sale line
      const lines = splitForReturn(qty, net);
      const total = lines.reduce((a, l) => a + l.qty * l.unitPriceCents, 0);
      assert.equal(total, -net, `qty ${qty}, net ${net}`);
      for (const l of lines) assert.ok(l.unitPriceCents >= 0, `a price went negative for qty ${qty}, net ${net}`);
    }
  }
});

test("nothing to return for a zero quantity", () => {
  assert.deepEqual(splitForReturn(0, 0), []);
});
