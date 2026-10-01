// The equipment framework (modules-design.md section 13.2, modules-foundation acceptance item 5):
//   npx tsx --conditions=react-server scripts/checks/equipment.check.ts
// The pure parts (kinds, form readers, starterKindFor) need no database; kindOf / kindByKey / servicesFor use a
// throwaway company "Check <run>", removed at the end. Exit code non-zero on the first failing assertion.
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { ACCESSORIES, MACHINE_TYPES } from "@/lib/constants";
import { readAnswers, readReadings } from "@/lib/equipment/form";
import { genericKind } from "@/lib/equipment/index";
import { SEWING_KIND } from "@/lib/equipment/sewing";
import { kindByKey, kindOf, servicesFor } from "@/lib/equipment/shop";
import type { FieldDef, ReadingDef } from "@/lib/equipment/types";
import { VACUUM_KIND } from "@/lib/equipment/vacuum";
import { DEFAULT_CHECKLIST, DEFAULT_SERVICE_MENU, starterKindFor } from "@/lib/service-menu";
import { makeCompany, removeCompany, RUN } from "./tenant";

let steps = 0;
const ok = (label: string) => {
  steps += 1;
  console.log(`  ok  ${label}`);
};

const userError = (re: RegExp) => (e: unknown) => {
  assert.ok(isUserError(e), `expected a UserError, got ${String(e)}`);
  assert.match((e as Error).message, re);
  return true;
};

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

/** Nothing reached Object.prototype. */
function assertNoPollution() {
  const fresh = {} as Record<string, unknown>;
  assert.equal(fresh.polluted, undefined, "Object.prototype was polluted");
  assert.equal(Object.keys(fresh).length, 0);
}

function pure() {
  // The sewing kind is exactly today's behaviour.
  assert.deepEqual(SEWING_KIND.types, MACHINE_TYPES);
  assert.deepEqual(SEWING_KIND.accessories, ACCESSORIES.filter((a) => a !== "Other"));
  assert.ok(SEWING_KIND.accessories.includes("Power cord") && SEWING_KIND.accessories.includes("Foot control"));
  assert.deepEqual(SEWING_KIND.defaultChecked, ["Power cord", "Foot control"]);
  assert.deepEqual(SEWING_KIND.checklist, DEFAULT_CHECKLIST);
  assert.deepEqual(SEWING_KIND.serviceMenu, DEFAULT_SERVICE_MENU);
  assert.equal(SEWING_KIND.equipment, "SEWING");
  assert.equal(SEWING_KIND.module, null);
  assert.deepEqual(SEWING_KIND.panels, { tension: true, timing: true });
  assert.equal(SEWING_KIND.intakeFields.length, 0);
  assert.equal(SEWING_KIND.readings.length, 0);
  ok("the sewing kind equals today's lists");

  // readAnswers
  const defs: FieldDef[] = [
    { key: "bagged", label: "Bags or bagless", type: "select", options: ["Bagged", "Bagless"], on: "machine" },
    { key: "cordless", label: "Cordless", type: "checkbox", on: "machine" },
    { key: "hours", label: "Hours on the meter", type: "number", on: "ticket" },
    { key: "smell", label: "Smell", type: "text", on: "ticket" },
  ];
  assert.throws(() => readAnswers(defs, "machine", form({ "f:bagged": "Maybe" })), userError(/Pick one of the choices for Bags or bagless/));
  assert.throws(() => readAnswers(defs, "machine", form({}), undefined, ["bagged"]), userError(/Answer 'Bags or bagless'/));
  assert.throws(() => readAnswers(defs, "ticket", form({ "f:hours": "lots" })), userError(/isn't a number/));
  const polluted = JSON.parse('{"__proto__": {"polluted": "yes"}, "old-answer": "kept", "gone": {"nested": true}}') as Record<string, unknown>;
  const machineAnswers = readAnswers(defs, "machine", form({ "f:bagged": "Bagged", "f:cordless": "on", "f:unknown": "x", "f:__proto__": "y", __proto__: "z", "f:hours": "12" }), polluted);
  assert.deepEqual(machineAnswers, { "old-answer": "kept", bagged: "Bagged", cordless: true }, "known machine fields, the primitive leftovers of prev, nothing else");
  assert.equal(Object.hasOwn(machineAnswers, "__proto__"), false);
  assert.equal(Object.getPrototypeOf(machineAnswers), Object.prototype);
  assertNoPollution();
  const ticketAnswers = readAnswers(defs, "ticket", form({ "f:hours": "12,5", "f:smell": ` ${"x".repeat(250)} `, "f:bagged": "Bagless" }));
  assert.equal(ticketAnswers.hours, 12.5, "a decimal comma counts");
  assert.equal((ticketAnswers.smell as string).length, 200, "text is cut to 200");
  assert.equal("bagged" in ticketAnswers, false, "a machine field isn't a ticket answer");
  assert.deepEqual(readAnswers(defs, "ticket", form({ "f:hours": "   " })), {}, "blank optional answers are dropped");
  ok("readAnswers: refuses a bad choice and a missing required answer; ignores unknown and __proto__ keys");

  // readReadings
  const rdefs: ReadingDef[] = [
    { key: "suction", label: "Suction", type: "number", unit: "inH2O", foundLeft: true },
    { key: "belt", label: "Belt", type: "passfail", foundLeft: false },
    { key: "noise", label: "Noise", type: "text", foundLeft: false },
  ];
  assert.throws(() => readReadings(rdefs, form({ "found:suction": "-1" })), userError(/Suction as found: "-1" isn't a reading/));
  assert.throws(() => readReadings(rdefs, form({ "left:suction": "high" })), userError(/isn't a reading/));
  assert.throws(() => readReadings(rdefs, form({ "left:belt": "meh" })), userError(/Belt: pick Pass or Fail/));
  const readings = readReadings(rdefs, form({ "found:suction": "60", "left:suction": "75,5", "found:belt": "pass", "left:noise": ` ${"n".repeat(100)} `, "found:unknown": "1", "found:__proto__": "2", __proto__: "3", "left:constructor": "4", "found:Suction": "5" }));
  assert.deepEqual(readings, { suction: { found: 60, left: 75.5 }, belt: { left: "pass" }, noise: { left: "n".repeat(80) } });
  assert.deepEqual(Object.keys(readings), ["suction", "belt", "noise"]);
  assert.equal(Object.hasOwn(readings, "__proto__"), false);
  assertNoPollution();
  assert.deepEqual(readReadings(rdefs, form({ "found:suction": "" })), {}, "a key with no value is left out");
  ok("readReadings: refuses a bad value; one-value readings go under left; unknown and __proto__ keys are ignored");

  // genericKind and starterKindFor
  const g = genericKind("APPLIANCE", "espresso", "Espresso machine");
  assert.equal(g.key, "espresso");
  assert.equal(g.builtIn, false);
  assert.equal(g.module, "appliance");
  assert.equal(g.noun, "espresso machine");
  assert.equal(genericKind("ROBOT", "robo").equipment, "APPLIANCE", "unknown equipment renders as an appliance");
  assert.equal(starterKindFor("Storage fee (after 60 days)"), null);
  assert.equal(starterKindFor("Rush - back mid-week"), null);
  assert.equal(starterKindFor("Diagnosis & estimate (credited toward approved work)"), null);
  assert.equal(starterKindFor("Hook timing only"), "sewing");
  assert.equal(starterKindFor("Clean, oil, time & adjust - mechanical"), "sewing");
  ok("starterKindFor: storage fee, rush and diagnosis are for every kind; the rest are sewing");
}

async function withDatabase() {
  const a = await makeCompany(`Check ${RUN}`);
  try {
    // kindOf falls back to a generic kind; kindByKey(null) is sewing.
    const k1 = await kindOf(a.shopId, { equipment: "APPLIANCE", kind: "espresso-xyz" });
    assert.equal(k1.key, "espresso-xyz");
    assert.equal(k1.builtIn, false);
    assert.equal(k1.equipment, "APPLIANCE");
    assert.equal(k1.module, "appliance");
    assert.equal(k1.label, "espresso-xyz", "a removed shop kind renders under its key");
    const k2 = await kindOf(a.shopId, { equipment: "ROBOT", kind: "robot-9" });
    assert.equal(k2.key, "robot-9");
    assert.equal(k2.equipment, "APPLIANCE");
    assert.equal((await kindOf(a.shopId, { equipment: "VACUUM", kind: "vacuum" })).key, "vacuum");
    assert.equal((await kindOf(a.shopId, { equipment: "SEWING", kind: "sewing" })).key, "sewing");
    assert.equal((await kindOf(a.shopId, { equipment: "APPLIANCE", kind: "vacuum" })).key, "vacuum", "the key wins over a mismatched equipment");
    assert.equal(await kindByKey(a.shopId, null), SEWING_KIND);
    assert.equal(await kindByKey(a.shopId, undefined), SEWING_KIND);
    assert.equal(await kindByKey(a.shopId, ""), SEWING_KIND);
    assert.equal(await kindByKey(a.shopId, "no-such-kind"), SEWING_KIND, "an unknown key means sewing");
    assert.equal(await kindByKey(a.shopId, "vacuum"), VACUUM_KIND);
    ok("kindOf falls back to genericKind; kindByKey(null) is sewing");

    // servicesFor("vacuum"): the items for every kind (null) and the vacuum ones, active only, this company only.
    const starter = await db.serviceItem.findMany({ where: { shopId: a.shopId }, select: { name: true, equipmentKind: true } });
    assert.equal(starter.length, DEFAULT_SERVICE_MENU.length);
    for (const s of starter) assert.equal(s.equipmentKind, starterKindFor(s.name), `${s.name}: a new company's menu uses starterKindFor`);
    await db.serviceItem.createMany({
      data: [
        { shopId: a.shopId, name: "Belt replacement", priceCents: 1500, equipmentKind: "vacuum", sortOrder: 100 },
        { shopId: a.shopId, name: "Old vacuum tune-up", priceCents: 4900, equipmentKind: "vacuum", sortOrder: 101, active: false },
        { shopId: a.shopId, name: "Mixer gear replacement", priceCents: 8900, equipmentKind: "stand-mixer", sortOrder: 102 },
        { shopId: a.shopId, name: "Bench fee", priceCents: 1000, equipmentKind: null, sortOrder: 103 },
      ],
    });
    const other = await makeCompany(`Check ${RUN} other`);
    try {
      await db.serviceItem.create({ data: { shopId: other.shopId, name: "Other company's vacuum item", priceCents: 100, equipmentKind: "vacuum" } });
      const items = await servicesFor(a.shopId, "vacuum");
      const names = items.map((i) => i.name);
      assert.ok(items.every((i) => i.shopId === a.shopId), "this company's only");
      assert.ok(items.every((i) => i.active), "active only");
      assert.ok(items.every((i) => i.equipmentKind === null || i.equipmentKind === "vacuum"), "null- and vacuum-kind only");
      for (const want of ["Belt replacement", "Bench fee", "Storage fee (after 60 days)", "Rush - back mid-week", "Diagnosis & estimate (credited toward approved work)"]) assert.ok(names.includes(want), `missing ${want}`);
      for (const not of ["Old vacuum tune-up", "Mixer gear replacement", "Hook timing only", "Clean, oil, time & adjust - mechanical", "Other company's vacuum item"]) assert.ok(!names.includes(not), `${not} shouldn't be offered`);
      const sorted = [...items].sort((x, y) => x.sortOrder - y.sortOrder).map((i) => i.name);
      assert.deepEqual(names, sorted, "by sortOrder");
      const sewing = await servicesFor(a.shopId, "sewing");
      assert.ok(sewing.some((i) => i.name === "Hook timing only") && sewing.some((i) => i.name === "Bench fee") && !sewing.some((i) => i.name === "Belt replacement"));
    } finally {
      await removeCompany(other.shopId);
    }
    ok("servicesFor('vacuum') returns null- and vacuum-kind items only");
  } finally {
    await removeCompany(a.shopId);
  }
}

async function main() {
  try {
    pure();
    await withDatabase();
    console.log(`equipment.check: ${steps} steps passed (run ${RUN})`);
  } finally {
    const left = await db.shop.count({ where: { name: { startsWith: `Check ${RUN}` } } });
    if (left) console.error(`cleanup: ${left} "Check ${RUN}" companies left behind`);
    await db.$disconnect();
    if (left) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
