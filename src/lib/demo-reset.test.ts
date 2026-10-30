import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEMO_COMPANIES, SEED_SCRIPTS, isDemoEmail, resetRefusal } from "./demo-reset";

const demoShop = (name = DEMO_COMPANIES[0]) => ({ name, userEmails: ["owner@stitchshop.test", "priya.nair@example.com"] });

test("the reset refuses unless the server is a demo", () => {
  assert.match(String(resetRefusal({ shops: [demoShop()] }, false)), /DEMO_MODE is not on/);
  assert.equal(resetRefusal({ shops: [demoShop()] }, true), null);
});

test("an empty database or one with only demo companies may be reset", () => {
  assert.equal(resetRefusal({ shops: [] }, true), null);
  assert.equal(resetRefusal({ shops: DEMO_COMPANIES.map((n) => demoShop(n)) }, true), null);
});

test("a real company in the same database stops it, whatever else is true", () => {
  const real = { name: "Sunny Day Sewing", userEmails: ["owner@sunnyday.example"] };
  assert.match(String(resetRefusal({ shops: [demoShop(), real] }, true)), /not a demo company \("Sunny Day Sewing"\)/);
  assert.match(String(resetRefusal({ shops: [real] }, true)), /Nothing was touched/);
});

test("a demo-named company with a real person in it stops it too", () => {
  const sneaky = { name: DEMO_COMPANIES[0], userEmails: ["a@stitchshop.test", "someone@gmail.com"] };
  assert.match(String(resetRefusal({ shops: [sneaky] }, true)), /not a demo person \(someone@gmail.com\)/);
  assert.equal(resetRefusal({ shops: [{ name: DEMO_COMPANIES[0], userEmails: ["A@STITCHSHOP.TEST"] }] }, true), null, "case does not matter");
});

test("every seed script the reset runs exists", () => {
  for (const s of SEED_SCRIPTS) assert.ok(fs.existsSync(path.resolve(import.meta.dirname, "../..", s)), s);
});

test("only invented domains count as demo people", () => {
  for (const e of ["a@stitchshop.test", "A@STITCHSHOP.TEST", "b@example.com", "c@example.org", "d@shop.example.net"]) assert.equal(isDemoEmail(e), true, e);
  for (const e of ["a@gmail.com", "owner@example.company", "x@notexample.com", "b@myexample.com"]) assert.equal(isDemoEmail(e), false, e);
});
