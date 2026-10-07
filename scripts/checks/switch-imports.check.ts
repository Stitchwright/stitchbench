// Help switching (shop-features-round-2-design.md 4.7): each system's layout read from a sample built from its documented
// column names (Square, Rain or Like Sew, QuickBooks Point of Sale), the file recognised by its columns, items brought in
// through the spreadsheet import (Square's variations, stock received, suppliers), customers matched by email or phone
// with their history in the notes, gift card balances as existing cards under their own numbers (hidden numbers and used
// cards left out), a tech refused, and the tenant section.
//   npm run -s check scripts/checks/switch-imports.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { parseTable } from "@/lib/parse-table";
import { detect, moneyCell, readCards, readCustomers, readItems } from "@/lib/switch/formats";
import { applySwitchFor, previewSwitch } from "@/lib/switch/import";
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

const SQUARE_ITEMS = [
  "Token,Item Name,Variation Name,SKU,Description,Categories,GTIN,Price,Default Unit Cost,Default Vendor Name,Current Quantity Main Street,Stock Alert Count Main Street",
  "ABC1,Aurifil 50wt,Regular,AUR-2024,Cotton thread,Thread,,13.95,7.50,Checker,6,2",
  'ABC2,Kona Cotton,White,KONA-W,,Fabric,,"$1,012.50",5.25,,3,',
  "ABC3,Clover Seam Ripper,Regular,,,Notions,051221508004,8.25,4.10,Brewer,4,",
  "ABC4,No Number Thing,Regular,,,,,1.00,,,1,",
].join("\n");
const SQUARE_CUSTOMERS = [
  "Reference ID,First Name,Last Name,Email Address,Phone Number,Street Address 1,City,State,Postal Code,Birthday,Memo,Square Customer ID,First Visit,Last Visit,Transaction Count,Total Spend",
  ",Jane,Quilter,jane-sw@example.test,(555) 410-2000,1 Main St,Springfield,IL,62701,1960-04-01,Likes batiks,SQ1,2021-01-02,2026-09-30,42,\"$1,234.50\"",
  ",Sue,Sewer,,555-410-3000,,,,,,,SQ2,,,,",
  ",No,Contact,,,,,,,,,SQ3,,,,",
].join("\n");
const SQUARE_CARDS = ["Gift Card Number,Balance,Status", "7783320012345678,25.00,Active", "7783320099990000,0.00,Active", "************1234,10.00,Active", "7783320055554444,40.00,Deactivated"].join("\n");
const QB_ITEMS = ["Item Number\tItem Name\tItem Description\tUPC\tRegular Price\tAverage Unit Cost\tOn Hand Qty\tVendor Name", "1001\tBobbin case\tBrother bobbin case\t\t24.99\t11.00\t2\tTacony", "1002\tNeedles 90/14\tSchmetz universal\t\t5.49\t2.10\t30\t"].join("\n");
const QB_CUSTOMERS = ["Customer ID,Last Name,First Name,Company,Phone 1,EMail,Street,City,State,ZIP", "77,Quilter,Jane,,555 410 2000,,,,,", "78,Baker,Bea,Bea's Bags,,bea@example.test,,,,"].join("\n");
const RAIN_ITEMS = ["SKU,Name,UPC,Price,Cost,Quantity On Hand,Manufacturer,Vendor", "R-1,Wonder Clips (50),,14.99,7.00,10,Clover,Checker"].join("\n");
const QB_CARDS = ["Gift Certificate #,Amount Remaining", "GCERT0001,15.00"].join("\n");

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    // 1. Reading each layout; the file recognised.
    assert.equal(moneyCell("$1,012.50"), 101250);
    assert.equal(moneyCell("(12.00)"), -1200);
    const sq = readItems("square", parseTable(SQUARE_ITEMS));
    assert.deepEqual(
      sq.rows.map((r) => [r.partNumber, r.description, r.priceCents, r.costCents, r.qty]),
      [
        ["AUR-2024", "Aurifil 50wt", 1395, 750, 6],
        ["KONA-W", "Kona Cotton, White", 101250, 525, 3],
        ["051221508004", "Clover Seam Ripper", 825, 410, 4],
      ],
    );
    assert.match(sq.problems[0], /Row 5 \(No Number Thing\): no item number or barcode/);
    const sc = readCustomers("square", parseTable(SQUARE_CUSTOMERS));
    assert.equal(sc.rows.length, 2);
    assert.equal(sc.rows[0].history, "From Square: spent $1234.50, 42 visits, first 2021-01-02, last 2026-09-30.");
    assert.ok(sc.rows[0].notes?.includes("Likes batiks") && sc.rows[0].notes.includes("Birthday: 1960-04-01") && sc.rows[0].address === "1 Main St, Springfield, IL 62701");
    const cards = readCards("square", parseTable(SQUARE_CARDS));
    assert.deepEqual(cards.rows, [{ number: "7783320012345678", balanceCents: 2500, email: null }]);
    assert.match(cards.problems.join(" "), /hidden/);
    assert.deepEqual(readItems("qbpos", parseTable(QB_ITEMS)).rows[0], { partNumber: "1001", barcode: null, description: "Bobbin case", brand: null, supplier: "Tacony", costCents: 1100, priceCents: 2499, qty: 2 });
    assert.equal(readCustomers("qbpos", parseTable(QB_CUSTOMERS)).rows[1].name, "Bea Baker");
    assert.deepEqual(detect(parseTable(SQUARE_ITEMS)[0]), { system: "square", kind: "items" });
    assert.deepEqual(detect(parseTable(SQUARE_CUSTOMERS)[0]), { system: "square", kind: "customers" });
    assert.deepEqual(detect(parseTable(QB_ITEMS)[0]), { system: "qbpos", kind: "items" });
    assert.deepEqual(detect(parseTable(QB_CUSTOMERS)[0]), { system: "qbpos", kind: "customers" });
    assert.equal(detect(["Foo", "Bar"]), null);
    ok("Square, QuickBooks POS and Rain layouts read (variations, money in any shape, history to notes, hidden card numbers refused); files recognised by their columns");

    // 2. Items through the import: preview, bring in, again (updated, not doubled).
    await expectError("a tech", () => previewSwitch({ ...a.user, role: "TECH" }, "square", "items", SQUARE_ITEMS), /owner or admin/);
    await expectError("the wrong file", () => previewSwitch(a.user, "square", "items", SQUARE_CUSTOMERS), /no column for/);
    await db.part.create({ data: { shopId: a.shopId, partNumber: "AUR-2024", description: "Aurifil (old)", numberKeys: ["AUR2024"], qtyOnHand: 1, priceCents: 1200 } });
    const p = await previewSwitch(a.user, "square", "items", SQUARE_ITEMS);
    assert.ok(p.total === 3 && p.fresh === 2 && p.already === 1 && p.problems.length === 1);
    const told = await applySwitchFor(a.user, "square", "items", SQUARE_ITEMS, { itemKind: "THREAD" });
    assert.match(told, /From Square: 2 items added, 1 updated/);
    const aur = await db.part.findFirstOrThrow({ where: { shopId: a.shopId, partNumber: "AUR-2024" } });
    assert.ok(aur.priceCents === 1395 && aur.qtyOnHand === 7 && aur.supplier === "Checker");
    const kona = await db.part.findFirstOrThrow({ where: { shopId: a.shopId, partNumber: "KONA-W" } });
    assert.ok(kona.kind === "THREAD" && kona.qtyOnHand === 3);
    await applySwitchFor(a.user, "qbpos", "items", QB_ITEMS);
    await applySwitchFor(a.user, "rain", "items", RAIN_ITEMS, { addQty: false });
    assert.equal((await db.part.findFirstOrThrow({ where: { shopId: a.shopId, partNumber: "R-1" } })).qtyOnHand, 0, "quantities not put on the shelf when asked not to");
    ok("items: the preview's new and already-here counts, brought in (updated, stock received, suppliers filled), QuickBooks and Rain too");

    // 3. Customers: matched by email or phone, history in the notes, no marketing.
    await db.customer.create({ data: { shopId: a.shopId, name: "Jane Q", phone: "555.410.2000" } });
    const cp = await previewSwitch(a.user, "square", "customers", SQUARE_CUSTOMERS);
    assert.ok(cp.total === 2 && cp.already === 1);
    assert.match(await applySwitchFor(a.user, "square", "customers", SQUARE_CUSTOMERS), /1 customer added, 1 already here/);
    const jane = await db.customer.findFirstOrThrow({ where: { shopId: a.shopId, name: "Jane Q" } });
    assert.ok(jane.email === "jane-sw@example.test" && jane.notes?.includes("spent $1234.50") && jane.address?.startsWith("1 Main St"));
    await applySwitchFor(a.user, "square", "customers", SQUARE_CUSTOMERS);
    const again = await db.customer.findFirstOrThrow({ where: { id: jane.id } });
    assert.equal(again.notes, jane.notes, "the history isn't added twice");
    assert.match(await applySwitchFor(a.user, "qbpos", "customers", QB_CUSTOMERS), /1 customer added, 1 already here/);
    assert.equal(await db.customer.count({ where: { shopId: a.shopId, smsConsentAt: { not: null } } }), 0);
    ok("customers: matched by email or phone (details filled, history once), new ones added, nobody signed up for marketing");

    // 4. Gift cards: balances under their own numbers; again: already here.
    const gp = await previewSwitch(a.user, "square", "giftcards", SQUARE_CARDS);
    assert.ok(gp.total === 1 && gp.fresh === 1);
    assert.match(await applySwitchFor(a.user, "square", "giftcards", SQUARE_CARDS), /1 gift card added with \$25\.00/);
    const card = await db.giftCard.findFirstOrThrow({ where: { shopId: a.shopId, number: "7783320012345678" }, include: { entries: true } });
    assert.ok(card.balanceCents === 2500 && card.entries[0].reason === "OPENING");
    assert.match(await applySwitchFor(a.user, "square", "giftcards", SQUARE_CARDS), /already in use/);
    assert.match(await applySwitchFor(a.user, "qbpos", "giftcards", QB_CARDS), /1 gift card added with \$15\.00/);
    ok("gift card balances: existing cards under their own numbers (OPENING on the ledger); a second run adds none");

    // 5. Tenant: B's import never touches A's records.
    const before = await db.part.count({ where: { shopId: a.shopId } });
    const bp = await previewSwitch(b.user, "square", "items", SQUARE_ITEMS);
    assert.ok(bp.already === 0 && bp.fresh === 3, "A's items don't count as B's");
    await applySwitchFor(b.user, "square", "customers", SQUARE_CUSTOMERS);
    assert.equal((await db.customer.findFirstOrThrow({ where: { id: jane.id } })).notes, again.notes);
    assert.match(await applySwitchFor(b.user, "square", "giftcards", SQUARE_CARDS), /1 gift card added/, "the same card number is B's own");
    assert.equal(await db.part.count({ where: { shopId: a.shopId } }), before);
    ok("tenant: another company's preview and imports see and change only its own records");

    console.log(`switch-imports.check: ${steps} groups passed`);
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
