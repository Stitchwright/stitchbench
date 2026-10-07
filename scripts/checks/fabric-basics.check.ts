// Fabric basics (fabric-smarts-design.md, package F1): the cut math (fat quarters floor to a quarter yard, half yards,
// remnant) and its rounding; cutting a bolt end takes the yards off, makes the target item the first time (priced from
// the yard price by the shop's settings, with the swatch copied) and reuses it after, with both CUT moves naming each
// other; refusals; the Bolt ends list (the limit, on order, the cut items themselves); "Add a collection" (all or none,
// numbers, pictures, receipts); the register's item search carrying the picture; the tenant section.
//   npm run check scripts/checks/fabric-basics.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { modelKey } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { addCollectionFor, boltEndsFor, cutFor } from "@/lib/fabric";
import { cutPlan, cutPrices, cutWords } from "@/lib/fabric-math";
import { completeSaleAs } from "@/lib/register-sale";
import { FIRST_PHOTO, viewItem } from "@/lib/register-item";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;

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

function form(entries: Record<string, string | File>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

// A 1x1 PNG: a swatch picture.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
const png = () => new File([PNG], "swatch.png", { type: "image/png" });

async function fabric(shopId: string, number: string, o: { qty: number; price?: number | null; cost?: number | null; photo?: boolean; unit?: string | null; consign?: string }) {
  return db.part.create({
    data: {
      shopId,
      partNumber: number,
      numberKeys: [number.replace(/[^A-Z0-9]/gi, "").toUpperCase()],
      description: `Batik ${number}`,
      kind: "FABRIC",
      unit: o.unit === undefined ? "yd" : o.unit,
      brand: "Moda",
      collection: "Spring Fling",
      designer: "Jo Designer",
      qtyOnHand: o.qty,
      priceCents: o.price === undefined ? 1400 : o.price,
      costCents: o.cost ?? null,
      consignLinkId: o.consign,
      photos: o.photo ? { create: { shopId, mime: "image/png", data: PNG } } : undefined,
    },
  });
}
const part = (id: string) => db.part.findUniqueOrThrow({ where: { id }, include: { moves: { orderBy: { createdAt: "asc" } }, photos: true } });

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    // 1. The math: floor to the quarter, the leftover in eighths, prices rounded once.
    assert.deepEqual(cutPlan("FQ", 1.375), { count: 5, usedYards: 1.25, leftYards: 0.125 });
    assert.deepEqual(cutPlan("FQ", 1), { count: 4, usedYards: 1, leftYards: 0 });
    assert.deepEqual(cutPlan("FQ", 0.875), { count: 3, usedYards: 0.75, leftYards: 0.125 });
    assert.deepEqual(cutPlan("FQ", 0.125), { count: 0, usedYards: 0, leftYards: 0.125 });
    assert.deepEqual(cutPlan("HALF", 1.375), { count: 2, usedYards: 1, leftYards: 0.375 });
    assert.deepEqual(cutPlan("HALF", 0.375), { count: 0, usedYards: 0, leftYards: 0.375 });
    assert.deepEqual(cutPlan("REMNANT", 0.625), { count: 0.625, usedYards: 0.625, leftYards: 0 });
    // A non-eighth amount on the bolt: a remnant takes exactly it, a fat quarter never more than is there.
    assert.deepEqual(cutPlan("REMNANT", 1.3), { count: 1.3, usedYards: 1.3, leftYards: 0 });
    assert.deepEqual(cutPlan("FQ", 1.24), { count: 4, usedYards: 1, leftYards: 0.24 });
    assert.equal(cutWords("FQ", 1.375), "1 3/8 yd makes 5 fat quarters, with 1/8 yd left.");
    assert.equal(cutWords("FQ", 1), "1 yd makes 4 fat quarters.");
    assert.equal(cutWords("FQ", 0.25), "1/4 yd makes 1 fat quarter.");
    // Yards that aren't eighths are said exactly, not rounded to the nearest eighth.
    assert.equal(cutWords("FQ", 0.24), "0.24 yd is too short for a fat quarter.");
    assert.equal(cutWords("REMNANT", 1.3), "1.3 yd goes to the remnant bin.");
    // $14.00 a yard: 350 x 1.15 = 402.5 cents rounds up to 403 (no float slip to 402).
    assert.equal(cutPrices("FQ", { priceCents: 1400, costCents: 700, costTenThou: null }).priceCents, 403);
    assert.equal(cutPrices("HALF", { priceCents: 1400, costCents: 700, costTenThou: null }).priceCents, 770);
    // The cost follows: a quarter of $7.00, kept finer than a cent.
    assert.deepEqual(cutPrices("FQ", { priceCents: 1400, costCents: 701, costTenThou: 70100 }), { priceCents: 403, costCents: 175, costTenThou: 17525 });
    // A remnant: 50% of the yard price, never under cost x 1.05 ($7.35 on a $7.00 cost).
    assert.equal(cutPrices("REMNANT", { priceCents: 1400, costCents: 700, costTenThou: null }).priceCents, 735);
    assert.equal(cutPrices("REMNANT", { priceCents: 1400, costCents: 100, costTenThou: null }).priceCents, 700);
    assert.equal(cutPrices("REMNANT", { priceCents: 1400, costCents: null, costTenThou: null }).priceCents, 700);
    assert.equal(cutPrices("FQ", { priceCents: null, costCents: null, costTenThou: null }).priceCents, null);
    assert.equal(cutPrices("FQ", { priceCents: 1400, costCents: null, costTenThou: null }, { fatQuarterMarkupPct: 0, halfYardMarkupPct: 10, remnantPricePct: 50 }).priceCents, 350);
    ok("cut math: floor to a quarter or half yard, the leftover, the words, prices and costs without float slips, the remnant's floor");

    // 2. Cutting 1 3/8 yd into fat quarters, twice: the first makes the item, the second adds to it.
    const bolt = await fabric(a.shopId, "MO-1001", { qty: 1.375, price: 1400, cost: 700, photo: true });
    const msg = await cutFor(user(a), bolt.id, "FQ");
    assert.match(msg, /Cut 1 1\/4 yd into 5 fat quarters \(new item MO-1001-FQ\)\. 1\/8 yd left/);
    let src = await part(bolt.id);
    assert.equal(src.qtyOnHand, 0.125);
    assert.ok(src.fatQuarterId);
    const fq = await part(src.fatQuarterId!);
    assert.equal(fq.partNumber, "MO-1001-FQ");
    assert.equal(fq.description, "Batik MO-1001 (fat quarter)");
    assert.equal(fq.qtyOnHand, 5);
    assert.equal(fq.unit, null);
    assert.equal(fq.kind, "FABRIC");
    assert.equal(fq.priceCents, 403);
    assert.equal(fq.costCents, 175);
    assert.equal(fq.brand, "Moda");
    assert.equal(fq.collection, "Spring Fling");
    assert.equal(fq.designer, "Jo Designer");
    assert.deepEqual(fq.numberKeys, ["MO1001FQ"]);
    assert.equal(fq.photos.length, 1, "the swatch is copied to the cut item");
    const out = src.moves.filter((m) => m.reason === "CUT");
    assert.equal(out.length, 1);
    assert.equal(out[0].qty, -1.25);
    assert.equal(out[0].otherPartId, fq.id);
    assert.equal(fq.moves.length, 1);
    assert.equal(fq.moves[0].reason, "CUT");
    assert.equal(fq.moves[0].qty, 5);
    assert.equal(fq.moves[0].otherPartId, bolt.id);
    // Moves add up to the stock.
    assert.equal(src.moves.reduce((s, m) => s + m.qty, 0), -1.25);
    ok("cut into fat quarters: yards off the bolt, item made once with the right price, cost, swatch and number, two linked CUT moves");

    // Second cut (more fabric arrived): the same item, no second one.
    await db.part.update({ where: { id: bolt.id }, data: { qtyOnHand: 0.875 } });
    await cutFor(user(a), bolt.id, "FQ");
    src = await part(bolt.id);
    assert.equal(src.qtyOnHand, 0.125);
    assert.equal((await part(fq.id)).qtyOnHand, 8);
    assert.equal(await db.part.count({ where: { shopId: a.shopId, partNumber: { endsWith: "-FQ" } } }), 1);
    ok("a second cut adds to the same fat quarter item");

    // 3. Half yards and remnant, with the shop's own settings.
    await db.shop.update({ where: { id: a.shopId }, data: { fatQuarterMarkupPct: 20, halfYardMarkupPct: 0, remnantPricePct: 60 } });
    const b2 = await fabric(a.shopId, "MO-1002", { qty: 1.375, price: 1000, cost: 500 });
    await cutFor(user(a), b2.id, "HALF");
    const b2p = await part(b2.id);
    assert.equal(b2p.qtyOnHand, 0.375);
    const hy = await part(b2p.halfYardId!);
    assert.deepEqual([hy.partNumber, hy.qtyOnHand, hy.priceCents, hy.unit], ["MO-1002-HY", 2, 500, null]);
    await cutFor(user(a), b2.id, "REMNANT");
    const b2r = await part(b2.id);
    assert.equal(b2r.qtyOnHand, 0);
    const rem = await part(b2r.remnantId!);
    assert.deepEqual([rem.partNumber, rem.qtyOnHand, rem.unit, rem.priceCents], ["MO-1002-REM", 0.375, "yd", 600]);
    assert.equal(rem.moves[0].qty, 0.375);
    // A remnant sells whole at the register whatever its yardage; other fabric is still cut in eighths.
    await db.part.update({ where: { id: rem.id }, data: { qtyOnHand: 1.3 } });
    await completeSaleAs(user(a), { lines: [{ partId: rem.id, description: "x", qty: 1.3, unitPriceCents: 600, discountCents: 0, taxable: false }], tenders: [{ method: "CASH", amountCents: 780 }] });
    assert.equal((await part(rem.id)).qtyOnHand, 0, "the 1.3 yd remnant sold whole");
    const b2y = await fabric(a.shopId, "MO-1002Y", { qty: 3, price: 1000 });
    await expectError("non-eighth yards of plain fabric", () => completeSaleAs(user(a), { lines: [{ partId: b2y.id, description: "x", qty: 1.3, unitPriceCents: 1000, discountCents: 0, taxable: false }], tenders: [{ method: "CASH", amountCents: 1300 }] }), /eighths/);
    assert.equal(b2r.moves.filter((m) => m.reason === "CUT").reduce((s, m) => s + m.qty, 0), -1.375);
    const b3 = await fabric(a.shopId, "MO-1003", { qty: 0.5, price: 1000 });
    await cutFor(user(a), b3.id, "FQ");
    assert.equal((await part((await part(b3.id)).fatQuarterId!)).priceCents, 300);
    ok("half yards and remnant (a yd item) use the shop's settings; the bolt's CUT moves add up to what left it");

    // 4. Refusals.
    await expectError("no price", async () => cutFor(user(a), (await fabric(a.shopId, "MO-2001", { qty: 1, price: null })).id, "FQ"), /price per yard first/);
    await expectError("no yards", async () => cutFor(user(a), (await fabric(a.shopId, "MO-2002", { qty: 0 })).id, "FQ"), /no yards left/);
    await expectError("too short", async () => cutFor(user(a), (await fabric(a.shopId, "MO-2003", { qty: 0.125 })).id, "FQ"), /too short for a fat quarter/);
    await expectError("half too short", async () => cutFor(user(a), (await fabric(a.shopId, "MO-2004", { qty: 0.375 })).id, "HALF"), /too short for a half yard/);
    await expectError("not by the yard", async () => cutFor(user(a), (await fabric(a.shopId, "MO-2005", { qty: 3, unit: null })).id, "FQ"), /isn't sold by the yard/);
    await expectError("consigned", async () => cutFor(user(a), (await fabric(a.shopId, "MO-2006", { qty: 1, consign: "chk-link" })).id, "FQ"), /consigned/);
    await fabric(a.shopId, "MO-2007-FQ", { qty: 1 });
    await expectError("number taken by another item", async () => cutFor(user(a), (await fabric(a.shopId, "MO-2007", { qty: 1 })).id, "FQ"), /already another item/);
    await expectError("bad kind", () => cutFor(user(a), bolt.id, "XX" as never), /Pick fat quarters/);
    await expectError("odd id", () => cutFor(user(a), { $ne: "x" } as never, "FQ"), /Not found/);
    ok("refused: no price, no yards, too short, not by the yard, consigned, number already another item, odd input; nothing changed by them");

    // 5. Bolt ends: the limit, on order, the items the cuts feed.
    const fresh = await checkShop({ retail: true });
    const small = await fabric(fresh.shopId, "BE-1", { qty: 0.875 });
    await fabric(fresh.shopId, "BE-2", { qty: 1 });
    await fabric(fresh.shopId, "BE-3", { qty: 1.125 });
    await fabric(fresh.shopId, "BE-4", { qty: 0 });
    await fabric(fresh.shopId, "BE-5", { qty: 0.5, consign: "chk-link" });
    const ordered = await fabric(fresh.shopId, "BE-6", { qty: 0.75 });
    const m = await db.machine.create({ data: { shopId: fresh.shopId, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
    const t = await db.ticket.create({ data: { shopId: fresh.shopId, number: 9001, status: "ON_BENCH", machineId: m.id, intake: {} } });
    await db.partWait.create({ data: { shopId: fresh.shopId, ticketId: t.id, partId: ordered.id, description: "on order" } });
    let ends = await boltEndsFor(fresh.shopId);
    assert.equal(ends.limit, 1);
    assert.deepEqual(ends.rows.map((r) => r.partNumber), ["BE-1", "BE-2"], "least first: BE-1 (1/2 yd) then BE-2 (1 yd); not BE-3 (over), BE-4 (empty), BE-5 (consigned), BE-6 (on order)");
    // Cutting the small one leaves 0.25 on the bolt; the fat-quarter item is not a bolt end itself.
    await cutFor(user(fresh), small.id, "HALF");
    await cutFor(user(fresh), small.id, "REMNANT");
    ends = await boltEndsFor(fresh.shopId);
    assert.deepEqual(ends.rows.map((r) => r.partNumber), ["BE-2"], "the remnant item (a yd item under 1 yd) isn't listed");
    // A received order closes the wait and brings it back; the limit is the shop's setting.
    await db.partWait.updateMany({ where: { partId: ordered.id }, data: { receivedAt: new Date() } });
    await db.shop.update({ where: { id: fresh.shopId }, data: { boltEndYards: 0.75 } });
    ends = await boltEndsFor(fresh.shopId);
    assert.deepEqual(ends.rows.map((r) => r.partNumber), ["BE-6"]);
    ok("bolt ends: at or under the limit, none on order, not consigned or empty, not the cut items; the shop's limit applies");

    // 6. Add a collection: a row per colorway, pictures, receipts, all or none.
    const base = { maker: "Riley Blake", collection: "Garden Party", designer: "Pat Pattern", inPrint: "YES", supplier: "Checker" };
    const n = await addCollectionFor(
      user(a),
      form({ ...base, "number.0": "RB-100", "color.0": "Rose", "yards.0": "15", "price.0": "13.50", "photo.0": png(), "number.1": "rb-101", "color.1": "Sky", "yards.1": "7.5", "price.1": "13.50", "number.3": "RB-103", "color.3": "Sage", "price.3": "$14" }),
    );
    assert.equal(n, 3);
    const rose = await db.part.findFirstOrThrow({ where: { shopId: a.shopId, partNumber: "RB-100" }, include: { moves: true, photos: true } });
    assert.deepEqual([rose.description, rose.brand, rose.collection, rose.designer, rose.inPrint, rose.boltYards, rose.unit, rose.kind, rose.priceCents, rose.qtyOnHand, rose.supplier], ["Garden Party Rose", "Riley Blake", "Garden Party", "Pat Pattern", "YES", 15, "yd", "FABRIC", 1350, 15, "Checker"]);
    assert.equal(rose.moves.length, 1);
    assert.equal(rose.moves[0].reason, "RECEIVED");
    assert.equal(rose.moves[0].qty, 15);
    assert.equal(rose.photos.length, 1);
    const sage = await db.part.findFirstOrThrow({ where: { shopId: a.shopId, partNumber: "RB-103" }, include: { moves: true } });
    assert.deepEqual([sage.qtyOnHand, sage.moves.length, sage.priceCents], [0, 0, 1400]);
    assert.deepEqual((await db.part.findFirstOrThrow({ where: { shopId: a.shopId, partNumber: "rb-101" } })).numberKeys, ["RB101"]);
    ok("add a collection: three fabrics with the maker, collection, designer, price, a receipt each (none for 0 yd) and the swatch");

    const count = () => db.part.count({ where: { shopId: a.shopId } });
    const before = await count();
    const bad = (extra: Record<string, string | File>) => form({ ...base, "number.0": "RB-200", "color.0": "Red", "price.0": "10", ...extra });
    await expectError("number already here", () => addCollectionFor(user(a), bad({ "number.1": "rb-100", "color.1": "X", "price.1": "10" })), /RB-100 is already in inventory/);
    await expectError("number twice", () => addCollectionFor(user(a), bad({ "number.1": "RB-200", "color.1": "X", "price.1": "10" })), /in the list twice/);
    await expectError("no price", () => addCollectionFor(user(a), bad({ "number.1": "RB-201", "color.1": "X" })), /Row 2.*price/);
    await expectError("no color", () => addCollectionFor(user(a), bad({ "number.1": "RB-201", "price.1": "9" })), /Row 2.*color/);
    await expectError("odd yards", () => addCollectionFor(user(a), bad({ "number.1": "RB-201", "color.1": "X", "price.1": "9", "yards.1": "2.3" })), /eighths/);
    await expectError("negative price", () => addCollectionFor(user(a), bad({ "number.1": "RB-201", "color.1": "X", "price.1": "-9" })), /price/i);
    await expectError("not a picture", () => addCollectionFor(user(a), bad({ "photo.0": new File(["x"], "x.txt", { type: "text/plain" }) })), /JPEG, PNG or WebP/);
    await expectError("no maker", () => addCollectionFor(user(a), form({ collection: "C", "number.0": "Z", "color.0": "Z", "price.0": "1" })), /maker/);
    await expectError("no rows", () => addCollectionFor(user(a), form(base)), /at least one colorway/);
    await expectError("bad in-print", () => addCollectionFor(user(a), bad({ inPrint: "MAYBE" })), /in print/);
    assert.equal(await count(), before, "a refused collection adds nothing, not even its good rows");
    ok("add a collection is all or none: duplicate, repeated, missing price or color, odd yards, bad picture, no maker or rows, bad flag");

    // The same numbers in another company are its own.
    await addCollectionFor(user(b), form({ ...base, "number.0": "RB-100", "color.0": "Rose", "price.0": "13.50" }));
    assert.equal(await db.part.count({ where: { shopId: b.shopId, partNumber: "RB-100" } }), 1);
    ok("another company can use the same item numbers");

    // 7. The register's item search carries the first picture (never the bytes).
    const withPhoto = await db.part.findFirstOrThrow({ where: { id: rose.id, shopId: a.shopId }, include: FIRST_PHOTO });
    const item = viewItem(withPhoto);
    assert.equal(item.photoId, rose.photos[0].id);
    assert.equal(JSON.stringify(item).includes("data"), false);
    const noPhoto = viewItem(await db.part.findFirstOrThrow({ where: { id: sage.id, shopId: a.shopId }, include: FIRST_PHOTO }));
    assert.equal(noPhoto.photoId, null);
    ok("a register item has the swatch's id when there is one, and none when not");

    // 8. Tenant: B with A's ids.
    const aTables = ["Part", "StockMove", "PartPhoto"];
    const snap = await snapshot(a.shopId, aTables);
    await expectNotFound("cutFor(B, A's fabric)", () => cutFor(user(b), bolt.id, "FQ"));
    await expectNotFound("cutFor(B, A's fabric, half)", () => cutFor(user(b), bolt.id, "HALF"));
    await expectNotFound("cutFor(B, A's fabric, remnant)", () => cutFor(user(b), bolt.id, "REMNANT"));
    assert.deepEqual((await boltEndsFor(b.shopId)).rows, []);
    const aEnds = (await boltEndsFor(a.shopId)).rows;
    assert.ok(aEnds.length > 0);
    for (const r of aEnds) assert.ok(await db.part.findFirst({ where: { id: r.id, shopId: a.shopId } }), "every bolt end listed for A is A's");
    assertUnchanged("tenant", snap, await snapshot(a.shopId, aTables));
    // A fabric whose link points at B's item doesn't use it: the cut makes (or refuses) its own, never touching B's rows.
    const bItem = await fabric(b.shopId, "MO-1001-FQ", { qty: 40 });
    await db.part.update({ where: { id: bolt.id }, data: { fatQuarterId: bItem.id, qtyOnHand: 0.5 } });
    await expectError("link into another company", () => cutFor(user(a), bolt.id, "FQ"), /already another item|in use/);
    assert.equal((await part(bItem.id)).qtyOnHand, 40);
    ok("tenant: B can't cut A's fabric or see its bolt ends; a link to another company's item is never followed");
  } finally {
    await cleanup();
  }
  console.log(`fabric-basics.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
