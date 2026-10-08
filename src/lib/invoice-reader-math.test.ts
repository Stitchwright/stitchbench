// Unit tests for reading a packing slip answer cut off at the hub's answer limit (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { buildInvoiceRead, buildInvoiceRest, INVOICE_MAX_TOKENS, parseSlip, salvageSlip } from "./invoice-reader-math";

const cut = `{"lines":[{"itemNumber":"ISA-0015","description":"Isacord {black}","qty":6,"unitCost":4.6},{"itemNumber":"PIN-1","description":"Pins \\"glass\\"","qty":3,"unitCost":3.1},{"itemNumber":"NEW-7`;

test("a cut-off answer keeps its whole lines (braces and quotes inside strings don't confuse it)", () => {
  assert.equal(parseSlip(cut), null, "not JSON as it stands");
  const got = salvageSlip(cut)!;
  assert.deepEqual(
    got.map((l) => [l.itemNumber, l.qty]),
    [
      ["ISA-0015", 6],
      ["PIN-1", 3],
    ],
  );
  assert.equal(got[1].description, 'Pins "glass"');
  assert.equal(salvageSlip('{"supplier":"x"'), null);
});

test("the rest of the page is asked for after the last line read, within the hub's limit", () => {
  assert.equal(buildInvoiceRead(1, 2, null).maxTokens, INVOICE_MAX_TOKENS);
  const rest = buildInvoiceRest(1, 2, "Notions Marketing", salvageSlip(cut)!);
  assert.equal(rest.feature, "read_invoice");
  assert.match(rest.messages[0].content as string, /first 2 product lines are read already, ending with item number PIN-1/);
  assert.ok(INVOICE_MAX_TOKENS <= 2000, "the hub caps read_invoice at 2000");
});
