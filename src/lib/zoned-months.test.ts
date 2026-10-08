// Unit test: rent-to-own and rent periods from the 29th to the 31st land on the month's last day (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { monthsOn } from "./zoned";

test("a month on from the 29th to the 31st is the shorter month's last day", () => {
  assert.equal(monthsOn("2026-01-31", 1), "2026-02-28");
  assert.equal(monthsOn("2028-01-30", 1), "2028-02-29");
  assert.equal(monthsOn("2026-08-31", 3), "2026-11-30");
  assert.equal(monthsOn("2026-03-15", 2), "2026-05-15");
  assert.equal(monthsOn("2026-12-31", 2), "2027-02-28");
});
