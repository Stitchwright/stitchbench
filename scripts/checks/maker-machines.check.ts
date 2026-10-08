// Maker machines for sale (shop-features-round-2-design.md 6.1, package maker-machines): craft cutters, fabric die
// cutters and laser cutters as kinds, they and the 3D and resin printers sold with no module (repair stays the Small
// Appliance Repair module's), a die cutter without a serial, a sale and a trade-in with no module, the register's search
// and lists, starter bundles (saved, refused, offered for a machine on the sale), machine models from a list read as
// those kinds, and the tenant section.
//   npm run check scripts/checks/maker-machines.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { BUILT_IN_KINDS, SELL_FREE_KEYS } from "@/lib/equipment";
import { shopKinds } from "@/lib/equipment/shop";
import { receiveUnitsFor, unitsForSaleFor } from "@/lib/units/units";
import { registerUnitHits } from "@/lib/units/sale-units";
import { completeSaleAs } from "@/lib/register-sale";
import { bundlesForUnits, deleteBundleFor, listBundles, saveBundleFor } from "@/lib/starter-bundles";
import { machineKindFromWords } from "@/lib/item-details";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });

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
  // 1. The kinds.
  assert.deepEqual(SELL_FREE_KEYS.sort(), ["3d-printer", "craft-cutter", "die-cutter", "laser-cutter", "resin-printer"]);
  for (const k of ["craft-cutter", "die-cutter", "laser-cutter"]) assert.equal(BUILT_IN_KINDS.find((x) => x.key === k)?.module, "appliance", `${k}: repair is the appliance module's`);
  assert.equal(BUILT_IN_KINDS.find((x) => x.key === "die-cutter")?.serialOptional, true);
  assert.deepEqual(["Cricut Maker 3 cutting machine", "Glowforge laser", "AccuQuilt GO! die cutter", "Bambu X1C 3D printer", "Elegoo resin printer", "Janome embroidery machine", "Shark upright vacuum"].map(machineKindFromWords), ["craft-cutter", "laser-cutter", "die-cutter", "3d-printer", "resin-printer", "sewing", "vacuum"]);
  ok("kinds: craft cutters, die cutters and lasers built in (repair in the appliance module), printers and cutters sell free, a die cutter's serial optional; list words read as these kinds");

  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    // 2. A shop with no modules sells them.
    const kinds = await shopKinds(a.shopId);
    assert.deepEqual(kinds.usable.map((k) => k.key), ["sewing"], "no module: repairs of sewing machines only");
    assert.deepEqual(kinds.sellable.map((k) => k.key).sort(), ["3d-printer", "craft-cutter", "die-cutter", "laser-cutter", "resin-printer", "sewing"]);
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const [printer] = await receiveUnitsFor(user(a), fd({ kind: "3d-printer", brand: "Bambu Lab", model: "P1S", condition: "NEW", priceCents: "699", serials: "P1S-0001" }));
    const [accu] = await receiveUnitsFor(user(a), fd({ kind: "die-cutter", brand: "AccuQuilt", model: "GO! Big", condition: "NEW", priceCents: "399" }));
    await receiveUnitsFor(user(a), fd({ kind: "laser-cutter", brand: "xTool", model: "P2", condition: "NEW", priceCents: "3999", serials: "XT-1" }));
    await expectError("a cutter needs its serial", () => receiveUnitsFor(user(a), fd({ kind: "craft-cutter", brand: "Cricut", model: "Maker 3", condition: "NEW", priceCents: "429" })), /serial number/);
    await expectError("a vacuum without Vac Shop", () => receiveUnitsFor(user(a), fd({ kind: "vacuum", brand: "Miele", model: "C3", condition: "NEW", priceCents: "599", serials: "V1" })), /Vac Shop/);
    assert.ok((await db.machine.findFirstOrThrow({ where: { shopId: a.shopId, brand: "AccuQuilt" } })).serial === null, "the die cutter has no serial");
    assert.ok((await unitsForSaleFor(a.shopId, "bambu")).some((u) => u.id === printer));
    assert.deepEqual((await registerUnitHits({ shopId: a.shopId, q: "P1S-0001", mode: "code" })).map((i) => i.stockUnitId), [printer], "the register finds it by serial");
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Maker Mae" } });
    const sale = await completeSaleAs(user(a), {
      customerId: cust.id,
      lines: [
        { description: "", qty: 1, unitPriceCents: 69_900, taxable: true, stockUnitId: printer },
        { description: "", qty: -1, unitPriceCents: 20_000, taxable: false, tradeIn: { kind: "laser-cutter", brand: "Glowforge", model: "Basic", condition: "USED", serial: "GF-9", machineType: null, bagged: null, bagType: null } },
      ],
      tenders: [{ method: "CASH", amountCents: 49_900 }],
    });
    assert.equal((await db.stockUnit.findUniqueOrThrow({ where: { id: printer } })).status, "SOLD");
    assert.ok(await db.stockUnit.findFirst({ where: { shopId: a.shopId, machine: { serial: "GF-9" }, status: "IN_STOCK" } }), "the laser trade-in is in stock");
    void sale;
    void accu;
    ok("no module: printers, die cutters (no serial) and lasers received, found by the register, sold and taken in trade; a cutter still needs a serial; a vacuum still needs Vac Shop");

    // 3. Starter bundles.
    const pla = await db.part.create({ data: { shopId: a.shopId, partNumber: "PLA-BLK", numberKeys: ["PLABLK"], description: "PLA black 1 kg", kind: "SUPPLY", qtyOnHand: 10, priceCents: 2499 } });
    const glue = await db.part.create({ data: { shopId: a.shopId, partNumber: "GLUE-1", numberKeys: ["GLUE1"], description: "Build plate glue", kind: "SUPPLY", qtyOnHand: 4, priceCents: 899 } });
    await expectError("a tech", () => saveBundleFor(tech(a), null, fd({ kind: "3d-printer", name: "Bambu starter", items: "PLA-BLK, 2" })), /owner or admin/);
    await expectError("no such kind", () => saveBundleFor(user(a), null, fd({ kind: "robot", name: "X", items: "PLA-BLK" })), /kind of machine/);
    await expectError("unknown item", () => saveBundleFor(user(a), null, fd({ kind: "3d-printer", name: "X", items: "NOPE, 2" })), /No item numbered NOPE/);
    assert.match(await saveBundleFor(user(a), null, fd({ kind: "3d-printer", name: "Bambu starter", items: "pla-blk, 2\nGLUE-1\nPLA-BLK 1" })), /Added/);
    await expectError("same name", () => saveBundleFor(user(a), null, fd({ kind: "laser-cutter", name: "bambu STARTER", items: "GLUE-1" })), /already a bundle/);
    const [bundle] = await listBundles(a.shopId);
    assert.deepEqual(bundle.lines.map((l) => [l.partNumber, l.qty]), [["PLA-BLK", 3], ["GLUE-1", 1]], "the same item twice adds up");
    const [p2] = await receiveUnitsFor(user(a), fd({ kind: "3d-printer", brand: "Bambu Lab", model: "A1", condition: "NEW", priceCents: "399", serials: "A1-1" }));
    const offered = await bundlesForUnits(a.shopId, [p2, accu]);
    assert.deepEqual(offered.find((u) => u.unitId === p2)!.bundles.map((x) => [x.name, x.items.map((i) => [i.item.id, i.qty])]), [["Bambu starter", [[pla.id, 3], [glue.id, 1]]]]);
    assert.deepEqual(offered.find((u) => u.unitId === accu)!.bundles, [], "none for a die cutter");
    ok("starter bundles: owner or admin, a known kind and items, each name once, the same item adds up; offered for a machine of its kind");

    // 4. Tenant.
    await db.part.create({ data: { shopId: b.shopId, partNumber: "GLUE-1", numberKeys: ["GLUE1"], description: "B glue", qtyOnHand: 1 } });
    await expectNotFound("B changes A's bundle", () => saveBundleFor(user(b), bundle.id, fd({ kind: "3d-printer", name: "Mine", items: "GLUE-1" })));
    await expectNotFound("B removes A's bundle", () => deleteBundleFor(user(b), bundle.id));
    assert.deepEqual(await bundlesForUnits(b.shopId, [p2]), [], "B sees none of A's machines");
    assert.deepEqual(await unitsForSaleFor(b.shopId, "bambu"), []);
    await deleteBundleFor(user(a), bundle.id);
    assert.deepEqual(await listBundles(a.shopId), []);
    ok("tenant: B can't change or remove A's bundles nor see A's machines; A removes its own");
  } finally {
    await cleanup();
  }
  console.log(`maker-machines.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
