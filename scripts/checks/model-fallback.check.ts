// Reference data for a variant model falls back to its base model's rows (src/lib/model-info.ts lookupModel), against the
// dev database with throwaway rows keyed by a per-run model name: the exact key is used when it has rows and says nothing
// of a fallback; "<base> deLuxe" falls back to the base's tension, factory settings and test mode and names it; the longest
// known prefix wins; a key under five characters, an unrelated key and another brand's rows never stand in; the base's
// "test mode NN" in a setting still resolves to its test.
//   npm run check scripts/checks/model-fallback.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { libraryLookup, pictureLookup, prefixKeys, settingsLookup, specsLookup } from "@/lib/model-info";
import { modesLookup, withTestLinks } from "@/lib/service-modes";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

const RUN = Date.now().toString(36).toUpperCase();
const BASE = `Fbk${RUN}`; // the base model, e.g. "FbkMD5K2Z3"
const LONGER = `${BASE} Royal`; // a known variant of the base
const BRAND = "Husqvarna Viking";
const ids: string[] = [];
const id = (n: string) => {
  const v = `fbk-${RUN}-${n}`;
  ids.push(v);
  return v;
};
const key = (m: string) => m.toUpperCase().replace(/[^A-Z0-9]/g, "");

const spec = (n: string, brand: string, models: string, upper: number) =>
  db.tensionSpec.create({ data: { id: id(n), category: "Sewing", brand, models, modelKeys: [key(models)], upperMinG: upper, upperMaxG: upper + 10, sourceFile: "fbk.pdf" } });
const setting = (n: string, brand: string, models: string, note: string | null) =>
  db.factorySetting.create({
    data: { id: id(n), category: "Sewing", brand, models, modelKeys: [key(models)], adjustment: "needle_bar_height", label: "Needle bar height", valueMin: 1, valueMax: 2, unit: "mm", notes: note, conditions: note, sourceFile: "fbk.pdf", figureBox: [] },
  });
const mode = (n: string, brand: string, models: string) =>
  db.serviceMode.create({
    data: { id: id(n), brand, models, modelKeys: [key(models)], mode: "Test mode", enterSteps: ["Hold the key"], exitSteps: ["Turn off"], tests: [{ code: "36", purpose: "Feed test" }], sourceFile: "fbk.pdf", figureBox: [] },
  });

async function main() {
  try {
    // The prefixes a key can fall back to.
    assert.deepEqual(prefixKeys("ABCDEFG"), ["ABCDEF", "ABCDE"]);
    assert.deepEqual(prefixKeys("ABCDE"), []);
    assert.deepEqual(prefixKeys("ABCD"), []);
    ok("prefixKeys: longest first, never under five characters, never the key itself");

    await spec("s-base", BRAND, BASE, 60);
    await spec("s-other-brand", "Bernina", `${BASE}`, 99);
    await setting("g-base", BRAND, BASE, "Check in test mode 36");
    await mode("m-base", BRAND, BASE);

    // Exact match: the base itself, nothing reported as a fallback.
    const exact = await specsLookup(BRAND, BASE);
    assert.equal(exact.from, null);
    assert.deepEqual(exact.rows.map((r) => r.id), [id("s-base")]);
    assert.equal((await modesLookup(BRAND, BASE)).from, null);
    assert.equal((await settingsLookup(BRAND, `${BASE.toLowerCase()}`)).from, null);
    ok("exact key: its own rows, no fallback named");

    // The variant falls back to the base, brand-gated.
    const variant = `${BASE.slice(0, 3)}${BASE.slice(3).toLowerCase()} deLuxe`;
    const sp = await specsLookup(BRAND, variant);
    assert.deepEqual(sp.rows.map((r) => r.id), [id("s-base")]);
    assert.equal(sp.from?.key, key(BASE));
    assert.equal(sp.from?.name, BASE);
    ok("variant falls back to the base's tension (Husqvarna Viking row, not Bernina's) and names the base");

    const st = await settingsLookup(BRAND, variant);
    assert.deepEqual(st.rows.map((r) => r.id), [id("g-base")]);
    assert.equal(st.from?.name, BASE);
    const md = await modesLookup(BRAND, variant);
    assert.deepEqual(md.rows.map((r) => r.id), [id("m-base")]);
    assert.equal(md.from?.key, key(BASE));
    ok("variant falls back to the base's factory settings and test mode");

    // "test mode 36" in the fallback setting resolves to test 36 of the fallback mode.
    const linked = withTestLinks(st.rows, md.rows, (l) => `#${l.modeId}-${l.test}`);
    const link = linked[0].testLinks.conditions;
    assert.ok(link, "link present");
    assert.equal(link.modeId, id("m-base"));
    assert.equal(link.test, 0);
    ok("a fallback setting's \"test mode 36\" links to the fallback mode's test 36");

    // The longest known prefix wins over a shorter one.
    await spec("s-longer", BRAND, LONGER, 70);
    const lv = await specsLookup(BRAND, `${LONGER} Plus`);
    assert.deepEqual(lv.rows.map((r) => r.id), [id("s-longer")]);
    assert.equal(lv.from?.key, key(LONGER));
    ok("longest known key wins");

    // Exact rows beat any fallback, even when a base exists.
    const ex2 = await specsLookup(BRAND, LONGER);
    assert.equal(ex2.from, null);
    assert.deepEqual(ex2.rows.map((r) => r.id), [id("s-longer")]);
    ok("an exact match never mixes in the base's rows");

    // Not found: unrelated key, a key too short to be a base, another brand.
    assert.deepEqual((await specsLookup(BRAND, `Zzq${RUN} deLuxe`)).rows, []);
    await spec("s-short", BRAND, "Ab12", 50); // a 4-character key
    assert.deepEqual((await specsLookup(BRAND, "Ab12 Plus")).rows, []);
    assert.deepEqual((await specsLookup("Janome", variant)).rows, []);
    assert.deepEqual((await settingsLookup("Janome", variant)).rows, []);
    assert.deepEqual((await modesLookup("Janome", variant)).rows, []);
    const unrelated = await specsLookup(BRAND, `Q${RUN}`);
    assert.equal(unrelated.from, null);
    ok("unrelated key, short key and another brand's rows don't fall back");

    // Pictures and manuals use the same helper (no rows on either here: the lookups answer empty, not an error).
    assert.equal((await pictureLookup(BRAND, variant)).picture, null);
    assert.deepEqual((await libraryLookup(BRAND, variant)).rows, []);
    ok("picture and library lookups run the fallback without rows");

    console.log(`\n${steps} model-fallback checks passed`);
  } finally {
    await db.tensionSpec.deleteMany({ where: { id: { in: ids } } });
    await db.factorySetting.deleteMany({ where: { id: { in: ids } } });
    await db.serviceMode.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
