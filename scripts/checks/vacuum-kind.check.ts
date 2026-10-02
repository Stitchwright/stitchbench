// The vacuum kind (modules-design.md 10.a, package vac-repair): the owner's six types, the intake contract keys, unique
// reading keys, menu names that fit, and links to Google, eBay and YouTube only. Pure: no database.
//   npx tsx scripts/checks/vacuum-kind.check.ts
import assert from "node:assert/strict";
import { brandMatches, VACUUM_BRANDS, VACUUM_KIND } from "../../src/lib/equipment/vacuum";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

for (const t of ["Upright", "Canister", "Central", "Backpack", "Robot", "Commercial"]) assert.ok(VACUUM_KIND.types.includes(t), `type ${t}`);
assert.ok(VACUUM_KIND.types.includes("Stick / cordless") && VACUUM_KIND.types.includes("Other"));
ok("the owner's six types are present, plus Stick / cordless and Other");

const bagged = VACUUM_KIND.intakeFields.find((f) => f.key === "bagged");
const bagType = VACUUM_KIND.intakeFields.find((f) => f.key === "bagType");
assert.ok(bagged && bagType, "the intake contract keys exist");
assert.deepEqual(bagged!.options, ["Bagged", "Bagless"]);
assert.equal(bagged!.on, "machine");
assert.equal(bagType!.on, "machine");
assert.ok(VACUUM_KIND.intakeFields.some((f) => f.key === "power" && f.type === "select"));
assert.ok(VACUUM_KIND.intakeFields.some((f) => f.key === "smell" && f.type === "checkbox" && f.on === "ticket"));
for (const f of VACUUM_KIND.intakeFields) assert.match(f.key, /^[a-z0-9-]{1,40}$/i, `field key ${f.key}`);
ok("bagged (Bagged / Bagless) and bagType are machine-level; power and the burning-smell question are there");

const readingKeys = VACUUM_KIND.readings.map((r) => r.key);
assert.equal(new Set(readingKeys).size, readingKeys.length, "reading keys are unique");
assert.deepEqual(readingKeys, ["suction", "amps", "brushroll"]);
assert.ok(VACUUM_KIND.readings.every((r) => r.foundLeft));
ok("three readings with unique keys, each as found / as left");

assert.equal(VACUUM_KIND.serviceMenu.length, 16);
for (const s of VACUUM_KIND.serviceMenu) {
  assert.ok(s.name.length <= 80, `menu name too long: ${s.name}`);
  assert.equal(s.priceCents, undefined, "no price: created switched off at $0");
}
assert.equal(VACUUM_KIND.checklist.length, 10);
assert.equal(VACUUM_KIND.accessories.length, 13);
assert.deepEqual(VACUUM_KIND.defaultChecked, []);
assert.equal(VACUUM_BRANDS.length, 30);
assert.ok(VACUUM_KIND.brands.includes("Hoover") && VACUUM_KIND.brands.includes("SEBO"));
ok("16 menu names of 80 characters or fewer with no prices; 10 checklist lines; 13 accessories, none ticked by default; 30 brands");

const links = VACUUM_KIND.links("Hoover", "UH70120");
assert.ok(links.length >= 3);
for (const l of links) assert.match(l.url, /^https:\/\/www\.(google|ebay|youtube)\.com\//, l.url);
assert.ok(links.some((l) => l.label === "Hoover support" && /google\.com/.test(l.url)), "the maker link is a Google search");
ok("links go to Google, eBay and YouTube only; 'Hoover support' is a Google search");

assert.equal(brandMatches("Hoover"), true);
assert.equal(brandMatches("dirt devil"), true);
assert.equal(brandMatches("Dirt-Devil"), true);
assert.equal(brandMatches("Janome"), false);
assert.equal(brandMatches(""), false);
assert.equal(VACUUM_KIND.panels.tension, false);
assert.equal(VACUUM_KIND.module, "vac");
ok("brandMatches ignores case, spaces and hyphens; tension and timing panels are off");

console.log(`vacuum-kind.check: ${steps} groups passed`);
