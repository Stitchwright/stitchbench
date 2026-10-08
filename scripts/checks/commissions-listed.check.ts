// Sales commissions and "listed elsewhere" holds (shop-features-round-2-design.md 9.7, package commissions-listed): the
// listing saved (places, https links only), the register refusing a listed machine or the last listed item until it is
// ticked taken down (a machine's listing cleared when it sells; an item with more left needs no tick), who sold it (the
// person signed in by default, one of the company's people, never another company's), the rules (owner or admin), the
// month's report (machines or everything, returns off, voids out), tenant.
//   npm run check scripts/checks/commissions-listed.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { receiveUnitsFor } from "@/lib/units/units";
import { commissionOn, placesText, readCommission, readListed } from "@/lib/listed-math";
import { commissionReport, saveCommissionFor, sellers, setListedFor } from "@/lib/commissions";
import { checkShop, cleanup } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
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
const cash = (amountCents: number) => [{ method: "CASH" as const, amountCents }];

async function main() {
  assert.deepEqual(readListed([{ where: "eBay", url: "https://ebay.com/x" }, { where: "ebay" }, { where: "Etsy", url: "javascript:x" }, { where: "" }]), [{ where: "eBay", url: "https://ebay.com/x" }, { where: "Etsy", url: null }]);
  assert.equal(placesText(readListed([{ where: "eBay" }, { where: "Etsy" }, { where: "Craigslist" }])), "eBay, Etsy and Craigslist");
  assert.deepEqual([readCommission({}), readCommission({ pct: 5 }), readCommission({ pct: 2, on: "all" }), readCommission({ pct: 500 })], [null, { pct: 5, on: "machines" }, { pct: 2, on: "all" }, null]);
  assert.equal(commissionOn(123456, { pct: 5, on: "machines" }), 6173);
  ok("listings read (each place once, https links only), the words, the rules, the commission rounded");

  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const sam = await db.user.create({ data: { shopId: a.shopId, email: `sam-${a.shopId}@x.test`, name: "Sam Seller", passwordHash: "x", role: "TECH" } });
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Bea Buyer", phone: "555-0124" } });
    const [u1] = await receiveUnitsFor(a.user, fd({ kind: "sewing", brand: "Janome", model: "M7", condition: "NEW", priceCents: "1000.00", serials: "JM-1" }));
    const foot = await db.part.create({ data: { shopId: a.shopId, partNumber: "FT-1", numberKeys: ["FT1"], description: "Vintage foot", priceCents: 2000, qtyOnHand: 2 } });

    // 1. Listing.
    await expectError("a bad link", () => setListedFor(a.user, "unit", u1, fd({ place: "eBay", "url:eBay": "http://ebay.com/x" })), /https/);
    assert.match(await setListedFor(a.user, "unit", u1, fd({ place: ["eBay", "Etsy"], "url:eBay": "https://ebay.com/itm/1", otherPlace: "Shop window" })), /eBay, Etsy and Shop window/);
    await setListedFor({ ...a.user, role: "TECH" }, "part", foot.id, fd({ place: "Etsy" }));
    ok("a machine listed on eBay (with its link), Etsy and a place typed; a tech can record an item's listing");

    // 2. The register.
    const sell = (o: { delisted?: boolean; soldById?: string; unit?: boolean; qty?: number }) =>
      completeSaleAs(a.user, {
        customerId: cust.id,
        soldById: o.soldById,
        lines: [o.unit ? { description: "", qty: 1, unitPriceCents: 100000, taxable: true, stockUnitId: u1, delisted: o.delisted } : { partId: foot.id, description: "", qty: o.qty ?? 1, unitPriceCents: 2000, taxable: true, delisted: o.delisted }],
        tenders: cash(o.unit ? 100000 : 2000 * (o.qty ?? 1)),
      });
    await expectError("listed machine", () => sell({ unit: true }), /also listed on eBay, Etsy and Shop window\. Take it down there first/);
    await expectError("another company's seller", () => sell({ unit: true, delisted: true, soldById: b.user.id }), /isn't one of your people/);
    const s1 = await sell({ unit: true, delisted: true, soldById: sam.id });
    assert.deepEqual((await db.stockUnit.findUniqueOrThrow({ where: { id: u1 } })).listedOn, [], "sold: no longer listed");
    const s2 = await sell({});
    await expectError("the last listed item", () => sell({}), /FT-1 is the last one/);
    await sell({ delisted: true });
    const lines = await db.saleLine.findMany({ where: { sale: { shopId: a.shopId } }, select: { saleId: true, soldById: true } });
    assert.ok(lines.find((l) => l.saleId === s1.saleId)!.soldById === sam.id && lines.find((l) => l.saleId === s2.saleId)!.soldById === a.user.id, "picked, else the person ringing up");
    ok("the register: a listed machine and the last listed item wait for the tick (one with more left doesn't); who sold it kept, never another company's person");

    // 3. Rules and the report.
    await expectError("a tech sets rules", () => saveCommissionFor({ ...a.user, role: "TECH" } as CurrentUser, sam.id, fd({ pct: "5" })), /owner or admin/);
    await saveCommissionFor(a.user, sam.id, fd({ pct: "5", on: "machines" }));
    await saveCommissionFor(a.user, a.user.id, fd({ pct: "2", on: "all" }));
    const ret = await completeSaleAs(a.user, { customerId: cust.id, lines: [{ partId: foot.id, description: "", qty: -1, unitPriceCents: 2000, taxable: true }], tenders: cash(-2000) });
    void ret;
    const from = new Date(Date.now() - 86_400_000);
    const to = new Date(Date.now() + 86_400_000);
    let rep = await commissionReport(a.shopId, from, to);
    const r = (id: string) => rep.find((x) => x.userId === id)!;
    assert.deepEqual([r(sam.id).machinesCents, r(sam.id).commissionCents], [100000, 5000]);
    assert.deepEqual([r(a.user.id).allCents, r(a.user.id).commissionCents], [2000 + 2000 - 2000, 40], "2% of everything, the return taken off");
    await voidSaleAs(a.user, s1.saleId, "wrong");
    rep = await commissionReport(a.shopId, from, to);
    assert.equal(r(sam.id).commissionCents, 0, "a voided sale earns nothing");
    assert.deepEqual((await sellers(a.shopId)).map((s) => s.name).sort(), [a.user.name, "Sam Seller"].sort());
    ok("rules by an owner; the report: 5% of machines, 2% of everything with the return off, the void out");

    // 4. Tenant.
    await expectNotFound("B lists A's machine", () => setListedFor(b.user, "unit", u1, fd({ place: "eBay" })));
    await expectNotFound("B lists A's item", () => setListedFor(b.user, "part", foot.id, fd({ place: "eBay" })));
    await expectNotFound("B sets A's person's rule", () => saveCommissionFor(b.user, sam.id, fd({ pct: "50" })));
    assert.ok(!(await commissionReport(b.shopId, from, to)).some((x) => x.userId === sam.id));
    assert.ok(!(await sellers(b.shopId)).some((x) => x.id === sam.id));
    ok("tenant: B can't list A's things, set A's people's rules, nor see them in its report or seller list");
  } finally {
    await cleanup();
  }
  console.log(`commissions-listed.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
