import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRICES, formatMinutes, basePriceCents, breakPct, cleanPrices, orderPrice, parseBreaks, parseTiers, pieceCents, runMinutes, sizesTotal, tiersText } from "./decor-math";

const P = DEFAULT_PRICES;

test("a piece costs its stitch tier, and the last tier plus each started thousand beyond it", () => {
  assert.equal(basePriceCents(0, P), 600);
  assert.equal(basePriceCents(5000, P), 600);
  assert.equal(basePriceCents(5001, P), 750);
  assert.equal(basePriceCents(20000, P), 1200);
  assert.equal(basePriceCents(20001, P), 1200 + 80); // one started thousand
  assert.equal(basePriceCents(22000, P), 1200 + 160);
  assert.equal(basePriceCents(22001, P), 1200 + 240);
});

test("quantity breaks take the largest minimum reached", () => {
  assert.equal(breakPct(11, P), 0);
  assert.equal(breakPct(12, P), 5);
  assert.equal(breakPct(47, P), 10);
  assert.equal(breakPct(1000, P), 20);
  assert.equal(pieceCents(5000, 24, P), 540); // 600 less 10%
  assert.equal(pieceCents(7000, 12, P), 713); // 750 less 5% = 712.5, rounded to the cent
});

test("run time counts stitches at the machine's speed and each colour change", () => {
  assert.equal(runMinutes(0, 3, P), 0);
  assert.equal(runMinutes(7000, 1, P), 10); // 7000 / 700
  assert.equal(runMinutes(7000, 4, P), 13); // 10 + 3 changes x 45 s = 12.25, rounded up
  assert.equal(runMinutes(10, 1, P), 1); // never less than a minute for a design
});

test("an order adds garments, decoration for every piece, digitizing per new design and the set-up fee", () => {
  const price = orderPrice(
    [{ qty: 10, garmentCents: 900 }, { qty: 14, garmentCents: 1100 }],
    [{ stitches: 6000, newDesign: true, priceEachCents: null }, { stitches: 3000, newDesign: false, priceEachCents: 450 }],
    { ...P, setupCents: 1500 },
  );
  assert.equal(price.pieces, 24);
  assert.equal(price.garmentCents, 10 * 900 + 14 * 1100);
  // 24 pieces: 10% off the 6000-stitch tier (750) = 675; the second placement's typed 450 wins over the table
  assert.deepEqual(price.eachCents, [675, 450]);
  assert.equal(price.decorationCents, 24 * (675 + 450));
  assert.equal(price.digitizingCents, 3500);
  assert.equal(price.setupCents, 1500);
  assert.equal(price.totalCents, price.garmentCents + price.decorationCents + 3500 + 1500);
});

test("an empty order costs nothing", () => {
  assert.equal(orderPrice([], [], { ...P, setupCents: 1500 }).totalCents, 0);
});

test("stored prices are made safe", () => {
  assert.deepEqual(cleanPrices(null), P);
  const c = cleanPrices({ tiers: [{ upTo: "9000", cents: 1000 }, { upTo: -5, cents: 5 }, { upTo: 3000, cents: 400 }], breaks: [{ min: 1, pct: 5 }, { min: 10, pct: 200 }, { min: 20, pct: 8 }], stitchesPerMinute: 99999, digitizingCents: -1 });
  assert.deepEqual(c.tiers, [{ upTo: 3000, cents: 400 }, { upTo: 9000, cents: 1000 }]);
  assert.deepEqual(c.breaks, [{ min: 20, pct: 8 }]);
  assert.equal(c.stitchesPerMinute, P.stitchesPerMinute);
  assert.equal(c.digitizingCents, P.digitizingCents);
  assert.deepEqual(cleanPrices({ breaks: [] }).breaks, []); // no breaks at all is allowed
});

test("the price table and breaks round-trip through their text", () => {
  const t = parseTiers("12000: 9.00\n5000: 6.5\n");
  assert.deepEqual("tiers" in t && t.tiers, [{ upTo: 5000, cents: 650 }, { upTo: 12000, cents: 900 }]);
  assert.equal(tiersText("tiers" in t ? t.tiers : []), "5000: 6.50\n12000: 9.00");
  assert.ok("error" in parseTiers("lots of stitches"));
  assert.ok("error" in parseTiers("5000: 6\n5000: 7"));
  assert.ok("error" in parseTiers(""));
  const b = parseBreaks("24: 10%\n12: 5");
  assert.deepEqual("breaks" in b && b.breaks, [{ min: 12, pct: 5 }, { min: 24, pct: 10 }]);
  assert.deepEqual(parseBreaks(""), { breaks: [] });
  assert.ok("error" in parseBreaks("1: 5"));
});

test("sizes add up", () => {
  assert.equal(sizesTotal("S 2, M 4, L 4"), 10);
  assert.equal(sizesTotal("2XL: 3; XL x 1"), 4);
  assert.equal(sizesTotal("some of each"), null);
  assert.equal(sizesTotal(""), null);
});

test("machine time reads as hours and minutes", () => {
  assert.deepEqual([0, 45, 60, 135, 61.4].map(formatMinutes), ["0 min", "45 min", "1 h", "2 h 15 min", "1 h 1 min"]);
  assert.equal(formatMinutes(-5), "0 min");
});
