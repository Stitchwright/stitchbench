// Unit tests for "Raise prices" and the margin floor in whole cents (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { floorPrice, raised } from "./repricing-math";

test("a raise that lands exactly on a step isn't pushed up a step by float rounding", () => {
  assert.equal(raised(1000, 10, "25"), 1100, "$10.00 + 10% is $11.00, not $11.25");
  assert.equal(raised(1000, 10, "1"), 1100);
  assert.equal(raised(2000, 15, "50"), 2300);
  assert.equal(raised(1000, 7.5, "1"), 1075);
  assert.equal(raised(999, 10, "1"), 1099, "1098.9 rounds up to the cent");
  assert.equal(raised(1000, 10, "99"), 1199, "ends in .99 at or above $11.00");
});

test("the floor price is exact in whole cents", () => {
  assert.equal(floorPrice(100, 300, 25, "1"), 400, "$3.00 cost at a 25% floor is $4.00");
  assert.equal(floorPrice(500, 300, 25, "1"), 500, "never below the price now");
  assert.equal(floorPrice(100, 700, 30, "1"), 1000);
});
