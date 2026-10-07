// Maker Shop's Supplies due (shop-features-round-2-design.md 6.3, package supplies-due): the running-low date (her own
// pace, the last purchase, the machine's sale), the list on real rows (printers and cutters sold here only, a week ahead,
// the item types that count for each kind, what to offer), Called / Snooze / Stop, the Maker Shop gate, the one-off send
// needing Marketing, the worker's still-wanted check, the Maker Shop module itself, and the tenant section.
//   npm run check scripts/checks/supplies-due.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { MODULES, PAID_MODULE_IDS } from "@/lib/module-info";
import { getModules } from "@/lib/modules";
import { receiveUnitsFor } from "@/lib/units/units";
import { completeSaleAs } from "@/lib/register-sale";
import { markSuppliesCalledFor, runningLowAt, sendSuppliesRemindersFor, snoozeSuppliesFor, stopSuppliesFor, suppliesDue, suppliesStillWanted } from "@/lib/supplies-due";
import { grantDevLicense } from "../license/dev";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

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

async function main() {
  // 1. The date.
  const sold = new Date("2026-01-01T12:00:00Z");
  assert.deepEqual(runningLowAt([], sold, 42), { at: new Date("2026-02-12T12:00:00Z"), from: "the machine's sale", gapDays: 42 });
  assert.equal(runningLowAt([new Date("2026-02-01T12:00:00Z")], sold, 42).at.toISOString(), "2026-03-15T12:00:00.000Z");
  const pace = runningLowAt([new Date("2026-02-01T12:00:00Z"), new Date("2026-03-03T12:00:00Z"), new Date("2026-04-02T12:00:00Z")], sold, 42);
  assert.deepEqual([pace.from, pace.gapDays, pace.at.toISOString()], ["her pace", 30, "2026-05-02T12:00:00.000Z"]);
  assert.equal(runningLowAt([new Date("2026-02-01T12:00:00Z"), new Date("2026-02-02T12:00:00Z")], sold, 42).gapDays, 14, "a gap is at least two weeks");
  assert.ok(PAID_MODULE_IDS.includes("maker") && MODULES.maker.label === "Maker Shop", "the Maker Shop module");
  ok("running low: her own pace (at least two weeks), six weeks after her last, or after the machine's sale; the Maker Shop module is listed");

  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    // 2. Without the module.
    assert.equal((await getModules(a.shopId)).states.maker.active, false);
    await expectError("no Maker Shop", () => markSuppliesCalledFor(user(a), "cxxxxxxxxxxxxxxxxxxxxxxxx"), /Maker Shop/);
    await grantDevLicense(a.shopId, ["maker"], { from: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10) });
    assert.equal((await getModules(a.shopId)).states.maker.active, true);

    // 3. The list.
    const mae = await db.customer.create({ data: { shopId: a.shopId, name: "Mae Maker", phone: "555-0101" } });
    const tim = await db.customer.create({ data: { shopId: a.shopId, name: "Tim Tinker" } });
    const pla = await db.part.create({ data: { shopId: a.shopId, partNumber: "PLA-BLK", numberKeys: ["PLABLK"], description: "Bambu PLA black", kind: "SUPPLY", itemType: "filament", qtyOnHand: 5, priceCents: 2499 } });
    const mat = await db.part.create({ data: { shopId: a.shopId, partNumber: "MAT-1", numberKeys: ["MAT1"], description: "Standard grip mat", kind: "SUPPLY", itemType: "mat", qtyOnHand: 0, priceCents: 1499 } });
    const sell = async (customerId: string, lines: Parameters<typeof completeSaleAs>[1]["lines"], when: Date, total: number) => {
      const r = await completeSaleAs(user(a), { customerId, lines, tenders: [{ method: "CASH", amountCents: total }] });
      await db.sale.update({ where: { id: r.saleId }, data: { createdAt: when } });
      return r;
    };
    const [printer] = await receiveUnitsFor(user(a), fd({ kind: "3d-printer", brand: "Bambu Lab", model: "P1S", condition: "NEW", priceCents: "699", serials: "P1S-1" }));
    await sell(mae.id, [{ description: "", qty: 1, unitPriceCents: 69_900, taxable: true, stockUnitId: printer }], ago(120), 69_900);
    await db.stockUnit.update({ where: { id: printer }, data: { soldAt: ago(120) } });
    await sell(mae.id, [{ partId: pla.id, description: "", qty: 2, unitPriceCents: 2499, taxable: true }], ago(85), 4998);
    await sell(mae.id, [{ partId: pla.id, description: "", qty: 1, unitPriceCents: 2499, taxable: true }], ago(55), 2499);
    await sell(mae.id, [{ partId: mat.id, description: "", qty: 1, unitPriceCents: 1499, taxable: true }], ago(5), 1499);
    const [cutter] = await receiveUnitsFor(user(a), fd({ kind: "craft-cutter", brand: "Cricut", model: "Maker 3", condition: "NEW", priceCents: "429", serials: "CR-1" }));
    await sell(tim.id, [{ description: "", qty: 1, unitPriceCents: 42_900, taxable: true, stockUnitId: cutter }], ago(10), 42_900);
    await db.stockUnit.update({ where: { id: cutter }, data: { soldAt: ago(10) } });
    // A printer of her own, not sold here: not on the list.
    await db.machine.create({ data: { shopId: a.shopId, customerId: tim.id, brand: "Prusa", model: "MK4", modelKey: "MK4", equipment: "APPLIANCE", kind: "3d-printer" } });
    let rows = await suppliesDue(a.shopId);
    assert.deepEqual(rows.map((r) => [r.customer.name, r.brand, r.from, r.overdue]), [["Mae Maker", "Bambu Lab", "her pace", true]], "her pace (30 days) after 55 days ago is overdue; the mat isn't filament; Tim's cutter is new; his own printer wasn't sold here");
    assert.deepEqual([rows[0].word, rows[0].offer], ["filament", "Bambu PLA black"]);
    ok("the list: printers and cutters sold here, the item types that count, her pace, the offer on the shelf");

    // 4. The marks.
    await markSuppliesCalledFor(user(a), rows[0].machineId, fd({ note: "will come Saturday" }));
    assert.deepEqual(await suppliesDue(a.shopId), [], "called: off the list");
    await db.suppliesCare.update({ where: { machineId: rows[0].machineId }, data: { calledAt: ago(60) } });
    rows = await suppliesDue(a.shopId);
    assert.equal(rows.length, 1, "a call before this running-low date doesn't count");
    await snoozeSuppliesFor(user(a), rows[0].machineId);
    assert.deepEqual(await suppliesDue(a.shopId), []);
    await db.suppliesCare.update({ where: { machineId: rows[0].machineId }, data: { snoozeUntil: null } });
    await stopSuppliesFor(user(a), rows[0].machineId);
    assert.deepEqual(await suppliesDue(a.shopId), []);
    await stopSuppliesFor(user(a), rows[0].machineId, false);
    assert.equal((await suppliesDue(a.shopId)).length, 1);
    ok("Called, Not yet (30 days) and Stop take it off the list; a call from before doesn't count; Stop undone puts it back");

    // 5. Sending and the worker.
    await expectError("without Marketing", () => sendSuppliesRemindersFor(user(a)), /Marketing module/);
    await expectError("a tech", () => sendSuppliesRemindersFor({ ...user(a), role: "TECH" }), /owner or admin/);
    const queuedAt = ago(1);
    assert.equal(await suppliesStillWanted({ shopId: a.shopId, refId: rows[0].machineId, createdAt: queuedAt }), null);
    await sell(mae.id, [{ partId: pla.id, description: "", qty: 1, unitPriceCents: 2499, taxable: true }], new Date(), 2499);
    assert.match((await suppliesStillWanted({ shopId: a.shopId, refId: rows[0].machineId, createdAt: queuedAt }))!, /bought filament/);
    assert.deepEqual(await suppliesDue(a.shopId), [], "bought today: not running low");
    ok("the send needs Marketing and an owner or admin; a queued reminder is cancelled once she buys filament");

    // 6. Tenant.
    await grantDevLicense(b.shopId, ["maker"], { from: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10) });
    await expectNotFound("B marks A's machine", () => markSuppliesCalledFor(user(b), rows[0].machineId));
    await expectNotFound("B snoozes A's machine", () => snoozeSuppliesFor(user(b), rows[0].machineId));
    assert.deepEqual(await suppliesDue(b.shopId), []);
    assert.match((await suppliesStillWanted({ shopId: b.shopId, refId: rows[0].machineId, createdAt: queuedAt }))!, /gone/);
    ok("tenant: B can't mark A's machines nor see A's list");
  } finally {
    await cleanup();
  }
  console.log(`supplies-due.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
