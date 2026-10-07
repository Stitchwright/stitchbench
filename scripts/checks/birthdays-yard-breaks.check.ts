// Birthdays and per-yard price breaks (shop-features-round-2-design.md 1.6): the offer and a birthday saved (refusals);
// in her birthday month the register's "Use it" takes the percent off one sale (labelled, once a year, a void gives it
// back; not in another month); the credit kind puts it on her store credit once; this month's list; yard breaks: the
// shop's steps on the yards of one line, an item's own break price, the bigger of a break and a group; the tenant section.
//   npm run -s check scripts/checks/birthdays-yard-breaks.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { completeSaleAs, voidSaleAs, type SaleLineInput } from "@/lib/register-sale";
import { addYardBreakFor, birthdayFor, birthdaysIn, giveBirthdayCreditAs, removeYardBreakFor, saveBirthdayFor, saveBirthdayOfferFor, saveItemBreakFor, yardBreaksFor } from "@/lib/birthdays";
import { saveGroupFor, setCustomerGroupFor } from "@/lib/price-groups";
import { customerExtrasFor } from "@/lib/register-extras";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
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
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const tech = { ...a.user, role: "TECH" as const };
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const today = ymdOf(new Date(), await shopTimeZone(a.shopId));
    const month = Number(today.slice(5, 7));
    const other = (month % 12) + 1;
    const fab = await db.part.create({ data: { shopId: a.shopId, partNumber: "KONA-B", description: "Kona cotton", priceCents: 1200, qtyOnHand: 100, unit: "yd", kind: "FABRIC", numberKeys: ["KONAB"] } });
    const line = (partId: string, qty: number, more: Partial<SaleLineInput> = {}): SaleLineInput => ({ partId, description: "", qty, unitPriceCents: 1200, taxable: true, ...more });

    // 1. The offer and a birthday.
    await expectError("a tech sets the offer", () => saveBirthdayOfferFor(tech, form({ kind: "pct", pct: "15" })), /owner or admin/);
    await expectError("too much", () => saveBirthdayOfferFor(a.user, form({ kind: "pct", pct: "80" })), /1 to 50/);
    await saveBirthdayOfferFor(a.user, form({ kind: "pct", pct: "15" }));
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Birthday" } });
    await expectError("February 30", () => saveBirthdayFor(a.user, jane.id, form({ month: "2", day: "30" })), /February has days 1 to 29/);
    await saveBirthdayFor(tech, jane.id, form({ month: String(month), day: "12" }));
    const ann = await db.customer.create({ data: { shopId: a.shopId, name: "Ann Later", birthMonth: other, birthDay: 3 } });
    assert.deepEqual(await birthdayFor(a.shopId, jane.id, today), { kind: "pct", value: 15, day: 12 });
    assert.equal(await birthdayFor(a.shopId, ann.id, today), null, "not her month");
    assert.equal((await customerExtrasFor(a.shopId, jane.id))!.birthday?.value, 15);
    assert.deepEqual((await birthdaysIn(a.shopId, month)).map((r) => r.name), ["Jane Birthday"]);
    ok("the offer (owner or admin, at most 50%), a birthday (any staff, real days); her month offers it, another doesn't; this month's list");

    // 2. Used at the register: once a year, a void gives it back.
    await expectError("not her month", () => completeSaleAs(a.user, { customerId: ann.id, birthday: true, lines: [line(fab.id, 1)], tenders: [cash(1020)] }), /isn't there today/);
    const s1 = await completeSaleAs(tech, { customerId: jane.id, birthday: true, lines: [line(fab.id, 2)], tenders: [cash(2040)] });
    const l1 = await db.saleLine.findFirstOrThrow({ where: { saleId: s1.saleId } });
    assert.ok(l1.discountCents === 360 && l1.priceNote === "Birthday 15%");
    assert.equal((await db.customer.findUniqueOrThrow({ where: { id: jane.id } })).birthdayUsedYear, Number(today.slice(0, 4)));
    await expectError("twice a year", () => completeSaleAs(a.user, { customerId: jane.id, birthday: true, lines: [line(fab.id, 1)], tenders: [cash(1020)] }), /isn't there today/);
    await voidSaleAs(a.user, s1.saleId, "wrong day");
    assert.equal((await db.customer.findUniqueOrThrow({ where: { id: jane.id } })).birthdayUsedYear, null, "the void gives it back");
    const s2 = await completeSaleAs(a.user, { customerId: jane.id, lines: [line(fab.id, 1)], tenders: [cash(1200)] });
    assert.equal((await db.saleLine.findFirstOrThrow({ where: { saleId: s2.saleId } })).discountCents, 0, "only when she uses it");
    ok("Use it: 15% off a tech's sale, labelled; once a year; a void gives it back; never by itself; not in another month");

    // 3. The credit kind.
    await saveBirthdayOfferFor(a.user, form({ kind: "credit", credit: "$10" }));
    assert.match(await giveBirthdayCreditAs(tech, jane.id, today), /\$10\.00 is on her store credit/);
    const credit = await db.giftCard.findFirstOrThrow({ where: { shopId: a.shopId, customerId: jane.id, kind: "credit" } });
    assert.equal(credit.balanceCents, 1000);
    await expectError("credit twice", () => giveBirthdayCreditAs(a.user, jane.id, today), /No birthday credit/);
    await saveBirthdayOfferFor(a.user, form({ kind: "none" }));
    assert.equal(await birthdayFor(a.shopId, ann.id, today), null);
    ok("the credit kind: $10 on her store credit, once; no offer: nothing");

    // 4. Yard breaks.
    await expectError("a tech adds a break", () => addYardBreakFor(tech, form({ minYards: "10", pctOff: "10" })), /owner or admin/);
    await addYardBreakFor(a.user, form({ minYards: "10", pctOff: "10" }));
    await addYardBreakFor(a.user, form({ minYards: "20", pctOff: "15" }));
    const s3 = await completeSaleAs(a.user, { customerId: null, lines: [line(fab.id, 9.875), line(fab.id, 10), line(fab.id, 25)], tenders: [cash(11_850 + 10_800 + 25_500)] });
    const l3 = await db.saleLine.findMany({ where: { saleId: s3.saleId }, orderBy: { qty: "asc" } });
    assert.deepEqual(l3.map((l) => [l.qty, l.discountCents, l.priceNote]), [[9.875, 0, null], [10, 1200, "10+ yd price"], [25, 4500, "20+ yd price"]]);
    const wide = await db.part.create({ data: { shopId: a.shopId, partNumber: "WIDE-1", description: "108 in wide-back", priceCents: 2400, qtyOnHand: 50, unit: "yd", kind: "FABRIC", numberKeys: ["WIDE1"] } });
    await expectError("break above the price", () => saveItemBreakFor(a.user, wide.id, form({ breakMinQty: "3", breakPrice: "25" })), /lower than/);
    await saveItemBreakFor(a.user, wide.id, form({ breakMinQty: "3", breakPrice: "$18" }));
    const s4 = await completeSaleAs(a.user, { customerId: null, lines: [{ ...line(wide.id, 3), unitPriceCents: 2400 }], tenders: [cash(5400)] });
    const l4 = await db.saleLine.findFirstOrThrow({ where: { saleId: s4.saleId } });
    assert.ok(l4.discountCents === 1800 && l4.priceNote === "3+ yd price", "its own break: $18 a yard from 3 yards");
    // A member's 20% beats the 10% break.
    const gid = await saveGroupFor(a.user, form({ name: "Teachers", gives: "pct", pctOff: "20" }));
    await setCustomerGroupFor(a.user, ann.id, form({ groupId: gid }));
    const s5 = await completeSaleAs(a.user, { customerId: ann.id, lines: [line(fab.id, 10)], tenders: [cash(9600)] });
    assert.equal((await db.saleLine.findFirstOrThrow({ where: { saleId: s5.saleId } })).priceNote, "Teachers 20%", "the bigger, not both");
    const breaks = await yardBreaksFor(a.shopId);
    await removeYardBreakFor(a.user, breaks[0].id);
    assert.equal((await yardBreaksFor(a.shopId)).length, 1);
    ok("yard breaks: 10+ and 20+ steps on one line's yards (not 9 7/8), an item's own $18 from 3 yards, a group's bigger percent wins; a step removed");

    // 5. Tenant.
    await expectNotFound("B saves A's customer's birthday", () => saveBirthdayFor(b.user, jane.id, form({ month: "1", day: "1" })));
    await expectNotFound("B removes A's break", () => removeYardBreakFor(b.user, breaks[1].id));
    await expectNotFound("B sets A's item break", () => saveItemBreakFor(b.user, wide.id, form({ breakMinQty: "" })));
    await saveBirthdayOfferFor(b.user, form({ kind: "credit", credit: "10" }));
    await expectError("B gives A's customer credit", () => giveBirthdayCreditAs(b.user, jane.id, today), /No birthday credit/);
    assert.deepEqual(await birthdaysIn(b.shopId, month), []);
    assert.deepEqual(await yardBreaksFor(b.shopId), []);
    assert.equal((await db.customer.findUniqueOrThrow({ where: { id: jane.id } })).birthMonth, month);
    ok("tenant: another company can't change A's birthdays or breaks, give A's customer credit, or list them");

    console.log(`birthdays-yard-breaks.check: ${steps} groups passed`);
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
