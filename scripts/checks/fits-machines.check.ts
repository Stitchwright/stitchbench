// Accessories that fit a machine (shop-features-round-2-design.md 2.4, package fits-machines): model lines read ("Brother,
// PE800", "Baby Lock, Altair"), an item's models kept beside their keys, fit groups (made, changed, refused twice,
// removed from the items), what fits one model (own models and groups, in stock), what fits each of a customer's machines,
// what goes with a machine for sale, the online shop's "Fits your machine", and the tenant section.
//   npm run check scripts/checks/fits-machines.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { addFitModelFor, deleteFitGroupFor, fitsForCustomer, fitsForUnits, parseModelLine, parseModelLines, partsFitting, removeFitModelFor, saveFitGroupFor, setFitGroupsFor, shopModels } from "@/lib/fits";
import { catalog, catalogFitModels } from "@/lib/shop/online-shop";
import { receiveUnitsFor } from "@/lib/units/units";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;

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
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function main() {
  // 1. Model lines.
  assert.deepEqual(parseModelLine("Brother, PE800"), { brand: "Brother", model: "PE800" });
  assert.deepEqual(parseModelLine("Brother PE800"), { brand: "Brother", model: "PE800" });
  assert.deepEqual(parseModelLine("Baby Lock, Altair 2"), { brand: "Baby Lock", model: "Altair 2" });
  assert.deepEqual(parseModelLines("Brother, PE800\nbrother, pe800\nBaby Lock, Altair"), { labels: ["Brother PE800", "Baby Lock Altair"], keys: ["PE800", "ALTAIR"] });
  ok("model lines: with or without a comma, a two-word brand with one, each model once");

  const a = await checkShop({ retail: true, repair: true });
  const b = await checkShop({ retail: true });
  try {
    const mk = (n: string, qty: number, o: Record<string, unknown> = {}) => db.part.create({ data: { shopId: a.shopId, partNumber: n, numberKeys: [n.replace(/[^A-Z0-9]/gi, "")], description: `Foot ${n}`, kind: "ACCESSORY", qtyOnHand: qty, priceCents: 1999, ...o } });
    const zigzag = await mk("FOOT-ZZ", 3);
    const walking = await mk("FOOT-WALK", 0);
    const quarter = await mk("FOOT-QTR", 5);
    const cricutBlade = await mk("CRI-BLADE", 4, { kind: "SUPPLY" });

    // 2. An item's models.
    assert.match(await addFitModelFor(user(a), zigzag.id, "Brother", "PE800"), /fits Brother PE800/);
    await addFitModelFor(user(a), zigzag.id, "Baby Lock", "Altair");
    await expectError("twice", () => addFitModelFor(user(a), zigzag.id, "brother", "pe800"), /already fits/);
    await expectError("no model", () => addFitModelFor(user(a), zigzag.id, "Brother", "  "), /model/);
    let z = await db.part.findUniqueOrThrow({ where: { id: zigzag.id } });
    assert.deepEqual([z.fitsModels, z.fitsKeys], [["Brother PE800", "Baby Lock Altair"], ["PE800", "ALTAIR"]], "labels and keys side by side");
    await removeFitModelFor(user(a), zigzag.id, "Brother PE800");
    z = await db.part.findUniqueOrThrow({ where: { id: zigzag.id } });
    assert.deepEqual([z.fitsModels, z.fitsKeys], [["Baby Lock Altair"], ["ALTAIR"]]);
    await addFitModelFor(user(a), zigzag.id, "Brother", "PE800");
    await addFitModelFor(user(a), walking.id, "Brother", "PE-800");
    ok("an item's models: added, refused twice or blank, taken off; labels and keys stay side by side");

    // 3. Fit groups.
    assert.match(await saveFitGroupFor(user(a), null, fd({ name: "Brother 7 mm low shank", models: "Brother, PE800\nBrother, SE600" })), /2 models/);
    await expectError("same name", () => saveFitGroupFor(user(a), null, fd({ name: "brother 7 MM low shank", models: "Brother, CS6000i" })), /already a group/);
    await expectError("no models", () => saveFitGroupFor(user(a), null, fd({ name: "Empty", models: " " })), /at least one model/);
    const g = await db.fitGroup.findFirstOrThrow({ where: { shopId: a.shopId } });
    await setFitGroupsFor(user(a), quarter.id, [g.id, "cbogus0000000000000000000"]);
    assert.deepEqual((await db.part.findUniqueOrThrow({ where: { id: quarter.id } })).fitGroupIds, [g.id], "only the shop's own groups kept");
    const cricut = await saveFitGroupFor(user(a), null, fd({ name: "Cricut Maker 3", models: "Cricut, Maker 3" }));
    void cricut;
    const cg = await db.fitGroup.findFirstOrThrow({ where: { shopId: a.shopId, name: "Cricut Maker 3" } });
    await setFitGroupsFor(user(a), cricutBlade.id, [cg.id]);
    ok("fit groups: made with their models, the same name refused, an empty one refused, ticked on items (only the shop's own)");

    // 4. What fits.
    const nums = async (model: string, inStock = false) => (await partsFitting(a.shopId, model, { inStock })).map((p) => p.partNumber).sort();
    assert.deepEqual(await nums("PE800"), ["FOOT-QTR", "FOOT-WALK", "FOOT-ZZ"], "own models (PE-800 is PE800) and the group");
    assert.deepEqual(await nums("pe 800", true), ["FOOT-QTR", "FOOT-ZZ"], "in stock only");
    assert.deepEqual(await nums("SE600"), ["FOOT-QTR"], "through the group alone");
    assert.deepEqual(await nums("Maker 3"), ["CRI-BLADE"]);
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Quilter" } });
    await db.machine.create({ data: { shopId: a.shopId, customerId: jane.id, brand: "Brother", model: "PE800", modelKey: "PE800" } });
    await db.machine.create({ data: { shopId: a.shopId, customerId: jane.id, brand: "Brother", model: "PE-800", modelKey: "PE800" } });
    await db.machine.create({ data: { shopId: a.shopId, customerId: jane.id, brand: "Singer", model: "Featherweight 221", modelKey: "FEATHERWEIGHT221" } });
    const jf = await fitsForCustomer(a.shopId, jane.id);
    assert.deepEqual(jf.map((f) => [f.label, f.items.map((i) => i.partNumber).sort()]), [["Brother PE-800", ["FOOT-QTR", "FOOT-ZZ"]]], "each model once; a machine with nothing on the shelf left out");
    assert.ok((await shopModels(a.shopId)).some((m) => m.model === "Featherweight 221"), "the shop's models for the pickers");
    const [unit] = await receiveUnitsFor(user(a), fd({ kind: "sewing", brand: "Brother", model: "SE600", condition: "NEW", priceCents: "499", serials: "SE-1" }));
    const gw = await fitsForUnits(a.shopId, [unit]);
    assert.deepEqual(gw.map((f) => [f.label, f.items.map((i) => i.partNumber)]), [["Brother SE600", ["FOOT-QTR"]]], "goes with the machine being sold");
    ok("what fits: own models and groups, any spacing of the model, in stock; each of her machines once; what goes with a machine for sale");

    // 5. The online shop.
    await db.part.updateMany({ where: { id: { in: [zigzag.id, quarter.id, walking.id] } }, data: { online: true } });
    const picks = await catalogFitModels(a.shopId);
    assert.deepEqual(picks.map((p) => p.label), ["Baby Lock Altair", "Brother PE800", "Brother SE600"]);
    assert.deepEqual((await catalog(a.shopId, { fits: "PE800" })).map((i) => i.partNumber).sort(), ["FOOT-QTR", "FOOT-WALK", "FOOT-ZZ"]);
    assert.deepEqual((await catalog(a.shopId, { fits: "ALTAIR" })).map((i) => i.partNumber), ["FOOT-ZZ"]);
    ok("online shop: the machines the listed items fit (group models too), and the list filtered by one");

    // 6. Removing a group; tenant.
    await deleteFitGroupFor(user(a), g.id);
    assert.deepEqual((await db.part.findUniqueOrThrow({ where: { id: quarter.id } })).fitGroupIds, [], "the group comes off its items");
    assert.deepEqual(await nums("SE600"), []);
    await expectNotFound("B adds to A's item", () => addFitModelFor(user(b), zigzag.id, "Brother", "PE800"));
    await expectNotFound("B changes A's group", () => saveFitGroupFor(user(b), cg.id, fd({ name: "Mine", models: "Cricut, Joy" })));
    await expectNotFound("B removes A's group", () => deleteFitGroupFor(user(b), cg.id));
    assert.deepEqual(await partsFitting(b.shopId, "PE800"), [], "B finds none of A's items");
    assert.deepEqual(await fitsForCustomer(b.shopId, jane.id), [], "B can't read A's customer");
    assert.deepEqual(await fitsForUnits(b.shopId, [unit]), [], "B can't read A's machine for sale");
    ok("removing a group takes it off its items; B can't change A's items or groups, nor read A's fits");
  } finally {
    await cleanup();
  }
  console.log(`fits-machines.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
