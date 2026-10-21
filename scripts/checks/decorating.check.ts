// Decorating (docs/plans/decorators-proposal.md, packages D1, D2 and the file import): the module gate (free while the program
// is free), taking an order, garments with sizes, a DST file read for its stitch count (other formats kept, stitches typed),
// the price from the shop's table with quantity breaks, the price kept when the table changes, the steps, turning an order
// down, collecting it as a register sale that bills exactly the quoted parts and voiding that sale, and the tenant section.
//   npm run check scripts/checks/decorating.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { DEFAULT_PRICES, orderPrice } from "@/lib/decor-math";
import { addLineFor, addPlacementFor, collectOrderFor, createOrderFor, decorPrices, orderView, ordersFor, placementFile, removeLineFor, removePlacementFor, requoteFor, saveDecorPricesFor, setOrderStatusFor, turnDownOrderFor } from "@/lib/decor";
import { voidSaleAs } from "@/lib/register-sale";
import { customerDeletePlan } from "@/lib/merge";
import { grantDevLicense } from "../license/dev";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });
const DAY = 86_400_000;

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
const fd = (o: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

/** A DST file of n stitches that go one tenth of a millimetre right and left in turn, and a colour change in the middle. */
function dst(n: number): File {
  const out = new Uint8Array(512 + n * 3 + 3);
  out.fill(0x20, 0, 512);
  const h = `LA:CHECK           \rST:${String(n).padStart(7)}\rCO:  1\r+X:    1\r-X:    0\r+Y:    0\r-Y:    0\r`;
  for (let i = 0; i < h.length; i++) out[i] = h.charCodeAt(i);
  for (let i = 0; i < n; i++) out.set([i % 2 === 0 ? 0x01 : 0x02, 0, i === Math.floor(n / 2) ? 0xc3 : 0x03], 512 + i * 3);
  out.set([0, 0, 0xf3], 512 + n * 3);
  return new File([out], "logo.dst");
}

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const base = { customerName: "Riverside Fire Dept", customerPhone: "555-0142", title: "Polos for the crew" };

    // 1. The gate: free while the program is free, a key when it is not.
    await expectError("no Decorating key", () => createOrderFor(user(a), fd(base)), /Decorating/);
    process.env.PROGRAM_FREE = "on";
    const free = await createOrderFor(user(a), fd({ ...base, title: "Free-program order" }));
    assert.equal(free.number, 1);
    process.env.PROGRAM_FREE = "off";
    await grantDevLicense(a.shopId, ["decorating"], { from: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10) });
    await grantDevLicense(b.shopId, ["decorating"], { from: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10) });
    ok("the gate: refused with no key, allowed while the program is free (the same module, no key), allowed with a key");

    // 2. Taking an order and its garments.
    const o = await createOrderFor(user(a), fd({ ...base, due: "2030-06-01" }));
    assert.equal(o.number, 2);
    await expectError("no title", () => createOrderFor(user(a), fd({ ...base, title: " " })), /Say what it is/);
    await expectError("sizes do not match", () => addLineFor(user(a), o.id, fd({ description: "Polo", qty: "10", sizes: "S 2, M 4" })), /add up to 6, not 10/);
    await expectError("no quantity", () => addLineFor(user(a), o.id, fd({ description: "Polo" })), /How many/);
    await addLineFor(user(a), o.id, fd({ description: "Port Authority polo", color: "Navy", sizes: "S 2, M 4, L 4", garment: "9.00" }));
    await addLineFor(user(a), o.id, fd({ description: "Port Authority polo", color: "White", qty: "14", garment: "11.00" }));
    let v = (await orderView(a.shopId, o.id))!;
    assert.deepEqual([v.pieces, v.garmentCents, v.lines.map((l) => l.qty), v.quoteCents], [24, 10 * 900 + 14 * 1100, [10, 14], 24400]);
    ok("an order and its garments: sizes add up to the count (10 from S 2, M 4, L 4), a wrong total is refused, the garments are priced");

    // 3. A DST file is read; other formats are kept and typed.
    await expectError("a PES with no stitch count", () => addPlacementFor(user(a), o.id, fd({ location: "Left chest", file: new File([new Uint8Array([35, 80, 69, 83])], "crest.pes") })), /PES files aren't read yet/);
    await expectError("nothing to price", () => addPlacementFor(user(a), o.id, fd({ location: "Left chest" })), /Give the stitch count/);
    await expectError("too large", () => addPlacementFor(user(a), o.id, fd({ location: "Left chest", stitches: "1", file: new File([new Uint8Array(11 * 1024 * 1024)], "big.dst") })), /larger than 10 MB/);
    const said = await addPlacementFor(user(a), o.id, fd({ location: "Left chest", stitches: "999", colors: "9", newDesign: "on", file: dst(5000) }));
    assert.match(said, /file says 5,000 stitches in 2 colours/);
    v = (await orderView(a.shopId, o.id))!;
    const pl = v.placements[0];
    assert.deepEqual([pl.stitches, pl.colors, pl.fileReadable, pl.fileFormat, pl.hasFile, pl.newDesign], [5000, 2, true, "DST", true, true], "what the file says wins over what was typed");
    // 24 pieces: the 5000-stitch tier is $6.00, 10% off = $5.40 each
    assert.equal(pl.quotedEachCents, 540);
    const expected = orderPrice(
      [{ qty: 10, garmentCents: 900 }, { qty: 14, garmentCents: 1100 }],
      [{ stitches: 5000, newDesign: true, priceEachCents: null }],
      DEFAULT_PRICES,
    );
    assert.equal(v.quoteCents, expected.totalCents);
    assert.deepEqual([expected.garmentCents, expected.decorationCents, expected.digitizingCents], [24400, 24 * 540, 3500]);
    const f = await placementFile(a.shopId, pl.id);
    assert.equal(f?.name, "logo.dst");
    assert.equal(f?.data.length, 512 + 5000 * 3 + 3);
    await addPlacementFor(user(a), o.id, fd({ location: "Back", stitches: "30000", colors: "1", price: "" }));
    await addPlacementFor(user(a), o.id, fd({ location: "Sleeve", stitches: "3000", price: "4.25", file: new File([new Uint8Array([1, 2, 3])], "sleeve.pes") }));
    v = (await orderView(a.shopId, o.id))!;
    // a 30000-stitch back: last tier $12.00 + 10 started thousands at $0.80 = $20.00, less 10% = $18.00; the sleeve's agreed $4.25 wins
    assert.deepEqual(v.placements.map((p) => p.quotedEachCents), [540, 1800, 425]);
    assert.deepEqual([v.placements[2].fileReadable, v.placements[2].fileFormat, v.placements[2].priceEachCents], [false, "PES", 425]);
    assert.equal(v.quoteCents, 24400 + 24 * (540 + 1800 + 425) + 3500);
    ok("a DST file is read (5,000 stitches, 2 colours, and it wins over what was typed); a PES is kept and typed; the table, the quantity break and an agreed price work out the price");

    // 4. The quoted price is kept when the table changes.
    const quoted = v.quoteCents;
    await expectError("a tech can't set prices", () => saveDecorPricesFor(tech(a), fd({ tiers: "5000: 1", breaks: "", extra: "0", digitizing: "0", setup: "0", spm: "700", colorSeconds: "45" })), /Only an owner or admin/);
    await expectError("a bad price line", () => saveDecorPricesFor(user(a), fd({ tiers: "lots", breaks: "", extra: "0", digitizing: "0", setup: "0", spm: "700", colorSeconds: "45" })), /isn't a price line/);
    assert.match(await saveDecorPricesFor(user(a), fd({ tiers: "5000: 7.00\n10000: 9.50", breaks: "12: 20", extra: "1.00", digitizing: "40", setup: "15", spm: "800", colorSeconds: "30" })), /Saved the prices/);
    assert.deepEqual((await decorPrices(a.shopId)).tiers, [{ upTo: 5000, cents: 700 }, { upTo: 10000, cents: 950 }]);
    assert.equal((await orderView(a.shopId, o.id))!.quoteCents, quoted, "an order already quoted keeps its price");
    await expectError("a tech can't re-price", () => requoteFor(tech(a), o.id), /Only an owner or admin/);
    await requoteFor(user(a), o.id);
    v = (await orderView(a.shopId, o.id))!;
    // 24 pieces, 20% off: 5000 -> $7.00 = $5.60; 30000 -> $9.50 + 20 x $1.00 = $29.50 = $23.60; the agreed $4.25 stays; digitizing $40, set-up $15
    assert.deepEqual(v.placements.map((p) => p.quotedEachCents), [560, 2360, 425]);
    assert.deepEqual([v.digitizingCents, v.setupCents], [4000, 1500]);
    assert.equal(v.quoteCents, 24400 + 24 * (560 + 2360 + 425) + 4000 + 1500);
    ok("a later change to the price table never moves a quoted order; working the price out again uses today's table (owner or admin only)");

    // 5. Removing, then the steps.
    const extra = await db.decorPlacement.findFirstOrThrow({ where: { orderId: o.id, location: "Sleeve" } });
    await removePlacementFor(user(a), o.id, extra.id);
    assert.equal((await orderView(a.shopId, o.id))!.placements.length, 2);
    const white = v.lines.find((l) => l.color === "White")!;
    await removeLineFor(user(a), o.id, white.id);
    assert.deepEqual([(await orderView(a.shopId, o.id))!.pieces, (await orderView(a.shopId, o.id))!.lines.length], [10, 1]);
    await addLineFor(user(a), o.id, fd({ description: "Port Authority polo", color: "White", qty: "14", garment: "11.00" }));
    await expectError("quoted to production", () => setOrderStatusFor(user(a), o.id, "IN_PRODUCTION"), /can't go to in production/);
    await expectError("approve an empty order", () => setOrderStatusFor(user(a), free.id, "APPROVED"), /Add the garments/);
    await setOrderStatusFor(user(a), o.id, "APPROVED");
    await setOrderStatusFor(user(a), o.id, "IN_PRODUCTION");
    await expectError("change in production", () => addLineFor(user(a), o.id, fd({ description: "Cap", qty: "1" })), /can't be changed now/);
    await expectError("collect before ready", () => collectOrderFor(user(a), o.id, fd({ method: "CASH" })), /Only a ready order/);
    assert.match(await setOrderStatusFor(user(a), o.id, "READY"), /is ready/);
    const t = await createOrderFor(user(a), fd({ ...base, title: "A copied logo" }));
    await expectError("no reason", () => turnDownOrderFor(user(a), t.id, " "), /Say why/);
    await turnDownOrderFor(user(a), t.id, "A trademarked logo");
    assert.deepEqual([(await orderView(a.shopId, t.id))!.status, (await orderView(a.shopId, t.id))!.turnedDownWhy], ["TURNED_DOWN", "A trademarked logo"]);
    await expectError("turn down a ready order", () => turnDownOrderFor(user(a), o.id, "x"), /can't be turned down/);
    ok("removing a decoration or garment prices again; the steps; a change after production starts is refused; turned down with a reason");

    // 6. Collecting bills exactly the quoted parts; voiding the sale puts it back.
    v = (await orderView(a.shopId, o.id))!;
    const total = v.quoteCents;
    assert.match(await collectOrderFor(user(a), o.id, fd({ method: "CARD" })), /collected: sale #/);
    v = (await orderView(a.shopId, o.id))!;
    const sale = await db.sale.findFirstOrThrow({ where: { id: v.saleId!, shopId: a.shopId }, include: { lines: true } });
    assert.deepEqual([v.status, sale.totalCents, (sale.tenders as { method: string }[])[0].method], ["COLLECTED", total, "CARD"]);
    assert.ok(sale.lines.length >= 4, "garments, two decorations, digitizing and set-up are billed as lines");
    await voidSaleAs(user(a), sale.id, "wrong order");
    v = (await orderView(a.shopId, o.id))!;
    assert.deepEqual([v.status, v.saleId], ["READY", null], "voiding the sale puts the order back on the shelf");
    ok("collecting bills the quoted parts as a register sale in the payment picked; voiding it makes the order ready again");

    // 7. Lists and the customer delete.
    assert.ok((await ordersFor(a.shopId)).some((r) => r.id === o.id && r.pieces === 24));
    assert.ok((await ordersFor(a.shopId, { closed: true })).some((r) => r.id === t.id));
    const plan = await customerDeletePlan(user(a), (await orderView(a.shopId, o.id))!.customerId!);
    assert.ok(plan.blockers.some((x) => /Decorating order #\d+ isn't collected yet/.test(x)), "an open order blocks deleting the customer");
    ok("the lists (open soonest due, finished lately); an open order blocks deleting the customer");

    // 8. Tenant.
    await expectNotFound("B moves A's order", () => setOrderStatusFor(user(b), o.id, "APPROVED"));
    await expectNotFound("B collects A's order", () => collectOrderFor(user(b), o.id, fd({ method: "CASH" })));
    await expectNotFound("B turns down A's order", () => turnDownOrderFor(user(b), t.id, "no"));
    await expectNotFound("B adds to A's order", () => addLineFor(user(b), o.id, fd({ description: "Cap", qty: "1" })));
    await expectNotFound("B removes A's line", () => removeLineFor(user(b), o.id, v.lines[0].id));
    assert.equal(await orderView(b.shopId, o.id), null);
    assert.equal(await placementFile(b.shopId, pl.id), null);
    assert.deepEqual(await ordersFor(b.shopId), []);
    // B's own order can't touch A's lines or files either: ids from another company are not found
    const own = await createOrderFor(user(b), fd({ ...base, title: "B's order" }));
    await expectError("B removes A's line through its own order", () => removeLineFor(user(b), own.id, v.lines[0].id), /isn't on this order/);
    ok("tenant: B can't move, collect, turn down, change, read or download A's orders, nor reach A's lines through its own");
  } finally {
    await cleanup();
  }
  console.log(`decorating.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
