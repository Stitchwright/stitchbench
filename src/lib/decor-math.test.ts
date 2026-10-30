import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRICES, effectiveColors, formatMinutes, parseScreenRows, placementMinutes, screenMinutes, screenPieceCents, screenRowsText, basePriceCents, breakPct, cleanPrices, orderPrice, parseBreaks, parseTiers, pieceCents, runMinutes, sizesTotal, tiersText } from "./decor-math";

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

test("a screen print costs the grid's price for its colours at its quantity, and each extra colour past the grid", () => {
  // default grid: 12: 3.50 4.50 5.50 6.50 / 24: 2.75 3.50 4.25 5.00 / 48 / 144, extra colour 0.60
  assert.equal(screenPieceCents(1, 12, P), 350);
  assert.equal(screenPieceCents(3, 23, P), 550); // 23 pieces: still the 12 row
  assert.equal(screenPieceCents(3, 24, P), 425);
  assert.equal(screenPieceCents(4, 500, P), 310);
  assert.equal(screenPieceCents(6, 24, P), 500 + 2 * 60, "two colours past the grid's four");
  assert.equal(screenPieceCents(1, 3, P), 350, "under the first row's quantity pays the first row");
  assert.equal(effectiveColors(2, false), 2);
  assert.equal(effectiveColors(2, true), 3, "an underbase is one more colour");
  assert.equal(effectiveColors(0, false), 1);
});

test("press time is set-up for each colour plus every piece through every colour", () => {
  // 150 prints an hour, 10 minutes a colour: 3 colours x 10 + 48 pieces x 3 / 150 h = 57.6 min -> 58
  assert.equal(screenMinutes(3, 48, P), 30 + 58);
  assert.equal(screenMinutes(1, 0, P), 0);
  assert.equal(placementMinutes({ method: "SCREEN_PRINT", stitches: 0, colors: 2, underbase: true }, 48, P), screenMinutes(3, 48, P));
  assert.equal(placementMinutes({ stitches: 7000, colors: 1 }, 10, P), 10 * runMinutes(7000, 1, P), "no method means embroidery");
});

test("an order mixes embroidery and screen print: screens only when they have to be made, digitizing only for embroidery", () => {
  const lines = [{ qty: 24, garmentCents: 600 }];
  const price = orderPrice(
    lines,
    [
      { method: "SCREEN_PRINT", stitches: 0, colors: 2, underbase: true, newDesign: true, priceEachCents: null },
      { method: "SCREEN_PRINT", stitches: 0, colors: 1, newDesign: false, priceEachCents: null },
      { method: "EMBROIDERY", stitches: 5000, newDesign: true, priceEachCents: null },
    ],
    P,
  );
  // 24 pieces: 3 colours (2 + underbase) = 4.25; 1 colour = 2.75; embroidery 5000 stitches 6.00 less 10% = 5.40
  assert.deepEqual(price.eachCents, [425, 275, 540]);
  assert.equal(price.screenCents, 3 * 2500, "three screens for the first print; none for the repeat");
  assert.equal(price.digitizingCents, 3500, "the embroidery only");
  assert.equal(price.totalCents, 24 * 600 + 24 * (425 + 275 + 540) + 7500 + 3500);
  // an agreed price wins for a screen print too
  assert.deepEqual(orderPrice(lines, [{ method: "SCREEN_PRINT", stitches: 0, colors: 4, newDesign: false, priceEachCents: 100 }], P).eachCents, [100]);
});

test("the screen print grid round-trips through its text, and bad lines are refused", () => {
  const g = parseScreenRows("48: 2.25, 2.90\n12: $3.50 4.50, 5.5");
  assert.deepEqual("rows" in g && g.rows, [{ min: 12, cents: [350, 450, 550] }, { min: 48, cents: [225, 290] }]);
  assert.equal(screenRowsText("rows" in g ? g.rows : []), "12: 3.50, 4.50, 5.50\n48: 2.25, 2.90");
  assert.ok("error" in parseScreenRows("a lot"));
  assert.ok("error" in parseScreenRows("12: cheap"));
  assert.ok("error" in parseScreenRows("12: 1\n12: 2"));
  assert.ok("error" in parseScreenRows(""));
  assert.ok("error" in parseScreenRows("0: 1"));
});

test("stored screen prices are made safe", () => {
  assert.deepEqual(cleanPrices({}).screen, P.screen);
  const c = cleanPrices({ screen: { rows: [{ min: 24, cents: [300, "x", 200] }, { min: 0, cents: [1] }, { min: 6, cents: [] }], printsPerHour: 0, screenCents: -5 } }).screen;
  assert.deepEqual(c.rows, [{ min: 24, cents: [300, 200] }]);
  assert.equal(c.printsPerHour, P.screen.printsPerHour);
  assert.equal(c.screenCents, P.screen.screenCents);
});
