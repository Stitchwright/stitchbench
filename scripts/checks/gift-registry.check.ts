// Wish lists and gift registries (shop-features-round-2-design.md 9.9, package gift-registry): a list for a customer
// (named for her by default), items from stock (by id or the part box's "number | words") or in words, bought at the
// register and ticked off by the sale (a void puts it back), the register's lookup by name, the public page (only what
// is still wanted, only on the shop's own address, gone once not shared, a new link when shared again), the line
// checks, the customer delete, tenant.
//   npm run check scripts/checks/gift-registry.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { deleteCustomerFor } from "@/lib/merge";
import { addRegistryItemFor, createRegistryFor, publicRegistry, registriesByName, registriesFor, registryView, removeRegistryItemFor, setRegistrySharedFor } from "@/lib/gift-registry";
import { checkShop, cleanup } from "./lib";
import { expectNotFound, RUN } from "./tenant";

const RUN_SLUG = `chk-${RUN}-gl`;

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
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
  if (!process.env.PUBLIC_URL) process.env.PUBLIC_URL = "http://localhost:3000";
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0, bookingSlug: RUN_SLUG } });
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Wisher", phone: "555-0111" } });
    const foot = await db.part.create({ data: { shopId: a.shopId, partNumber: "WF-9", numberKeys: ["WF9"], description: "Walking foot", priceCents: 4000, qtyOnHand: 5 } });
    const thread = await db.part.create({ data: { shopId: a.shopId, partNumber: "TH-2", numberKeys: ["TH2"], description: "Thread", priceCents: 900, qtyOnHand: 5 } });

    // 1. The list.
    const r = await createRegistryFor(a.user, jane.id, fd({ eventDate: "2026-12-25" }));
    let v = (await registryView(a.shopId, r.id))!;
    assert.deepEqual([v.title, v.eventDate, !!v.link], ["Jane's wish list", "2026-12-25", true]);
    await addRegistryItemFor(a.user, r.id, fd({ partId: foot.id, qty: "1" }));
    await addRegistryItemFor(a.user, r.id, fd({ partNumber: "th-2 | Thread (5 on hand)", qty: "3", note: "navy" }));
    await addRegistryItemFor(a.user, r.id, fd({ description: "A class gift card" }));
    await expectError("nothing", () => addRegistryItemFor(a.user, r.id, fd({ qty: "1" })), /Pick an item/);
    await expectError("too many", () => addRegistryItemFor(a.user, r.id, fd({ description: "x", qty: "500" })), /1 to 99/);
    v = (await registryView(a.shopId, r.id))!;
    assert.deepEqual(v.lines.map((l) => [l.description, l.qtyWanted, l.left]), [["Walking foot (WF-9)", 1, 1], ["Thread (TH-2)", 3, 3], ["A class gift card", 1, 1]]);
    ok("a list named for her, items from stock by id or the part box, one in words; nothing or 500 refused");

    // 2. Bought at the register.
    const hits = await registriesByName(a.shopId, "wisher");
    assert.equal(hits.length, 1);
    const fItem = hits[0].lines.find((l) => l.partId === foot.id)!;
    const tItem = hits[0].lines.find((l) => l.partId === thread.id)!;
    await expectError("another item", () => completeSaleAs(a.user, { lines: [{ partId: thread.id, registryItemId: fItem.id, description: "", qty: 1, unitPriceCents: 900, taxable: true }], tenders: cash(900) }), /the item on the list/);
    const s1 = await completeSaleAs(a.user, { lines: [{ partId: foot.id, registryItemId: fItem.id, description: "", qty: 1, unitPriceCents: 4000, taxable: true }, { partId: thread.id, registryItemId: tItem.id, description: "", qty: 2, unitPriceCents: 900, taxable: true }], tenders: cash(5800) });
    v = (await registryView(a.shopId, r.id))!;
    assert.deepEqual(v.lines.map((l) => l.left), [0, 1, 1]);
    assert.deepEqual((await registriesByName(a.shopId, "Jane"))[0].lines.map((l) => l.description), ["Thread (TH-2)", "A class gift card"], "the register shows only what is still wanted");
    await voidSaleAs(a.user, s1.saleId, "wrong");
    assert.deepEqual((await registryView(a.shopId, r.id))!.lines.map((l) => l.left), [1, 3, 1], "the void puts them back");
    await completeSaleAs(a.user, { lines: [{ partId: foot.id, registryItemId: fItem.id, description: "", qty: 1, unitPriceCents: 4000, taxable: true }], tenders: cash(4000) });
    ok("bought at the register (the same item only): ticked off; the lookup by name shows what is left; a void puts it back");

    // 3. The public page.
    let pub = (await publicRegistry(RUN_SLUG, v.token))!;
    assert.deepEqual([pub.title, pub.firstName, pub.lines.map((l) => [l.description, l.left])], ["Jane's wish list", "Jane", [["Thread (TH-2)", 3], ["A class gift card", 1]]]);
    assert.ok(!JSON.stringify(pub).includes("bought"), "nothing about buying");
    assert.equal(await publicRegistry("other-slug", v.token), null, "only on the shop's own address");
    await setRegistrySharedFor(a.user, r.id, false);
    assert.equal(await publicRegistry(RUN_SLUG, v.token), null, "not shared: gone");
    await setRegistrySharedFor(a.user, r.id, true);
    const again = (await registryView(a.shopId, r.id))!;
    assert.notEqual(again.token, v.token, "shared again with a new link");
    assert.equal(await publicRegistry(RUN_SLUG, v.token), null);
    pub = (await publicRegistry(RUN_SLUG, again.token))!;
    assert.equal(pub.lines.length, 2);
    await removeRegistryItemFor(a.user, again.lines[2].id);
    ok("the public page: what is still wanted, nothing about buyers, only at the shop's address; stopped, then a new link");

    // 4. Tenant; the delete.
    await expectNotFound("B makes a list for A's customer", () => createRegistryFor(b.user, jane.id, fd({})));
    await expectNotFound("B adds to A's list", () => addRegistryItemFor(b.user, r.id, fd({ description: "x" })));
    await expectNotFound("B removes from A's list", () => removeRegistryItemFor(b.user, again.lines[0].id));
    await expectNotFound("B stops A's list", () => setRegistrySharedFor(b.user, r.id, false));
    assert.equal(await registryView(b.shopId, r.id), null);
    assert.deepEqual(await registriesByName(b.shopId, "Jane"), []);
    const bPart = await db.part.create({ data: { shopId: b.shopId, partNumber: "WF-9", numberKeys: ["WF9"], description: "B foot", priceCents: 1, qtyOnHand: 5 } });
    await expectError("B rings up A's list item", () => completeSaleAs(b.user, { lines: [{ partId: bPart.id, registryItemId: fItem.id, description: "", qty: 1, unitPriceCents: 1, taxable: true }], tenders: cash(1) }), /isn't one of this shop's/);
    await expectError("B adds A's item", () => addRegistryItemFor(a.user, r.id, fd({ partId: bPart.id })), /isn't in your inventory/);
    await deleteCustomerFor(a.user, jane.id, "Jane Wisher");
    assert.deepEqual(await registriesFor(a.shopId, jane.id), []);
    assert.equal(await registryView(a.shopId, r.id), null, "her lists go with her");
    ok("tenant: B can't make, change, stop, read, ring up or fill A's lists; deleting her deletes her lists");
  } finally {
    await cleanup();
  }
  console.log(`gift-registry.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
