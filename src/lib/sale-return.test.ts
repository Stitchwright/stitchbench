// Unit tests for splitting a sold line's charge into exact return lines (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { linesOfSale, receiptStands, returnSkip, splitForReturn } from "./sale-return";
import { roundCents } from "./register-math";

test("a service plan comes back with its machine; layaway money is settled on the layaway", () => {
  assert.equal(returnSkip({ machinePlanId: "mp1" }), "unit");
  assert.equal(returnSkip({ kind: "LAYAWAY" }), "layaway");
  assert.equal(returnSkip({ kind: "LAYAWAY_FEE" }), "layaway");
  assert.equal(returnSkip({ kind: "NOTION" }), null, "an item a layaway held, sold on pick-up, returns like any other");
});

test("special-order and loaner deposits, kept deposits, rent and loaner charges are settled where they were taken", () => {
  for (const kind of ["DEPOSIT", "DEPOSIT_KEPT", "RENT", "LOAN_FEE"]) assert.equal(returnSkip({ kind }), "held", kind);
});

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

test("a receipt leaves out lines with their own way back: repairs, gift cards, bookings, vacuums and trade-ins", () => {
  assert.equal(returnSkip({}), null);
  assert.equal(returnSkip({ repairJobId: "r" }), "repair");
  assert.equal(returnSkip({ giftCardId: "g" }), "card");
  assert.equal(returnSkip({ enrollmentId: "e" }), "booking");
  assert.equal(returnSkip({ appointmentId: "a" }), "booking");
  assert.equal(returnSkip({ stockUnitId: "u" }), "unit");
  assert.equal(returnSkip({ tradeInUnitId: "t" }), "unit");
});

test("a return takes the receipt's tax only for items that sale sold", () => {
  const sold = [
    { partId: "p1", description: "Bobbins" },
    { partId: null, description: "Hemming" },
  ];
  assert.equal(linesOfSale([{ partId: "p1", description: "anything" }, { partId: null, description: "Hemming" }], sold), true);
  assert.equal(linesOfSale([{ partId: "p2", description: "Bobbins" }], sold), false, "another part");
  assert.equal(linesOfSale([{ partId: null, description: "Other item" }], sold), false, "a typed line the sale didn't have");
  assert.equal(linesOfSale([{ partId: null, description: "Bobbins" }], sold), false, "a typed line named like a part");
});

test("the scanned receipt stands only while every return line came from it", () => {
  assert.equal(receiptStands("s1", [{ qty: -1, fromSale: "s1" }, { qty: -2, fromSale: "s1" }]), true);
  assert.equal(receiptStands("s1", [{ qty: -1, fromSale: "s1" }, { qty: 1 }]), true, "a sale line beside it (the server then charges the rate today anyway)");
  assert.equal(receiptStands("s1", []), false, "its lines removed");
  assert.equal(receiptStands("s1", [{ qty: 1 }]), false, "no return lines left");
  assert.equal(receiptStands("s1", [{ qty: -1 }]), false, "a return typed by hand");
  assert.equal(receiptStands("s1", [{ qty: -1, fromSale: "s1" }, { qty: -1, fromSale: "s2" }]), false, "another receipt's lines");
  assert.equal(receiptStands(null, [{ qty: -1, fromSale: "s1" }]), false);
});
