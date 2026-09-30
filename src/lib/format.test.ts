// Unit tests for money typed by people, the CSV files the shop downloads and page addresses (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { money, toCents } from "./format";
import { csvCell, csvResponse } from "./csv";
import { firstValues } from "./search-params";

test("money typed as a person would", () => {
  assert.equal(toCents("12.50"), 1250);
  assert.equal(toCents("12"), 1200);
  assert.equal(toCents("$5"), 500);
  assert.equal(toCents(" $ 1,000.50 "), 100050);
  assert.equal(toCents("1,234,567.89"), 123456789);
  assert.equal(toCents(".5"), 50);
  assert.equal(toCents("5."), 500);
  assert.equal(toCents("-20"), -2000);
  assert.equal(toCents("+3"), 300);
  assert.equal(toCents("19.999"), 2000, "extra decimals are rounded");
  assert.ok(Object.is(toCents("-0"), 0), "not negative zero");
});

test("money that could be read two ways, or isn't money, is refused", () => {
  for (const bad of ["", "   ", "abc", "-", ".", "$", "1.000,50", "1,50", "12,5", "1,00", "1,2345", "1e3", "0x10", "Infinity", "NaN", "1.2.3", "12abc", "1 2 3 x"]) {
    assert.equal(toCents(bad), null, `"${bad}"`);
  }
  assert.equal(toCents(null), null);
  assert.equal(toCents(undefined), null);
});

test("an amount too big for the books' whole numbers is refused instead of crashing the save", () => {
  assert.equal(toCents("21474836.47"), 2_147_483_647);
  assert.equal(toCents("21474836.48"), null);
  assert.equal(toCents("99999999999"), null);
  assert.equal(toCents("-25000000"), null);
});

test("money is shown with its sign in front of the dollar sign", () => {
  assert.equal(money(1250), "$12.50");
  assert.equal(money(-2000), "-$20.00");
  assert.equal(money(0), "$0.00");
  assert.equal(money(null), "");
});

test("a CSV cell: quoted when it has a comma, quote or line break; a formula gets an apostrophe", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("-12.50"), "-12.50", "a negative amount stays a number");
  assert.equal(csvCell("-dash text"), "'-dash text");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell(new Date("2026-09-30T12:00:00Z")), "2026-09-30T12:00:00.000Z");
});

test("a CSV download starts with a UTF-8 byte order mark so Excel reads accents, and ends rows with CRLF", async () => {
  const res = csvResponse([["name", "amount"], ["José Núñez", "1.50"], ["½ yd, cut", "-2.00"]], "test.csv");
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  assert.equal(text, '﻿name,amount\r\nJosé Núñez,1.50\r\n"½ yd, cut",-2.00\r\n');
  assert.equal(res.headers.get("Content-Type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("Content-Disposition"), 'attachment; filename="test.csv"');
});

test("a parameter repeated in the address is read as its first value", () => {
  assert.deepEqual(firstValues({ q: ["a", "b"], show: "paid", x: undefined }), { q: "a", show: "paid", x: undefined });
});
