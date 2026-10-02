// "What you repair" and the appliance kinds (modules-design.md 11, package appliance-repair): the list boxes, the
// accessory box round trip, the question rows (a relabelled question keeps its key, new rows get unique keys, a bad row
// is named), the four built-in appliance kinds, shopKind(row), and a database section: a company adds "Espresso machine"
// with a Choice question, relabels it, the kind reaches check-in, the switches, "Check-in opens on", and the tenant
// section (B saving A's key makes B's own row).
//   npm run check scripts/checks/equipment-lines.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { APPLIANCE_KINDS, PRINTER_KIND, RESIN_PRINTER_KIND, STAND_MIXER_KIND } from "@/lib/equipment/appliances";
import { cleanFieldDefs } from "@/lib/equipment/form";
import { shopKind } from "@/lib/equipment/index";
import { accessoryBoxText, readAccessoryBox, readListBox, readQuestionRows, slug, uniqueKey } from "@/lib/equipment/lines";
import { shopKinds, usableKind } from "@/lib/equipment/shop";
import { saveCheckInKindFor, saveEquipmentKindFor, setKindActiveFor } from "@/lib/equipment/shop-kinds";
import type { FieldDef } from "@/lib/equipment/types";
import { grantDevLicense } from "../license/dev";
import { makeCompany, removeCompany, RUN } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

function form(entries: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

async function expectError(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

function expectErrorSync(label: string, fn: () => unknown, re: RegExp) {
  try {
    fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

// ---------- pure ----------

assert.deepEqual(readListBox(" Tilt-head \n\nBowl-lift\nTilt-head\r\n"), ["Tilt-head", "Bowl-lift"]);
assert.equal(readListBox("x".repeat(200))[0].length, 120);
assert.equal(readListBox(Array.from({ length: 10 }, (_, i) => `t${i}`).join("\n"), 4).length, 4);
assert.deepEqual(readListBox(null), []);
ok("readListBox trims, drops blanks and repeats, cuts at 120 characters and at max");

const acc = readAccessoryBox("* Power cord\nPortafilter\n*Tamper\n\n* Power cord");
assert.deepEqual(acc, { accessories: ["Power cord", "Portafilter", "Tamper"], defaultChecked: ["Power cord", "Tamper"] });
assert.equal(accessoryBoxText(acc), "* Power cord\nPortafilter\n* Tamper");
assert.deepEqual(readAccessoryBox(accessoryBoxText(acc)), acc);
ok("the accessory box round-trips, * marking what is ticked at check-in");

assert.equal(slug("Espresso machine"), "espresso-machine");
assert.equal(slug("  Boiler type?! "), "boiler-type");
assert.equal(slug("***"), "q");
assert.equal(slug("a".repeat(60)).length, 40);
assert.equal(uniqueKey("pump", new Set(["pump", "pump-2"])), "pump-3");
const prev: FieldDef[] = [{ key: "boiler", label: "Boiler type", type: "select", options: ["Single", "Dual"], on: "machine" }];
const rows = readQuestionRows(
  form({
    "q.key": ["boiler", "", "", ""],
    "q.label": ["Boiler", "Pump", "Pump", ""],
    "q.type": ["select", "text", "number", "text"],
    "q.options": ["Single, Dual, Single", "", "", ""],
    "q.on": ["machine", "ticket", "machine", "machine"],
  }),
  prev,
);
assert.deepEqual(rows, [
  { key: "boiler", label: "Boiler", type: "select", options: ["Single", "Dual"], on: "machine" },
  { key: "pump", label: "Pump", type: "text", on: "ticket" },
  { key: "pump-2", label: "Pump", type: "number", on: "machine" },
]);
assert.deepEqual(readQuestionRows(form({ "q.key": ["boiler"], "q.label": ["Boiler"], "q.type": ["select"], "q.options": ["Single"], "q.on": ["machine"], "q.remove": ["boiler"] }), prev), []);
expectErrorSync("choice without choices", () => readQuestionRows(form({ "q.key": ["", ""], "q.label": ["Size", "Kind"], "q.type": ["text", "select"], "q.options": ["", ""], "q.on": ["machine", "machine"] }), []), /^Question 2: a Choice question needs its choices/);
expectErrorSync("too long", () => readQuestionRows(form({ "q.key": [""], "q.label": ["x".repeat(121)], "q.type": ["text"], "q.options": [""], "q.on": ["machine"] }), []), /^Question 1: .*120/);
expectErrorSync("too many choices", () => readQuestionRows(form({ "q.key": [""], "q.label": ["Kind"], "q.type": ["select"], "q.options": [Array.from({ length: 21 }, (_, i) => `c${i}`).join(",")], "q.on": ["machine"] }), []), /^Question 1: 20 choices at most/);
// A relabelled question keeps its key only when the key was really one of the kind's.
assert.equal(readQuestionRows(form({ "q.key": ["stolen"], "q.label": ["Boiler"], "q.type": ["text"], "q.options": [""], "q.on": ["machine"] }), prev)[0].key, "boiler-0".slice(0, 6));
ok("readQuestionRows: a relabelled question keeps its key, new rows get unique keys, removals and blanks are skipped, a bad row is named");

const row = { key: "espresso-machine", label: "Espresso machine", noun: null, types: ["Semi-automatic"], brands: ["Gaggia"], accessories: ["Power cord", "Portafilter"], defaultChecked: ["Power cord", "Not listed"], checklist: ["Descaled"], intakeFields: [{ key: "boiler", label: "Boiler type", type: "select", options: ["Single", "Dual"], on: "machine" }, { key: "bad key!", label: "x", type: "text", on: "machine" }] };
const sk = shopKind(row);
assert.ok(sk.equipment === "APPLIANCE" && sk.module === "appliance" && !sk.builtIn);
assert.equal(sk.noun, "espresso machine");
assert.deepEqual(sk.types, ["Semi-automatic"]);
assert.deepEqual(sk.defaultChecked, ["Power cord"], "only accessories it lists");
assert.deepEqual(sk.readings, []);
assert.deepEqual(sk.serviceMenu, []);
assert.deepEqual(
  sk.intakeFields.map((f) => f.key),
  ["boiler"],
  "a bad key is dropped",
);
assert.match(sk.links("Gaggia", "Classic")[0].url, /^https:\/\//);
ok("shopKind(row) uses only its own lists, has no readings or menu, and generic links");

// The four built-in appliance kinds (11.1).
assert.deepEqual(
  APPLIANCE_KINDS.map((k) => k.key),
  ["stand-mixer", "3d-printer", "resin-printer", "other"],
);
for (const k of APPLIANCE_KINDS) {
  assert.equal(k.equipment, "APPLIANCE");
  assert.equal(k.module, "appliance");
  assert.ok(k.builtIn && !k.panels.tension && !k.panels.timing);
  for (const f of k.intakeFields) assert.match(f.key, /^[a-z0-9-]{1,40}$/, `${k.key} field ${f.key}`);
  assert.equal(new Set(k.readings.map((r) => r.key)).size, k.readings.length, `${k.key} reading keys unique`);
  for (const s of k.serviceMenu) assert.ok(s.name.length <= 80 && s.priceCents === undefined, `${k.key} menu ${s.name}`);
  assert.ok(k.defaultChecked.every((a) => k.accessories.includes(a)), `${k.key} ticks list accessories`);
}
assert.ok(STAND_MIXER_KIND.types.includes("Tilt-head") && STAND_MIXER_KIND.types.includes("Bowl-lift"));
assert.ok(STAND_MIXER_KIND.intakeFields.some((f) => f.key === "bowl" && f.label === "Bowl size" && f.on === "machine"));
assert.ok(STAND_MIXER_KIND.intakeFields.some((f) => f.key === "grease" && f.type === "checkbox" && f.on === "ticket"));
assert.ok(STAND_MIXER_KIND.readings.some((r) => r.key === "dime" && r.label === "Dime test (planetary mixers)" && r.type === "passfail" && r.foundLeft));
assert.equal(STAND_MIXER_KIND.checklist.length, 10);
assert.equal(STAND_MIXER_KIND.serviceMenu.length, 7);
assert.deepEqual(STAND_MIXER_KIND.defaultChecked, ["Bowl"]);
assert.ok(PRINTER_KIND.intakeFields.some((f) => f.key === "filament" && f.on === "ticket") && !PRINTER_KIND.intakeFields.some((f) => f.key === "resin"));
assert.ok(PRINTER_KIND.intakeFields.some((f) => f.key === "nozzle" && f.options?.includes("0.4")));
assert.ok(PRINTER_KIND.readings.some((r) => r.key === "firmware" && r.type === "text" && r.foundLeft));
assert.equal(PRINTER_KIND.serviceMenu.length, 9);
assert.ok(RESIN_PRINTER_KIND.intakeFields.some((f) => f.key === "resin" && f.on === "ticket"));
assert.equal(RESIN_PRINTER_KIND.checklist[0], "FEP / release film checked or replaced");
assert.equal(RESIN_PRINTER_KIND.readings.length, 3);
const other = APPLIANCE_KINDS[3];
assert.ok(other.types.includes("Espresso machine") && other.brands.length === 0 && other.intakeFields.length === 0 && other.readings.length === 0 && other.checklist.length === 4);
ok("the four appliance kinds: mixer (bowl size, dime test, 10-line checklist), 3D printer (filament, nozzle, firmware text), resin (resin in use, FEP first), other");

// ---------- database ----------

async function main() {
  const a = await makeCompany(`Check ${RUN} A`);
  const b = await makeCompany(`Check ${RUN} B`);
  try {
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    await grantDevLicense(a.shopId, ["appliance"], { from });
    await grantDevLicense(b.shopId, ["appliance"], { from });
    const espresso = { label: "Espresso machine", noun: "espresso machine", types: "Semi-automatic\nSuper-automatic", brands: "Gaggia\nBreville", accessories: "* Power cord\nPortafilter", checklist: "Descaled\nGroup gasket checked" };
    const key = await saveEquipmentKindFor(a.user, null, form({ ...espresso, "q.key": ["", "", ""], "q.label": ["Boiler type", "", ""], "q.type": ["select", "text", "text"], "q.options": ["Single, Dual", "", ""], "q.on": ["machine", "machine", "machine"], active: "on" }));
    assert.equal(key, "espresso-machine");
    let rowA = await db.shopEquipmentKind.findUniqueOrThrow({ where: { shopId_key: { shopId: a.shopId, key } } });
    assert.deepEqual(rowA.types, ["Semi-automatic", "Super-automatic"]);
    assert.deepEqual(rowA.accessories, ["Power cord", "Portafilter"]);
    assert.deepEqual(rowA.defaultChecked, ["Power cord"]);
    assert.deepEqual(cleanFieldDefs(rowA.intakeFields), [{ key: "boiler-type", label: "Boiler type", type: "select", options: ["Single", "Dual"], on: "machine" }]);
    const kinds = await shopKinds(a.shopId);
    const mine = kinds.usable.find((k) => k.key === key);
    assert.ok(mine && mine.label === "Espresso machine" && mine.noun === "espresso machine" && mine.intakeFields[0].label === "Boiler type");
    assert.ok(kinds.usable.some((k) => k.key === "stand-mixer"), "the built-in appliance kinds are usable with the module on");
    ok("a company adds Espresso machine with a Boiler type choice question; it is usable at check-in with its lists");

    // Relabelling the question keeps its key (and so the answers); a removed one goes.
    await saveEquipmentKindFor(a.user, key, form({ ...espresso, "q.key": ["boiler-type", "", "", ""], "q.label": ["Boiler", "Pump pressure", "", ""], "q.type": ["select", "number", "text", "text"], "q.options": ["Single, Dual", "", "", ""], "q.on": ["machine", "ticket", "machine", "machine"], active: "on" }));
    rowA = await db.shopEquipmentKind.findUniqueOrThrow({ where: { shopId_key: { shopId: a.shopId, key } } });
    assert.deepEqual(
      cleanFieldDefs(rowA.intakeFields).map((f) => [f.key, f.label, f.on]),
      [
        ["boiler-type", "Boiler", "machine"],
        ["pump-pressure", "Pump pressure", "ticket"],
      ],
    );
    await saveEquipmentKindFor(a.user, key, form({ ...espresso, "q.key": ["boiler-type", "pump-pressure"], "q.label": ["Boiler", "Pump pressure"], "q.type": ["select", "number"], "q.options": ["Single, Dual", ""], "q.on": ["machine", "ticket"], "q.remove": ["pump-pressure"], active: "on" }));
    rowA = await db.shopEquipmentKind.findUniqueOrThrow({ where: { shopId_key: { shopId: a.shopId, key } } });
    assert.deepEqual(
      cleanFieldDefs(rowA.intakeFields).map((f) => f.key),
      ["boiler-type"],
    );
    ok("relabelling 'Boiler type' to 'Boiler' keeps the key boiler-type; Remove drops a question");

    // Refusals: a built-in name, a repeated name, no name.
    await expectError("built-in name", () => saveEquipmentKindFor(a.user, null, form({ label: "Stand mixer" })), /built-in kinds/);
    await expectError("repeated name", () => saveEquipmentKindFor(a.user, null, form({ label: "espresso MACHINE" })), /already have a kind called/);
    await expectError("no name", () => saveEquipmentKindFor(a.user, null, form({ label: "" })), /Give the kind a name/);
    await expectError("bad explicit key", () => saveEquipmentKindFor(a.user, "Not A Key", form({ label: "Grinder" })), /lower-case letters/);
    ok("refused: a built-in kind's name, a name the company already uses, no name, a bad key");

    // Switch off: gone from check-in, still in `all` so records render; back on.
    await setKindActiveFor(a.user, key, false);
    assert.equal(await usableKind(a.shopId, key), null);
    assert.ok((await shopKinds(a.shopId)).all.some((k) => k.key === key));
    await setKindActiveFor(a.user, key, true);
    assert.ok(await usableKind(a.shopId, key));
    await expectError("unknown kind", () => setKindActiveFor(a.user, "nope", false), /Kind not found/);
    ok("switched off, the kind leaves check-in but still renders; switched on again");

    // Check-in opens on.
    await saveCheckInKindFor(a.user, form({ checkInKind: "stand-mixer" }));
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).checkInKind, "stand-mixer");
    await saveCheckInKindFor(a.user, form({ checkInKind: key }));
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).checkInKind, key);
    await expectError("not usable", () => saveCheckInKindFor(a.user, form({ checkInKind: "vacuum" })), /Pick one of the kinds you can check in/);
    await expectError("nonsense", () => saveCheckInKindFor(a.user, form({ checkInKind: "zzz" })), /Pick one of the kinds/);
    ok("'Check-in opens on' takes a usable kind (the mixer, the company's own) and refuses one it can't check in");

    // Tenant: B saving A's key makes B's own row; A's row is as it was.
    rowA = await db.shopEquipmentKind.findUniqueOrThrow({ where: { shopId_key: { shopId: a.shopId, key } } });
    const beforeA = JSON.stringify(rowA);
    const kb = await saveEquipmentKindFor(b.user, "espresso-machine", form({ label: "Espresso machine", types: "Lever", "q.key": [""], "q.label": ["Pump"], "q.type": ["text"], "q.options": [""], "q.on": ["machine"] }));
    assert.equal(kb, "espresso-machine");
    const rowB = await db.shopEquipmentKind.findUniqueOrThrow({ where: { shopId_key: { shopId: b.shopId, key: kb } } });
    assert.ok(rowB.shopId === b.shopId && rowB.id !== rowA.id);
    assert.deepEqual(rowB.types, ["Lever"]);
    assert.equal(JSON.stringify(await db.shopEquipmentKind.findUniqueOrThrow({ where: { shopId_key: { shopId: a.shopId, key } } })), beforeA);
    await expectError("B switching A's kind by a key it doesn't have", () => setKindActiveFor(b.user, "no-such-kind", false), /Kind not found/);
    assert.ok(!(await shopKinds(b.shopId)).all.some((k) => k.key === key && k.types.includes("Semi-automatic")), "B sees its own espresso machine, not A's");
    ok("tenant: B saving A's key gets B's own row; A's row is unchanged");
  } finally {
    await removeCompany(a.shopId);
    await removeCompany(b.shopId);
  }
  console.log(`equipment-lines.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
