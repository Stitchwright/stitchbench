// Software licences and activation codes (shop-features-round-2-design.md 2.5, package software-codes): months added to a
// shop day, the item's licence (once or a subscription), codes loaded ahead, a sale with a typed code, the next code on
// hand, "Add the code later", one licence a line, the customer's own machine, activation (the shop's setting or marked),
// returns (an unactivated one back with its code in the drawer; an activated one refused unless an owner gives a reason,
// audited), a renewal carrying the date on, voids putting everything back, the renewal reminder's still-wanted check,
// and the tenant section.
//   npm run check scripts/checks/software-codes.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { completeSaleAs, voidSaleAs, type SaleLineInput } from "@/lib/register-sale";
import { addMonthsYmd, codesOnHand, codesToFillIn, fillCodeFor, loadCodesFor, maskCode, renewNoticeStillWanted, renewalsDue, saveSoftwareItemFor, setActivatedFor } from "@/lib/software";
import { ymdOf } from "@/lib/zoned";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });
const NY = "America/New_York";

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
const cash = (c: number) => [{ method: "CASH" as const, amountCents: c }];

async function main() {
  // 1. Pure bits.
  assert.deepEqual([addMonthsYmd("2026-01-31", 1), addMonthsYmd("2026-10-07", 12), addMonthsYmd("2024-02-29", 12), addMonthsYmd("2026-11-15", 3)], ["2026-02-28", "2027-10-07", "2025-02-28", "2027-02-15"]);
  assert.deepEqual([maskCode("ABCD-1234-7F3K"), maskCode(null)], ["…7F3K", ""]);
  ok("months onto a shop day (month ends kept), codes masked to their last four");

  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0, timeZone: NY } });
    const sw = await db.part.create({ data: { shopId: a.shopId, partNumber: "PE-DESIGN", numberKeys: ["PEDESIGN"], description: "PE-Design 11", kind: "SOFTWARE", qtyOnHand: 5, priceCents: 100_000 } });
    const sub = await db.part.create({ data: { shopId: a.shopId, partNumber: "HATCH-SUB", numberKeys: ["HATCHSUB"], description: "Hatch subscription", kind: "SOFTWARE", qtyOnHand: 50, priceCents: 20_000 } });
    const notSw = await db.part.create({ data: { shopId: a.shopId, partNumber: "PINS", numberKeys: ["PINS"], description: "Pins", kind: "NOTION", qtyOnHand: 5, priceCents: 500 } });

    // 2. The item.
    await expectError("not software", () => saveSoftwareItemFor(user(a), notSw.id, fd({ licenseKind: "ONCE" })), /isn't software/);
    await expectError("0 months", () => saveSoftwareItemFor(user(a), sub.id, fd({ licenseKind: "SUBSCRIPTION", licenseMonths: "0" })), /1 to 120/);
    assert.match(await saveSoftwareItemFor(user(a), sub.id, fd({ licenseKind: "SUBSCRIPTION", licenseMonths: "12" })), /12-month subscription/);
    await saveSoftwareItemFor(user(a), sw.id, fd({ licenseKind: "ONCE", noReturnText: "No returns once the box is opened." }));
    assert.match(await loadCodesFor(user(a), sw.id, "CODE-AAA1\nCODE-BBB2, CODE-CCC3\nCODE-AAA1"), /^3 codes/);
    assert.match(await loadCodesFor(user(a), sw.id, "CODE-CCC3\nCODE-DDD4"), /1 code .*1 already loaded/);
    assert.equal(await codesOnHand(a.shopId, sw.id), 4);
    ok("the item: once or a subscription (months checked), its words, codes loaded ahead (each once)");

    // 3. Selling.
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Hooper" } });
    const pe = await db.machine.create({ data: { shopId: a.shopId, customerId: jane.id, brand: "Brother", model: "PE800", modelKey: "PE800" } });
    const other = await db.machine.create({ data: { shopId: a.shopId, brand: "Brother", model: "SE600", modelKey: "SE600" } });
    const line = (partId: string, price: number, software: SaleLineInput["software"], qty = 1): SaleLineInput => ({ partId, description: "", qty, unitPriceCents: price, taxable: true, software });
    await expectError("two on a line", () => completeSaleAs(user(a), { customerId: jane.id, lines: [line(sw.id, 100_000, {}, 2)], tenders: cash(200_000) }), /one licence a line/);
    await expectError("not her machine", () => completeSaleAs(user(a), { customerId: jane.id, lines: [line(sw.id, 100_000, { machineId: other.id })], tenders: cash(100_000) }), /customer's own machines/);
    const s1 = await completeSaleAs(user(a), { customerId: jane.id, lines: [line(sw.id, 100_000, { machineId: pe.id }), line(sw.id, 100_000, { code: "code-typed-9" })], tenders: cash(200_000) });
    const l1 = await db.softwareLicense.findMany({ where: { shopId: a.shopId, saleId: s1.saleId }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(l1.map((l) => [l.code, l.machineId, l.kind, l.activatedAt]), [["CODE-AAA1", pe.id, "ONCE", null], ["code-typed-9", null, "ONCE", null]], "the first code on hand, then the typed one");
    assert.equal(await codesOnHand(a.shopId, sw.id), 3);
    await expectError("no code on a subscription with none on hand", () => completeSaleAs(user(a), { customerId: jane.id, lines: [line(sub.id, 20_000, {})], tenders: cash(20_000) }), /Add the code later/);
    const s2 = await completeSaleAs(user(a), { customerId: jane.id, lines: [line(sub.id, 20_000, { later: true })], tenders: cash(20_000) });
    const subLic = await db.softwareLicense.findFirstOrThrow({ where: { shopId: a.shopId, saleId: s2.saleId } });
    const today = ymdOf(new Date(), NY);
    assert.deepEqual([subLic.code, subLic.kind, ymdOf(subLic.renewsOn!, NY)], [null, "SUBSCRIPTION", addMonthsYmd(today, 12)]);
    assert.deepEqual((await codesToFillIn(a.shopId)).map((r) => r.id), [subLic.id], "on the Codes to fill in list");
    await fillCodeFor(user(a), subLic.id, "HATCH-777");
    await expectError("filled twice", () => fillCodeFor(user(a), subLic.id, "X"), /already has its code/);
    assert.deepEqual(await codesToFillIn(a.shopId), []);
    ok("selling: one licence a line, her own machine, the next code on hand, a typed code, a subscription's renewal date, Add the code later and filling it in");

    // 4. Activation and returns.
    await db.shop.update({ where: { id: a.shopId }, data: { softwareActivatedAtSale: true } });
    const s3 = await completeSaleAs(user(a), { customerId: jane.id, lines: [line(sw.id, 100_000, {})], tenders: cash(100_000) });
    const l3 = await db.softwareLicense.findFirstOrThrow({ where: { shopId: a.shopId, saleId: s3.saleId } });
    assert.ok(l3.activatedAt, "the shop's setting: activated on the sale date");
    await db.shop.update({ where: { id: a.shopId }, data: { softwareActivatedAtSale: false } });
    // An unactivated one comes back, its code back in the drawer.
    const r1 = await completeSaleAs(user(a), { customerId: jane.id, returnOfSaleId: s1.saleId, lines: [line(sw.id, 100_000, {}, -1)], tenders: cash(-100_000) });
    const back = await db.softwareLicense.findUniqueOrThrow({ where: { id: l1[1].id } });
    assert.equal(back.status, "RETURNED", "the receipt's latest licence of it");
    // The activated one: refused for a tech, refused without a reason, taken back by the owner with one.
    await expectError("a tech", () => completeSaleAs(tech(a), { customerId: jane.id, lines: [line(sw.id, 100_000, { returnReason: "box unopened" }, -1)], tenders: cash(-100_000) }), /owner or admin can still take it back/);
    await expectError("no reason", () => completeSaleAs(user(a), { customerId: jane.id, lines: [line(sw.id, 100_000, {}, -1)], tenders: cash(-100_000) }), /give the reason/);
    await completeSaleAs(user(a), { customerId: jane.id, lines: [line(sw.id, 100_000, { returnReason: "Maker took the code back" }, -1)], tenders: cash(-100_000) });
    assert.equal((await db.softwareLicense.findUniqueOrThrow({ where: { id: l3.id } })).status, "RETURNED");
    const audited = await db.auditEntry.findFirst({ where: { shopId: a.shopId, action: "software.return" } });
    assert.equal(audited?.reason, "Maker took the code back");
    // Voiding the first return: the licence is active again.
    await voidSaleAs(user(a), r1.saleId, "rung up by mistake");
    assert.equal((await db.softwareLicense.findUniqueOrThrow({ where: { id: l1[1].id } })).status, "ACTIVE");
    await setActivatedFor(user(a), l1[0].id, true);
    await expectError("a tech un-activates", () => setActivatedFor(tech(a), l1[0].id, false), /owner or admin/);
    ok("activation by the shop's setting or marked; returns: unactivated back, activated refused (tech, no reason) or taken back by the owner with a reason (audited); voiding the return restores it");

    // 5. Renewal, and voids.
    const s4 = await completeSaleAs(user(a), { customerId: jane.id, lines: [line(sub.id, 20_000, { renewId: subLic.id })], tenders: cash(20_000) });
    const renewed = await db.softwareLicense.findFirstOrThrow({ where: { shopId: a.shopId, saleId: s4.saleId } });
    assert.deepEqual([renewed.code, renewed.renewedFromId, ymdOf(renewed.renewsOn!, NY)], ["HATCH-777", subLic.id, addMonthsYmd(addMonthsYmd(today, 12), 12)], "carried on from the old renewal date");
    assert.equal((await db.softwareLicense.findUniqueOrThrow({ where: { id: subLic.id } })).status, "RENEWED");
    await expectError("renew a renewed one", () => completeSaleAs(user(a), { customerId: jane.id, lines: [line(sub.id, 20_000, { renewId: subLic.id })], tenders: cash(20_000) }), /isn't this customer's active subscription/);
    await expectError("void the first sale of a renewed licence", () => voidSaleAs(user(a), s2.saleId, "x"), /renewed since/);
    await voidSaleAs(user(a), s4.saleId, "rung up twice");
    assert.equal((await db.softwareLicense.findUniqueOrThrow({ where: { id: subLic.id } })).status, "ACTIVE", "voiding the renewal: the old one is active again");
    assert.equal(await db.softwareLicense.count({ where: { id: renewed.id } }), 0);
    const before = await codesOnHand(a.shopId, sw.id);
    const s5 = await completeSaleAs(user(a), { lines: [line(sw.id, 100_000, {})], tenders: cash(100_000) });
    assert.equal(await codesOnHand(a.shopId, sw.id), before - 1);
    await voidSaleAs(user(a), s5.saleId, "wrong item");
    assert.equal(await codesOnHand(a.shopId, sw.id), before, "voiding the sale puts its drawer code back");
    // Review fixes: an activated licence's code isn't put back by a void (the licence ends, keeping it); a return with no
    // licence of hers makes none and takes no code.
    await db.shop.update({ where: { id: a.shopId }, data: { softwareActivatedAtSale: true } });
    const s6 = await completeSaleAs(user(a), { lines: [line(sw.id, 100_000, {})], tenders: cash(100_000) });
    await db.shop.update({ where: { id: a.shopId }, data: { softwareActivatedAtSale: false } });
    await voidSaleAs(user(a), s6.saleId, "wrong item");
    assert.equal(await codesOnHand(a.shopId, sw.id), before - 1, "an activated code stays used");
    assert.equal((await db.softwareLicense.findFirstOrThrow({ where: { shopId: a.shopId, saleId: s6.saleId } })).status, "ENDED");
    const stranger = await db.customer.create({ data: { shopId: a.shopId, name: "No Licence" } });
    const lics = await db.softwareLicense.count({ where: { shopId: a.shopId } });
    await completeSaleAs(user(a), { customerId: stranger.id, lines: [line(sw.id, 100_000, {}, -1)], tenders: cash(-100_000) });
    assert.equal(await db.softwareLicense.count({ where: { shopId: a.shopId } }), lics, "no phantom licence");
    assert.equal(await codesOnHand(a.shopId, sw.id), before - 1, "and no code taken");
    ok("renewal: a new licence from the old renewal date, the old one renewed; voiding it brings the old one back; voiding a sale puts its code back in the drawer");

    // 6. Renewals list and the reminder's still-wanted check.
    await db.softwareLicense.update({ where: { id: subLic.id }, data: { renewsOn: new Date(Date.now() + 10 * 86_400_000) } });
    assert.ok((await renewalsDue(a.shopId)).some((r) => r.id === subLic.id), "renewing in 10 days");
    const day = ymdOf(new Date(Date.now() + 10 * 86_400_000), NY);
    const row = { shopId: a.shopId, refId: subLic.id, dedupeKey: `software_renew:${subLic.id}:${day}` };
    assert.equal(await renewNoticeStillWanted(row), null);
    assert.match((await renewNoticeStillWanted({ ...row, dedupeKey: `software_renew:${subLic.id}:2020-01-01` }))!, /date changed/);
    await db.softwareLicense.update({ where: { id: subLic.id }, data: { status: "ENDED" } });
    assert.match((await renewNoticeStillWanted(row))!, /renewed or ended/);
    ok("renewals due list; the reminder goes only while the licence is active with the same date");

    // 7. Tenant.
    await expectNotFound("B fills A's code", () => fillCodeFor(user(b), l1[0].id, "X"));
    await expectNotFound("B marks A's activated", () => setActivatedFor(user(b), l1[0].id, true));
    await expectNotFound("B loads codes on A's item", () => loadCodesFor(user(b), sw.id, "Z"));
    assert.equal(await codesOnHand(b.shopId, sw.id), 0);
    const bCust = await db.customer.create({ data: { shopId: b.shopId, name: "B customer" } });
    const bSw = await db.part.create({ data: { shopId: b.shopId, partNumber: "B-SW", numberKeys: ["BSW"], description: "B soft", kind: "SOFTWARE", licenseKind: "SUBSCRIPTION", licenseMonths: 12, qtyOnHand: 1, priceCents: 100 } });
    await expectError("B renews A's licence", () => completeSaleAs(user(b), { customerId: bCust.id, lines: [line(bSw.id, 100, { renewId: subLic.id })], tenders: cash(100) }), /isn't this customer's active subscription/);
    assert.deepEqual(await renewalsDue(b.shopId), []);
    ok("tenant: B can't fill, mark, load codes on or renew A's; B's lists show none of A's");
  } finally {
    await cleanup();
  }
  console.log(`software-codes.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
