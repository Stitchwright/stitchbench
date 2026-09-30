// Unit tests for a stock item's condition and who made it: what the invoice says, the tags, the spreadsheet words and
// the number a second item of the same part is saved under (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { asCondition, asOrigin, conditionFromText, disclosure, labelFields, labelTag, numberNames, originFromText, partTags, shopNumberText, twinNumber, withDisclosure } from "./part-labels";

const p = (condition: "NEW" | "USED" | "REFURB", origin: "GENUINE" | "COMPATIBLE" | "PRINTED", brand: string | null = null) => ({ condition, origin, brand });

test("a new genuine part says nothing on the bill; the others say what they are", () => {
  assert.equal(disclosure(p("NEW", "GENUINE", "Brother")), "");
  assert.equal(disclosure(p("USED", "GENUINE")), "used");
  assert.equal(disclosure(p("REFURB", "GENUINE")), "refurbished");
  assert.equal(disclosure(p("NEW", "COMPATIBLE", "Brother")), "compatible, not genuine Brother");
  assert.equal(disclosure(p("NEW", "COMPATIBLE")), "compatible");
  assert.equal(disclosure(p("NEW", "PRINTED")), "3D printed");
  assert.equal(disclosure(p("USED", "COMPATIBLE")), "used, compatible");
  assert.equal(disclosure(p("REFURB", "PRINTED", "Janome")), "refurbished, 3D printed");
});

test("the disclosure is written into the line's description", () => {
  assert.equal(withDisclosure("SA157 Bobbin case", p("USED", "GENUINE")), "SA157 Bobbin case (used)");
  assert.equal(withDisclosure("SB-00012 Spool pin knob", p("NEW", "PRINTED")), "SB-00012 Spool pin knob (3D printed)");
  assert.equal(withDisclosure("Touch screen", p("NEW", "COMPATIBLE", " Brother ")), "Touch screen (compatible, not genuine Brother)");
  assert.equal(withDisclosure("Thread", p("NEW", "GENUINE")), "Thread");
});

test("tags on the list and on a label", () => {
  assert.deepEqual(partTags(p("NEW", "GENUINE")), []);
  assert.deepEqual(partTags(p("USED", "COMPATIBLE")), ["Used", "Compatible"]);
  assert.deepEqual(partTags(p("REFURB", "PRINTED")), ["Refurbished", "3D printed"]);
  assert.equal(labelTag(p("NEW", "GENUINE")), "");
  assert.equal(labelTag(p("USED", "GENUINE")), "USED");
  assert.equal(labelTag(p("REFURB", "GENUINE")), "REFURB");
  assert.equal(labelTag(p("NEW", "COMPATIBLE")), "COMPATIBLE");
  assert.equal(labelTag(p("NEW", "PRINTED")), "3D PRINTED");
  assert.equal(labelTag(p("USED", "COMPATIBLE")), "USED · COMPATIBLE");
});

test("spreadsheet words", () => {
  assert.equal(conditionFromText("New"), "NEW");
  assert.equal(conditionFromText(" USED "), "USED");
  assert.equal(conditionFromText("Refurbished"), "REFURB");
  assert.equal(conditionFromText("refurb"), "REFURB");
  assert.equal(conditionFromText("mint"), null);
  assert.equal(conditionFromText(""), null);
  assert.equal(originFromText("Genuine"), "GENUINE");
  assert.equal(originFromText("OEM"), "GENUINE");
  assert.equal(originFromText("Compatible"), "COMPATIBLE");
  assert.equal(originFromText("Aftermarket"), "COMPATIBLE");
  assert.equal(originFromText("generic"), "COMPATIBLE");
  assert.equal(originFromText("3D printed"), "PRINTED");
  assert.equal(originFromText("3d-printed"), "PRINTED");
  assert.equal(originFromText("Printed"), "PRINTED");
  assert.equal(originFromText("Brother"), null);
  assert.equal(originFromText(null), null);
});

test("the same part in another condition is saved as <number> (used); beside a partner's stock as (own)", () => {
  assert.equal(twinNumber("SA157", "USED", true), "SA157 (used)");
  assert.equal(twinNumber("SA157", "REFURB", true), "SA157 (refurbished)");
  assert.equal(twinNumber("SA157", "NEW", true), "SA157 (new)");
  assert.equal(twinNumber("SA157", "NEW", false), "SA157 (own)");
  assert.deepEqual(numberNames("SA157"), ["SA157", "SA157 (own)", "SA157 (new)", "SA157 (used)", "SA157 (refurbished)"]);
});

test("shop numbers", () => {
  assert.equal(shopNumberText("SB", 1), "SB-00001");
  assert.equal(shopNumberText("SS", 42), "SS-00042");
  assert.equal(shopNumberText("SB", 123456), "SB-123456");
});

test("what a partner shop is sent: only what isn't new and genuine, and only values we know", () => {
  assert.deepEqual(labelFields({ condition: "NEW", origin: "GENUINE" }), {});
  assert.deepEqual(labelFields({}), {});
  assert.deepEqual(labelFields({ condition: "USED", origin: "GENUINE" }), { condition: "USED" });
  assert.deepEqual(labelFields({ condition: "NEW", origin: "PRINTED" }), { origin: "PRINTED" });
  assert.deepEqual(labelFields({ condition: "REFURB", origin: "COMPATIBLE" }), { condition: "REFURB", origin: "COMPATIBLE" });
  assert.deepEqual(labelFields({ condition: "MINT", origin: 5 }), {});
  assert.equal(asCondition("USED"), "USED");
  assert.equal(asCondition("used"), null);
  assert.equal(asCondition(undefined), null);
  assert.equal(asOrigin("PRINTED"), "PRINTED");
  assert.equal(asOrigin("HANDMADE"), null);
  assert.deepEqual(partTags({ condition: "USED", origin: "COMPATIBLE" }), ["Used", "Compatible"]);
  assert.deepEqual(partTags({}), []);
  assert.deepEqual(partTags({ condition: "junk" }), []);
});
