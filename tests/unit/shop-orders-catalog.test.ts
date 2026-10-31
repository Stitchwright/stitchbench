// The catalogue a shop publishes: how the shop's garments and decoration prices become what MakerFoundry charges.
import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, breaksText, parsePriceBreaks, splitList, type CatalogIn } from "../../src/lib/shop-orders/catalog";

const base: CatalogIn = {
  shopName: "Main Street Threadworks",
  ships: false,
  shippingCents: 800,
  products: [{ sku: "TEE-01", name: "Cotton tee", kind: "shirt", colours: "Navy, White\nNavy", sizes: "S, M, L", blankCents: 900 }],
  offers: [
    { method: "embroidery", placement: "Left chest", breaks: [{ min: 1, cents: 1200 }, { min: 12, cents: 1000 }], setupCents: 2500 },
    { method: "embroidery", placement: "Right chest", breaks: [{ min: 1, cents: 1200 }, { min: 12, cents: 1000 }], setupCents: 2500 },
    { method: "embroidery", placement: "Full back", breaks: [{ min: 1, cents: 2000 }], setupCents: 2500 },
  ],
};

test("the price of a piece in the catalogue is the blank plus the decoration at each break", () => {
  const r = buildCatalog(base);
  assert.ok(r.ok);
  if (!r.ok) return;
  const methods = r.body.products[0].methods;
  assert.equal(methods.length, 2, "placements with the same prices share an entry");
  const chest = methods.find((m) => m.placements.includes("Left chest"));
  assert.deepEqual(chest?.placements, ["Left chest", "Right chest"]);
  assert.deepEqual(chest?.price_breaks, [{ min: 1, cents: 2100 }, { min: 12, cents: 1900 }]);
  assert.equal(chest?.setup_cents, 2500);
  assert.deepEqual(r.body.products[0].colours, ["Navy", "White"], "repeated colours are dropped");
});

test("shipping is off, and priced at zero, until the shop says it ships", () => {
  const off = buildCatalog(base);
  assert.ok(off.ok && off.body.shop.ships === false && off.body.shipping.flat_cents === 0 && off.body.shop.pickup === true);
  const on = buildCatalog({ ...base, ships: true });
  assert.ok(on.ok && on.body.shop.ships === true && on.body.shipping.flat_cents === 800);
});

test("nothing to sell is said, not published", () => {
  assert.equal(buildCatalog({ ...base, offers: [] }).ok, false);
  assert.equal(buildCatalog({ ...base, products: [] }).ok, false);
  assert.equal(buildCatalog({ ...base, products: [{ ...base.products[0], sizes: "" }] }).ok, false);
});

test("price breaks are read from lines of pieces and dollars, and have to start at one piece", () => {
  assert.deepEqual(parsePriceBreaks("12: 10.50\n1: 12"), { breaks: [{ min: 1, cents: 1200 }, { min: 12, cents: 1050 }] });
  for (const bad of ["", "12: 10", "1: abc", "1: 5\n1: 6", "0: 5"]) assert.ok("error" in parsePriceBreaks(bad), bad);
  assert.equal(breaksText([{ min: 1, cents: 1200 }, { min: 12, cents: 1050 }]), "1: 12.00\n12: 10.50");
});

test("a list of colours or sizes is cleaned", () => {
  assert.deepEqual(splitList(" S ,M;L\n\nXL, s", 20), ["S", "M", "L", "XL"]);
  assert.equal(splitList("a,b,c", 2).length, 2);
});
