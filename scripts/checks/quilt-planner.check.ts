// The quilt planner (shop-features-round-2-design.md 5.3, package quilt-planner; no AI):
//   1. forgiving yards ("2 1/4", "2-1/4", "2¼", "1/2 yd"), the back of a pattern read line by line (and what it
//      couldn't read), written back the same way
//   2. a plain quilt's yards: blocks across and down, squares per strip, border, binding, backing pieced the cheaper way,
//      each up to the eighth; the numbers' problems in words
//   3. a pattern's yardage saved (replaces, clears), refused on an item that isn't a pattern, or with words it can't
//      read; another company's pattern: not found
//   4. the planner's lists: this company's patterns with yardage and its fabric in stock (none sold out, consigned or
//      another company's); the pull list's ids and quantities for the register and the kit builder
//   npm run -s check scripts/checks/quilt-planner.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { parsePatternNeeds, parseYards, patternNeedsText, plainQuiltPlan, plainQuiltProblem, PLAIN_DEFAULTS, roundUpEighth } from "@/lib/fabric-math";
import { patternNeedsFor, plannerData, pullListItems, savePatternNeedsFor } from "@/lib/quilt";
import { expectUserError, ok, stepCount } from "./assistant-hub";
import { checkShop, cleanup } from "./lib";

async function main() {
  // ===== 1. yards and the back of a pattern =====
  for (const [s, y] of [
    ["2 1/4", 2.25],
    ["2-1/4", 2.25],
    ["2¼", 2.25],
    ["2.25", 2.25],
    ["1/2 yd", 0.5],
    ["3 3/4 yards", 3.75],
    ["1 yd", 1],
    ["7/8", 0.875],
  ] as const)
    assert.equal(parseYards(s), y, s);
  for (const s of ["", "lots", "0", "1/0", "5/4", "2.5 1/2"]) assert.equal(parseYards(s), null, s);
  const back = parsePatternNeeds("Throw: background 2 1/4 yd, focus 1 yd, binding 1/2 yd, backing 3 3/4 yd\nQueen: Background 4 yards; Focus fabric 2\n");
  assert.deepEqual(back.problems, []);
  assert.deepEqual(back.lines, [
    { size: "Throw", role: "background", yards: 2.25 },
    { size: "Throw", role: "focus", yards: 1 },
    { size: "Throw", role: "binding", yards: 0.5 },
    { size: "Throw", role: "backing", yards: 3.75 },
    { size: "Queen", role: "Background", yards: 4 },
    { size: "Queen", role: "Focus fabric", yards: 2 },
  ]);
  assert.equal(patternNeedsText(back.lines), "Throw: background 2 1/4 yd, focus 1 yd, binding 1/2 yd, backing 3 3/4 yd\nQueen: Background 4 yd, Focus fabric 2 yd");
  assert.deepEqual(parsePatternNeeds(patternNeedsText(back.lines)).lines, back.lines, "read back the same");
  assert.deepEqual(parsePatternNeeds("background 1 yd").lines, [{ size: "One size", role: "background", yards: 1 }]);
  assert.deepEqual(parsePatternNeeds("Throw: background lots, focus 1 yd").problems, ['Throw: "background lots"']);
  ok("forgiving yards; the back of a pattern read, its problems named, written back the same");

  // ===== 2. a plain quilt =====
  assert.equal(roundUpEighth(1.0278), 1.125);
  assert.equal(roundUpEighth(1), 1);
  const p = plainQuiltPlan(PLAIN_DEFAULTS);
  assert.deepEqual([p.cols, p.rows, p.blocks, p.finishedWidth, p.finishedLength], [10, 12, 120, 60, 72]);
  // 30 squares each, 6 to a 40" strip of 6 1/2": 5 strips = 32 1/2" = 0.903 yd, + 1/8 = 1.028 -> 1 1/8
  assert.deepEqual(
    p.roles.map((r) => [r.role, r.yards]),
    [
      ["Focus", 1.125],
      ["Fabric 2", 1.125],
      ["Fabric 3", 1.125],
      ["Fabric 4", 1.125],
      ["Binding", 0.625], // 279" of 2 1/2" strips: 7 strips = 17.5" = 0.486 + 1/8
      ["Backing", 3.875], // 68 x 80: two widths of 68" (crosswise) = 136" = 3.78 -> 3 7/8
    ],
  );
  const q = plainQuiltPlan({ widthIn: 90, lengthIn: 108, blockIn: 9, fabrics: 3, backgroundPct: 50, borderIn: 4.5 });
  assert.deepEqual([q.cols, q.rows, q.blocks], [9, 11, 99]);
  assert.deepEqual(q.roles.map((r) => r.role), ["Background", "Focus", "Fabric 2", "Fabric 3", "Border", "Binding", "Backing"]);
  assert.equal(q.roles[0].note, '50 squares cut 9.5"');
  assert.equal(q.roles[1].note, '17 squares cut 9.5"');
  assert.ok(q.roles.every((r) => r.yards > 0 && Number.isInteger(r.yards * 8)), "every part in eighths of a yard");
  assert.equal(plainQuiltProblem(PLAIN_DEFAULTS), null);
  assert.match(plainQuiltProblem({ ...PLAIN_DEFAULTS, blockIn: 0 }) ?? "", /Blocks are 1 to 36/);
  assert.match(plainQuiltProblem({ ...PLAIN_DEFAULTS, widthIn: NaN }) ?? "", /size in inches/);
  assert.match(plainQuiltProblem({ ...PLAIN_DEFAULTS, fabrics: 0 }) ?? "", /1 to 12 fabrics/);
  assert.match(plainQuiltProblem({ ...PLAIN_DEFAULTS, borderIn: 12, widthIn: 26 }) ?? "", /no room/);
  ok("a plain quilt's yards: squares, border, binding and backing in eighths; its problems in words");

  // ===== 3. a pattern's yardage =====
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const pattern = await db.part.create({ data: { shopId: a.shopId, partNumber: "PAT-1", description: "Easy Street", kind: "PATTERN", qtyOnHand: 3, priceCents: 1400 } });
  const notPattern = await db.part.create({ data: { shopId: a.shopId, partNumber: "N-1", description: "Pins", kind: "NOTION", qtyOnHand: 3 } });
  assert.equal(await savePatternNeedsFor(a.user, pattern.id, "Throw: background 2 1/4 yd, focus 1 yd\nQueen: background 4 yd, focus 2 yd"), 4);
  assert.equal(await savePatternNeedsFor(a.user, pattern.id, "Throw: background 2 1/2 yd, focus 1 yd, binding 1/2 yd"), 3, "typed again: replaces");
  assert.deepEqual(await patternNeedsFor(a.shopId, pattern.id), [
    { size: "Throw", role: "background", yards: 2.5 },
    { size: "Throw", role: "focus", yards: 1 },
    { size: "Throw", role: "binding", yards: 0.5 },
  ]);
  await expectUserError("not a pattern", () => savePatternNeedsFor(a.user, notPattern.id, "background 1 yd"), /kind to Pattern/);
  await expectUserError("words it can't read", () => savePatternNeedsFor(a.user, pattern.id, "Throw: background a bit"), /couldn't be read: Throw: "background a bit"/);
  await expectUserError("another company's pattern", () => savePatternNeedsFor(b.user, pattern.id, "background 1 yd"), /not found/);
  assert.equal((await patternNeedsFor(a.shopId, pattern.id)).length, 3, "refusals change nothing");
  ok("a pattern's yardage saved and replaced; refused on a non-pattern, unreadable words, another company");

  // ===== 4. the planner's lists =====
  const navy = await db.part.create({ data: { shopId: a.shopId, partNumber: "K-NAVY", description: "Kona Navy", kind: "FABRIC", unit: "yd", qtyOnHand: 8, priceCents: 1200, collection: "Kona Solids", colorTags: ["navy"] } });
  await db.part.create({ data: { shopId: a.shopId, partNumber: "SOLD-OUT", description: "Sold out SOLDOUT", kind: "FABRIC", unit: "yd", qtyOnHand: 0 } });
  await db.part.create({ data: { shopId: a.shopId, partNumber: "CONS", description: "Consigned CONSIGNED", kind: "FABRIC", unit: "yd", qtyOnHand: 5, consignLinkId: "x" } });
  await db.part.create({ data: { shopId: b.shopId, partNumber: "B-1", description: "B-SECRET fabric", kind: "FABRIC", unit: "yd", qtyOnHand: 5 } });
  const bPattern = await db.part.create({ data: { shopId: b.shopId, partNumber: "B-PAT", description: "B-SECRET pattern", kind: "PATTERN", qtyOnHand: 1 } });
  await savePatternNeedsFor(b.user, bPattern.id, "background 1 yd");
  const data = await plannerData(a.shopId);
  assert.deepEqual(data.patterns.map((x) => [x.name, x.sizes.map((s) => s.size)]), [["Easy Street", ["Throw"]]]);
  assert.deepEqual(data.fabrics.map((f) => f.partNumber), ["K-NAVY"], "in stock, own, not consigned");
  assert.ok(!JSON.stringify(data).includes("B-SECRET"));
  assert.deepEqual(pullListItems(`${navy.id}:2.3,${pattern.id}:1,junk,${navy.id}:9,abc:1`), [
    { id: navy.id, qty: 2.375 },
    { id: pattern.id, qty: 1 },
  ]);
  ok("the planner's lists are this company's; the pull list's quantities in eighths, each item once");

  console.log(`quilt-planner check: ${stepCount()} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await db.$disconnect();
  });
