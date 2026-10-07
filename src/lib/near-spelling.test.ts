// Unit tests for the customer search's near spellings (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { editDistance, nameNear, prefixPatterns, searchPrefixes, spacedWords } from "./near-spelling";

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

test("the database's narrowing finds names with apostrophes, hyphens and commas", () => {
  // The SQL in src/lib/customer-search.ts builds spacedWords() and matches it LIKE each pattern.
  const like = (name: string, typed: string) => prefixPatterns(typed).some((p) => spacedWords(name).includes(p.slice(1, -1)));
  assert.equal(spacedWords("O'Brien, Ruth"), " obrien ruth");
  assert.equal(spacedWords("Smith-Jones"), " smith jones");
  assert.equal(spacedWords("Miller,Dorothy"), " miller dorothy");
  for (const [name, typed] of [
    ["O'Brien, Ruth", "obrien"],
    ["Smith-Jones", "jonse"],
    ["Miller,Dorothy", "dorthy"],
    ["Dorothy Miller", "dorthy"],
  ]) {
    assert.ok(like(name, typed), `${name} is a candidate for ${typed}`);
    assert.ok(nameNear(name, typed), `${name} is near ${typed}`);
  }
  assert.ok(!like("Ruth Adams", "dorthy"));
  assert.deepEqual(prefixPatterns("do"), [], "fewer than 3 letters: no near-spelling search");
});
