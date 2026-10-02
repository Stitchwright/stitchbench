// The bag / belt / filter finder (modules-design.md 10.b, package vac-finder): seeded cross-reference rows, a company's
// parts, suppliesFor by model (exact, close match, the sewing part left out), by type, brand-aware stock matches, the
// number "1" never an item, the local Fits fallback, numberOwner per brand, the cap at 60 in rank order, and the
// tenant section (company B never sees A's parts; A's customer isn't B's).
//   npm run check scripts/checks/vac-finder.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { modelKey } from "@/lib/format";
import { numberKey, partKeys, type XFit, type XNumber } from "@/lib/parts";
import { customerVacuumsFor, FINDER_CAP, guessCategory, partIsSupply, suppliesFor, VAC_SEARCH_SITES } from "@/lib/vac/finder";
import { numberOwner } from "@/lib/xref-rules";
import { assertUnchanged, expectNotFound, makeCompany, removeCompany, RUN, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

type Seed = { id: string; name: string; kind: string; category: string; numbers: XNumber[]; fits: { brand: string; model: string; evidence?: string }[] };

/** An XPart row the way the hub sync writes one (numberKeys and fitKeys derived). */
async function seed(x: Seed) {
  const fits: XFit[] = x.fits.map((f) => ({ brand: f.brand, model: f.model, modelKey: modelKey(f.model), evidence: f.evidence ?? "listed", source: null }));
  const row = {
    name: x.name,
    kind: x.kind,
    category: x.category,
    specs: null,
    notes: null,
    numbers: x.numbers,
    numberKeys: [...new Set(x.numbers.map((n) => numberKey(n.number)).filter(Boolean))],
    fits,
    fitKeys: [...new Set(fits.map((f) => f.modelKey).filter(Boolean))],
    sources: [],
    updatedAt: new Date(),
  };
  await db.xPart.upsert({ where: { id: x.id }, create: { id: x.id, ...row }, update: row });
}

async function part(shopId: string, p: { partNumber: string; description: string; brand: string | null; fits?: string; qty?: number; priceCents?: number; altNumbers?: string[] }) {
  return db.part.create({
    data: {
      shopId,
      partNumber: p.partNumber,
      description: p.description,
      brand: p.brand,
      fits: p.fits ?? null,
      qtyOnHand: p.qty ?? 3,
      priceCents: p.priceCents ?? 1299,
      altNumbers: p.altNumbers ?? [],
      numberKeys: partKeys(p.partNumber, p.altNumbers ?? []),
      kind: "SUPPLY",
    },
  });
}

async function main() {
  const a = await makeCompany(`Check ${RUN} A`);
  const b = await makeCompany(`Check ${RUN} B`);
  const seeded: string[] = [];
  try {
    // 1. The cross-reference rows: a bag for the UH70120PC, a belt for the UH70120, a sewing part on the same key, a Kenmore Type C.
    const rows: Seed[] = [
      { id: "vck-bag-y", name: "Hoover Type Y bag", kind: "SUPPLY", category: "Vacuum bag", numbers: [{ brand: "Hoover", number: "Type Y" }, { brand: "EnviroCare", number: "138SW" }], fits: [{ brand: "Hoover", model: "UH70120PC", evidence: "maker" }] },
      { id: "vck-belt", name: "Hoover WindTunnel belt", kind: "PART", category: "Vacuum belt", numbers: [{ brand: "Hoover", number: "38528033" }], fits: [{ brand: "Hoover", model: "UH70120", evidence: "tested" }] },
      { id: "vck-sewing", name: "Bobbin case (not a vacuum part)", kind: "PART", category: "Bobbin case", numbers: [{ brand: "Hoover", number: "BC-UH70120" }], fits: [{ brand: "Hoover", model: "UH70120" }] },
      { id: "vck-bag-c", name: "Kenmore Type C bag", kind: "SUPPLY", category: "Vacuum bag", numbers: [{ brand: "Kenmore", number: "Type C" }], fits: [{ brand: "Kenmore", model: "BC4027" }] },
    ];
    for (const r of rows) {
      await seed(r);
      seeded.push(r.id);
    }
    ok("four cross-reference rows seeded (bag, belt, a sewing part on the same model, a Kenmore Type C)");

    // 2. Company A's parts.
    const p138 = await part(a.shopId, { partNumber: "138SW", description: "EnviroCare bags for Hoover Type Y (3)", brand: "EnviroCare" });
    const pElux = await part(a.shopId, { partNumber: "Type C", description: "Electrolux Type C bags", brand: "Electrolux" });
    const pOne = await part(a.shopId, { partNumber: "1", description: "Odd part", brand: null });
    const pLocal = await part(a.shopId, { partNumber: "LOCAL-BAG", description: "Shop-brand paper bag (5 pack)", brand: null, fits: "Hoover, UH70120" });
    ok("company A has EnviroCare 138SW, Electrolux Type C, a brandless part numbered 1, and a local bag whose Fits say Hoover, UH70120");

    // 3a. By model: the belt exactly, the bag as a close match, the sewing part absent.
    const r1 = await suppliesFor(a.shopId, { brand: "Hoover", model: "UH70120" });
    const belt = r1.supplies.find((s) => s.xpartId === "vck-belt");
    assert.ok(belt, "the belt is found");
    assert.equal(belt.close, null);
    assert.equal(belt.evidence, "tested");
    assert.equal(belt.category, "Vacuum belt");
    assert.ok(!r1.supplies.some((s) => s.xpartId === "vck-sewing"), "the sewing part is left out");
    assert.ok(!r1.supplies.some((s) => s.xpartId === "vck-bag-c"), "the Kenmore bag is not for a Hoover");
    ok("by model: the belt (tested) is listed and the bobbin case on the same model key is not");

    // The close match only runs when the exact search finds nothing: ask for the bag's model alone to see it exact, and a
    // prefix of it to see "close".
    const rExact = await suppliesFor(a.shopId, { brand: "Hoover", model: "UH70120PC" });
    const bagExact = rExact.supplies.find((s) => s.xpartId === "vck-bag-y");
    assert.ok(bagExact && bagExact.close === null && bagExact.evidence === "maker");
    const rClose = await suppliesFor(a.shopId, { brand: "Hoover", model: "UH7012" });
    const bagClose = rClose.supplies.find((s) => s.xpartId === "vck-bag-y");
    assert.ok(bagClose, "the prefix fallback finds the bag");
    assert.equal(bagClose.close, "UH70120PC");
    assert.ok(!rClose.supplies.some((s) => s.xpartId === "vck-sewing"), "the fallback keeps to the supply categories");
    assert.ok(rClose.supplies.some((s) => s.xpartId === "vck-belt"), "the belt (UH70120) is a close match of UH7012 too");
    // 3b. The bag's items hold the 138SW part.
    assert.deepEqual(
      bagExact.items.map((i) => i.id),
      [p138.id],
    );
    assert.equal(bagExact.items[0].priceCents, 1299);
    ok("UH70120PC finds the bag exactly (maker); UH7012 finds it as 'Close match: UH70120PC'; its items hold the 138SW part");

    // 3c. By type.
    const r2 = await suppliesFor(a.shopId, { text: "Type Y" });
    assert.ok(r2.supplies.some((s) => s.xpartId === "vck-bag-y"), "Type Y finds the bag");
    assert.ok(!r2.supplies.some((s) => s.xpartId === "vck-bag-c"));
    const r2b = await suppliesFor(a.shopId, { text: "138sw" });
    assert.ok(r2b.supplies.some((s) => s.xpartId === "vck-bag-y"), "an aftermarket number finds it too");
    const r2c = await suppliesFor(a.shopId, { text: "WindTunnel" });
    assert.ok(r2c.supplies.some((s) => s.xpartId === "vck-belt"), "a word in the name finds the belt");
    ok("by type or number: 'Type Y', '138sw' and 'WindTunnel' each find their entry");

    // 3d. The Kenmore Type C has no items: the Electrolux part doesn't match it.
    const r3 = await suppliesFor(a.shopId, { text: "Type C" });
    const kc = r3.supplies.find((s) => s.xpartId === "vck-bag-c");
    assert.ok(kc);
    assert.deepEqual(kc.items, []);
    assert.equal(partIsSupply({ brand: "Electrolux", numberKeys: pElux.numberKeys }, kc.numbers), false);
    assert.equal(partIsSupply({ brand: "Kenmore", numberKeys: ["TYPEC"] }, kc.numbers), true);
    assert.equal(partIsSupply({ brand: null, numberKeys: ["TYPEC"] }, kc.numbers), false, "a brandless 'Type C' (5 characters, no digit) doesn't match");
    assert.equal(partIsSupply({ brand: "Generic", numberKeys: ["138SW"] }, [{ brand: "EnviroCare", number: "138SW" }]), true, "a Generic part with a 5+ character number with a digit does");
    ok("brand-aware stock: Electrolux Type C is never offered as Kenmore Type C; Generic 138SW is accepted");

    // 3e. The part numbered "1" is never an item, even after "Generic, 1" goes on an entry.
    await seed({ ...rows[1], numbers: [...rows[1].numbers, { brand: "Generic", number: "1" }] });
    const r4 = await suppliesFor(a.shopId, { brand: "Hoover", model: "UH70120" });
    const belt2 = r4.supplies.find((s) => s.xpartId === "vck-belt");
    assert.ok(belt2);
    assert.ok(!belt2.items.some((i) => i.id === pOne.id), "the part numbered 1 is not an item");
    assert.equal(partIsSupply({ brand: null, numberKeys: ["1"] }, belt2.numbers), false);
    ok("a number '1' on an entry matches nothing");

    // 3f. The local fallback: A's bag whose Fits say "Hoover, UH70120".
    const local = r4.supplies.find((s) => s.source === "local");
    assert.ok(local, "the local part is listed");
    assert.equal(local.xpartId, null);
    assert.equal(local.category, "Vacuum bag");
    assert.deepEqual(
      local.items.map((i) => i.id),
      [pLocal.id],
    );
    assert.equal(guessCategory("Hoover belt, 2 pack"), "Vacuum belt");
    assert.equal(guessCategory("HEPA filter"), "Vacuum filter");
    assert.equal(guessCategory("Brush roll"), null);
    const rNoBrand = await suppliesFor(a.shopId, { text: "UH70120" });
    assert.ok(!rNoBrand.supplies.some((s) => s.source === "local"), "without a brand there is no model search and no local fallback");
    ok("the local fallback lists the shop's own bag whose Fits name the model, guessed as a bag, with the part as its item");

    // Sort: bags before belts, stocked before not, then name.
    const order = r4.supplies.map((s) => s.category ?? "other");
    const firstBelt = order.indexOf("Vacuum belt");
    assert.ok(firstBelt > 0 && order.slice(0, firstBelt).every((c) => c === "Vacuum bag"), `bags come first: ${order.join(", ")}`);
    ok("results are sorted by category (bags, belts, filters, other)");

    // 3g. numberOwner is brand-aware: "Type Y" can exist under Hoover and under Kenmore.
    assert.equal((await numberOwner([{ brand: "Hoover", number: "Type Y" }]))?.id, "vck-bag-y");
    assert.equal(await numberOwner([{ brand: "Kenmore", number: "Type Y" }]), null);
    assert.equal(await numberOwner([{ brand: "EnviroCare", number: "138SW" }], "vck-bag-y"), null, "the entry itself is excepted");
    assert.equal(await numberOwner([{ brand: "Hoover", number: "1" }]), null, "a one-character number never clashes");
    ok("numberOwner matches (brand, number) pairs: Type Y under Kenmore is free");

    // 3h. 70 matching entries: capped at 60 in rank order.
    for (let i = 0; i < 70; i++) {
      const id = `vck-cap-${String(i).padStart(2, "0")}`;
      await seed({ id, name: `Cap bag ${String(i).padStart(2, "0")}`, kind: "SUPPLY", category: "Vacuum bag", numbers: [{ brand: "CapBrand", number: `CAP${1000 + i}` }], fits: [{ brand: "CapBrand", model: "VCKCAP1" }] });
      seeded.push(id);
    }
    const r5 = await suppliesFor(a.shopId, { brand: "CapBrand", model: "VCKCAP1" });
    assert.equal(r5.supplies.length, FINDER_CAP);
    assert.equal(r5.truncated, true);
    assert.equal(r5.supplies[0].name, "Cap bag 00");
    assert.equal(r5.supplies[59].name, "Cap bag 59");
    // A stocked one ranks ahead of the unstocked, whatever its name.
    await part(a.shopId, { partNumber: "CAP1069", description: "Cap bag 69 in stock", brand: "CapBrand" });
    const r6 = await suppliesFor(a.shopId, { brand: "CapBrand", model: "VCKCAP1" });
    assert.equal(r6.supplies[0].name, "Cap bag 69");
    assert.equal(r6.supplies[0].items.length, 1);
    assert.equal(r6.supplies.length, FINDER_CAP);
    ok("70 matches are capped at 60 in rank order; a stocked one moves to the front");

    // customerVacuumsFor
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Vac Owner", phone: "555-0100" } });
    const m = await db.machine.create({ data: { shopId: a.shopId, customerId: cust.id, brand: "Hoover", model: "UH70120", modelKey: modelKey("UH70120"), equipment: "VACUUM", kind: "vacuum", details: { bagged: "Bagged", bagType: "Type Y" } } });
    await db.machine.create({ data: { shopId: a.shopId, customerId: cust.id, brand: "Janome", model: "HD3000", modelKey: modelKey("HD3000") } });
    const vacs = await customerVacuumsFor(a.shopId, cust.id);
    assert.deepEqual(vacs, [{ id: m.id, brand: "Hoover", model: "UH70120", bagType: "Type Y" }]);
    assert.equal(VAC_SEARCH_SITES.length, 2);
    assert.ok(VAC_SEARCH_SITES.every((s) => /^https:\/\/www\.(ebay|google)\.com\//.test(s.url("Type Y")) && /vacuum/.test(decodeURIComponent(s.url("Type Y")))));
    ok("customerVacuumsFor lists the customer's vacuums only, with the bag type; the search sites are eBay and Google '... vacuum'");

    // 4. Tenant: B never sees A's parts as items; A's customer isn't B's.
    const before = await snapshot(a.shopId, ["Part", "Machine", "Customer"]);
    const rb = await suppliesFor(b.shopId, { brand: "Hoover", model: "UH70120PC", text: "Type Y" });
    assert.ok(rb.supplies.some((s) => s.xpartId === "vck-bag-y"), "the community entry is visible to B");
    assert.ok(rb.supplies.every((s) => s.items.length === 0 && s.source === "hub"), "none of A's parts show as B's items or local results");
    await expectNotFound("customerVacuumsFor with A's customer", () => customerVacuumsFor(b.shopId, cust.id));
    assertUnchanged("tenant", before, await snapshot(a.shopId, ["Part", "Machine", "Customer"]));
    ok("tenant: company B sees the community entries but none of A's stock, and A's customer is 'not found'");
  } finally {
    await db.xPart.deleteMany({ where: { id: { in: seeded } } });
    await removeCompany(a.shopId);
    await removeCompany(b.shopId);
  }
  console.log(`vac-finder.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
