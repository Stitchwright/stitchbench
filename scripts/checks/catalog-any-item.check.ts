// Distributor lists for any item (shop-features-round-2-design.md 2.3, package catalog-any-item): a list's type column in
// words ("Thread", "3D filament", "HTV"), the supplier's default type for rows that don't say, the new columns (color
// number and name, weight, fibre, spool size, filament diameter) read and suggested from headings, new thread and
// filament made with their details and no stock, updates to costs and details on items that are there (stock never
// touched), the default type saved on the supplier, the refusals (fabric against a notion, a notion against fabric,
// consigned stock), the "Suppliers' lists" supplier made by name, and the tenant section.
//   npm run check scripts/checks/catalog-any-item.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { applyCatalogFor, previewCatalogFor, sheetViewFor } from "@/lib/connectors/catalog";
import { readCatalogRows, suggestMap } from "@/lib/connectors/layout";
import { ensureSupplierFor } from "@/lib/fabric-orders";
import { detailsLine, kindFromWords, specsOf } from "@/lib/item-details";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const bytes = (s: string) => new TextEncoder().encode(s);

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

async function main() {
  // 1. Types in words, and the new columns.
  assert.deepEqual(
    ["Thread", "embroidery thread", "Notions", "3D Filament", "PLA", "HTV", "Cutting mats", "Laser plywood", "Dies", "Quilting cotton", "Patterns & books", "SUPPLY:resin", "Robots"].map(kindFromWords),
    ["THREAD", "THREAD", "NOTION", "SUPPLY:filament", "SUPPLY:filament", "SUPPLY:vinyl", "SUPPLY:mat", "SUPPLY:laser-material", "ACCESSORY:die", "FABRIC", "PATTERN", "SUPPLY:resin", null],
  );
  const headers = ["SKU", "Color #", "Color Name", "Description", "Weight", "Fiber", "Spool Size", "Type", "Cost", "MSRP"];
  assert.deepEqual(suggestMap(headers), {
    itemNumber: "SKU",
    colorNumber: "Color #",
    colorName: "Color Name",
    description: "Description",
    kind: "Type",
    costPerYard: "Cost",
    pricePerYard: "MSRP",
    material: "Fiber",
    weight: "Weight",
    putUp: "Spool Size",
  });
  const sheet = [
    headers.join(","),
    "ISA-0015,0015,White,Isacord 0015 White,40,polyester,1000 m spool,Thread,3.10,6.99",
    "ISA-3644,3644,Navy,,40,Polyester,5000 m cone,Thread,12.40,24.99",
    "GING-8,,,Gingher 8 in shears,,,,Notions,18.00,34.99",
    "PLA-BLK,,Black,Bambu PLA black,,PLA,,3D filament,15.00,24.99",
    "ODD-1,,,Mystery thing,,,,Robots,1.00,2.00",
  ].join("\n");
  const read = readCatalogRows(sheet.split("\n").map((l) => l.split(",")), suggestMap(headers));
  assert.deepEqual([read.rows[0].colorNumber, read.rows[0].weight, read.rows[0].putUp, read.rows[0].kind], ["0015", "40", "1000 m spool", "Thread"]);
  ok("types in words (thread, notions, filament, HTV, mats, laser stock, dies, fabric, patterns); the new columns suggested from headings and read");

  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    // 2. A thread and notions list, through the supplier made by name.
    const supId = await ensureSupplierFor(user(a), "Hab+Dash");
    assert.equal(await ensureSupplierFor(user(a), "hab+dash"), supId, "the same supplier whatever the capitals");
    const view = await sheetViewFor(user(a), supId, "t.csv", bytes(sheet));
    assert.deepEqual([view.defaultKind, view.map.colorNumber], ["FABRIC", "Color #"], "a supplier with no default: fabric, as before");
    const map = view.map;
    const navy = await db.part.create({ data: { shopId: a.shopId, partNumber: "ISA-3644", numberKeys: ["ISA3644"], description: "Isacord navy", kind: "THREAD", qtyOnHand: 4, costCents: 1100 } });
    const shears = await db.part.create({ data: { shopId: a.shopId, partNumber: "GING-8", numberKeys: ["GING8"], description: "Shears", kind: "NOTION", qtyOnHand: 2, costCents: 1600 } });
    const pv = await previewCatalogFor(user(a), supId, "t.csv", bytes(sheet), map, "NOTION");
    assert.deepEqual([pv.create, pv.update, pv.unchanged], [3, 2, 0], "new: 0015, PLA, ODD-1; updated: navy, shears");
    assert.ok(pv.problems.some((p) => /type "Robots" isn't one the program knows/.test(p)));
    const navyChange = pv.changeSample.find((c) => c.itemNumber === "ISA-3644")!;
    assert.ok(navyChange.what.some((w) => /cost \$11\.00 to \$12\.40/.test(w)) && navyChange.what.some((w) => /color number to 3644/.test(w)) && navyChange.what.some((w) => /spool to 5,000 m cone/.test(w)), navyChange.what.join("; "));
    const note = await applyCatalogFor(user(a), supId, "t.csv", bytes(sheet), map, true, "NOTION");
    assert.match(note, /3 new, 2 updated/);
    const isa = await db.part.findFirstOrThrow({ where: { shopId: a.shopId, partNumber: "ISA-0015" } });
    assert.deepEqual([isa.kind, isa.itemType, isa.unit, isa.qtyOnHand, isa.costCents, isa.priceCents, isa.supplier], ["THREAD", "thread", null, 0, 310, 699, "Hab+Dash"]);
    assert.equal(detailsLine(isa), "0015 White · 40 wt polyester · 1,000 m spool");
    const pla = await db.part.findFirstOrThrow({ where: { shopId: a.shopId, partNumber: "PLA-BLK" } });
    assert.deepEqual([pla.kind, pla.itemType, pla.material, pla.colorName], ["SUPPLY", "filament", "PLA", "Black"]);
    const odd = await db.part.findFirstOrThrow({ where: { shopId: a.shopId, partNumber: "ODD-1" } });
    assert.deepEqual([odd.kind, odd.itemType], ["NOTION", null], "an unknown type is read as the list's default");
    const n1 = await db.part.findUniqueOrThrow({ where: { id: navy.id } });
    assert.deepEqual([n1.qtyOnHand, n1.costCents, n1.colorNumber, specsOf(n1.specs).putUp, n1.description], [4, 1240, "3644", "5,000 m cone", "Isacord navy"], "costs and details updated, stock and a blank description left");
    const s1 = await db.part.findUniqueOrThrow({ where: { id: shears.id } });
    assert.deepEqual([s1.costCents, s1.qtyOnHand, s1.itemType], [1800, 2, null]);
    assert.equal((await db.fabricSupplier.findUniqueOrThrow({ where: { id: supId } })).defaultKind, "NOTION", "the list's type is saved with the columns");
    assert.equal((await sheetViewFor(user(a), supId, "t.csv", bytes(sheet))).defaultKind, "NOTION");
    assert.equal(await db.stockMove.count({ where: { shopId: a.shopId } }), 0, "a list is not stock");
    const again = await previewCatalogFor(user(a), supId, "t.csv", bytes(sheet), map);
    assert.deepEqual([again.create, again.update], [0, 0], "a second time changes nothing (the saved type is used)");
    ok("a thread and notions list: new thread and filament with their details and no stock, costs and details updated, an unknown type read as the default, the default saved; again changes nothing");

    // 3. The refusals.
    const fab = await db.part.create({ data: { shopId: a.shopId, partNumber: "FAB-9", numberKeys: ["FAB9"], description: "Batik", kind: "FABRIC", unit: "yd", qtyOnHand: 10 } });
    const link = await db.partnerLink.create({ data: { id: `chkcat${Date.now().toString(36)}`, shopId: a.shopId, side: "retail", partnerName: "Repair Co" } });
    await db.part.create({ data: { shopId: a.shopId, partNumber: "CON-5", numberKeys: ["CON5"], description: "Consigned", kind: "NOTION", qtyOnHand: 1, consignLinkId: link.id, consignItemKey: "k" } });
    const clash = ["SKU,Description,Cost,Type", "FAB-9,Batik again,4.00,Notions", "CON-5,Consigned,1.00,Notions", "GING-8,Shears,19.00,Fabric"].join("\n");
    const cm = { itemNumber: "SKU", description: "Description", costPerYard: "Cost", kind: "Type" };
    const cp = await previewCatalogFor(user(a), supId, "c.csv", bytes(clash), cm);
    assert.deepEqual([cp.create, cp.update], [0, 0]);
    assert.ok(cp.problems.some((p) => /FAB-9 is fabric by the yard in inventory/.test(p)));
    assert.ok(cp.problems.some((p) => /CON-5 is a partner's consigned stock/.test(p)));
    assert.ok(cp.problems.some((p) => /GING-8 is already in inventory as something other than fabric/.test(p)));
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: fab.id } })).description, "Batik");
    ok("refused by name: a notion row against fabric by the yard, a fabric row against a notion, a partner's consigned stock");

    // 4. Tenant.
    await expectNotFound("B previews on A's supplier", () => previewCatalogFor(user(b), supId, "t.csv", bytes(sheet), map));
    await expectNotFound("B applies on A's supplier", () => applyCatalogFor(user(b), supId, "t.csv", bytes(sheet), map, true));
    const bSup = await ensureSupplierFor(user(b), "Hab+Dash");
    assert.notEqual(bSup, supId, "the same name is B's own supplier");
    const bp = await previewCatalogFor(user(b), bSup, "t.csv", bytes(sheet), map, "NOTION");
    assert.deepEqual([bp.create, bp.update], [5, 0], "B's import sees none of A's items");
    await expectError("an empty name", () => ensureSupplierFor(user(b), "  "), /supplier's name/);
    ok("tenant: B can't preview or apply on A's supplier; the same name is B's own; B's import sees none of A's items");
  } finally {
    await cleanup();
  }
  console.log(`catalog-any-item.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
