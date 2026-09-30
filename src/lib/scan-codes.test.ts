// Unit tests for parsing a claim tag or receipt barcode scanned at the register (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { parseScanCode } from "./scan-codes";

test("a receipt barcode (S<number>) is a sale to return", () => {
  assert.deepEqual(parseScanCode("S1004"), { kind: "sale", number: 1004 });
  assert.deepEqual(parseScanCode("s1004"), { kind: "sale", number: 1004 });
  assert.deepEqual(parseScanCode("  S42  "), { kind: "sale", number: 42 });
});

test("a claim tag barcode (T<tag>), or the tag typed alone, is a pickup job", () => {
  assert.deepEqual(parseScanCode("T101"), { kind: "tag", tag: "101" });
  assert.deepEqual(parseScanCode("t101"), { kind: "tag", tag: "101" });
  assert.deepEqual(parseScanCode("101"), { kind: "tag", tag: "101" });
  assert.deepEqual(parseScanCode(" 101 "), { kind: "tag", tag: "101" });
});

test("anything else is neither: the register keeps treating it as an item code or search text", () => {
  for (const c of ["", "  ", "ABC123", "T", "S", "T-101", "S 1004", "12345678901", "T12345678901"]) {
    assert.deepEqual(parseScanCode(c), { kind: "none" }, `"${c}"`);
  }
});
