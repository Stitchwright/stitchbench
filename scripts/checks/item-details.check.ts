// Item details (shop-features-round-2-design.md 2.1 and 6.2, package item-details): "What is it?" (a kind, or a kind with
// a type of supply), forgiving input for each detail (lists matched in any case, "40" -> "40 wt", "1kg" -> "1 kg"), only
// the chosen type's fields kept, the one-line summary the counter reads, specs cleaned when read, and a round trip
// through the database (the columns and specs JSON, the search on color number, name and material).
//   npm run check scripts/checks/item-details.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { KIND_CHOICES, canonical, detailsFrom, detailsLine, hexOf, kindChoiceOf, normalSpec, parseKindChoice, specsOf, typeOf } from "@/lib/item-details";
import { checkShop, cleanup } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

function expectError(label: string, fn: () => unknown, re: RegExp) {
  try {
    fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

const getter = (o: Record<string, string>) => (k: string) => o[k] ?? null;

async function main() {
  // 1. "What is it?"
  assert.deepEqual(parseKindChoice("SUPPLY:filament"), { kind: "SUPPLY", itemType: "filament" });
  assert.deepEqual(parseKindChoice("THREAD"), { kind: "THREAD", itemType: "thread" });
  assert.deepEqual(parseKindChoice("NOTION"), { kind: "NOTION", itemType: null });
  assert.deepEqual(parseKindChoice(null), { kind: "PART", itemType: null }, "an older form with no kind is a part");
  assert.deepEqual(parseKindChoice("ACCESSORY:die"), { kind: "ACCESSORY", itemType: "die" });
  expectError("a type under the wrong kind", () => parseKindChoice("NOTION:filament"), /Pick what kind/);
  expectError("an unknown kind", () => parseKindChoice("ROBOT"), /Pick what kind/);
  assert.equal(kindChoiceOf({ kind: "SUPPLY", itemType: "vinyl" }), "SUPPLY:vinyl");
  assert.equal(kindChoiceOf({ kind: "THREAD", itemType: null }), "THREAD", "a thread saved before types is still Thread");
  assert.equal(typeOf({ kind: "THREAD", itemType: null }), "thread");
  assert.equal(typeOf({ kind: "SUPPLY", itemType: "bogus" }), null);
  assert.ok(KIND_CHOICES.some((c) => c.value === "SUPPLY:laser-material" && c.craft), "the craft supplies are offered");
  ok("what is it: kinds and types of supply, an older thread is still thread, a mismatched or unknown choice refused in words");

  // 2. Forgiving input.
  assert.equal(canonical(["PLA", "PETG"], "petg"), "PETG");
  assert.equal(canonical(["Heat transfer (iron-on)"], "heat transfer iron on"), "Heat transfer (iron-on)");
  assert.equal(canonical(["PLA"], "  Glow  PLA "), "Glow PLA", "a word of its own stays as typed");
  assert.deepEqual([hexOf("#ABC"), hexOf("1a2b3c"), hexOf(""), hexOf(null)], ["#aabbcc", "#1a2b3c", null, null]);
  expectError("not a color", () => hexOf("navy"), /swatch color/);
  assert.deepEqual(
    [normalSpec("weight", "40"), normalSpec("weight", "50wt"), normalSpec("diameter", "1.75"), normalSpec("spool", "1kg"), normalSpec("spool", "1000"), normalSpec("spool", "250"), normalSpec("volume", "500"), normalSpec("volume", "1 litre"), normalSpec("thickness", "3")],
    ["40 wt", "50 wt", "1.75 mm", "1 kg", "1 kg", "250 g", "500 ml", "1 l", "3 mm"],
  );
  assert.equal(normalSpec("putUp", "1,000 M SPOOL", ["1,000 m spool"]), "1,000 m spool");
  ok("forgiving input: list words in any case, swatch colors in any form, 40 -> 40 wt, 1kg -> 1 kg, 500 -> 500 ml, 3 -> 3 mm");

  // 3. Only the chosen type's fields are kept.
  const thread = detailsFrom("thread", getter({ colorNumber: " 0015 ", colorName: "White", colorHex: "#FFFFFF", material: "polyester", weight: "40", putUp: "5000 m cone", diameter: "1.75" }));
  assert.deepEqual(thread, { colorNumber: "0015", colorName: "White", colorHex: "#ffffff", material: "Polyester", specs: { weight: "40 wt", putUp: "5,000 m cone" } }, "diameter isn't a thread field");
  const blade = detailsFrom("blade", getter({ material: "deep point", colorName: "Red" }));
  assert.deepEqual(blade, { colorNumber: null, colorName: null, colorHex: null, material: "Deep point", specs: {} }, "a blade has no color");
  assert.deepEqual(detailsFrom(null, getter({ colorNumber: "1" })).colorNumber, null, "an item with no type keeps no details");
  expectError("a bad swatch", () => detailsFrom("thread", getter({ colorHex: "zzz" })), /swatch color/);
  ok("only the chosen type's fields are kept; an item with no type keeps none");

  // 4. The one line the counter reads.
  assert.equal(detailsLine({ kind: "THREAD", brand: "Isacord", ...thread }), "Isacord 0015 White · 40 wt polyester · 5,000 m cone");
  assert.equal(
    detailsLine({ kind: "SUPPLY", itemType: "filament", material: "PLA", colorName: "Black", specs: { diameter: "1.75 mm", spool: "1 kg", finish: "Matte" } }),
    "PLA black · 1.75 mm · 1 kg · matte",
  );
  assert.equal(detailsLine({ kind: "SUPPLY", itemType: "laser-material", material: "Birch plywood", specs: { thickness: "3 mm", size: "12 x 20 in" } }), "Birch plywood 3 mm · 12 x 20 in");
  assert.equal(detailsLine({ kind: "NOTION" }), "");
  assert.deepEqual(specsOf({ weight: "40 wt", bogus: "x", size: 12, putUp: "   " }), { weight: "40 wt", size: "12" }, "unknown keys and blanks dropped");
  assert.deepEqual(specsOf("junk"), {});
  ok("the one-line summary: thread, filament and laser material read as the counter says them; specs cleaned when read");

  // 5. The database round trip and the search.
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    const filament = detailsFrom("filament", getter({ material: "pla", colorName: "Black", diameter: "1.75", spool: "1000" }));
    const p = await db.part.create({
      data: { shopId: a.shopId, partNumber: "BAMBU-PLA-BLK", numberKeys: ["BAMBUPLABLK"], description: "Bambu PLA Basic black", kind: "SUPPLY", itemType: "filament", ...filament },
    });
    await db.part.create({ data: { shopId: a.shopId, partNumber: "ISA-0015", numberKeys: ["ISA0015"], description: "Isacord white", kind: "THREAD", brand: "Isacord", ...thread } });
    const back = await db.part.findUniqueOrThrow({ where: { id: p.id } });
    assert.equal(detailsLine(back), "PLA black · 1.75 mm · 1 kg");
    const hits = async (shopId: string, term: string) =>
      (
        await db.part.findMany({
          where: { shopId, OR: [{ colorNumber: { contains: term, mode: "insensitive" } }, { colorName: { contains: term, mode: "insensitive" } }, { material: { contains: term, mode: "insensitive" } }] },
          select: { partNumber: true },
          orderBy: { partNumber: "asc" },
        })
      ).map((x) => x.partNumber);
    assert.deepEqual(await hits(a.shopId, "0015"), ["ISA-0015"]);
    assert.deepEqual(await hits(a.shopId, "black"), ["BAMBU-PLA-BLK"]);
    assert.deepEqual(await hits(a.shopId, "poly"), ["ISA-0015"]);
    assert.deepEqual(await hits(b.shopId, "0015"), [], "B finds none of A's");
    ok("round trip: the columns and specs JSON come back as saved; color number, name and material are searchable; B sees none of A's");
  } finally {
    await cleanup();
  }
  console.log(`item-details.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
