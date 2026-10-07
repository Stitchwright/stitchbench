// Unit tests for the customer search's near spellings (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { editDistance, nameNear, searchPrefixes } from "./near-spelling";

test("edit distance counts a swap of neighbours as one", () => {
  assert.equal(editDistance("dorthy", "dorothy"), 1);
  assert.equal(editDistance("ab", "ba"), 1);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("miller", "miller"), 0);
});

test("a misspelt first name finds the customer", () => {
  assert.ok(nameNear("Dorothy Miller", "dorthy"));
  assert.ok(nameNear("Dorothy Miller", "Dorthy Miler"));
  assert.ok(nameNear("Dorothy Miller", "dorth"));
  assert.ok(nameNear("Dorothy Miller", "miller"));
  assert.ok(nameNear("O'Brien, Ruth", "obrien"));
});

test("unrelated names and short words are not near", () => {
  assert.ok(!nameNear("Dorothy Miller", "ruth"));
  assert.ok(!nameNear("Dorothy Miller", "dorthy smith"));
  assert.ok(!nameNear("Dot Miller", "dan"));
  assert.ok(!nameNear("Ann Lee", "al"));
});

test("the database narrows by each word's first two letters", () => {
  assert.deepEqual(searchPrefixes("Dorthy Miler"), ["do", "mi"]);
  assert.deepEqual(searchPrefixes("al"), []);
});
