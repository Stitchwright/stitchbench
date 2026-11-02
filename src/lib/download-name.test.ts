// Unit tests for file names sent in download headers (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { headerFileName } from "./download-name";

test("a download's file name keeps its letters and loses quotes, backslashes and line breaks", () => {
  assert.equal(headerFileName("warranty receipt.pdf"), "warranty receipt.pdf");
  assert.equal(headerFileName('a"b\\c\rd\ne.pdf'), "a_b_c_d_e.pdf");
});
