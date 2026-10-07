// Vacuums for sale (modules-design.md 10.c, package vac-sales-warranty): receiving, a sale through the register's own
// completeSaleAs / voidSaleAs (the hooks run inside its transaction with real Sale and SaleLine rows), a return, the
// voids in both orders, the whole-sale discount share, trade-ins (new, and of a vacuum sold here, with its void putting
// the sale back exactly), the warranty in shop time, the module gate on a lapsed company, the TECH price rule, the
// abandoned-ticket path, the register lookups, and the tenant section.
//   npm run check scripts/checks/vac-units.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { modelKey } from "@/lib/format";
import { loadModules } from "@/lib/modules";
import { completeSaleAs, voidSaleAs, type SaleInput } from "@/lib/register-sale";
import type { CurrentUser } from "@/lib/session";
import { prepareUnitLines, registerUnitHits } from "@/lib/units/sale-units";
import type { TradeInInput } from "@/lib/units/types";
import { listUnits, receiveUnitsFor, recordRegistrationFor, setUnitOffSaleFor, unitDetail, unitFromAbandonedFor, unitsForSaleFor, unitsToReturnFor, updateUnitFor, warrantyEnd } from "@/lib/units/units";
import { addDays, dayStart, ymdOf, zonedTime } from "@/lib/zoned";
import { grantDevLicense } from "../license/dev";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

const NY = "America/New_York";
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

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

const unit = (id: string) => db.stockUnit.findUniqueOrThrow({ where: { id }, include: { machine: true } });
const cash = (amountCents: number) => [{ method: "CASH" as const, amountCents }];
const RECEIVE = { kind: "vacuum", brand: "Miele", model: "C3", condition: "NEW", "f:bagged": "Bagged", "f:bagType": "GN", priceCents: "499.00", costCents: "300.00" };

async function main() {
  const a = await checkShop({ retail: true, repair: true, modules: ["vac"] });
  const b = await checkShop({ retail: true, modules: ["vac"] });
  const lapsed = await checkShop({ retail: true });
  try {
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Buyer One", phone: "555-0101" } });
    const bags = await db.part.create({ data: { shopId: a.shopId, partNumber: "GN-BAGS", description: "Miele GN bags (4)", priceCents: 2000, qtyOnHand: 10, numberKeys: ["GNBAGS"], kind: "SUPPLY" } });
    const sell = (lines: SaleInput["lines"], tenders: SaleInput["tenders"], extra: Partial<SaleInput> = {}) => completeSaleAs(user(a), { customerId: cust.id, lines, tenders, ...extra });
    const unitLine = (stockUnitId: string, unitPriceCents: number, qty = 1) => ({ description: "", qty, unitPriceCents, taxable: true, stockUnitId });

    // 1. Receive one, then two from a two-line serial box.
    const [u1] = await receiveUnitsFor(user(a), form({ ...RECEIVE, serials: "MC3-001" }));
    const [u2, u3] = await receiveUnitsFor(user(a), form({ ...RECEIVE, serials: "MC3-002\nMC3-003" }));
    assert.ok(u1 && u2 && u3);
    await expectError("the same serial again", () => receiveUnitsFor(user(a), form({ ...RECEIVE, serials: "mc3-001" })), /already in your stock/);
    await expectError("no serial on a new one", () => receiveUnitsFor(user(a), form({ ...RECEIVE, serials: "" })), /Enter the serial number/);
    await expectError("bags or bagless unanswered", () => receiveUnitsFor(user(a), form({ ...RECEIVE, "f:bagged": "", serials: "MC3-009" })), /Bags or bagless/);
    const d1 = await unitDetail(a.shopId, u1);
    assert.ok(d1 && d1.status === "IN_STOCK" && d1.warrantyMonths === 12 && d1.warrantyBy === "Miele" && d1.details.bagged === "Bagged" && d1.serial === "MC3-001");
    assert.equal((await listUnits(a.shopId, "stock", null)).length, 3);
    assert.equal((await listUnits(a.shopId, "stock", "mc3-002")).length, 1);
    const m1 = await db.machine.findUniqueOrThrow({ where: { id: d1.machineId } });
    assert.ok(m1.equipment === "VACUUM" && m1.kind === "vacuum" && m1.customerId === null);
    ok("received three units (one, then two from the serial box); repeats, a missing serial and an unanswered bags question are refused");

    // 2. Sell u1: SOLD, warranty a year on, buyer set.
    const s1 = await sell([unitLine(u1, 49900)], cash(49900));
    let x1 = await unit(u1);
    assert.equal(x1.status, "SOLD");
    assert.ok(x1.soldLineId && x1.soldAt);
    assert.equal(x1.soldNetCents, 49900);
    assert.equal(x1.machine.customerId, cust.id);
    assert.equal(x1.warrantyUntil?.getTime(), warrantyEnd(x1.soldAt!, 12, NY).until.getTime());
    assert.equal(warrantyEnd(x1.soldAt!, 12, NY).lastDay, `${Number(ymdOf(x1.soldAt!, NY).slice(0, 4)) + 1}${ymdOf(x1.soldAt!, NY).slice(4)}`.replace(/-02-29$/, "-02-28"));
    const line1 = await db.saleLine.findUniqueOrThrow({ where: { id: x1.soldLineId! } });
    assert.ok(line1.stockUnitId === u1 && line1.costCents === 30000 && /Miele C3 \(New\) S\/N MC3-001/.test(line1.description));
    assert.equal((await unitDetail(a.shopId, u1))?.sale?.number, s1.number);
    ok("sold: SOLD with the line, its cost, the buyer and a warranty through the same day a year on");

    // 3. Selling it again is refused; so is a sale with no customer, or a tech changing the price.
    await expectError("sold again", () => sell([unitLine(u1, 49900)], cash(49900)), /isn't in stock any more/);
    await expectError("no customer", () => completeSaleAs(user(a), { customerId: null, lines: [unitLine(u3, 49900)], tenders: cash(49900) }), /Pick the customer first/);
    await expectError("tech changes a set price", () => prepareUnitLines({ shopId: a.shopId, role: "TECH", customerId: cust.id, lines: [{ stockUnitId: u3, tradeIn: null, qty: 1, unitPriceCents: 40000, taxable: true }] }), /Only an owner or admin can change the price/);
    await expectError("two of one unit", () => sell([unitLine(u3, 49900, 2)], cash(99800)), /one line of 1/);
    ok("a sold unit can't sell again; a sale needs the customer; a tech can't change the price; a vacuum is one line of 1");

    // 4. Return it: IN_STOCK; a refund above what it sold for is refused.
    await expectError("refund too much", () => sell([unitLine(u1, 50000, -1)], cash(-50000)), /refund at most \$499\.00/);
    const r1 = await sell([unitLine(u1, 49900, -1)], cash(-49900));
    x1 = await unit(u1);
    assert.equal(x1.status, "IN_STOCK");
    assert.ok(x1.returnLineId && x1.soldLineId === line1.id, "soldLineId is kept until it sells again");
    assert.equal(x1.machine.customerId, null);
    ok("returned: IN_STOCK, the buyer cleared, at most what it sold for");

    // 6 (first): voiding the sale while the return stands is refused.
    await expectError("void the sale after a return", () => voidSaleAs(user(a), s1.saleId, "test"), /void that return first/);
    ok("voiding the sale while the return stands: 'void that return first'");

    // 5. Void the return: SOLD again, buyer back.
    await voidSaleAs(user(a), r1.saleId, "test");
    x1 = await unit(u1);
    assert.equal(x1.status, "SOLD");
    assert.equal(x1.returnLineId, null);
    assert.equal(x1.machine.customerId, cust.id);
    // And now the sale can be voided: back in stock, no warranty.
    await voidSaleAs(user(a), s1.saleId, "test");
    x1 = await unit(u1);
    assert.ok(x1.status === "IN_STOCK" && x1.soldLineId === null && x1.warrantyUntil === null && x1.machine.customerId === null);
    ok("void the return: SOLD with the buyer; then void the sale: IN_STOCK with no warranty");

    // 7. Discount share: a $500 unit and $20 of bags with $52 off store soldNetCents 45000; a return refunds at most $450.
    await updateUnitFor(user(a), u2, form({ priceCents: "500.00" }));
    const s2 = await sell([unitLine(u2, 50000), { partId: bags.id, description: "", qty: 1, unitPriceCents: 2000, taxable: true }], cash(46800), { orderDiscountCents: 5200 });
    const x2 = await unit(u2);
    assert.equal(x2.soldNetCents, 45000);
    await expectError("refund above the net", () => sell([unitLine(u2, 46000, -1)], cash(-46000)), /refund at most \$450\.00/);
    const back = await unitsToReturnFor(a.shopId, "MC3-002");
    assert.equal(back.length, 1);
    assert.equal(back[0].refundCents, 45000);
    await sell([unitLine(u2, 45000, -1)], cash(-45000));
    assert.equal((await unit(u2)).status, "IN_STOCK");
    void s2;
    ok("a $52 whole-sale discount over $520 leaves the $500 vacuum sold for $450.00, the most a return refunds");

    // 8. Trade-in of a new vacuum: the machine and an IN_STOCK unit, cost = credit, the line not taxable.
    const tradeIn: TradeInInput = { brand: "Hoover", model: "UH70120", serial: "HV-1", machineType: "Upright", condition: "USED", bagged: "Bagged", bagType: "Type Y" };
    const t1 = await sell([{ description: "", qty: -1, unitPriceCents: 5000, taxable: true, tradeIn }], cash(-5000));
    const hv = await db.machine.findFirstOrThrow({ where: { shopId: a.shopId, serial: "HV-1" }, include: { stock: true } });
    assert.ok(hv.equipment === "VACUUM" && hv.customerId === null && (hv.details as { bagged?: string }).bagged === "Bagged");
    assert.ok(hv.stock && hv.stock.status === "IN_STOCK" && hv.stock.costCents === 5000 && hv.stock.priceCents === null && hv.stock.condition === "USED");
    const tLine = await db.saleLine.findFirstOrThrow({ where: { saleId: t1.saleId } });
    assert.ok(tLine.taxable === false && tLine.tradeInUnitId === hv.stock.id && /^Trade-in: Hoover UH70120 S\/N HV-1$/.test(tLine.description));
    await expectError("the same vacuum traded in again", () => sell([{ description: "", qty: -1, unitPriceCents: 1000, taxable: false, tradeIn }], cash(-1000)), /already in your stock/);
    await expectError("trade-in without bags answer", () => sell([{ description: "", qty: -1, unitPriceCents: 1000, taxable: false, tradeIn: { ...tradeIn, serial: "HV-2", bagged: null } }], cash(-1000)), /whether it takes bags/);
    ok("trade-in: the machine (no owner) and an IN_STOCK unit at the credit, no price; the line isn't taxed; a repeat is refused");

    // 9. Trade back: sell u1 again, register the warranty, trade it in; voiding that trade-in restores the sale exactly.
    const s1b = await sell([unitLine(u1, 49900)], cash(49900));
    await recordRegistrationFor(user(a), u1, form({ registeredOn: ymdOf(new Date(), NY), registrationRef: "REG-1" }));
    const sold = await unit(u1);
    assert.ok(sold.registeredAt && sold.registrationRef === "REG-1" && sold.warrantyUntil);
    assert.equal((await listUnits(a.shopId, "register", null)).length, 0, "registered: off the to-register list");
    const tb = await sell([{ description: "", qty: -1, unitPriceCents: 10000, taxable: false, tradeIn: { ...tradeIn, brand: "Miele", model: "C3", serial: "mc3-001", condition: "USED" } }], cash(-10000));
    let y1 = await unit(u1);
    assert.ok(y1.status === "IN_STOCK" && y1.costCents === 10000 && y1.priceCents === null && y1.condition === "USED" && y1.machine.customerId === null && y1.soldLineId === null);
    assert.equal((await db.saleLine.findFirstOrThrow({ where: { saleId: tb.saleId } })).tradeInUnitId, u1, "the same unit, not a second one");
    await voidSaleAs(user(a), tb.saleId, "test");
    y1 = await unit(u1);
    assert.equal(y1.status, "SOLD");
    assert.equal(y1.soldLineId, sold.soldLineId);
    assert.equal(y1.warrantyUntil?.getTime(), sold.warrantyUntil!.getTime());
    assert.equal(y1.registeredAt?.getTime(), sold.registeredAt!.getTime());
    assert.equal(y1.registrationRef, "REG-1");
    assert.equal(y1.condition, "NEW");
    assert.equal(y1.machine.customerId, cust.id);
    void s1b;
    ok("trade back: the sold unit goes IN_STOCK as used at the credit; voiding the trade-in restores SOLD with the buyer, warranty and registration");

    // 10. Void a plain trade-in: REMOVED, the customer back on the machine.
    await voidSaleAs(user(a), t1.saleId, "test");
    const hv2 = await db.machine.findUniqueOrThrow({ where: { id: hv.id }, include: { stock: true } });
    assert.equal(hv2.stock?.status, "REMOVED");
    assert.equal(hv2.customerId, cust.id);
    await setUnitOffSaleFor(user(a), hv2.stock!.id, false);
    assert.equal((await unit(hv2.stock!.id)).status, "IN_STOCK");
    await setUnitOffSaleFor(user(a), hv2.stock!.id, true, form({ reason: "parts machine" }));
    assert.equal((await unit(hv2.stock!.id)).status, "REMOVED");
    assert.match(JSON.stringify((await unit(hv2.stock!.id)).events), /parts machine/);
    ok("void a plain trade-in: REMOVED; put back on sale and taken off again with the reason recorded");

    // 11. Warranty in shop time: 8 pm Jan 31 in Chicago is Feb 1 in UTC; 12 months is through Jan 31, 1 month through Feb 28.
    const CH = "America/Chicago";
    const late = zonedTime("2026-01-31", 20 * 60, CH);
    assert.ok(late.toISOString().startsWith("2026-02-01T02:00"));
    assert.equal(warrantyEnd(late, 12, CH).lastDay, "2027-01-31");
    assert.equal(warrantyEnd(late, 1, CH).lastDay, "2026-02-28");
    assert.equal(warrantyEnd(late, 1, CH).until.getTime(), dayStart("2026-03-01", CH).getTime());
    assert.equal(warrantyEnd(zonedTime("2028-01-31", 600, CH), 1, CH).lastDay, "2028-02-29");
    assert.equal(warrantyEnd(late, 0, CH).lastDay, "2026-01-31");
    ok("warranty: the sale's date in shop time plus calendar months, the day clamped to the month's end");

    // Abandoned: a vacuum whose last ticket was abandoned goes up for sale at the unpaid balance.
    const ab = await db.machine.create({ data: { shopId: a.shopId, customerId: cust.id, brand: "Kirby", model: "G4", modelKey: modelKey("G4"), serial: "KG4-1", equipment: "VACUUM", kind: "vacuum" } });
    await expectError("no abandoned ticket", () => unitFromAbandonedFor(user(a), ab.id), /marked Abandoned/);
    await db.ticket.create({
      data: {
        shopId: a.shopId,
        number: 9001,
        machineId: ab.id,
        customerId: cust.id,
        status: "ABANDONED",
        lines: { create: [{ kind: "LABOR", description: "Diagnosis", qty: 1, unitPriceCents: 4000, taxable: false }] },
        payments: { create: [{ method: "CASH", amountCents: 1000 }] },
      },
    });
    const abUnit = await unitFromAbandonedFor(user(a), ab.id);
    const abRow = await unit(abUnit);
    assert.ok(abRow.status === "IN_STOCK" && abRow.condition === "USED" && abRow.costCents === 3000 && abRow.priceCents === null && abRow.machine.customerId === null);
    await expectError("twice", () => unitFromAbandonedFor(user(a), ab.id), /already in your stock/);
    ok("an abandoned vacuum goes up for sale as Used, its cost the ticket's unpaid balance");

    // The register's lookups.
    const byCode = await registerUnitHits({ shopId: a.shopId, q: "mc3-003", mode: "code" });
    assert.equal(byCode.length, 1);
    assert.ok(byCode[0].stockUnitId === u3 && byCode[0].priceCents === 49900 && byCode[0].disclosure === "");
    const bySearch = await registerUnitHits({ shopId: a.shopId, q: "Miele C3", mode: "search" });
    assert.ok(bySearch.some((h) => h.stockUnitId === u3) && bySearch.some((h) => h.stockUnitId === u2) && !bySearch.some((h) => h.stockUnitId === u1), "in-stock Mieles only");
    const forSale = await unitsForSaleFor(a.shopId, null);
    assert.ok(forSale.some((x) => x.id === u3) && !forSale.some((x) => x.id === u1));
    assert.deepEqual(await registerUnitHits({ shopId: lapsed.shopId, q: "x", mode: "search" }), []);
    ok("the register finds in-stock units by serial and by brand / model words");

    // Gate: a lapsed company can take a return but not sell or trade in; its lookups for sale are empty.
    const today = ymdOf(new Date(), "UTC");
    await grantDevLicense(lapsed.shopId, ["vac"], { from: addDays(today, -400), until: addDays(today, -300), grace: 14 });
    assert.equal((await loadModules(lapsed.shopId)).states.vac.status, "lapsed");
    const lc = await db.customer.create({ data: { shopId: lapsed.shopId, name: "Late Buyer" } });
    const lm = await db.machine.create({ data: { shopId: lapsed.shopId, customerId: lc.id, brand: "Sebo", model: "X4", modelKey: "X4", serial: "SX4-1", equipment: "VACUUM", kind: "vacuum" } });
    const lsale = await db.sale.create({ data: { shopId: lapsed.shopId, number: 7001, customerId: lc.id, subtotalCents: 80000, taxCents: 0, totalCents: 80000, taxRatePct: 0, lines: { create: [{ description: "Sebo X4", qty: 1, unitPriceCents: 80000, taxable: true }] } }, include: { lines: true } });
    const lu = await db.stockUnit.create({ data: { shopId: lapsed.shopId, machineId: lm.id, status: "SOLD", condition: "NEW", priceCents: 80000, soldLineId: lsale.lines[0].id, soldAt: new Date(), soldNetCents: 80000 } });
    await db.saleLine.update({ where: { id: lsale.lines[0].id }, data: { stockUnitId: lu.id } });
    const lu2 = await db.stockUnit.create({ data: { shopId: lapsed.shopId, machineId: (await db.machine.create({ data: { shopId: lapsed.shopId, brand: "Sebo", model: "X4", modelKey: "X4", serial: "SX4-2", equipment: "VACUUM", kind: "vacuum" } })).id, status: "IN_STOCK", condition: "NEW", priceCents: 80000 } });
    const gate = (lines: Parameters<typeof prepareUnitLines>[0]["lines"], role: "OWNER" | "TECH" = "OWNER") => prepareUnitLines({ shopId: lapsed.shopId, role, customerId: lc.id, lines });
    await expectError("lapsed sale", () => gate([{ stockUnitId: lu2.id, tradeIn: null, qty: 1, unitPriceCents: 80000, taxable: true }]), /ended on/);
    await expectError("lapsed trade-in", () => gate([{ stockUnitId: null, tradeIn, qty: -1, unitPriceCents: 1000, taxable: false }]), /ended on/);
    const ret = await gate([{ stockUnitId: lu.id, tradeIn: null, qty: -1, unitPriceCents: 80000, taxable: true }]);
    assert.equal(ret.size, 1);
    assert.equal(ret.get(0)?.qty, -1);
    await expectError("tech changes a refund", () => gate([{ stockUnitId: lu.id, tradeIn: null, qty: -1, unitPriceCents: 70000, taxable: true }], "TECH"), /Only an owner or admin can change the refund/);
    assert.deepEqual(await unitsForSaleFor(lapsed.shopId, null), []);
    assert.equal((await unitsToReturnFor(lapsed.shopId, "Late")).length, 1, "returns are found by the buyer's name");
    assert.equal((await listUnits(lapsed.shopId, "sold", null)).length, 1, "the lapsed company's records still list");
    ok("lapsed: a sale and a trade-in are refused, a return goes through at the original amount; a tech can't change a refund");

    // Tenant: B with A's ids.
    const before = await snapshot(a.shopId, ["StockUnit", "Machine", "Sale"]);
    const [bu] = await receiveUnitsFor(user(b), form({ ...RECEIVE, serials: "MC3-003" }));
    const bRow = await unit(bu);
    assert.equal(bRow.shopId, b.shopId);
    assert.notEqual(bRow.machineId, (await unit(u3)).machineId, "B's serial MC3-003 is a new machine in B");
    await expectNotFound("updateUnitFor(B, A's unit)", () => updateUnitFor(user(b), u3, form({ priceCents: "1.00" })));
    await expectNotFound("recordRegistrationFor(B, A's unit)", () => recordRegistrationFor(user(b), u1, form({ registeredOn: ymdOf(new Date(), NY) })));
    await expectNotFound("setUnitOffSaleFor(B, A's unit)", () => setUnitOffSaleFor(user(b), u3, true));
    await expectNotFound("unitDetail(B, A's unit)", () => unitDetail(b.shopId, u1));
    await expectNotFound("unitFromAbandonedFor(B, A's machine)", () => unitFromAbandonedFor(user(b), ab.id));
    await expectError("prepareUnitLines(B, A's unit)", () => prepareUnitLines({ shopId: b.shopId, role: "OWNER", customerId: bRow.machineId, lines: [{ stockUnitId: u3, tradeIn: null, qty: 1, unitPriceCents: 49900, taxable: true }] }), /isn't in stock any more/);
    assert.deepEqual(await unitsToReturnFor(b.shopId, "MC3-001"), []);
    assert.deepEqual(await registerUnitHits({ shopId: b.shopId, q: "mc3-002", mode: "code" }), []);
    // A trade-in at B whose serial matches A's sold unit makes B's own machine; A's unit stays SOLD.
    const bc = await db.customer.create({ data: { shopId: b.shopId, name: "B Buyer" } });
    await completeSaleAs(user(b), { customerId: bc.id, lines: [{ description: "", qty: -1, unitPriceCents: 500, taxable: false, tradeIn: { ...tradeIn, brand: "Miele", model: "C3", serial: "MC3-001" } }], tenders: cash(-500) });
    assert.equal((await unit(u1)).status, "SOLD");
    assert.equal(await db.machine.count({ where: { shopId: b.shopId, serial: "MC3-001" } }), 1);
    assertUnchanged("tenant", before, await snapshot(a.shopId, ["StockUnit", "Machine", "Sale"]));
    ok("tenant: B's calls with A's ids answer not found; B's trade-in of A's serial is B's own machine; A's rows are unchanged");

  } finally {
    await cleanup();
  }
  console.log(`vac-units.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
