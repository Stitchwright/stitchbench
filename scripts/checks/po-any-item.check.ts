// Purchase orders for any item (shop-features-round-2-design.md 1.1, package po-any-item): the pieces math (EACH lines,
// amounts in words, the suggestion from an item's own reorder point), "Running low" on real rows (kits, fabric's cut items,
// consigned stock and fabric by the yard left out; what is on a sent order counted), ticking items onto one draft per
// supplier beside fabric, lines by hand (always pieces for an item sold each), a tech can't set a cost, send, receiving
// pieces into stock, the CSV, "Order more" from an item's page, and the tenant section.
//   npm run check scripts/checks/po-any-item.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { addItemsToDraftFor, addLineFor, orderCsvRows, orderFor, orderOneFor, orderText, receiveOrderFor, reorderEachFor, saveOrderFor, sendOrderFor } from "@/lib/fabric-orders";
import { amountText, eachSuggestion, lineCostTotal, lineYards, orderAmountText, outstandingYards, statusAfterReceive } from "@/lib/fabric-orders-math";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });

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

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function item(shopId: string, number: string, o: { qty: number; reorderAt: number; supplier?: string | null; kind?: "NOTION" | "THREAD" | "SUPPLY" | "PART" | "FABRIC"; unit?: string | null; cost?: number | null }) {
  return db.part.create({
    data: {
      shopId,
      partNumber: number,
      numberKeys: [number.replace(/[^A-Z0-9]/gi, "").toUpperCase()],
      description: `Item ${number}`,
      kind: o.kind ?? "NOTION",
      unit: o.unit ?? null,
      supplier: o.supplier === undefined ? "Notions Marketing" : o.supplier,
      qtyOnHand: o.qty,
      reorderAt: o.reorderAt,
      costCents: o.cost === undefined ? 250 : o.cost,
      priceCents: 599,
    },
  });
}

async function main() {
  const a = await checkShop({ retail: true, repair: true });
  const b = await checkShop({ retail: true });
  try {
    // 1. The math.
    const each = { unit: "EACH" as const, qty: 12, boltYards: 15, costCents: 250, receivedYards: 5 };
    assert.deepEqual([lineYards(each), outstandingYards(each), lineCostTotal(each)], [12, 7, 3000]);
    assert.equal(outstandingYards({ ...each, receivedYards: 20 }), 0, "an over-delivery leaves nothing outstanding");
    assert.equal(statusAfterReceive([each]), "PARTLY_RECEIVED");
    assert.equal(statusAfterReceive([{ ...each, receivedYards: 12 }]), "RECEIVED");
    assert.deepEqual([amountText(each), amountText({ unit: "BOLT", qty: 1.5, boltYards: 15 }), amountText({ unit: "YD", qty: 3.5, boltYards: 15 })], ["12", "1.5 bolts (22 1/2 yd)", "3 1/2 yd"]);
    assert.equal(orderAmountText([each, { unit: "BOLT", qty: 2, boltYards: 15 }]), "30 yd and 12 pieces");
    assert.equal(orderAmountText([{ ...each, qty: 1 }]), "1 piece");
    assert.deepEqual([eachSuggestion({ reorderAt: 5, onHand: 2, onOrder: 0 }), eachSuggestion({ reorderAt: 5, onHand: 2, onOrder: 4 }), eachSuggestion({ reorderAt: 5, onHand: 5, onOrder: 0 }), eachSuggestion({ reorderAt: 0, onHand: 0, onOrder: 0 }), eachSuggestion({ reorderAt: 0.5, onHand: 0, onOrder: 0 })], [8, 0, 5, 0, 1]);
    ok("pieces: 12 ordered, 5 came, 7 to come, $30.00; amounts in words; the suggestion brings stock up to twice the reorder point (on order counts)");

    // 2. Running low on real rows.
    const pins = await item(a.shopId, "PIN-1", { qty: 2, reorderAt: 5 });
    const thread = await item(a.shopId, "ISA-0015", { qty: 0, reorderAt: 3, kind: "THREAD" });
    await item(a.shopId, "PLENTY-1", { qty: 9, reorderAt: 5 });
    await item(a.shopId, "NOPOINT-1", { qty: 0, reorderAt: 0 });
    const loose = await item(a.shopId, "LOOSE-1", { qty: 1, reorderAt: 4, supplier: null });
    const fabric = await item(a.shopId, "FAB-1", { qty: 1, reorderAt: 5, kind: "FABRIC", unit: "yd", supplier: "Notions Marketing" });
    const kitStock = await item(a.shopId, "KIT-1", { qty: 0, reorderAt: 2 });
    await db.kit.create({ data: { shopId: a.shopId, name: "Table runner kit", partId: kitStock.id } });
    const fq = await item(a.shopId, "FQ-1", { qty: 0, reorderAt: 4 });
    await db.part.update({ where: { id: fabric.id }, data: { fatQuarterId: fq.id } });
    const link = await db.partnerLink.create({ data: { id: `chkpo${Date.now().toString(36)}`, shopId: a.shopId, side: "retail", partnerName: "Repair Co" } });
    await db.part.create({ data: { shopId: a.shopId, partNumber: "CON-1", numberKeys: ["CON1"], description: "Consigned", qtyOnHand: 0, reorderAt: 3, consignLinkId: link.id, consignItemKey: "x", supplier: "Notions Marketing" } });
    let low = await reorderEachFor(a.shopId);
    assert.deepEqual(low.map((r) => r.partNumber), ["ISA-0015", "PIN-1", "LOOSE-1"], "with a supplier first; kits, fabric's cut items, consigned stock, fabric by the yard and items above their point left out");
    assert.deepEqual([low[0].suggest, low[1].suggest, low[2].supplier], [6, 8, null]);
    ok("running low: items at or below their own point, kits / cut items / consigned / yardage left out, no supplier last");

    // 3. Ticked items onto drafts (one per supplier, fabric beside them).
    await expectError("no supplier", () => addItemsToDraftFor(user(a), [{ partId: loose.id, qty: 3 }]), /Give LOOSE-1 a supplier/);
    await expectError("half a pin", () => addItemsToDraftFor(user(a), [{ partId: pins.id, qty: 1.5 }]), /whole number of pieces/);
    await expectError("fabric in quarter bolts", () => addItemsToDraftFor(user(a), [{ partId: fabric.id, qty: 0.25 }]), /halves/);
    const text = await addItemsToDraftFor(user(a), [
      { partId: pins.id, qty: 8 },
      { partId: thread.id, qty: 6 },
      { partId: fabric.id, qty: 1 },
    ]);
    assert.match(text, /order #1 \(Notions Marketing, 3 lines\)/);
    await addItemsToDraftFor(user(a), [{ partId: pins.id, qty: 10 }]);
    const po = await db.purchaseOrder.findFirstOrThrow({ where: { shopId: a.shopId, status: "DRAFT" } });
    let o = (await orderFor(a.shopId, po.id))!;
    const line = (pn: string) => o.lines.find((l) => l.itemNumber === pn)!;
    assert.deepEqual([o.lines.length, line("PIN-1").unit, line("PIN-1").qty, line("FAB-1").unit, line("FAB-1").qty, o.amountText], [3, "EACH", 10, "BOLT", 1, "15 yd and 16 pieces"]);
    low = await reorderEachFor(a.shopId);
    assert.equal(low.find((r) => r.partNumber === "PIN-1")!.inDraft, 10, "a draft is shown, not counted as on order");
    ok("ticked items: one draft per supplier with the fabric beside them, pieces and bolts, the same item sets its amount; refusals by name");

    // 4. Lines by hand: an item sold each is always pieces; a tech can't set a cost.
    const tape = await item(a.shopId, "TAPE-1", { qty: 4, reorderAt: 1, cost: 125 });
    await addLineFor(user(a), po.id, fd({ itemNumber: "tape-1 | Item TAPE-1", qty: "3", unit: "YD" }));
    o = (await orderFor(a.shopId, po.id))!;
    assert.deepEqual([line("TAPE-1").unit, line("TAPE-1").qty, line("TAPE-1").costCents], ["EACH", 3, 125], "pieces whatever the form says, at the item's own cost");
    await expectError("a tech types a cost", () => addLineFor(tech(a), po.id, fd({ itemNumber: "PLENTY-1", qty: "2", cost: "1.00" })), /Only an owner or admin/);
    const tapeLine = line("TAPE-1").id;
    await saveOrderFor(tech(a), po.id, fd({ ...Object.fromEntries(o.lines.map((l) => [`qty.${l.id}`, String(l.qty)])), [`unit.${tapeLine}`]: "BOLT", [`qty.${tapeLine}`]: "4", [`cost.${tapeLine}`]: "0.01" }));
    o = (await orderFor(a.shopId, po.id))!;
    assert.deepEqual([line("TAPE-1").unit, line("TAPE-1").qty, line("TAPE-1").costCents], ["EACH", 4, 125], "a tech's save changes the amount, keeps the cost; EACH stays EACH");
    await expectError("fractional pieces on save", () => saveOrderFor(user(a), po.id, fd({ ...Object.fromEntries(o.lines.map((l) => [`qty.${l.id}`, String(l.qty)])), [`qty.${tapeLine}`]: "2.5" })), /whole number of pieces/);
    ok("by hand: an item sold each goes on in pieces at its own cost; a tech can't type a cost and a tech's save keeps it");

    // 5. Send, the text and the CSV, receive pieces.
    await sendOrderFor(user(a), po.id, "manual");
    o = (await orderFor(a.shopId, po.id))!;
    assert.match(orderText(o), /PIN-1  Item PIN-1  10  @ \$2\.50 each/);
    assert.match(orderText(o), /Total: 15 yd and 20 pieces/);
    const csv = orderCsvRows(o);
    const pinRow = csv.find((r) => r[0] === "PIN-1")!;
    assert.deepEqual([pinRow[2], pinRow[3], pinRow[4]], [10, "each", ""], "the CSV: quantity, unit each, no yards");
    low = await reorderEachFor(a.shopId);
    assert.ok(!low.some((r) => r.partNumber === "PIN-1"), "10 coming: PIN-1 isn't running low any more");
    await expectError("half a piece came", () => receiveOrderFor(user(a), po.id, fd({ [`yards.${line("PIN-1").id}`]: "2.5" })), /whole number of pieces/);
    const msg = await receiveOrderFor(user(a), po.id, fd({ [`yards.${line("PIN-1").id}`]: "6", [`yards.${line("FAB-1").id}`]: "15" }));
    assert.match(msg, /Received 15 yd and 6 pieces on 2 lines of order #1/);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: pins.id } })).qtyOnHand, 8);
    assert.equal((await db.stockMove.findFirstOrThrow({ where: { partId: pins.id, reason: "RECEIVED" } })).qty, 6);
    o = (await orderFor(a.shopId, po.id))!;
    assert.deepEqual([o.status, outstandingYards(line("PIN-1"))], ["PARTLY_RECEIVED", 4]);
    await receiveOrderFor(user(a), po.id, fd(Object.fromEntries(o.lines.map((l) => [`yards.${l.id}`, String(outstandingYards(l))]))));
    assert.equal((await orderFor(a.shopId, po.id))!.status, "RECEIVED");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: thread.id } })).qtyOnHand, 6);
    ok("send and receive: the text and CSV read in pieces, a sent order counts as coming, pieces received into stock with a RECEIVED move, partly then all in");

    // 6. Order more from an item's page.
    assert.match(await orderOneFor(user(a), tape.id, 5), /order #2 \(Notions Marketing, 1 line\)/);
    await expectError("no supplier", () => orderOneFor(user(a), loose.id, 1), /a supplier first/);
    ok("Order more: onto a new draft for the item's supplier; refused without a supplier");

    // 7. Tenant.
    await expectError("B orders A's item", () => addItemsToDraftFor(user(b), [{ partId: pins.id, qty: 1 }]), /isn't in your inventory/);
    await expectError("B orders more of A's item", () => orderOneFor(user(b), tape.id, 1), /isn't in your inventory/);
    await expectNotFound("B adds to A's order", () => addLineFor(user(b), po.id, fd({ itemNumber: "PIN-1", qty: "1" })));
    assert.deepEqual(await reorderEachFor(b.shopId), [], "B sees none of A's items");
    ok("tenant: B can't order A's items or add to A's order, and sees none of A's");
  } finally {
    await cleanup();
  }
  console.log(`po-any-item.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
