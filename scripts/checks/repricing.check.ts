// Raise prices, the margin floor and back orders (shop-features-round-2-design.md 4.4): the rounding and margin math, a
// raise by supplier previewed and written (an item changed meanwhile left alone), Undo within a day (and not after, and
// not twice), the margin floor saved and its items raised to the floor, a tech refused, a purchase order line marked back
// ordered with its day, the Coming in list with who's waiting, "Let them know" queued once, and the tenant section.
//   npm run -s check scripts/checks/repricing.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { modelKey } from "@/lib/format";
import { floorPrice, floorsOf, marginPct, raised, roundUp, underFloor } from "@/lib/repricing-math";
import { applyRaiseFor, previewRaise, raiseChoices, recentRaises, ruleFrom, saveFloorsFor, underFloorCount, undoRaiseFor } from "@/lib/repricing";
import { clearBackorderFor, comingIn, letThemKnowFor, markBackorderFor } from "@/lib/backorders";
import { checkShop, cleanup, clearKick, messagingFor, withSink } from "./lib";
import { expectNotFound } from "./tenant";

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
  await withSink();
  const a = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
  const b = await checkShop({ retail: true });
  const tech = { ...a.user, role: "TECH" as const };
  try {
    // 1. The math.
    assert.deepEqual([roundUp(1210, "99"), roundUp(1299, "99"), roundUp(1201, "25"), roundUp(1250, "50"), roundUp(1251, "50"), roundUp(1200.2, "1")], [1299, 1299, 1225, 1250, 1300, 1201]);
    assert.equal(raised(1000, 10, "99"), 1199);
    assert.equal(raised(1299, 0.5, "99"), 1399, "rounded up, never below the raise");
    assert.equal(Math.round(marginPct(1000, 600)!), 40);
    assert.equal(floorPrice(1000, 700, 40, "99"), 1199, "700 / 0.6 = 1166.7, up to 11.99");
    const f = floorsOf({ all: 40, FABRIC: 50, bad: 3, NOTION: 120 });
    assert.deepEqual(f, { all: 40, FABRIC: 50 });
    assert.ok(underFloor({ priceCents: 1000, costCents: 650, kind: "NOTION" }, f) && !underFloor({ priceCents: 1000, costCents: 550, kind: "NOTION" }, f) && underFloor({ priceCents: 1000, costCents: 550, kind: "FABRIC" }, f));
    ok("rounding up (.99, 25 and 50 cents, the cent), a raise never lower, margins, floors read safely and per kind");

    // 2. A raise by supplier: preview, write, an item changed meanwhile left alone.
    const mk = (n: string, d: Record<string, unknown>) => db.part.create({ data: { shopId: a.shopId, partNumber: n, description: `Item ${n}`, numberKeys: [n], kind: "NOTION", ...d } as Parameters<typeof db.part.create>[0]["data"] });
    const p1 = await mk("RP-1", { supplier: "Checker", priceCents: 1000, costCents: 500 });
    const p2 = await mk("RP-2", { supplier: "checker", priceCents: 450, costCents: 300 });
    const p3 = await mk("RP-3", { supplier: "Brewer", priceCents: 800, costCents: 600 });
    await mk("RP-4", { supplier: "Checker", priceCents: null });
    const ch = await raiseChoices(a.shopId);
    assert.ok(ch.supplier.includes("Brewer") && ch.supplier.some((s) => /checker/i.test(s)));
    await expectError("no whose", () => Promise.resolve(ruleFrom({ whose: "", pct: 10 })), /whose/);
    await expectError("no percent", () => Promise.resolve(ruleFrom({ whose: "supplier", value: "Checker", pct: null })), /how much/);
    const rule = ruleFrom({ whose: "supplier", value: "CHECKER", pct: 10, round: "99" });
    const prev = await previewRaise(a.shopId, rule);
    assert.deepEqual(prev.map((l) => [l.partNumber, l.oldCents, l.newCents]), [["RP-1", 1000, 1199], ["RP-2", 450, 499]], "any case; no price, no line");
    await expectError("a tech raising", () => applyRaiseFor(tech, rule), /owner or admin/);
    const r1 = await applyRaiseFor(a.user, rule);
    assert.equal(r1.count, 2);
    assert.deepEqual((await db.part.findMany({ where: { id: { in: [p1.id, p2.id, p3.id] } }, orderBy: { partNumber: "asc" } })).map((p) => p.priceCents), [1199, 499, 800]);
    ok("a raise by supplier (any case): the preview's old and new prices, written; a tech refused; other suppliers untouched");

    // 3. Undo: back for a day, an item changed since left alone; not twice, not after a day.
    await db.part.update({ where: { id: p2.id }, data: { priceCents: 525 } });
    await expectError("a tech undoing", () => undoRaiseFor(tech, r1.id), /owner or admin/);
    const u = await undoRaiseFor(a.user, r1.id);
    assert.deepEqual(u, { back: 1, left: 1 });
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: p1.id } })).priceCents, 1000);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: p2.id } })).priceCents, 525, "changed since: left");
    await expectError("twice", () => undoRaiseFor(a.user, r1.id), /undone already/);
    const r2 = await applyRaiseFor(a.user, ruleFrom({ whose: "kind", value: "NOTION", pct: 5, round: "25" }));
    await expectError("after a day", () => undoRaiseFor(a.user, r2.id, new Date(Date.now() + 25 * 3_600_000)), /for a day/);
    const list = await recentRaises(a.shopId);
    assert.ok(list[0].id === r2.id && list[0].canUndo && list[1].undoneAt && !list[1].canUndo);
    ok("Undo puts back what it raised (an item changed since is left), only once and only for a day");

    // 4. The margin floor: saved, counted, raised to the floor.
    await expectError("a bad floor", () => saveFloorsFor(a.user, form({ floor_all: "120" })), /1 to 95/);
    await expectError("a tech", () => saveFloorsFor(tech, form({ floor_all: "40" })), /owner or admin/);
    assert.equal(await underFloorCount(a.shopId), 0, "off: nothing");
    await saveFloorsFor(a.user, form({ floor_all: "40%", floor_FABRIC: "", floor_NOTION: "45" }));
    assert.deepEqual(floorsOf((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).marginFloor), { all: 40, NOTION: 45 });
    await db.part.update({ where: { id: p3.id }, data: { costCents: 700 } }); // a cost rise
    const under = await underFloorCount(a.shopId);
    assert.ok(under >= 1);
    const fl = await previewRaise(a.shopId, ruleFrom({ whose: "floor", round: "99" }));
    const l3 = fl.find((l) => l.partId === p3.id)!;
    assert.ok(l3 && l3.newCents === 1299 && Math.round(l3.marginAfter!) >= 45, "700 / 0.55 = 12.73 -> 12.99");
    await applyRaiseFor(a.user, ruleFrom({ whose: "floor", round: "99" }));
    assert.equal(await underFloorCount(a.shopId), 0);
    ok("the margin floor saved (per kind, forgiving), its items counted, and raised up to the floor");

    // 5. Back orders: marked on a sent order's line, Coming in, Let them know once.
    await messagingFor(a.shopId, { email: true });
    const sup = await db.fabricSupplier.create({ data: { shopId: a.shopId, name: "Checker" } });
    const po = await db.purchaseOrder.create({ data: { shopId: a.shopId, number: 1, supplierId: sup.id, supplierName: "Checker", status: "SENT", sentAt: new Date() } });
    const line = await db.purchaseOrderLine.create({ data: { shopId: a.shopId, orderId: po.id, partId: p1.id, itemNumber: "RP-1", description: "Item RP-1", unit: "EACH", qty: 3 } });
    const draft = await db.purchaseOrder.create({ data: { shopId: a.shopId, number: 2, supplierId: sup.id, supplierName: "Checker" } });
    const dline = await db.purchaseOrderLine.create({ data: { shopId: a.shopId, orderId: draft.id, partId: p1.id, itemNumber: "RP-1", description: "Item RP-1", unit: "EACH", qty: 1 } });
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Backorder", email: "jane-bo@example.test", notifyBy: "email" } });
    const m = await db.machine.create({ data: { shopId: a.shopId, customerId: jane.id, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
    const t = await db.ticket.create({ data: { shopId: a.shopId, number: 9001, status: "WAITING_PARTS", machineId: m.id, customerId: jane.id, intake: {} } });
    await db.partWait.create({ data: { shopId: a.shopId, ticketId: t.id, partId: p1.id, description: "Bobbin case" } });
    await expectError("a draft's line", () => markBackorderFor(a.user, dline.id, null), /sent order/);
    await expectError("a bad day", () => markBackorderFor(a.user, line.id, "20 Nov"), /day/);
    await markBackorderFor(a.user, line.id, null);
    await expectError("no day yet", () => letThemKnowFor(a.user, line.id), /day it's expected/);
    await markBackorderFor(a.user, line.id, "2026-11-20");
    const ci = await comingIn(a.shopId);
    assert.equal(ci.length, 1, "the draft isn't coming in");
    assert.ok(ci[0].backordered && ci[0].expectedOn === "2026-11-20" && ci[0].stillToCome === "3" && ci[0].waiting[0]?.name === "Jane Backorder");
    assert.match(await letThemKnowFor(a.user, line.id), /Told 1 customer it's delayed until about Nov 20, 2026/);
    await letThemKnowFor(a.user, line.id);
    const msgs = await db.outMessage.findMany({ where: { shopId: a.shopId, refType: "po_line", refId: line.id } });
    assert.equal(msgs.length, 1, "never twice for the same day");
    assert.ok(msgs[0].body.includes("Hi Jane") && msgs[0].body.includes("Bobbin case") && msgs[0].body.includes("Nov 20, 2026"));
    assert.equal((await db.partWait.findFirstOrThrow({ where: { ticketId: t.id } })).expectedOn, "2026-11-20");
    await clearBackorderFor(a.user, line.id);
    assert.ok(!(await comingIn(a.shopId))[0].backordered);
    ok("a sent order's line back ordered with its day (a draft's refused); Coming in shows it with Jane waiting; Let them know tells her once");

    // 6. Tenant.
    await expectNotFound("B undoes A's raise", () => undoRaiseFor(b.user, r2.id));
    await expectNotFound("B marks A's line", () => markBackorderFor(b.user, line.id, null));
    await expectNotFound("B clears A's line", () => clearBackorderFor(b.user, line.id));
    await expectNotFound("B tells A's customers", () => letThemKnowFor(b.user, line.id));
    const before = (await db.part.findUniqueOrThrow({ where: { id: p1.id } })).priceCents;
    await expectError("B raises a supplier only A has", () => applyRaiseFor(b.user, ruleFrom({ whose: "supplier", value: "Checker", pct: 50 })), /No prices to change/);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: p1.id } })).priceCents, before);
    assert.deepEqual(await comingIn(b.shopId), []);
    assert.deepEqual((await raiseChoices(b.shopId)).supplier, []);
    ok("tenant: another company can't undo, mark, clear or tell on A's records, nor raise A's prices or see its lists");

    console.log(`repricing.check: ${steps} groups passed`);
  } finally {
    clearKick();
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
