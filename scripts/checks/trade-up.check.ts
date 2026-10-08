// Trade-up credit and the trade-in rule (shop-features-round-2-design.md 1.9): off by default; on, a repair done within
// the days gives its charges as a credit (the invoice's line, the register's quiet line); used on a machine sold to her
// (a discount labelled "Trade-up credit", by a tech too, once per ticket, not on anything else, refused past its day or
// for another customer); a void gives it back; the rule's starting number; the tenant section.
//   npm run -s check scripts/checks/trade-up.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { receiveUnitsFor } from "@/lib/units/units";
import { creditForTicket, creditsFor, saveTradeUpSettingsFor, tradeInStart, tradeUpSettings } from "@/lib/trade-up";
import { customerExtrasFor } from "@/lib/register-extras";
import { shopTimeZone } from "@/lib/shop-zone";
import { addDays, ymdOf } from "@/lib/zoned";
import { checkShop, cleanup } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

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

async function main() {
  const a = await checkShop({ retail: true, repair: true });
  const b = await checkShop({ retail: true, repair: true });
  const tech = { ...a.user, role: "TECH" as const };
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const today = ymdOf(new Date(), await shopTimeZone(a.shopId));
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Trader" } });
    const ann = await db.customer.create({ data: { shopId: a.shopId, name: "Ann Other" } });
    const m = await db.machine.create({ data: { shopId: a.shopId, customerId: jane.id, brand: "Singer", model: "Featherweight", modelKey: "FEATHERWEIGHT" } });
    const ticket = await db.ticket.create({
      data: { shopId: a.shopId, number: 7, customerId: jane.id, machineId: m.id, status: "COLLECTED", readyAt: new Date(), closedAt: new Date(), lines: { create: [{ kind: "LABOR", description: "Clean, oil and adjust", qty: 1, unitPriceCents: 8900 }] } },
    });
    const [u1, u2] = await receiveUnitsFor(a.user, form({ kind: "sewing", brand: "Janome", model: "Skyline S5", condition: "NEW", priceCents: "1200.00", serials: "UP-1\nUP-2" }));

    // 1. Off by default; on.
    assert.deepEqual(await tradeUpSettings(a.shopId), { days: 0, lessPct: 30 });
    assert.equal(await creditForTicket(a.shopId, ticket.id), null);
    await expectError("a tech", () => saveTradeUpSettingsFor(tech, form({ on: "on", days: "30" })), /owner or admin/);
    await saveTradeUpSettingsFor(a.user, form({ on: "on", days: "30", lessPct: "30" }));
    const c = await creditForTicket(a.shopId, ticket.id);
    assert.ok(c && c.amountCents === 8900 && c.until === addDays(today, 30));
    assert.equal((await customerExtrasFor(a.shopId, jane.id))!.tradeUps[0].amountCents, 8900);
    assert.deepEqual(await creditsFor(a.shopId, ann.id), []);
    assert.equal(tradeInStart(40_000, 30), 28_000);
    ok("off by default; on for 30 days: the $89 repair is a credit until 30 days on, on the invoice and at the register; the trade-in rule starts $400 at $280");

    // 2. Used on a machine, by a tech.
    const unitLine = (id: string, more = {}) => ({ description: "", qty: 1, unitPriceCents: 120_000, taxable: true, stockUnitId: id, ...more });
    await expectError("on something else", () => completeSaleAs(a.user, { customerId: jane.id, lines: [{ description: "Misc", qty: 1, unitPriceCents: 500, taxable: true, tradeUpTicketId: ticket.id }], tenders: [{ method: "CASH", amountCents: 500 }] }), /comes off a machine/);
    await expectError("another customer", () => completeSaleAs(a.user, { customerId: ann.id, lines: [unitLine(u1, { tradeUpTicketId: ticket.id })], tenders: [{ method: "CASH", amountCents: 111_100 }] }), /isn't there any more/);
    const s1 = await completeSaleAs(tech, { customerId: jane.id, lines: [unitLine(u1, { tradeUpTicketId: ticket.id })], tenders: [{ method: "CASH", amountCents: 111_100 }] });
    const l1 = await db.saleLine.findFirstOrThrow({ where: { saleId: s1.saleId } });
    assert.ok(l1.discountCents === 8900 && l1.priceNote === "Trade-up credit");
    assert.deepEqual(await creditsFor(a.shopId, jane.id), [], "used once");
    await expectError("used twice", () => completeSaleAs(a.user, { customerId: jane.id, lines: [unitLine(u2, { tradeUpTicketId: ticket.id })], tenders: [{ method: "CASH", amountCents: 111_100 }] }), /isn't there any more/);
    ok("used on a $1,200 machine by a tech: $89 off, labelled Trade-up credit; once only; not on anything else, nor for another customer");

    // 3. A void gives it back; past its day it's gone.
    await voidSaleAs(a.user, s1.saleId, "x");
    assert.equal((await creditsFor(a.shopId, jane.id)).length, 1);
    await db.ticket.update({ where: { id: ticket.id }, data: { readyAt: new Date(Date.now() - 40 * 86_400_000), closedAt: new Date(Date.now() - 40 * 86_400_000) } });
    assert.deepEqual(await creditsFor(a.shopId, jane.id), [], "past its day");
    ok("a void gives the credit back; 40 days on it is gone");

    // 4. Tenant.
    await db.ticket.update({ where: { id: ticket.id }, data: { readyAt: new Date(), closedAt: new Date() } });
    await saveTradeUpSettingsFor(b.user, form({ on: "on", days: "30" }));
    assert.equal(await creditForTicket(b.shopId, ticket.id), null);
    assert.deepEqual(await creditsFor(b.shopId, jane.id), []);
    const bc = await db.customer.create({ data: { shopId: b.shopId, name: "B Buyer" } });
    const [bu] = await receiveUnitsFor(b.user, form({ kind: "sewing", brand: "Janome", model: "HD1000", condition: "NEW", priceCents: "300.00", serials: "B-1" }));
    await expectError("B uses A's ticket", () => completeSaleAs(b.user, { customerId: bc.id, lines: [{ description: "", qty: 1, unitPriceCents: 30_000, taxable: true, stockUnitId: bu, tradeUpTicketId: ticket.id }], tenders: [{ method: "CASH", amountCents: 30_000 }] }), /isn't there any more/);
    ok("tenant: another company can't see or use A's repair credits");

    console.log(`trade-up.check: ${steps} groups passed`);
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
