// Fabric insight (fabric-smarts-design.md, package F2): the selling rate (steady, lumpy by Croston, a new fabric blended
// toward its peers), FIFO age and sell-through from the receipts, the markdown-versus-fat-quarters numbers, the
// markdown ladder (steps, the floor, the current step, undo the same day), A/B/C cuts, GMROI on a hand-computed example,
// cost at time of sale, and the tenant section.
//   npm run check scripts/checks/fabric-insight.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { todayIn } from "@/lib/time-zone";
import { cutPrices } from "@/lib/fabric-math";
import { insightFor, ladderViewsFor, markDownFor, undoMarkdownFor } from "@/lib/fabric-insight";
import {
  INSIGHT_DEFAULTS,
  abcGrades,
  blendVelocity,
  convertVsMarkdown,
  crostonSba,
  fifoAge,
  gmroi,
  gmroiBand,
  ladderView,
  priceBand,
  priorRate,
  settingsProblem,
  slowStage,
  velocityOf,
  weeksOfSupply,
  yardCostTenThou,
} from "@/lib/fabric-insight-math";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const near = (got: number, want: number, label: string, eps = 1e-9) => assert.ok(Math.abs(got - want) < eps, `${label}: got ${got}, want ${want}`);

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

const TZ = "America/New_York";
const TODAY = todayIn(TZ);
/** Midday in the shop's zone, k days ago (16:00 UTC is 11 or 12 o'clock in New York, so always the same local day). */
const at = (k: number) => new Date(Date.parse(`${TODAY}T16:00:00Z`) - k * 86_400_000);
const S = INSIGHT_DEFAULTS;

async function fabric(shopId: string, number: string, o: { qty: number; price?: number | null; cost?: number | null; brand?: string; supplier?: string; age: number }) {
  return db.part.create({
    data: {
      shopId,
      partNumber: number,
      numberKeys: [number.replace(/[^A-Z0-9]/gi, "").toUpperCase()],
      description: `Batik ${number}`,
      kind: "FABRIC",
      unit: "yd",
      brand: o.brand ?? "Moda",
      supplier: o.supplier ?? "Wholesale Co",
      qtyOnHand: o.qty,
      priceCents: o.price === undefined ? 1400 : o.price,
      costCents: o.cost === undefined ? 700 : o.cost,
      createdAt: at(o.age),
    },
  });
}
const move = (shopId: string, partId: string, qty: number, reason: "RECEIVED" | "SOLD" | "ADJUSTED", ago: number) =>
  db.stockMove.create({ data: { shopId, partId, qty, reason, createdAt: at(ago) } });
let saleNo = 0;
async function sale(shopId: string, partId: string, qty: number, unit: number, cost: number | null, ago: number) {
  saleNo += 1;
  await db.sale.create({
    data: {
      shopId,
      number: saleNo,
      subtotalCents: Math.round(qty * unit),
      taxCents: 0,
      totalCents: Math.round(qty * unit),
      taxRatePct: 0,
      createdAt: at(ago),
      lines: { create: { partId, description: "Fabric", qty, unit: "yd", unitPriceCents: unit, costCents: cost, taxable: true } },
    },
  });
  await move(shopId, partId, -qty, "SOLD", ago);
}

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const c = await checkShop({ retail: true });
  try {
    // 1. Velocity: steady, lumpy (Croston), new item blending, in-stock days only.
    const day = (pairs: [number, number][]) => new Map(pairs);
    // Steady: 3 yd sold on one day of each of the 12 weeks, in stock the whole 84 days: 36 / 84 x 7 = 3.0 a week.
    const steadySold = day(Array.from({ length: 12 }, (_, w) => [3 + 7 * w, 3] as [number, number]));
    const steady = velocityOf({ qNow: 64, net: new Map([...steadySold].map(([k, v]) => [k, -v])), sold: steadySold, existsAgo: 100, weeks: 12 });
    assert.equal(steady.daysInStock, 84);
    near(steady.trailing, 3, "steady trailing");
    assert.equal(steady.lumpy, false);
    near(steady.own, 3, "steady own");
    // Lumpy: 6 yd 70 days ago and 4 yd 20 days ago. Weekly series (oldest first): index 2 sells 6, index 10 sells 4.
    // size = .2 x 4 + .8 x 6 = 5.6, gap = .2 x 8 + .8 x 2 = 3.2, rate = 5.6 / 3.2 x (1 - .1) = 1.575.
    const lumpySold = day([
      [70, 6],
      [20, 4],
    ]);
    const lumpy = velocityOf({ qNow: 30, net: new Map([...lumpySold].map(([k, v]) => [k, -v])), sold: lumpySold, existsAgo: 100, weeks: 12 });
    assert.equal(lumpy.lumpy, true);
    near(lumpy.own, (5.6 / 3.2) * 0.9, "lumpy croston");
    near(lumpy.trailing, (10 / 84) * 7, "lumpy trailing is what a plain average would say");
    near(crostonSba([0, 6, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0]), 1.575, "croston by hand");
    assert.equal(crostonSba([0, 0, 0]), 0);
    // A long silence after the last sale fades the rate instead of holding it.
    assert.ok(crostonSba([0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) < crostonSba([0, 6, 0, 0]));
    // Out of stock for most of the window: only the days in stock count (10 days in stock, 7 yd sold = 7 a week).
    const gone = velocityOf({
      qNow: 0,
      net: new Map([
        [0, -7],
        [10, 14],
      ]), // 14 yd came in 10 days ago, 7 sold today ... balance was 0 before day 10
      sold: day([[0, 7]]),
      existsAgo: 200,
      weeks: 12,
    });
    assert.equal(gone.daysInStock, 11, "days 0..10: stock on hand at the end of day 1 to 10, and a sale today");
    near(gone.trailing, (7 / 11) * 7, "in-stock days only");
    // A fabric that didn't exist yet isn't "in stock" before it was made.
    assert.equal(velocityOf({ qNow: 5, net: new Map(), sold: new Map(), existsAgo: 10, weeks: 12 }).daysInStock, 11);
    // New fabric: weight on its own rate = days in stock / 42, the rest the peers' median.
    const b1 = blendVelocity(7, 11, 42, 2.2875);
    near(b1.weight, 11 / 42, "weight");
    near(b1.rate, (11 / 42) * 7 + (31 / 42) * 2.2875, "blend");
    assert.equal(blendVelocity(5, 60, 42, 100).rate, 5, "fully its own after 42 days");
    const pool = [
      { brand: "Moda", band: "$12 to $14", rate: 3 },
      { brand: "Moda", band: "$12 to $14", rate: 1.575 },
      { brand: "Riley", band: "$8 to $10", rate: 10 },
    ];
    near(priorRate({ brand: "Moda", band: "$8 to $10" }, pool), 2.2875, "same maker");
    near(priorRate({ brand: "Other", band: "$8 to $10" }, pool), 10, "else the price band");
    near(priorRate({ brand: null, band: "$14 and up" }, pool), 3, "else the shop median");
    assert.equal(priorRate({ brand: null, band: "x" }, []), 0);
    assert.equal(weeksOfSupply(64, 3)?.toFixed(2), "21.33");
    assert.equal(weeksOfSupply(5, 0), null);
    assert.equal(priceBand(799), "Under $8");
    assert.equal(priceBand(1000), "$10 to $12");
    assert.equal(priceBand(1400), "$14 and up");
    ok("velocity: steady 3.0 a week, lumpy by Croston (1.575, not the plain 0.83), in-stock days only, new-item blend and priors, weeks of supply, bands");

    // 2. FIFO age and sell-through.
    const f1 = fifoAge(
      [
        { ago: 200, yards: 20 },
        { ago: 30, yards: 10 },
      ],
      18,
    )!;
    near(f1.ageDays, (10 * 30 + 8 * 200) / 18, "weighted age");
    assert.equal(f1.oldestDays, 200);
    near(f1.soldShare, 0.4, "sold share = 1 - 18 / 30");
    const f2 = fifoAge(
      [
        { ago: 200, yards: 20 },
        { ago: 30, yards: 10 },
      ],
      10,
    )!;
    assert.equal(f2.ageDays, 30);
    assert.equal(f2.soldShare, 0);
    assert.equal(fifoAge([{ ago: 10, yards: 5 }], 0), null);
    near(fifoAge([{ ago: 130, yards: 15 }], 12)!.soldShare, 0.2, "one lot");
    // Stages: watch / markdown / clearance by age, only under 60% sold, and never while early.
    const aged = (age: number, sold: number) => ({ ageDays: age, oldestDays: age, soldShare: sold, yards: 5 });
    assert.equal(slowStage(aged(89, 0.1), 200, S), null);
    assert.equal(slowStage(aged(90, 0.1), 200, S), "watch");
    assert.equal(slowStage(aged(120, 0.1), 200, S), "markdown");
    assert.equal(slowStage(aged(180, 0.1), 200, S), "clearance");
    assert.equal(slowStage(aged(150, 0.6), 200, S), null, "60% sold is no longer slow");
    assert.equal(slowStage(aged(150, 0.59), 200, S), "markdown");
    assert.equal(slowStage(aged(150, 0.1), 20, S), null, "early fabric is left alone");
    assert.equal(slowStage(aged(100, 0.36), 200, S, 21.3), null, "an old lot of a steady seller (21 weeks of supply) isn't watched");
    assert.equal(slowStage(aged(100, 0.36), 200, S, 27), "watch");
    assert.equal(slowStage(aged(130, 0.36), 200, S, 21.3), "markdown", "the markdown stage doesn't look at the weeks of supply");
    ok("FIFO age (weighted and oldest), sold share, stages at 90 / 120 / 180 days under 60% sold, early skipped");

    // 3. Markdown or fat quarters. The research example: cost $6.00, price $12.00.
    assert.deepEqual(convertVsMarkdown({ markdownPriceCents: 960, fqPriceCents: 325, yardCostCents: 600, cutCostCents: 50 }), { markdownMargin: 360, fqMargin: 650, better: "fq" });
    assert.equal(convertVsMarkdown({ markdownPriceCents: 960, fqPriceCents: 200, yardCostCents: 600, cutCostCents: 50 }).better, "markdown");
    assert.equal(convertVsMarkdown({ markdownPriceCents: null, fqPriceCents: 200, yardCostCents: 600, cutCostCents: 50 }).better, "fq", "no markdown left: cutting is the only way out");
    // With the F1 cut price: $14.00 a yard, 15% markup -> 403 each; cost $7.00; 4 x 403 - 700 - 50 = 862; markdown 20% = 1120 - 700 = 420.
    const fqPrice = cutPrices("FQ", { priceCents: 1400, costCents: 700, costTenThou: null }).priceCents!;
    assert.equal(fqPrice, 403);
    assert.deepEqual(convertVsMarkdown({ markdownPriceCents: 1120, fqPriceCents: fqPrice, yardCostCents: 700, cutCostCents: 50 }), { markdownMargin: 420, fqMargin: 862, better: "fq" });
    ok("markdown-versus-convert numbers: 3.60 vs 6.50 (research example), 4.20 vs 8.62 with the F1 cut price, ties go to the markdown");

    // 4. The ladder: 20 / 35 / 50 off the regular price, the floor, the current step, a hand-changed price.
    const view = (price: number | null, cost: number | null, rows: Parameters<typeof ladderView>[0]["rows"] = []) => ladderView({ priceCents: price, yardTenThou: cost == null ? null : cost * 100, rows, today: TODAY }, S);
    const l0 = view(1400, 700);
    assert.deepEqual(l0.offer, { step: 1, pct: 20, priceCents: 1120, fromCents: 1400, regularCents: 1400, held: false });
    assert.equal(l0.floorCents, 735);
    const row = (step: number, regular: number, old: number, now: number, d = TODAY) => ({ id: `r${step}`, step, regularCents: regular, oldCents: old, newCents: now, day: d });
    const l1 = view(1120, 700, [row(1, 1400, 1400, 1120)]);
    assert.equal(l1.step, 1);
    assert.deepEqual(l1.offer, { step: 2, pct: 35, priceCents: 910, fromCents: 1120, regularCents: 1400, held: false });
    assert.deepEqual(l1.undo, { id: "r1", backCents: 1400, step: 1 });
    const l2 = view(910, 700, [row(2, 1400, 1120, 910), row(1, 1400, 1400, 1120)]);
    // Step 3: 50% of 1400 = 700, under the floor of 735: held at 735.
    assert.deepEqual(l2.offer, { step: 3, pct: 50, priceCents: 735, fromCents: 910, regularCents: 1400, held: true });
    const l3 = view(735, 700, [row(3, 1400, 910, 735), row(2, 1400, 1120, 910), row(1, 1400, 1400, 1120)]);
    assert.equal(l3.offer, null);
    assert.equal(l3.stopped, "last");
    // A high cost: $14 price, $13 cost: floor 1365; step 1 is held there and then nothing is left.
    const h0 = view(1400, 1300);
    assert.equal(h0.offer?.priceCents, 1365);
    assert.equal(h0.offer?.held, true);
    const h1 = view(1365, 1300, [row(1, 1400, 1400, 1365)]);
    assert.equal(h1.offer, null);
    assert.equal(h1.stopped, "floor");
    // Never up: a price already under the step stays.
    assert.equal(view(1000, 700, [row(1, 1400, 1400, 1000)]).offer?.priceCents, 910);
    assert.equal(view(800, 700, [row(1, 1400, 1400, 1120)]).step, 0, "a price changed by hand starts the ladder again from the price it has");
    assert.equal(view(800, 700, [row(1, 1400, 1400, 1120)]).regularCents, 800);
    assert.equal(view(1120, 700, [row(1, 1400, 1400, 1120, "2000-01-01")]).undo, null, "undo only the day it was made");
    assert.equal(view(null, 700).stopped, "noprice");
    assert.equal(view(1400, null).offer?.priceCents, 1120, "no cost on file: no floor");
    assert.equal(yardCostTenThou({ costCents: 701, costTenThou: 70120 }), 70120);
    assert.equal(yardCostTenThou({ costCents: 800, costTenThou: 70120 }), 80000, "the finer figure only while it agrees with costCents");
    ok("ladder: 20 / 35 / 50 off the regular price, the floor holds step 3 at cost x 1.05, last step and floor stop it, a hand-changed price restarts it, undo only today");

    // 5. A/B/C and GMROI.
    const grade = (m: number[]) => {
      const g = abcGrades(m.map((x, i) => ({ id: String(i), margin: x, rated: true })), 80, 95);
      return m.map((_, i) => g.get(String(i))).join("");
    };
    assert.equal(grade([50, 30, 15, 5]), "AABC", "cum 50, 80, 95, 100");
    assert.equal(grade([5, 15, 30, 50]), "CBAA", "order doesn't matter");
    assert.equal(grade([60, 30, 10]), "ABC");
    assert.equal(grade([100]), "A");
    assert.equal(grade([0, 0]), "CC");
    assert.equal(grade([50, 50, -5]), "ACC", "50% of the margin is A; the next 50% is past 95%; a negative margin is C");
    // Unrated fabrics are left out of the shares: the 400 of the unrated one would not change x (90%, first so A) or y (100%, so C).
    const g2 = abcGrades(
      [
        { id: "x", margin: 90, rated: true },
        { id: "y", margin: 10, rated: true },
        { id: "z", margin: 400, rated: false },
      ],
      80,
      95,
    );
    assert.deepEqual([g2.get("x"), g2.get("y"), g2.get("z")], ["A", "C", "unrated"]);
    // GMROI by hand: a year of 50,000 cents margin on 25,000 cents average stock is 2.0; a 100-day window is scaled to a year.
    near(gmroi({ marginCents: 50_000, avgInventoryCents: 25_000, windowDays: 365 })!, 2, "gmroi year");
    near(gmroi({ marginCents: 3000, avgInventoryCents: 2980, windowDays: 100 })!, (3000 * 3.65) / 2980, "gmroi scaled");
    assert.equal(gmroi({ marginCents: 1, avgInventoryCents: 0, windowDays: 365 }), null);
    assert.equal(gmroiBand(3, S), "good");
    assert.equal(gmroiBand(2.9, S), "ok");
    assert.equal(gmroiBand(1.49, S), "review");
    assert.match(settingsProblem({ ...S, fabMarkdownDays: 60 }) ?? "", /in that order/);
    assert.match(settingsProblem({ ...S, fabStep2Pct: 10 }) ?? "", /deeper/);
    assert.equal(settingsProblem(S), null);
    ok("A/B/C at 80 / 95 of margin (unrated left out), GMROI scaled to a year, bands, settings that don't hang together are refused");

    // 6. The database: shop A with fabrics of every kind.
    const steadyP = await fabric(a.shopId, "ST-1", { qty: 64, price: 1400, cost: 700, age: 100 });
    await move(a.shopId, steadyP.id, 100, "RECEIVED", 100);
    for (let w = 0; w < 12; w++) await sale(a.shopId, steadyP.id, 3, 1400, 600, 3 + 7 * w); // cost recorded 600 (today's cost is 700)
    const lumpyP = await fabric(a.shopId, "LU-1", { qty: 30, price: 1000, cost: 400, age: 100 });
    await move(a.shopId, lumpyP.id, 40, "RECEIVED", 100);
    await sale(a.shopId, lumpyP.id, 6, 1000, null, 70); // no cost recorded: today's 400 is used
    await sale(a.shopId, lumpyP.id, 4, 1000, null, 20);
    const newP = await fabric(a.shopId, "NW-1", { qty: 10, price: 1200, cost: 600, age: 10 });
    await move(a.shopId, newP.id, 20, "RECEIVED", 10);
    for (let k = 1; k <= 10; k++) await sale(a.shopId, newP.id, 1, 1200, 600, k);
    // FIFO: 20 yd 200 days ago, 10 yd 30 days ago, 12 yd gone: 18 left.
    const fifoP = await fabric(a.shopId, "FI-1", { qty: 18, price: 1400, cost: 700, age: 200 });
    await move(a.shopId, fifoP.id, 20, "RECEIVED", 200);
    await move(a.shopId, fifoP.id, 10, "RECEIVED", 30);
    await move(a.shopId, fifoP.id, -12, "ADJUSTED", 150);
    // A markdown-stage fabric: one lot of 15 yd 130 days ago, 3 sold long ago.
    const slowP = await fabric(a.shopId, "SL-1", { qty: 12, price: 1400, cost: 700, age: 130 });
    await move(a.shopId, slowP.id, 15, "RECEIVED", 130);
    await move(a.shopId, slowP.id, -3, "ADJUSTED", 120);
    // Opening stock with no moves at all, 150 days old.
    const openP = await fabric(a.shopId, "OP-1", { qty: 8, price: 1400, cost: 700, age: 150 });
    // Sells well and never slow: 190 days old but 70% gone.
    const goodP = await fabric(a.shopId, "GD-1", { qty: 6, price: 1400, cost: 700, age: 190 });
    await move(a.shopId, goodP.id, 20, "RECEIVED", 190);
    await move(a.shopId, goodP.id, -14, "ADJUSTED", 100);
    // No price, a consigned item, and a fat quarter item (not sold by the yard).
    const noPriceP = await fabric(a.shopId, "NP-1", { qty: 5, price: null, cost: 700, age: 160 });
    await move(a.shopId, noPriceP.id, 5, "RECEIVED", 160);
    const consignP = await fabric(a.shopId, "CO-1", { qty: 5, price: 1400, cost: 700, age: 160 });
    await db.part.update({ where: { id: consignP.id }, data: { consignLinkId: "x-link" } });
    await move(a.shopId, consignP.id, 5, "RECEIVED", 160);

    const ins = await insightFor(a.shopId);
    const it = (id: string) => ins.items.find((i) => i.id === id);
    const st = it(steadyP.id)!;
    near(st.perWeek, 3, "steady item's rate in the page");
    assert.equal(st.lumpy, false);
    assert.equal(st.weeks!.toFixed(2), "21.33");
    assert.equal(st.margin, 36 * (1400 - 600), "margin uses the cost recorded at the sale (600), not today's (700)");
    const lu = it(lumpyP.id)!;
    assert.equal(lu.lumpy, true);
    near(lu.perWeek, 1.575, "lumpy item's rate", 1e-9);
    assert.equal(lu.margin, 10 * (1000 - 400), "sale lines with no cost recorded use today's cost");
    assert.equal(ins.linesWithoutCost, 2);
    const nw = it(newP.id)!;
    assert.equal(nw.early, true);
    assert.equal(nw.daysInStock, 11);
    // Peers: same maker (Moda), established (42+ in-stock days): steady 3.0, lumpy 1.575, fifo/slow/open items too.
    const peers = ins.items.filter((i) => i.id !== newP.id && i.brand === "Moda" && i.daysInStock >= 42).map((i) => i.perWeek);
    const prior = [...peers].sort((x, y) => x - y);
    const med = prior.length % 2 ? prior[prior.length >> 1] : (prior[prior.length / 2 - 1] + prior[prior.length / 2]) / 2;
    near(nw.perWeek, (11 / 42) * (10 / 11) * 7 + (31 / 42) * med, "new fabric: blended toward the peers' median", 1e-9);
    assert.equal(it(steadyP.id)!.grade, "A");
    assert.equal(nw.grade, "unrated");
    ok("page numbers: steady 3.0 a week and 21.33 weeks, lumpy 1.575, cost at time of sale (600 not 700), today's cost for lines with none (2 counted), new fabric blended with its peers");

    const slowIds = ins.slow.map((r) => r.item.id);
    assert.ok(slowIds.includes(fifoP.id) && slowIds.includes(slowP.id) && slowIds.includes(openP.id) && slowIds.includes(noPriceP.id));
    for (const id of [steadyP.id, lumpyP.id, newP.id, goodP.id, consignP.id]) assert.ok(!slowIds.includes(id), "not slow");
    const rf = ins.slow.find((r) => r.item.id === fifoP.id)!;
    near(rf.item.aged!.ageDays, (10 * 30 + 8 * 200) / 18, "fifo weighted age", 1e-9);
    near(rf.item.aged!.soldShare, 0.4, "fifo sold share");
    assert.equal(rf.stage, "watch");
    const rs = ins.slow.find((r) => r.item.id === slowP.id)!;
    assert.equal(rs.stage, "markdown");
    near(rs.item.aged!.soldShare, 0.2, "sold 20%");
    assert.deepEqual(rs.convert, { markdownMargin: 420, fqMargin: 862, better: "fq" });
    assert.equal(rs.ladder.offer?.priceCents, 1120);
    const ro = ins.slow.find((r) => r.item.id === openP.id)!;
    assert.equal(ro.stage, "markdown", "opening stock with no moves is a lot dated when the fabric was made");
    assert.equal(ro.item.aged!.soldShare, 0);
    assert.equal(ins.slow.find((r) => r.item.id === noPriceP.id)!.convert, null);
    assert.ok(ins.slow.every((r, i, all) => i === 0 || all[i - 1].item.aged!.ageDays >= r.item.aged!.ageDays), "oldest first");
    ok("slow fabric: FIFO age 105.6 days and 40% sold (watch), 130 days 20% sold (markdown, 4.20 vs 8.62, fat quarters better), opening stock, no price; well-sold, new and consigned left out");

    // 7. Roll-ups.
    assert.ok(ins.groups.maker.some((g) => g.name === "Moda"));
    const moda = ins.groups.maker.find((g) => g.name === "Moda")!;
    assert.equal(moda.items, ins.items.filter((i) => i.brand === "Moda").length);
    near(moda.perWeek, ins.items.filter((i) => i.brand === "Moda").reduce((x, i) => x + i.perWeek, 0), "group sums its fabrics' rates");
    assert.ok(ins.groups.band.some((g) => g.name === "$14 and up"));
    assert.ok(ins.groups.color.some((g) => g.name === "(no color tag)"));
    assert.ok(ins.items.every((i) => i.id !== consignP.id), "a partner's consigned stock isn't the shop's fabric");
    assert.ok(ins.gmroi.maker.some((g) => g.name === "Moda") && ins.gmroi.supplier.some((g) => g.name === "Wholesale Co"));
    ok("roll-ups by maker, price band and color; GMROI by maker and supplier exist; consigned stock left out");

    // 8. GMROI on a hand-computed example (shop C): 10 yd of cost $4.00 received 100 days ago, 5 yd sold 50 days ago at $10.
    const gp = await fabric(c.shopId, "GM-1", { qty: 5, price: 1000, cost: 400, brand: "Hand", supplier: "Hand Supply", age: 100 });
    await move(c.shopId, gp.id, 10, "RECEIVED", 100);
    await sale(c.shopId, gp.id, 5, 1000, 400, 50);
    const gi = await insightFor(c.shopId);
    assert.equal(gi.gmroi.windowDays, 100);
    // Days 0..50 hold 5 yd (51 days), days 51..99 hold 10 yd (49 days): (255 + 490) x 400 / 100 = 2980 cents average stock.
    const row0 = gi.gmroi.maker.find((g) => g.name === "Hand")!;
    assert.equal(row0.avgInventory, 2980);
    assert.equal(row0.margin, 3000);
    near(row0.value!, (3000 * 3.65) / 2980, "GMROI", 1e-9);
    assert.equal(row0.band, "good");
    assert.equal(gi.gmroi.supplier.find((g) => g.name === "Hand Supply")!.value, row0.value);
    ok("GMROI by hand: margin 30.00, average stock 29.80 over 100 days, scaled to a year = 3.67");

    // 9. Marking down: the ladder moves, the row records it, undo works the same day only.
    const lad = (id: string) => ladderViewsFor(a.shopId, [id]).then((m) => m.get(id)!);
    const msg1 = await markDownFor(user(a), slowP.id, "slow");
    assert.match(msg1, /SL-1: \$14\.00 to \$11\.20 a yard \(20% off\)/);
    let p = await db.part.findUniqueOrThrow({ where: { id: slowP.id } });
    assert.equal(p.priceCents, 1120);
    let rows = await db.fabricMarkdown.findMany({ where: { partId: slowP.id }, orderBy: { createdAt: "asc" } });
    assert.equal(rows.length, 1);
    assert.deepEqual({ step: rows[0].step, pct: rows[0].pct, regular: rows[0].regularCents, old: rows[0].oldCents, now: rows[0].newCents, by: rows[0].userId, name: rows[0].userName }, { step: 1, pct: 20, regular: 1400, old: 1400, now: 1120, by: a.user.id, name: a.user.name });
    assert.match(rows[0].reason, /^Slow fabric: 130 days on the shelf, 20% sold$/);
    let l = await lad(slowP.id);
    assert.equal(l.step, 1);
    assert.equal(l.offer?.pct, 35);
    assert.equal(l.undo?.id, rows[0].id);
    // Undo: back to $14.00; the ladder is at step 0 again.
    assert.match(await undoMarkdownFor(user(a), rows[0].id), /back to \$14\.00/);
    p = await db.part.findUniqueOrThrow({ where: { id: slowP.id } });
    assert.equal(p.priceCents, 1400);
    assert.equal((await lad(slowP.id)).step, 0);
    await expectError("undo twice", () => undoMarkdownFor(user(a), rows[0].id), /already undone/);
    // Mark down again, then step 2 and 3 (held at the floor), then the last step refuses.
    await markDownFor(user(a), slowP.id, "slow");
    assert.match(await markDownFor(user(a), slowP.id, "slow"), /\$11\.20 to \$9\.10 a yard \(35% off\)/);
    assert.match(await markDownFor(user(a), slowP.id, "bolt"), /\$9\.10 to \$7\.35 a yard \(50% off, held at the floor\)/);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: slowP.id } })).priceCents, 735);
    await expectError("last step", () => markDownFor(user(a), slowP.id, "slow"), /last markdown step/);
    rows = await db.fabricMarkdown.findMany({ where: { partId: slowP.id, undoneAt: null }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(rows.map((r) => [r.step, r.oldCents, r.newCents]), [[1, 1400, 1120], [2, 1120, 910], [3, 910, 735]]);
    assert.match(rows[2].reason, /^Bolt end: 12 yd left$/);
    // Only the top one can be undone; undo it and the price returns to the step before.
    await expectError("undo under another", () => undoMarkdownFor(user(a), rows[1].id), /later markdown/);
    await undoMarkdownFor(user(a), rows[2].id);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: slowP.id } })).priceCents, 910);
    // A markdown from yesterday can't be undone, and a hand-changed price blocks the undo.
    await db.fabricMarkdown.update({ where: { id: rows[1].id }, data: { createdAt: at(1) } });
    await expectError("undo another day", () => undoMarkdownFor(user(a), rows[1].id), /only on the day/);
    assert.equal((await lad(slowP.id)).undo, null);
    await db.fabricMarkdown.update({ where: { id: rows[1].id }, data: { createdAt: new Date() } });
    await db.part.update({ where: { id: slowP.id }, data: { priceCents: 999 } });
    await expectError("undo after a hand change", () => undoMarkdownFor(user(a), rows[1].id), /price was changed/);
    l = await lad(slowP.id);
    assert.equal(l.step, 0);
    assert.equal(l.regularCents, 999, "the ladder starts again from the price set by hand");
    // The floor: a $14.00 fabric costing $13.00 goes to $13.65 and then stops.
    const hi = await fabric(a.shopId, "HI-1", { qty: 5, price: 1400, cost: 1300, age: 150 });
    assert.match(await markDownFor(user(a), hi.id, "bolt"), /\$14\.00 to \$13\.65 a yard \(20% off, held at the floor\)/);
    await expectError("floor", () => markDownFor(user(a), hi.id, "bolt"), /lowest price the ladder allows/);
    await expectError("no price", () => markDownFor(user(a), noPriceP.id, "slow"), /price per yard first/);
    await expectError("consigned", () => markDownFor(user(a), consignP.id, "slow"), /consigned/);
    ok("mark down: 14.00 to 11.20 to 9.10 to 7.35 (floor), the row says old, new, why, who; undo today only and only the top one; a hand price restarts it; floor and last step refuse");

    // 10. Tenant: B with A's ids.
    const tables = ["Part", "StockMove", "Sale", "FabricMarkdown"];
    const snap = await snapshot(a.shopId, tables);
    await expectNotFound("markDownFor(B, A's fabric)", () => markDownFor(user(b), fifoP.id, "slow"));
    await expectNotFound("undoMarkdownFor(B, A's markdown)", () => undoMarkdownFor(user(b), rows[0].id));
    assert.equal((await ladderViewsFor(b.shopId, [fifoP.id, slowP.id])).size, 0, "B gets no ladder for A's fabric");
    const bIns = await insightFor(b.shopId);
    assert.deepEqual([bIns.items.length, bIns.slow.length, bIns.fabrics, bIns.gmroi.maker.length], [0, 0, 0, 0]);
    // A's page lists only A's fabrics.
    for (const i of (await insightFor(a.shopId)).items) assert.ok(await db.part.findFirst({ where: { id: i.id, shopId: a.shopId } }), "every fabric listed for A is A's");
    assertUnchanged("tenant", snap, await snapshot(a.shopId, tables));
    ok("tenant: B can't mark down or undo A's, sees no ladder or fabric of A's, and A's rows are unchanged");
  } finally {
    await cleanup();
  }
  console.log(`fabric-insight.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
