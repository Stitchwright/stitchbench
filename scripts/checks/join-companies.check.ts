// Bring an existing company in as a store (shop-features-round-2-design.md 7.6): only the owner of both, typing its
// name; refused while it has partner shops or a gift card number both use; then every row of its own comes over as a
// new store (its stock that store's, its numbers on from the first's, an item number both use tagged with the store,
// the same supplier made one, a login both have kept but switched off), customers who may be the same are listed for
// the merge, and the second company is left closed; the store count goes up; and the tenant section.
//   npm run -s check scripts/checks/join-companies.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { completeSaleAs } from "@/lib/register-sale";
import { joinCompanyFor, makeJoinCodeFor, sameCustomersFor } from "@/lib/join-companies";
import { activeStores } from "@/lib/stores";
import { storeQty } from "@/lib/stock";
import { storeCount } from "@/lib/hub";
import { checkShop, cleanup } from "./lib";

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

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const c = await checkShop({ retail: true });
  try {
    const A = a.shopId;
    const B = b.shopId;
    // The same owner runs both: B's owner login has A's owner's email (which alone proves nothing: she signs in to both).
    await db.user.update({ where: { id: b.user.id }, data: { email: a.user.email.toUpperCase() } });
    // C's owner gives herself a wildcard email (emails aren't verified): it must not match anything.
    await db.user.update({ where: { id: c.user.id }, data: { email: "%@%" } });
    await db.shop.update({ where: { id: B }, data: { name: `${b.name} Florida`, address: "2 Gulf Rd, Naples FL", taxRatePct: 7 } });
    const bName = `${b.name} Florida`;

    // A's records
    const aCust = await db.customer.create({ data: { shopId: A, name: "Jane Both", email: "jane@both.test" } });
    const aPart = await db.part.create({ data: { shopId: A, partNumber: "BN-2", description: "Bobbin", priceCents: 300, kind: "NOTION", numberKeys: ["BN2"], qtyOnHand: 10 } });
    await completeSaleAs(a.user, { lines: [{ partId: aPart.id, description: "Bobbin", qty: 1, unitPriceCents: 300, taxable: false }], tenders: [{ method: "CASH", amountCents: 300 }] });
    await db.fabricSupplier.create({ data: { shopId: A, name: "Notions Inc" } });
    // B's records
    const bCust = await db.customer.create({ data: { shopId: B, name: "Jane Both", email: "JANE@both.test" } });
    const bOnly = await db.customer.create({ data: { shopId: B, name: "Flo Rida" } });
    const bPart = await db.part.create({ data: { shopId: B, partNumber: "bn-2", description: "Bobbin (Florida)", priceCents: 300, kind: "NOTION", numberKeys: ["BN2"], qtyOnHand: 6, reorderAt: 2, location: "F1" } });
    const bSale = await completeSaleAs(b.user, { customerId: bCust.id, lines: [{ partId: bPart.id, description: "Bobbin", qty: 1, unitPriceCents: 300, taxable: true }], tenders: [{ method: "CASH", amountCents: 321 }] });
    const bSup = await db.fabricSupplier.create({ data: { shopId: B, name: "notions inc" } });
    const bPo = await db.purchaseOrder.create({ data: { shopId: B, number: 1, supplierId: bSup.id, supplierName: bSup.name } });
    const bTech = await db.user.create({ data: { shopId: B, email: `jt-${Date.now()}@stitchbench.test`, name: "Flo Tech", role: "TECH", passwordHash: "x" } });
    const bCard = await db.giftCard.create({ data: { shopId: B, number: `GJ${Date.now()}`.slice(0, 20), balanceCents: 2500, customerId: bOnly.id } });

    // ---------- 1. who can join what ----------
    await expectError("an admin makes a join code", () => makeJoinCodeFor({ ...b.user, role: "ADMIN" }), /Only the owner/);
    await expectError("no code: the same email proves nothing", () => joinCompanyFor(a.user, "", bName), /join code isn't right/);
    const { code } = await makeJoinCodeFor(b.user);
    assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const stored = await db.shop.findUniqueOrThrow({ where: { id: B }, select: { joinCodeHash: true } });
    assert.ok(stored.joinCodeHash && !stored.joinCodeHash.includes(code.slice(0, 5)), "kept hashed");
    await expectError("wildcard email, no code", () => joinCompanyFor(c.user, "%%%%%-%%%%%", bName), /join code isn't right/);
    await expectError("run out", () => joinCompanyFor(a.user, code, bName, null, new Date(Date.now() + 31 * 60_000)), /run out/);
    await expectError("an admin joins", () => joinCompanyFor({ ...a.user, role: "ADMIN" }, code, bName), /Only the owner/);
    await expectError("wrong name", () => joinCompanyFor(a.user, code, "Florida"), /Type .* to confirm/);
    await expectError("its own code", () => joinCompanyFor(b.user, code, bName), /join code isn't right/);
    const link = await db.partnerLink.create({ data: { id: `jl${Date.now()}`, shopId: B, side: "retail", partnerName: "Some shop" } });
    await expectError("partner shops", () => joinCompanyFor(a.user, code, bName), /partner shops/);
    await db.partnerLink.delete({ where: { shopId_id: { shopId: B, id: link.id } } });
    const clash = await db.giftCard.create({ data: { shopId: A, number: bCard.number, balanceCents: 0 } });
    await expectError("a gift card number in both", () => joinCompanyFor(a.user, code, bName), /in both companies/);
    await db.giftCard.delete({ where: { id: clash.id } });
    ok("only with a join code made by the other company's owner signed in there (never by email; run out after 30 minutes), typing its name; refused with partner shops or a gift card number both use");

    // ---------- 2. the join ----------
    const aSaleMax = (await db.sale.aggregate({ where: { shopId: A }, _max: { number: true } }))._max.number!;
    const bSaleNo = (await db.sale.findUniqueOrThrow({ where: { id: bSale.saleId } })).number;
    const r = await joinCompanyFor(a.user, ` ${code.toLowerCase()} `, bName.toLowerCase(), "Florida");
    assert.equal(r.storeName, "Florida");
    const stores = await activeStores(A);
    assert.deepEqual(stores.map((s) => s.name).sort(), ["Florida", "Main store"]);
    const fl = stores.find((s) => s.name === "Florida")!;
    assert.equal(fl.taxRatePct, 7, "the store has the joined company's tax rate");
    assert.equal(fl.address, "2 Gulf Rd, Naples FL");
    // Its items and stock: at the new store.
    const moved = await db.part.findUniqueOrThrow({ where: { id: bPart.id } });
    assert.equal(moved.shopId, A);
    assert.equal(moved.partNumber, "bn-2 (Florida)", "an item number both used is tagged with the store");
    assert.ok(moved.altNumbers.includes("bn-2"));
    assert.equal(await storeQty(db, A, bPart.id, fl.id), 5, "its stock is the new store's");
    assert.equal(await storeQty(db, A, bPart.id, stores.find((s) => s.main)!.id), 0, "none at the main store");
    const lvl = await db.stockLevel.findFirstOrThrow({ where: { partId: bPart.id, locationId: fl.id } });
    assert.equal(lvl.reorderAt, 2);
    assert.equal(lvl.bin, "F1");
    // Its numbers on from the first's.
    const sale = await db.sale.findUniqueOrThrow({ where: { id: bSale.saleId } });
    assert.equal(sale.shopId, A);
    assert.equal(sale.locationId, fl.id);
    assert.equal(sale.number, bSaleNo + Math.ceil((aSaleMax + 1) / 1000) * 1000);
    assert.ok((await db.shop.findUniqueOrThrow({ where: { id: A } })).nextSaleNumber > sale.number, "the counter moved past them");
    assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: bPo.id } })).supplierId, (await db.fabricSupplier.findFirstOrThrow({ where: { shopId: A, name: "Notions Inc" } })).id, "one supplier");
    assert.equal(await db.fabricSupplier.count({ where: { id: bSup.id } }), 0);
    // People: the tech works at Florida; the owner's second login is kept but off.
    const tech = await db.user.findUniqueOrThrow({ where: { id: bTech.id } });
    assert.equal(tech.shopId, A);
    assert.equal(tech.locationId, fl.id);
    const oldOwner = await db.user.findUniqueOrThrow({ where: { id: b.user.id } });
    assert.equal(oldOwner.shopId, A);
    assert.equal(oldOwner.active, false);
    assert.notEqual(oldOwner.email.toLowerCase(), a.user.email.toLowerCase());
    assert.equal((await db.giftCard.findUniqueOrThrow({ where: { id: bCard.id } })).shopId, A, "the gift card works at every store now");
    // The second company: closed, saying where it went.
    const old = await db.shop.findUniqueOrThrow({ where: { id: B } });
    assert.ok(old.movedOutAt && /Joined into .* as the Florida store/.test(old.movedTo ?? ""));
    assert.equal(await db.customer.count({ where: { shopId: B } }), 0);
    assert.equal(await storeCount(A), 2, "the hub is told two stores");
    ok("joined as Florida: its tax rate and address, items and stock at Florida, numbers on from the first's, one supplier, its tech at Florida, the owner's second login off, the old company closed");

    // ---------- 3. customers who may be the same ----------
    assert.deepEqual(r.maybeSame.map((m) => [m.intoId, m.fromId]), [[aCust.id, bCust.id]], "Jane at both (the same email), never merged by itself");
    assert.equal(await db.customer.count({ where: { id: { in: [aCust.id, bCust.id] }, shopId: A } }), 2);
    assert.deepEqual((await sameCustomersFor(a.user, fl.id)).map((m) => m.fromId), [bCust.id]);
    ok("Jane Both is offered for the merge (same email at both); Flo Rida isn't; nothing is merged by itself");

    // ---------- 4. tenant ----------
    await expectError("C joins A without a code", () => joinCompanyFor(c.user, "", a.name), /join code isn't right/);
    assert.deepEqual(await sameCustomersFor(c.user, fl.id), []);
    await expectError("the code again", () => joinCompanyFor(a.user, code, bName), /join code isn't right/);
    ok("tenant: another company's owner can't join it in or see its customers; a closed company can't be joined again");

    console.log(`join-companies.check: ${steps} groups passed`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
