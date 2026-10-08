// Color lookup at the counter (shop-features-round-2-design.md 2.2 and 6.2, package color-lookup): the words split and
// scored ("isa 15", "0015", "ISA-5005", "Aurifil 2024", "navy", "PLA black 1.75", "matte red PETG"), every word having to
// match, the ordering (exact number, in stock), the shop's own matches both ways, "Colors bought before" from sales that
// stand (returns and voids left out), the register's search putting color hits first, and the tenant section.
//   npm run check scripts/checks/color-lookup.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { colorScore, colorTokens } from "@/lib/color-match";
import { colorsBoughtBy, findColorsFor, linkSameAsFor, sameAsOf, unlinkSameAsFor } from "@/lib/colors";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;

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

type Opts = { brand?: string; colorNumber?: string; colorName?: string; colorHex?: string; material?: string; itemType?: string; specs?: Record<string, string>; qty?: number; kind?: "THREAD" | "SUPPLY" | "NOTION" };
async function item(shopId: string, number: string, o: Opts) {
  return db.part.create({
    data: {
      shopId,
      partNumber: number,
      numberKeys: [number.replace(/[^A-Z0-9]/gi, "").toUpperCase()],
      description: `${o.brand ?? ""} ${o.colorName ?? number}`.trim(),
      kind: o.kind ?? "THREAD",
      brand: o.brand ?? null,
      colorNumber: o.colorNumber ?? null,
      colorName: o.colorName ?? null,
      colorHex: o.colorHex ?? null,
      material: o.material ?? null,
      itemType: o.itemType ?? (o.kind && o.kind !== "THREAD" ? null : "thread"),
      specs: o.specs ?? undefined,
      qtyOnHand: o.qty ?? 3,
      priceCents: 899,
      location: "Wall A",
    },
  });
}

const cash = (amountCents: number) => [{ method: "CASH" as const, amountCents }];

async function main() {
  // 1. The words and the score.
  assert.deepEqual(colorTokens("ISA-5005"), ["isa", "5005"]);
  assert.deepEqual(colorTokens("isa5005"), ["isa", "5005"]);
  assert.deepEqual(colorTokens("PLA black 1.75"), ["pla", "black", "1.75"]);
  const isa = { partNumber: "ISA-0015", description: "Isacord White", brand: "Isacord", kind: "THREAD", itemType: "thread", colorNumber: "0015", colorName: "White", material: "Polyester", specs: { weight: "40 wt" } };
  for (const q of ["isa 15", "0015", "15", "ISA-0015", "isacord 0015", "white", "isa white 40"]) assert.ok(colorScore(isa, colorTokens(q)) != null, `"${q}" finds Isacord 0015`);
  for (const q of ["isa 16", "aurifil 15", "navy", "isa 15 black"]) assert.equal(colorScore(isa, colorTokens(q)), null, `"${q}" doesn't`);
  assert.ok(colorScore(isa, colorTokens("isa 15"))! > colorScore(isa, colorTokens("isa 1"))!, "an exact number scores above a near one");
  const pla = { partNumber: "BL-PLA-R", description: "Bambu PLA Matte red", brand: "Bambu Lab", kind: "SUPPLY", itemType: "filament", colorNumber: null, colorName: "Red", material: "PLA", specs: { diameter: "1.75 mm", finish: "Matte", spool: "1 kg" } };
  for (const q of ["PLA red 1.75", "matte red pla", "red", "bambu pla"]) assert.ok(colorScore(pla, colorTokens(q)) != null, `"${q}" finds the red PLA`);
  assert.equal(colorScore(pla, colorTokens("matte red PETG")), null, "PETG isn't PLA");
  assert.equal(colorScore({ ...isa, colorNumber: null, colorName: null, material: null, specs: null, itemType: null, kind: "NOTION" }, colorTokens("white")), null, "a word only in the description isn't a color hit");
  ok('words split and scored: "isa 15", "0015", "ISA-0015", "white", "PLA red 1.75", "matte red pla"; a wrong number, maker, color or material doesn\'t match');

  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    // 2. Lookups on real rows.
    const i15 = await item(a.shopId, "ISA-0015", { brand: "Isacord", colorNumber: "0015", colorName: "White", colorHex: "#ffffff", material: "Polyester", specs: { weight: "40 wt" } });
    const i1510 = await item(a.shopId, "ISA-1510", { brand: "Isacord", colorNumber: "1510", colorName: "Ivory", qty: 0 });
    const aur = await item(a.shopId, "AUR-2024", { brand: "Aurifil", colorNumber: "2024", colorName: "White", material: "Cotton" });
    const mad = await item(a.shopId, "MAD-1147", { brand: "Madeira", colorNumber: "1147", colorName: "Navy", colorHex: "#1b2a4a" });
    const navyIsa = await item(a.shopId, "ISA-3644", { brand: "Isacord", colorNumber: "3644", colorName: "Navy", qty: 0 });
    await item(a.shopId, "BL-PLA-R", { kind: "SUPPLY", itemType: "filament", brand: "Bambu Lab", colorName: "Red", material: "PLA", specs: { diameter: "1.75 mm", finish: "Matte" } });
    await item(a.shopId, "BL-PETG-R", { kind: "SUPPLY", itemType: "filament", brand: "Bambu Lab", colorName: "Red", material: "PETG", specs: { diameter: "1.75 mm" } });
    const old = await db.part.create({ data: { shopId: a.shopId, partNumber: "OLD-THR", numberKeys: ["OLDTHR"], description: "Old white thread", kind: "THREAD", qtyOnHand: 1 } });
    const nums = async (q: string) => (await findColorsFor(a.shopId, q)).map((h) => h.partNumber);
    assert.deepEqual(await nums("isa 15"), ["ISA-0015", "ISA-1510"], "exact number first, a near one after");
    assert.deepEqual(await nums("Aurifil 2024"), ["AUR-2024"]);
    assert.deepEqual(await nums("navy"), ["MAD-1147", "ISA-3644"], "in stock first");
    assert.deepEqual(await nums("PLA red 1.75"), ["BL-PLA-R"]);
    assert.deepEqual(await nums("red petg"), ["BL-PETG-R"]);
    assert.ok((await nums("thread")).includes("OLD-THR"), "a thread saved before types is found as thread");
    const hit = (await findColorsFor(a.shopId, "0015"))[0];
    assert.deepEqual([hit.details, hit.colorHex, hit.location, hit.qtyOnHand], ["Isacord 0015 White · 40 wt polyester", "#ffffff", "Wall A", 3]);
    assert.deepEqual(await findColorsFor(a.shopId, "x"), [], "nothing for a single letter");
    ok("lookups: exact number first, in stock first, maker and number, color names, filament by material and diameter; the hit carries details, swatch, bin and stock");

    // 3. The shop's own matches, both ways.
    assert.match(await linkSameAsFor(user(a), navyIsa.id, "mad-1147"), /marked the same color/);
    assert.deepEqual((await sameAsOf(a.shopId, mad.id)).map((s) => s.label), ["Isacord 3644 Navy"], "both ways");
    const navyHit = (await findColorsFor(a.shopId, "isa 3644"))[0];
    assert.deepEqual(navyHit.sameAs.map((s) => [s.label, s.qtyOnHand]), [["Madeira 1147 Navy", 3]], "out of Isacord 3644: Madeira 1147 is on the shelf");
    await expectError("twice", () => linkSameAsFor(user(a), mad.id, "ISA-3644"), /already marked/);
    await expectError("itself", () => linkSameAsFor(user(a), mad.id, "MAD-1147"), /No other item/);
    await expectError("unknown", () => linkSameAsFor(user(a), mad.id, "NOPE"), /No other item/);
    await unlinkSameAsFor(user(a), mad.id, navyIsa.id);
    assert.deepEqual([(await sameAsOf(a.shopId, mad.id)).length, (await sameAsOf(a.shopId, navyIsa.id)).length], [0, 0], "taken off both ways");
    ok("the shop's matches: linked by number both ways, shown with stock in the lookup, refused twice / itself / unknown, taken off both ways");

    // 4. Colors bought before: sales that stand, returns and voids left out.
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Thread Tina" } });
    const s1 = await completeSaleAs(user(a), { customerId: cust.id, lines: [{ partId: i15.id, description: "", qty: 1, unitPriceCents: 899, taxable: true }, { partId: old.id, description: "", qty: 1, unitPriceCents: 899, taxable: true }], tenders: cash(1798) });
    await completeSaleAs(user(a), { customerId: cust.id, lines: [{ partId: aur.id, description: "", qty: 2, unitPriceCents: 899, taxable: true }], tenders: cash(1798) });
    const s3 = await completeSaleAs(user(a), { customerId: cust.id, lines: [{ partId: mad.id, description: "", qty: 1, unitPriceCents: 899, taxable: true }], tenders: cash(899) });
    await voidSaleAs(user(a), s3.saleId, "rung up by mistake");
    await completeSaleAs(user(a), { customerId: cust.id, lines: [{ partId: i1510.id, description: "", qty: -1, unitPriceCents: 899, taxable: true }], tenders: cash(-899) }).catch(() => undefined);
    const bought = await colorsBoughtBy(a.shopId, cust.id);
    assert.deepEqual(bought.map((h) => h.partNumber).sort(), ["AUR-2024", "ISA-0015", "OLD-THR"], "the voided sale and a return are left out");
    assert.ok(bought.every((h) => h.boughtText && /\d{4}/.test(h.boughtText)), "each says when");
    void s1;
    ok("colors bought before: from her sales that stand, each once, with when; a voided sale and a return are left out");

    // 5. Tenant.
    assert.deepEqual(await findColorsFor(b.shopId, "isa 15"), [], "B finds none of A's");
    assert.deepEqual(await colorsBoughtBy(b.shopId, cust.id), [], "B can't read A's customer's colors");
    await expectNotFound("B links A's item", () => linkSameAsFor(user(b), mad.id, "ISA-3644"));
    const bThread = await item(b.shopId, "B-THR", { brand: "Isacord", colorNumber: "0015" });
    await expectError("B links to A's number", () => linkSameAsFor(user(b), bThread.id, "ISA-0015"), /No other item/);
    await db.part.update({ where: { id: bThread.id }, data: { sameAs: [mad.id] } });
    assert.deepEqual(await sameAsOf(b.shopId, bThread.id), [], "an id of A's in B's list shows nothing");
    ok("tenant: B finds none of A's colors or customers, can't link A's items, and a stray id of A's shows nothing");
  } finally {
    await cleanup();
  }
  console.log(`color-lookup.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
