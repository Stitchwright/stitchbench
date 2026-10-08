// More than one store (shop-features-round-2-design.md 7.1, 7.2, 7.3, 7.5): a company with one store works as before
// (no Location row needed, nothing extra in the stock); a second store is added from the company's own details; stock
// per store (the main store's is the total less the others'), sent, asked for, held for a customer, counted on
// arrival, declined; sales at a store take its stock and its tax rate, and a void puts it back there; a refund over a
// store's limit needs a manager's code (used once) or the owner's yes; "ship it to her from there" takes the other
// store's stock and gives it a Ship this job (a void cancels it); a purchase order's share sent on; reorder per store
// and for every store; "sells faster at"; the online shop sells from the chosen store; counts per store; closing a store
// is refused while it has stock; and the tenant section.
//   npm run -s check scripts/checks/stores.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { activeStores, currentStore, isMultiStore, storesOf } from "@/lib/stores";
import { addStoreFor, saveStoreFor, setOnlineStoreFor, setStoreOpenFor } from "@/lib/stores-admin";
import { moveStock, storeQty, storeStockFor } from "@/lib/stock";
import { arrivedTransferFor, askStockFor, cancelTransferFor, declineAskedFor, sendAskedFor, sendStockFor, storeTodo, transfersFor } from "@/lib/transfers";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { approveWithCodeFor, askOwnerFor, decideApprovalFor, setApproveCodeFor } from "@/lib/approvals";
import { moveSuggestionsFor, reorderByStore, saveSplitFor, saveStoreLevelFor, sendShareFor } from "@/lib/store-orders";
import { countStock } from "@/lib/parts";
import { cancelSpecialOrderAs, takeSpecialOrderAs } from "@/lib/special-orders";
import { catalog } from "@/lib/shop/online-shop";
import { checkShop, cleanup } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

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

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    const A = a.shopId;
    await db.shop.update({ where: { id: A }, data: { taxRatePct: 6.25, address: "1 Main St, Boston MA" } });
    const part = await db.part.create({ data: { shopId: A, partNumber: "ST-1", description: "Walking foot", priceCents: 1000, costCents: 400, kind: "ACCESSORY", numberKeys: ["ST1"], supplier: "Notions Inc", reorderAt: 2 } });
    // checkShop is made the way sign-up makes a company: no Location row yet (a new company); null is the main store.
    await db.location.deleteMany({ where: { shopId: A } });

    // ---------- 1. one store: as before ----------
    assert.equal((await storesOf(A)).length, 0);
    assert.equal(await isMultiStore(A), false);
    assert.equal(await currentStore(a.user), null);
    await db.$transaction((tx) => moveStock(tx, { shopId: A, partId: part.id, locationId: null, qty: 10, reason: "RECEIVED", userId: a.user.id }));
    const s1 = await completeSaleAs(a.user, { lines: [{ partId: part.id, description: "Walking foot", qty: 1, unitPriceCents: 1000, taxable: true }], tenders: [{ method: "CASH", amountCents: 1063 }] });
    const sale1 = await db.sale.findUniqueOrThrow({ where: { id: s1.saleId } });
    assert.equal(sale1.taxRatePct, 6.25);
    assert.equal(sale1.locationId, null);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand, 9);
    assert.equal(await db.stockLevel.count({ where: { shopId: A } }), 0, "no store levels for a one-store company");
    assert.equal(await storeStockFor(A, [{ id: part.id, qtyOnHand: 9 }], null), null, "nothing extra to show");
    ok("one store, no Location row: sale at the company's rate, stock on Part only, nothing extra to show");

    // ---------- 2. add a second store ----------
    const tech = { ...a.user, id: (await db.user.create({ data: { shopId: A, email: `stores-tech-${Date.now()}@stitchbench.test`, name: "Tess Tech", role: "TECH", passwordHash: "x" } })).id, role: "TECH" as const, name: "Tess Tech" };
    await expectError("a tech adds a store", () => addStoreFor(tech, form({ name: "Florida" })), /Only the owner/);
    const fl = await addStoreFor(a.user, form({ name: "Florida", mainName: "Boston", address: "2 Gulf Rd, Naples FL", taxRatePct: "7", timeZone: "America/New_York" }));
    const stores = await activeStores(A);
    const main = stores.find((s) => s.main)!;
    assert.equal(stores.length, 2);
    assert.equal(main.name, "Boston");
    assert.equal(main.taxRatePct, 6.25, "the main store's details are the company's own");
    assert.equal(main.address, "1 Main St, Boston MA");
    assert.equal(fl.taxRatePct, 7);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: a.user.id } })).locationId, main.id, "staff home to the main store");
    await expectError("same name", () => addStoreFor(a.user, form({ name: "florida" })), /already called/);
    assert.equal(await isMultiStore(A), true);
    ok("add a second store: the main store made from the company's details and renamed, the new one with its own tax rate; owners only; names unique");

    const atMain: CurrentUser = { ...a.user, locationId: main.id };
    const atFl: CurrentUser = { ...a.user, locationId: fl.id };
    assert.equal((await currentStore(atFl))!.id, fl.id);
    assert.equal((await currentStore(a.user))!.id, main.id, "no device store: the person's home store");

    // ---------- 3. send, arrive with a count difference ----------
    assert.equal(await storeQty(db, A, part.id, main.id), 9);
    assert.equal(await storeQty(db, A, part.id, fl.id), 0);
    await expectError("send more than there", () => sendStockFor(atMain, { toId: fl.id, lines: [{ partId: part.id, qty: 20 }] }), /has only 9/);
    const t1 = await sendStockFor(atMain, { toId: fl.id, lines: [{ partId: part.id, qty: 4 }] });
    assert.equal(await storeQty(db, A, part.id, main.id), 5, "off the main shelf when sent");
    assert.equal(await storeQty(db, A, part.id, fl.id), 0, "not at Florida until it arrives");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand, 5, "on the way: on no shelf");
    assert.equal((await storeTodo(A, fl.id)).comingHere.length, 1, "Florida sees it coming");
    const tline = (await db.stockTransferLine.findFirstOrThrow({ where: { transferId: t1.id } })).id;
    const words = await arrivedTransferFor(atFl, t1.id, { [tline]: 3 });
    assert.match(words, /counted differently/);
    assert.equal(await storeQty(db, A, part.id, fl.id), 3);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand, 8, "the total is the stores' stock");
    const adj = await db.stockMove.findFirstOrThrow({ where: { shopId: A, partId: part.id, reason: "ADJUSTED", locationId: fl.id } });
    assert.equal(adj.qty, -1, "the difference is recorded at Florida");
    await expectError("arrived twice", () => arrivedTransferFor(atFl, t1.id), /arrived already/);
    ok("send 4: off Boston's shelf at once, on no shelf on the way, onto Florida's when it arrived; 3 counted, the 1 short an adjustment at Florida");

    // ---------- 4. ask, held for a customer, decline, send, cancel ----------
    const jane = await db.customer.create({ data: { shopId: A, name: "Jane Stores" } });
    const ask = await askStockFor(atFl, { fromId: main.id, lines: [{ partId: part.id, qty: 2 }], forCustomerId: jane.id, note: "For Jane by Friday" });
    assert.equal(ask.held, true);
    assert.equal(await storeQty(db, A, part.id, main.id), 3, "held for her at Boston from the start");
    assert.equal((await storeTodo(A, main.id)).askedOfUs.length, 1, "Boston sees the request");
    await declineAskedFor(atMain, ask.id, "Last two are spoken for");
    assert.equal(await storeQty(db, A, part.id, main.id), 5, "back on the shelf");
    assert.equal((await db.stockTransfer.findUniqueOrThrow({ where: { id: ask.id } })).declineReason, "Last two are spoken for");
    const ask2 = await askStockFor(atFl, { fromId: main.id, lines: [{ partId: part.id, qty: 2 }] });
    assert.equal(ask2.held, false);
    await sendAskedFor(atMain, ask2.id);
    assert.equal(await storeQty(db, A, part.id, main.id), 3);
    await cancelTransferFor(atMain, ask2.id);
    assert.equal(await storeQty(db, A, part.id, main.id), 5, "a cancelled transfer puts it back where it left");
    ok("ask: held for her at Boston, Can't this time puts it back with the reason; asked, sent, cancelled: back on Boston's shelf");

    // "Bring it here for her": her special order at Florida, Boston asked (held there), sent; on arrival it's here and held at Florida.
    const so = await takeSpecialOrderAs(atFl, { customerId: jane.id, partId: part.id, qty: 1, priceCents: 1000, depositCents: 0 });
    const soRow = await db.specialOrder.findUniqueOrThrow({ where: { id: so.id } });
    assert.equal(soRow.locationId, fl.id, "the order is Florida's");
    const bring = await askStockFor(atFl, { fromId: main.id, lines: [{ partId: part.id, qty: 1 }], forCustomerId: jane.id, specialOrderId: so.id });
    assert.equal(bring.held, true);
    await sendAskedFor(atMain, bring.id);
    const flBeforeHere = await storeQty(db, A, part.id, fl.id);
    await arrivedTransferFor(atFl, bring.id);
    const soHere = await db.specialOrder.findUniqueOrThrow({ where: { id: so.id } });
    assert.equal(soHere.status, "HERE", "her special order is here");
    assert.equal(soHere.heldQty, 1);
    assert.equal(await storeQty(db, A, part.id, fl.id), flBeforeHere, "arrived at Florida and held for her there");
    await cancelSpecialOrderAs(a.user, { id: so.id });
    assert.equal(await storeQty(db, A, part.id, fl.id), flBeforeHere + 1, "cancelled: on Florida's shelf");
    ok("bring it here for her: Florida's special order, held at Boston, sent, arrived: here and held at Florida (cancelled: on Florida's shelf)");

    // ---------- 5. a sale at Florida: its stock, its rate; a void puts it back there ----------
    const fl5 = await storeQty(db, A, part.id, fl.id);
    const main5 = await storeQty(db, A, part.id, main.id);
    const s2 = await completeSaleAs(atFl, { lines: [{ partId: part.id, description: "Walking foot", qty: 1, unitPriceCents: 1000, taxable: true }], tenders: [{ method: "CASH", amountCents: 1070 }] });
    const sale2 = await db.sale.findUniqueOrThrow({ where: { id: s2.saleId } });
    assert.equal(sale2.locationId, fl.id);
    assert.equal(sale2.taxRatePct, 7, "Florida's tax rate");
    assert.equal(await storeQty(db, A, part.id, fl.id), fl5 - 1);
    assert.equal(await storeQty(db, A, part.id, main.id), main5, "Boston's shelf untouched");
    await voidSaleAs(atMain, s2.saleId, "check");
    assert.equal(await storeQty(db, A, part.id, fl.id), fl5, "back on Florida's shelf, wherever it was voided");
    ok("a sale at Florida: Florida's stock and 7% tax; voided from Boston, the stock goes back to Florida");

    // ---------- 6. approvals over a store's limit ----------
    await saveStoreFor(a.user, fl.id, form({ name: "Florida", approveRefund: "15", approveDiscount: "20", taxRatePct: "7", timeZone: "America/New_York" }));
    const refundLine = { partId: part.id, description: "Walking foot", qty: -2, unitPriceCents: 1000, taxable: true };
    await expectError("refund over the limit", () => completeSaleAs(atFl, { lines: [refundLine], tenders: [{ method: "CASH", amountCents: -2140 }] }), /refund of \$21\.40, over this store's limit/);
    await expectError("a big discount", () => completeSaleAs(atFl, { lines: [{ ...refundLine, qty: 1, discountCents: 300 }], tenders: [{ method: "CASH", amountCents: 749 }] }), /30% discount/);
    // Promotions and price groups the shop set up aren't the cashier's discount: under 20% typed is fine.
    await completeSaleAs(atFl, { lines: [{ ...refundLine, qty: 1, discountCents: 100 }], tenders: [{ method: "CASH", amountCents: 963 }] });
    await expectError("a 4-digit code", () => setApproveCodeFor(a.user, "4321"), /6 to 8 numbers/);
    await setApproveCodeFor(a.user, "864213");
    await expectError("tech sets a code", () => setApproveCodeFor(tech, "111111"), /Only an owner or admin/);
    const need = { kind: "REFUND", amountCents: 2140, pct: null };
    await expectError("wrong code", () => approveWithCodeFor({ ...tech, locationId: fl.id }, fl, need, "000000", "Broken", {}), /isn't right/);
    // Five wrong codes at once (review fix: counted in the database before each check): the sixth try and the right code wait 15 minutes.
    const guesses = await Promise.allSettled([1, 2, 3, 4, 5, 6, 7, 8].map((g) => approveWithCodeFor({ ...tech, locationId: fl.id }, fl, need, String(100000 + g), "Guess", {})));
    assert.ok(guesses.some((x) => x.status === "rejected" && /Too many wrong codes/.test(String((x.reason as Error).message))), "guesses at the same moment trip the lock");
    await expectError("locked", () => approveWithCodeFor({ ...tech, locationId: fl.id }, fl, need, "864213", "x", {}), /Too many wrong codes. Wait 15 minutes/);
    await expectError("another person at the locked store", () => approveWithCodeFor({ ...a.user, locationId: fl.id }, fl, need, "864213", "x", {}), /Too many wrong codes/);
    await db.user.update({ where: { id: tech.id }, data: { approveFails: 0, approveLockedUntil: null } });
    await db.location.update({ where: { id: fl.id }, data: { approveFails: 0, approveLockedUntil: null } });
    // A 4-digit code set before codes were 6 still works (Settings asks her to change it).
    const salt = "0123456789abcdef01234567";
    const old4 = `scrypt:${salt}:${(await import("node:crypto")).scryptSync("4321", salt, 32).toString("hex")}`;
    await db.user.update({ where: { id: a.user.id }, data: { approveCode: old4, approveCodeOld: true } });
    const apId = await approveWithCodeFor({ ...tech, locationId: fl.id }, fl, need, "4321", "Broken in the box", { lines: [{ description: "Walking foot", qty: -2, unitPriceCents: 1000 }] });
    const ret = await completeSaleAs({ ...tech, locationId: fl.id }, { lines: [refundLine], tenders: [{ method: "CASH", amountCents: -2140 }], approvalId: apId });
    assert.ok(ret.saleId);
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: apId } })).status, "USED");
    await expectError("used twice", () => completeSaleAs({ ...tech, locationId: fl.id }, { lines: [refundLine], tenders: [{ method: "CASH", amountCents: -2140 }], approvalId: apId }), /over this store's limit/);
    const asked = await askOwnerFor({ ...tech, locationId: fl.id }, fl, need, "Regular customer", {});
    await expectError("a tech answers", () => decideApprovalFor(tech, asked.id, true, null), /Only the owner/);
    await decideApprovalFor(a.user, asked.id, false, "Store credit instead");
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: asked.id } })).status, "REFUSED");
    const asked2 = await askOwnerFor({ ...tech, locationId: fl.id }, fl, need, "Regular customer", {});
    await decideApprovalFor(a.user, asked2.id, true, null);
    await completeSaleAs({ ...tech, locationId: fl.id }, { lines: [refundLine], tenders: [{ method: "CASH", amountCents: -2140 }], approvalId: asked2.id });
    await expectError("answered twice", () => decideApprovalFor(a.user, asked2.id, true, null), /answered already/);
    await saveStoreFor(a.user, fl.id, form({ name: "Florida", approveRefund: "", approveDiscount: "", taxRatePct: "7", timeZone: "America/New_York" }));
    ok("a refund over Florida's $15 limit and a 30% discount are refused; a manager's code approves once; the owner says no, then yes; limits cleared");

    // ---------- 7. ship it to her from there ----------
    const flBefore = await storeQty(db, A, part.id, fl.id);
    const mainBefore = await storeQty(db, A, part.id, main.id);
    await expectError("no address", () => completeSaleAs(atFl, { customerId: jane.id, lines: [{ partId: part.id, description: "Walking foot", qty: 1, unitPriceCents: 1000, taxable: true, shipFromId: main.id }], tenders: [{ method: "CASH", amountCents: 1070 }] }), /address/);
    const s3 = await completeSaleAs(atFl, { customerId: jane.id, shipTo: "9 Palm Way, Naples FL", lines: [{ partId: part.id, description: "Walking foot", qty: 1, unitPriceCents: 1000, taxable: true, shipFromId: main.id }], tenders: [{ method: "CASH", amountCents: 1070 }] });
    assert.equal(await storeQty(db, A, part.id, main.id), mainBefore - 1, "off Boston's shelf");
    assert.equal(await storeQty(db, A, part.id, fl.id), flBefore, "Florida's untouched");
    const job = await db.webOrder.findFirstOrThrow({ where: { shopId: A, saleId: s3.saleId } });
    assert.equal(job.source, "store");
    assert.equal(job.locationId, main.id);
    assert.equal(job.status, "PAID");
    assert.equal(job.fulfil, "ship");
    assert.equal(job.address, "9 Palm Way, Naples FL");
    await voidSaleAs(atFl, s3.saleId, "check");
    assert.equal((await db.webOrder.findUniqueOrThrow({ where: { id: job.id } })).status, "CANCELLED", "the void cancels the shipping");
    assert.equal(await storeQty(db, A, part.id, main.id), mainBefore, "and the stock is back at Boston");
    // One sale with the same item from both stores (one from here, one shipped from Boston): the void puts each back where it came from.
    const s4 = await completeSaleAs(atFl, { customerId: jane.id, shipTo: "9 Palm Way, Naples FL", lines: [{ partId: part.id, description: "Walking foot", qty: 1, unitPriceCents: 1000, taxable: true }, { partId: part.id, description: "Walking foot", qty: 1, unitPriceCents: 1000, taxable: true, shipFromId: main.id }], tenders: [{ method: "CASH", amountCents: 2140 }] });
    await voidSaleAs(atFl, s4.saleId, "check");
    assert.equal(await storeQty(db, A, part.id, main.id), mainBefore, "Boston's one back at Boston");
    assert.equal(await storeQty(db, A, part.id, fl.id), flBefore, "Florida's one back at Florida");
    ok("ship it to her from Boston: sold at Florida, Boston's stock, a Ship this job at Boston with her address; the void cancels it and puts it back");

    // ---------- 8. one purchase order for both stores ----------
    const sup = await db.fabricSupplier.create({ data: { shopId: A, name: "Notions Inc" } });
    const po = await db.purchaseOrder.create({ data: { shopId: A, number: 1, supplierId: sup.id, supplierName: sup.name, status: "SENT", locationId: main.id, lines: { create: { shopId: A, partId: part.id, itemNumber: "ST-1", description: "Walking foot", unit: "EACH", qty: 12 } } }, include: { lines: true } });
    const pl = po.lines[0];
    await expectError("split over the line", () => saveSplitFor(a.user, po.id, form({ [`split.${pl.id}.${fl.id}`]: "13" })), /more than the 12 ordered/);
    await saveSplitFor(a.user, po.id, form({ [`split.${pl.id}.${fl.id}`]: "6" }));
    await expectError("not come yet", () => sendShareFor(atMain, po.id, fl.id), /hasn't come in/);
    await db.purchaseOrder.update({ where: { id: po.id }, data: { status: "RECEIVED" } });
    await db.purchaseOrderLine.update({ where: { id: pl.id }, data: { receivedYards: 12 } });
    await db.$transaction((tx) => moveStock(tx, { shopId: A, partId: part.id, locationId: main.id, qty: 12, reason: "RECEIVED", userId: a.user.id, note: "Order #1" }));
    const mainNow = await storeQty(db, A, part.id, main.id);
    assert.match(await sendShareFor(atMain, po.id, fl.id), /Florida's share is on its way/);
    assert.equal(await storeQty(db, A, part.id, main.id), mainNow - 6);
    await expectError("share twice", () => sendShareFor(atMain, po.id, fl.id), /went on transfer/);
    ok("one order for both stores: 12, 6 for Florida (13 refused); Send Florida's share once the box is in, once");

    // ---------- 9. reorder per store and for every store; sells faster at ----------
    const flStock = await storeQty(db, A, part.id, fl.id);
    await saveStoreLevelFor(a.user, part.id, fl.id, form({ reorderAt: String(flStock + 2), bin: "F-3" }));
    const lvl = await db.stockLevel.findFirstOrThrow({ where: { partId: part.id, locationId: fl.id } });
    assert.equal(lvl.bin, "F-3");
    const hereRows = await reorderByStore(A, fl, "here");
    assert.ok(hereRows.some((r) => r.id === part.id), "low at Florida");
    const allRows = await reorderByStore(A, main, "all");
    const row = allRows.find((r) => r.id === part.id)!;
    assert.ok(row && row.split[fl.id] > 0, "the combined order keeps Florida's share");
    // A new item: 5 at Boston, 3 at Florida; sold 3 at Florida in the window, none at Boston: it sells faster at Florida.
    const slow = await db.part.create({ data: { shopId: A, partNumber: "ST-3", description: "Bobbin box", priceCents: 1000, kind: "NOTION", numberKeys: ["ST3"] } });
    await db.$transaction(async (tx) => {
      await moveStock(tx, { shopId: A, partId: slow.id, locationId: main.id, qty: 5, reason: "RECEIVED" });
      await moveStock(tx, { shopId: A, partId: slow.id, locationId: fl.id, qty: 3, reason: "RECEIVED" });
    });
    for (let i = 0; i < 3; i++) await completeSaleAs(atFl, { lines: [{ partId: slow.id, description: "Bobbin box", qty: 1, unitPriceCents: 1000, taxable: true }], tenders: [{ method: "CASH", amountCents: 1070 }] });
    const sugg = await moveSuggestionsFor(A, main);
    const sg = sugg.find((x) => x.partId === slow.id);
    assert.ok(sg && sg.to.id === fl.id && /Sells faster at Florida \(3 in 8 weeks there, none here\)/.test(sg.words), JSON.stringify(sugg));
    assert.deepEqual(await moveSuggestionsFor(A, fl), [], "nothing to send from Florida");
    ok("Florida's own reorder point and bin; low at Florida; All stores keeps each store's share; Sells faster at Florida (3 in 8 weeks there, none here)");

    // ---------- 10. the online shop sells from the chosen store ----------
    await db.part.update({ where: { id: part.id }, data: { online: true } });
    const empty = await db.part.create({ data: { shopId: A, partNumber: "ST-2", description: "Seam ripper", priceCents: 500, kind: "NOTION", numberKeys: ["ST2"], online: true } });
    await db.$transaction((tx) => moveStock(tx, { shopId: A, partId: empty.id, locationId: main.id, qty: 4, reason: "RECEIVED" }));
    const seen = async () => new Map((await catalog(A)).map((c) => [c.id, c.inStock]));
    assert.equal((await seen()).get(empty.id), true, "in stock at Boston (the main store sells online)");
    await setOnlineStoreFor(a.user, fl.id);
    assert.equal((await seen()).get(empty.id), false, "none at Florida once Florida sells online");
    await setOnlineStoreFor(a.user, main.id);
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: A } })).onlineLocationId, null, "the main store is null");
    ok("the online shop's stock is the chosen store's (Boston: in stock; Florida: out)");

    // ---------- 11. counts per store; closing a store ----------
    await countStock(A, empty.id, 1, a.user.id, "Shelf count", fl.id);
    assert.equal(await storeQty(db, A, empty.id, fl.id), 1);
    assert.equal(await storeQty(db, A, empty.id, main.id), 4, "Boston's count untouched");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: empty.id } })).qtyOnHand, 5);
    await expectError("close the main store", () => setStoreOpenFor(a.user, main.id, false), /main store can't be closed/);
    await expectError("close with stock", () => setStoreOpenFor(a.user, fl.id, false), /still has/);
    ok("a count at Florida sets Florida's shelf only; the main store can't close; a store with stock can't close");

    // ---------- 12. tenant ----------
    const snapA = await snapshot(A, ["Location", "StockLevel", "StockTransfer", "Approval", "Part"]);
    const B = { ...b.user };
    await expectNotFound("B sends A's item", () => sendStockFor(B, { toId: fl.id, fromId: main.id, lines: [{ partId: part.id, qty: 1 }] }));
    await expectNotFound("B marks A's transfer arrived", () => arrivedTransferFor(B, t1.id));
    await expectNotFound("B cancels A's transfer", () => cancelTransferFor(B, ask2.id));
    await expectNotFound("B decides A's approval", () => decideApprovalFor(B, asked.id, true, null));
    await expectNotFound("B saves A's store", () => saveStoreFor(B, fl.id, form({ name: "Mine" })));
    await expectNotFound("B closes A's store", () => setStoreOpenFor(B, fl.id, false));
    await expectNotFound("B sends A's order share", () => sendShareFor(B, po.id, fl.id));
    await expectNotFound("B splits A's order", () => saveSplitFor(B, po.id, form({})));
    assert.deepEqual(await transfersFor(b.shopId), []);
    assert.deepEqual(await storesOf(b.shopId).then((s) => s.map((x) => x.id).filter((id) => [main.id, fl.id].includes(id))), []);
    assertUnchanged("company A", snapA, await snapshot(A, ["Location", "StockLevel", "StockTransfer", "Approval", "Part"]));
    ok("tenant: B can't send, receive, cancel, approve, change, close, split or send a share of A's; A's rows unchanged");

    console.log(`stores.check: ${steps} groups passed`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
