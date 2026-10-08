// Customer price groups, memberships and the lifetime discount (shop-features-round-2-design.md 1.5): the pure rules;
// groups saved (refusals, a tech); at the register a member's lines get the group's percent on the kinds it covers,
// labelled, a promotion and the group never both (the bigger, and a group that skips sale items stands aside), the
// wholesale price, "take it off this line", an ended membership gives nothing; a membership item sold puts the buyer in
// its group (untaxed, no stock, renewals add on, a void puts her back); a vacuum's lifetime discount on its supplies;
// the report; the tenant section. Through the register's own completeSaleAs / voidSaleAs.
//   npm run -s check scripts/checks/price-groups.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { completeSaleAs, voidSaleAs, type SaleLineInput } from "@/lib/register-sale";
import { receiveUnitsFor } from "@/lib/units/units";
import { customerGroupFor, groupReport, priceGroupsFor, saveGroupFor, saveMembershipItemFor, setCustomerGroupFor } from "@/lib/price-groups";
import { bestRule, ruleHits } from "@/lib/price-rules";
import { customerExtrasFor } from "@/lib/register-extras";
import { addDays, addMonths, ymdOf } from "@/lib/zoned";
import { checkShop, cleanup } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

function form(entries: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
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

const cash = (amountCents: number) => ({ method: "CASH" as const, amountCents });

async function main() {
  const a = await checkShop({ retail: true, modules: ["vac"] });
  const b = await checkShop({ retail: true });
  const tech = { ...a.user, role: "TECH" as const };
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const today = ymdOf(new Date(), "America/New_York");

    // 1. The rules (pure).
    const guild = { id: "g1", name: "Guild", pctOff: 10, useWholesale: false, kinds: ["FABRIC", "NOTION"], onSaleItems: false };
    assert.deepEqual(bestRule({ group: guild }, { kind: "FABRIC", qty: 2, unitPriceCents: 1200 }), { cents: 240, label: "Guild 10%", rule: "group", groupId: "g1" });
    assert.equal(bestRule({ group: guild }, { kind: "THREAD", qty: 1, unitPriceCents: 1000 }), null, "not a kind it covers");
    assert.equal(bestRule({ group: guild }, { kind: "FABRIC", qty: 1, unitPriceCents: 1000, onPromo: true }), null, "stands aside for an item on sale");
    assert.equal(bestRule({ group: { ...guild, useWholesale: true, name: "Wholesale" } }, { kind: "FABRIC", qty: 3, unitPriceCents: 1000, wholesaleCents: 600 })!.cents, 1200);
    assert.equal(ruleHits({ group: guild, lifetime: [{ machineId: "m1", pctOff: 25 }] }, { kind: "NOTION", qty: 1, unitPriceCents: 1000, machineId: "m1" })[0].label, "Lifetime 25%", "the bigger first");
    assert.equal(bestRule({ group: guild }, { kind: "FABRIC", qty: -1, unitPriceCents: 1000 }), null, "never on a return");
    ok("rules: a group's percent on its kinds, the wholesale price, standing aside for sale items, the lifetime discount, the biggest first, never a return");

    // 2. Groups.
    await expectError("a tech", () => saveGroupFor(tech, form({ name: "Guild", gives: "pct", pctOff: "10" })), /owner or admin/);
    await expectError("no percent", () => saveGroupFor(a.user, form({ name: "Guild", gives: "pct", pctOff: "0" })), /1 to 90/);
    const gId = await saveGroupFor(a.user, form({ name: "Guild", gives: "pct", pctOff: "10%", kinds: ["FABRIC", "NOTION"] }));
    const wId = await saveGroupFor(a.user, form({ name: "Wholesale", gives: "wholesale" }));
    const clubId = await saveGroupFor(a.user, form({ name: "Club card", gives: "pct", pctOff: "15" }));
    const groups = await priceGroupsFor(a.shopId);
    assert.deepEqual(groups.map((g) => g.name), ["Club card", "Guild", "Wholesale"]);
    assert.deepEqual(groups.find((g) => g.id === gId)!.kinds, ["FABRIC", "NOTION"]);
    ok("groups saved: a percent on some kinds, the wholesale price, a club card; techs and a 0% refused");

    // 3. At the register.
    const fab = await db.part.create({ data: { shopId: a.shopId, partNumber: "FAB-G", description: "Kona cotton", priceCents: 1200, qtyOnHand: 50, unit: "yd", kind: "FABRIC", numberKeys: ["FABG"], wholesaleCents: 700 } });
    const thr = await db.part.create({ data: { shopId: a.shopId, partNumber: "THR-G", description: "Aurifil 50wt", priceCents: 1500, qtyOnHand: 10, kind: "THREAD", numberKeys: ["THRG"] } });
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Guild" } });
    await setCustomerGroupFor(a.user, jane.id, form({ groupId: gId }));
    const line = (partId: string, qty: number, price: number, more: Partial<SaleLineInput> = {}): SaleLineInput => ({ partId, description: "", qty, unitPriceCents: price, taxable: true, ...more });
    const s1 = await completeSaleAs(tech, { customerId: jane.id, lines: [line(fab.id, 2, 1200), line(thr.id, 1, 1500)], tenders: [cash(2160 + 1500)] });
    const l1 = await db.saleLine.findMany({ where: { saleId: s1.saleId }, orderBy: { partNumber: "asc" } });
    assert.deepEqual(l1.map((l) => [l.partNumber, l.discountCents, l.priceNote, l.priceGroupId]), [["FAB-G", 240, "Guild 10%", gId], ["THR-G", 0, null, null]]);
    const s2 = await completeSaleAs(a.user, { customerId: jane.id, lines: [line(fab.id, 1, 1200, { noRule: true })], tenders: [cash(1200)] });
    assert.equal((await db.saleLine.findFirstOrThrow({ where: { saleId: s2.saleId } })).discountCents, 0, "taken off the line");
    // A promotion on fabric (5%): the guild stands aside for sale items; with "sale items too", the bigger (10%) wins.
    await db.promotion.create({ data: { shopId: a.shopId, name: "Fall fabric", effect: "PERCENT", value: 5, firstDay: addDays(today, -1), lastDay: addDays(today, 1), scope: { kinds: ["FABRIC"] } } });
    const s3 = await completeSaleAs(a.user, { customerId: jane.id, lines: [line(fab.id, 1, 1200)], tenders: [cash(1140)] });
    let x = await db.saleLine.findFirstOrThrow({ where: { saleId: s3.saleId } });
    assert.ok(x.discountCents === 60 && x.promotionId && !x.priceNote, "the promotion alone");
    await saveGroupFor(a.user, form({ name: "Guild", gives: "pct", pctOff: "10", kinds: ["FABRIC", "NOTION"], onSaleItems: "on", active: "on" }), gId);
    const s4 = await completeSaleAs(a.user, { customerId: jane.id, lines: [line(fab.id, 1, 1200)], tenders: [cash(1080)] });
    x = await db.saleLine.findFirstOrThrow({ where: { saleId: s4.saleId } });
    assert.ok(x.discountCents === 120 && !x.promotionId && x.priceNote === "Guild 10%", "the bigger, not both");
    await db.promotion.deleteMany({ where: { shopId: a.shopId } });
    // Wholesale; an ended membership.
    const wanda = await db.customer.create({ data: { shopId: a.shopId, name: "Wanda Wholesale" } });
    await setCustomerGroupFor(a.user, wanda.id, form({ groupId: wId }));
    const s5 = await completeSaleAs(a.user, { customerId: wanda.id, lines: [line(fab.id, 10, 1200)], tenders: [cash(7000)] });
    assert.equal((await db.saleLine.findFirstOrThrow({ where: { saleId: s5.saleId } })).discountCents, 5000, "sold at $7 a yard");
    await setCustomerGroupFor(a.user, wanda.id, form({ groupId: wId, until: addDays(today, -1) }));
    const s6 = await completeSaleAs(a.user, { customerId: wanda.id, lines: [line(fab.id, 1, 1200)], tenders: [cash(1200)] });
    assert.equal((await db.saleLine.findFirstOrThrow({ where: { saleId: s6.saleId } })).discountCents, 0, "ended: nothing");
    assert.equal((await customerGroupFor(a.shopId, wanda.id))!.inForce, false);
    ok("a member's covered lines 10% off, labelled, by a tech too; taken off a line; never both with a promotion; wholesale; an ended membership gives nothing");

    // 4. Selling a membership.
    const card = await db.part.create({ data: { shopId: a.shopId, partNumber: "CLUB-12", description: "Club card, 12 months", priceCents: 2500, qtyOnHand: 0, kind: "SUPPLY", numberKeys: ["CLUB12"] } });
    await saveMembershipItemFor(a.user, card.id, form({ groupId: clubId, months: "12" }));
    await expectError("no customer", () => completeSaleAs(a.user, { customerId: null, lines: [line(card.id, 1, 2500)], tenders: [cash(2500)] }), /customer first/);
    const ann = await db.customer.create({ data: { shopId: a.shopId, name: "Ann Member" } });
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 6 } });
    const m1 = await completeSaleAs(a.user, { customerId: ann.id, lines: [line(card.id, 1, 2500)], tenders: [cash(2500)] });
    const ml = await db.saleLine.findFirstOrThrow({ where: { saleId: m1.saleId } });
    assert.ok(ml.kind === "MEMBERSHIP" && !ml.taxable && ml.priceNote === "member:|");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: card.id } })).qtyOnHand, 0, "no stock taken");
    let annRow = await db.customer.findUniqueOrThrow({ where: { id: ann.id } });
    const year = addMonths(today, 12)!;
    assert.ok(annRow.priceGroupId === clubId && annRow.priceGroupUntil === year);
    const m2 = await completeSaleAs(a.user, { customerId: ann.id, lines: [line(card.id, 1, 2500)], tenders: [cash(2500)] });
    annRow = await db.customer.findUniqueOrThrow({ where: { id: ann.id } });
    assert.equal(annRow.priceGroupUntil, addMonths(year, 12), "a renewal adds on to the day it ends");
    await voidSaleAs(a.user, m2.saleId, "rung twice");
    annRow = await db.customer.findUniqueOrThrow({ where: { id: ann.id } });
    assert.equal(annRow.priceGroupUntil, year, "the void puts her back");
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    ok("a membership sold: the buyer in its group for 12 months, untaxed, no stock; a renewal adds on; a void puts her back");

    // 5. A vacuum's lifetime discount on its supplies.
    const [vac] = await receiveUnitsFor(a.user, form({ kind: "vacuum", brand: "Miele", model: "C3", condition: "NEW", "f:bagged": "Bagged", "f:bagType": "GN", priceCents: "499.00", serials: "LIFE-1" }));
    await db.stockUnit.update({ where: { id: vac }, data: { lifetimePctOff: 25 } });
    await completeSaleAs(a.user, { customerId: ann.id, lines: [{ description: "", qty: 1, unitPriceCents: 49_900, taxable: true, stockUnitId: vac }], tenders: [cash(49_900)] });
    const machineId = (await db.stockUnit.findUniqueOrThrow({ where: { id: vac } })).machineId;
    const bags = await db.part.create({ data: { shopId: a.shopId, partNumber: "GN-BAGS", description: "Miele GN bags", priceCents: 2000, qtyOnHand: 5, kind: "SUPPLY", numberKeys: ["GNBAGS"] } });
    const s7 = await completeSaleAs(a.user, { customerId: ann.id, lines: [line(bags.id, 1, 2000, { machineId })], tenders: [cash(1500)] });
    x = await db.saleLine.findFirstOrThrow({ where: { saleId: s7.saleId } });
    assert.ok(x.discountCents === 500 && x.priceNote === "Lifetime 25%");
    const ex = (await customerExtrasFor(a.shopId, ann.id))!;
    assert.ok(ex.group?.name === "Club card" && ex.lifetime[0].pctOff === 25);
    ok("a vacuum sold with a lifetime 25%: its bags 25% off for the buyer, labelled; the register reads her group and lifetime discount");

    // 6. The report.
    const r = await groupReport(a.shopId, today);
    const g = r.groups.find((x2) => x2.id === gId)!;
    assert.ok(g.givenCents === 240 + 120 && g.lines === 2 && g.members === 1);
    assert.ok(r.renewals.some((x2) => x2.name === "Wanda Wholesale"), "an ended membership shows under renewals");
    ok("the report: discounts given by group, members, renewals due");

    // 7. Tenant.
    await expectNotFound("B changes A's group", () => saveGroupFor(b.user, form({ name: "Mine", gives: "pct", pctOff: "50" }), gId));
    await expectNotFound("B puts A's customer in a group", () => setCustomerGroupFor(b.user, jane.id, form({ groupId: "" })));
    const bj = await db.customer.create({ data: { shopId: b.shopId, name: "B Buyer" } });
    await expectNotFound("B uses A's group", () => setCustomerGroupFor(b.user, bj.id, form({ groupId: gId })));
    await expectNotFound("B makes A's item a membership", () => saveMembershipItemFor(b.user, card.id, form({ groupId: "" })));
    assert.equal(await customerGroupFor(b.shopId, jane.id), null);
    assert.equal(await customerExtrasFor(b.shopId, jane.id), null);
    assert.deepEqual(await priceGroupsFor(b.shopId), []);
    assert.equal((await db.priceGroup.findUniqueOrThrow({ where: { id: gId } })).pctOff, 10);
    ok("tenant: another company can't change, use or read A's groups or put A's customers in one");

    console.log(`price-groups.check: ${steps} groups passed`);
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
