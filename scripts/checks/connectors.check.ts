// Wholesaler connectors (fabric-smarts-design.md section 5a, package F6): the spreadsheet readers (CSV, Windows-1252,
// .xlsx), the column mapping, the dry run and the apply (create or update by the maker's item number, stock untouched,
// idempotent), the order in a per-supplier column layout, the email body and the send through the shop's own SMTP (the
// sink) with its fallbacks, the Notions Marketing placeholder, that no wholesaler login is kept anywhere, and the tenant
// section.
//   npm run check scripts/checks/connectors.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { applyCatalogFor, previewCatalogFor, sheetViewFor } from "@/lib/connectors/catalog";
import { DEFAULT_ORDER_LAYOUT, cleanLayout, cleanMap, csvText, layoutText, orderEmailParts, parseLayoutText, readCatalogRows, suggestMap } from "@/lib/connectors/layout";
import { connectorFor, connectorList } from "@/lib/connectors/registry";
import { NOTIONS_MARKETING_LAYOUT } from "@/lib/connectors/notions-marketing";
import { readTable } from "@/lib/connectors/sheet";
import { addLineFor, createOrderFor, orderCsvRows, orderFor, saveConnectorFor, saveSupplierFor, sendOrderFor, suppliersFor } from "@/lib/fabric-orders";
import { checkShop, cleanup, messagingFor, withSink, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

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
function expectThrowSync(label: string, fn: () => unknown, re: RegExp) {
  try {
    fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

// A minimal .xlsx writer for the check (stored and deflated zip entries), so the reader is tested on a real zip.
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function zip(files: { name: string; data: string; deflate?: boolean }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.data, "utf8");
    const body = f.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(f.name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(f.deflate ? 8 : 0, 8);
    h.writeUInt32LE(crc32(raw), 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(name.length, 26);
    parts.push(h, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(f.deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(files.length, 8);
  e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, e]);
}
const cellXml = (ref: string, v: string | number | null, t?: "s" | "inline") =>
  v === null ? `<c r="${ref}" s="1"/>` : t === "inline" ? `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>` : t === "s" ? `<c r="${ref}" t="s"><v>${v}</v></c>` : `<c r="${ref}"><v>${v}</v></c>`;

function xlsx(): Uint8Array {
  // Shared strings: 0 Item #, 1 Description, 2 Wholesale, 3 Collection, 4 BE-100, 5 Batik Blue & Green, 6 Bali, 7 title line
  const sst = ["Item #", "Description", "Wholesale", "Collection", "BE-100", "Batik Blue &amp; Green", "Bali", "Fall price list"];
  const sharedXml = `<?xml version="1.0"?><sst xmlns="x" count="8" uniqueCount="8">${sst.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
  const rows = [
    `<row r="1">${cellXml("A1", 7, "s")}</row>`,
    `<row r="2">${cellXml("A2", 0, "s")}${cellXml("B2", 1, "s")}${cellXml("C2", 2, "s")}${cellXml("E2", 3, "s")}</row>`,
    `<row r="3">${cellXml("A3", 4, "s")}${cellXml("B3", 5, "s")}${cellXml("C3", "4.1")}${cellXml("D3", null)}${cellXml("E3", 6, "s")}</row>`,
    `<row r="4">${cellXml("A4", "BE-101", "inline")}${cellXml("B4", "Inline row")}${cellXml("C4", "8.4999999999999992")}</row>`,
    `<row r="5"/>`,
  ].join("");
  return new Uint8Array(
    zip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "xl/workbook.xml", data: `<workbook><sheets><sheet name="Fall" sheetId="1" r:id="rId7"/></sheets></workbook>`, deflate: true },
      { name: "xl/_rels/workbook.xml.rels", data: `<Relationships><Relationship Id="rId7" Type="t" Target="worksheets/sheet2.xml"/></Relationships>` },
      { name: "xl/sharedStrings.xml", data: sharedXml, deflate: true },
      { name: "xl/worksheets/sheet2.xml", data: `<worksheet><sheetData>${rows}</sheetData></worksheet>`, deflate: true },
    ]),
  );
}

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    // 1. Readers.
    const csv = ['Fall price list,,', 'Item #,Description,Wholesale,Collection', 'BE-100,"Batik, Blue",$4.10,Bali', "BE-101,Plain,8.50,", ",No number,1.00,", "BE-102,Odd price,abc,Bali"].join("\n");
    const t = readTable("fall.csv", bytes("﻿" + csv));
    assert.deepEqual(t[1], ["Item #", "Description", "Wholesale", "Collection"]);
    assert.deepEqual(t[2], ["BE-100", "Batik, Blue", "$4.10", "Bali"]);
    const latin = readTable("old.csv", new Uint8Array(Buffer.from("Item #,Description\nBE-1,Caf\xe9 print\n", "latin1")));
    assert.equal(latin[1][1], "Café print", "Windows-1252 (Excel's plain CSV) reads as accents");
    const x = readTable("fall.xlsx", xlsx());
    assert.deepEqual(x[0], ["Fall price list"]);
    assert.deepEqual(x[1], ["Item #", "Description", "Wholesale", "", "Collection"]);
    assert.deepEqual(x[2], ["BE-100", "Batik Blue & Green", "4.1", "", "Bali"], "shared strings, entities, an empty cell between");
    assert.deepEqual(x[3], ["BE-101", "Inline row", "8.5"], "inline strings; 8.4999999999999992 reads as 8.5");
    assert.equal(x.length, 4, "an empty row is dropped");
    expectThrowSync("empty file", () => readTable("x.csv", new Uint8Array(0)), /empty/);
    expectThrowSync("old xls", () => readTable("x.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4])), /old Excel/);
    expectThrowSync("binary junk", () => readTable("x.csv", new Uint8Array([65, 0, 66, 0, 67])), /doesn't look like/);
    expectThrowSync("a zip that isn't a workbook", () => readTable("x.xlsx", new Uint8Array(zip([{ name: "a.txt", data: "hi" }]))), /isn't an Excel workbook/);
    ok("readers: CSV with a BOM, quotes and title lines; Windows-1252; .xlsx (shared and inline strings, entities, gaps, numbers, empty rows); bad files refused in plain words");

    // 2. Mapping.
    const headers = t[1];
    const guess = suggestMap(headers);
    assert.deepEqual(guess, { itemNumber: "Item #", description: "Description", costPerYard: "Wholesale", collection: "Collection" });
    assert.deepEqual(cleanMap({ itemNumber: " Item # ", costPerYard: "Wholesale", evil: "x", description: 5, password: "p" }), { itemNumber: "Item #", costPerYard: "Wholesale" });
    const read = readCatalogRows(t, guess);
    assert.deepEqual(
      read.rows.map((r) => [r.line, r.itemNumber, r.description, r.costTenThou, r.costCents, r.collection]),
      [
        [3, "BE-100", "Batik, Blue", 41000, 410, "Bali"],
        [4, "BE-101", "Plain", 85000, 850, undefined],
        [6, "BE-102", "Odd price", undefined, undefined, "Bali"],
      ],
    );
    assert.ok(read.problems.some((p) => /Row 5: no item number/.test(p)));
    assert.ok(read.problems.some((p) => /Row 6 \(BE-102\): cost "abc"/.test(p)));
    assert.deepEqual(readCatalogRows(t, { itemNumber: "Item #", costPerYard: "Nope" }).missing, ["costPerYard"]);
    assert.match(readCatalogRows(t, { description: "Description" }).problems[0], /item number/);
    // By heading: a re-ordered sheet reads the same.
    const re = readCatalogRows([["Collection", "Wholesale", "Item #"], ["Bali", "4.10", "BE-100"]], guess);
    assert.deepEqual([re.rows[0].itemNumber, re.rows[0].costCents, re.rows[0].collection], ["BE-100", 410, "Bali"]);
    ok("mapping: headings suggest the columns; a saved map is cleaned (unknown keys dropped) and reads by heading; bad figures and missing numbers are reported, not guessed");

    // 3. Dry run and apply.
    await saveSupplierFor(user(a), fd({ name: "Test Wholesale", orderEmail: "orders@testwholesale.example" }));
    const sup = await db.fabricSupplier.findFirstOrThrow({ where: { shopId: a.shopId, name: "Test Wholesale" } });
    const mk = (n: string, o: Record<string, unknown> = {}) =>
      db.part.create({ data: { shopId: a.shopId, partNumber: n, numberKeys: [n.replace(/[^A-Z0-9]/gi, "").toUpperCase()], description: `Existing ${n}`, kind: "FABRIC", unit: "yd", qtyOnHand: 12, costCents: 300, priceCents: 1300, ...o } });
    const exists = await mk("BE-100", { qtyOnHand: 12.5 });
    const marked = await mk("BE-101", { priceCents: 900 });
    await db.fabricMarkdown.create({ data: { shopId: a.shopId, partId: marked.id, step: 1, pct: 10, regularCents: 1000, oldCents: 1000, newCents: 900, reason: "check" } });
    const notion = await db.part.create({ data: { shopId: a.shopId, partNumber: "BE-102", numberKeys: ["BE102"], description: "A notion", kind: "NOTION", qtyOnHand: 3 } });
    const sheet = ["Item #,Description,Wholesale,Retail,Collection", "be 100,Batik Blue,4.10,14.00,Bali", "BE-101,Plain Cream,8.50,12.00,Bali", "BE-102,Notion clash,1.00,2.00,", "BE-200,New one,5.25,13.50,Bali", "BE-200,New one twice,5.25,13.50,Bali", "BE-201,Another new,0.125,,Bali"].join("\n");
    const mapA = { itemNumber: "Item #", description: "Description", costPerYard: "Wholesale", pricePerYard: "Retail", collection: "Collection" };
    const view = await sheetViewFor(user(a), sup.id, "w.csv", bytes(sheet));
    assert.deepEqual([view.rowCount, view.mapFrom, view.map.itemNumber, view.map.costPerYard], [6, "suggested", "Item #", "Wholesale"]);
    const before = JSON.stringify(await db.part.findMany({ where: { shopId: a.shopId }, orderBy: { id: "asc" } }));
    const pv = await previewCatalogFor(user(a), sup.id, "w.csv", bytes(sheet), mapA);
    assert.deepEqual([pv.create, pv.update, pv.unchanged], [2, 2, 0]);
    assert.ok(pv.problems.some((p) => /BE-101 is marked down, so its price was left alone/.test(p)));
    assert.ok(pv.problems.some((p) => /BE-102.*something other than fabric/.test(p)));
    assert.ok(pv.problems.some((p) => /BE-200 is in the sheet twice/.test(p)));
    assert.ok(pv.changeSample.some((c) => c.itemNumber === "be 100" && c.what.some((w) => /cost \$3\.00 to \$4\.10/.test(w))));
    assert.equal(JSON.stringify(await db.part.findMany({ where: { shopId: a.shopId }, orderBy: { id: "asc" } })), before, "a dry run writes nothing");
    assert.equal((await db.fabricSupplier.findUniqueOrThrow({ where: { id: sup.id } })).catalogAt, null);
    await expectError("no item number column", () => previewCatalogFor(user(a), sup.id, "w.csv", bytes(sheet), { description: "Description" }), /item number/);
    await expectError("a column the sheet lacks", () => previewCatalogFor(user(a), sup.id, "w.csv", bytes(sheet), { itemNumber: "SKU" }), /no column headed "SKU"/);
    const note = await applyCatalogFor(user(a), sup.id, "w.csv", bytes(sheet), mapA, true);
    assert.match(note, /2 new, 2 updated, 0 unchanged/);
    const e1 = await db.part.findUniqueOrThrow({ where: { id: exists.id } });
    assert.deepEqual([e1.costCents, e1.costTenThou, e1.priceCents, e1.description, e1.collection, e1.supplier, e1.qtyOnHand], [410, 41000, 1400, "Batik Blue", "Bali", "Test Wholesale", 12.5], "updated by number ('be 100' is BE-100); stock untouched");
    const m1 = await db.part.findUniqueOrThrow({ where: { id: marked.id } });
    assert.deepEqual([m1.priceCents, m1.costCents, m1.description], [900, 850, "Plain Cream"], "a marked-down price is left alone; the rest updates");
    const n1 = await db.part.findUniqueOrThrow({ where: { id: notion.id } });
    assert.deepEqual([n1.kind, n1.description, n1.qtyOnHand], ["NOTION", "A notion", 3], "a non-fabric item with that number is left alone");
    const fresh = await db.part.findMany({ where: { shopId: a.shopId, partNumber: { in: ["BE-200", "BE-201"] } }, orderBy: { partNumber: "asc" } });
    assert.deepEqual(
      fresh.map((p) => [p.partNumber, p.kind, p.unit, p.qtyOnHand, p.costCents, p.costTenThou, p.priceCents, p.collection, p.supplier, p.boltYards, p.numberKeys]),
      [
        ["BE-200", "FABRIC", "yd", 0, 525, 52500, 1350, "Bali", "Test Wholesale", 15, ["BE200"]],
        ["BE-201", "FABRIC", "yd", 0, 13, 1250, null, "Bali", "Test Wholesale", 15, ["BE201"]],
      ],
    );
    assert.equal(await db.stockMove.count({ where: { shopId: a.shopId } }), 0, "no stock moves: a catalog is not stock");
    const sAfter = await db.fabricSupplier.findUniqueOrThrow({ where: { id: sup.id } });
    assert.deepEqual(cleanMap(sAfter.catalogMap), mapA);
    assert.ok(sAfter.catalogAt && /2 new, 2 updated/.test(sAfter.catalogNote ?? ""));
    const view2 = await sheetViewFor(user(a), sup.id, "w.csv", bytes(sheet));
    assert.deepEqual([view2.mapFrom, view2.map], ["saved", mapA]);
    // Again: nothing new, nothing changed (upsert by item number).
    const again = await previewCatalogFor(user(a), sup.id, "w.csv", bytes(sheet), mapA);
    assert.deepEqual([again.create, again.update, again.unchanged], [0, 0, 4]);
    assert.match(await applyCatalogFor(user(a), sup.id, "w.csv", bytes(sheet), mapA, false), /0 new, 0 updated, 4 unchanged/);
    assert.equal(await db.part.count({ where: { shopId: a.shopId, partNumber: { in: ["BE-200", "BE-201"] } } }), 2, "no duplicates on a second import");
    // The .xlsx goes through the same path.
    const xv = await previewCatalogFor(user(a), sup.id, "fall.xlsx", xlsx(), { itemNumber: "Item #", description: "Description", costPerYard: "Wholesale", collection: "Collection" });
    assert.deepEqual([xv.create, xv.update], [0, 2], "both rows exist (BE-100, BE-101): their descriptions change");
    ok("dry run: counts and examples, nothing written; apply: creates (no stock) and updates by item number (any punctuation or case), skips marked-down prices, non-fabric clashes and repeats, saves the map; a second import changes nothing");

    // 4. Order layout.
    await saveConnectorFor(user(a), fd({ name: "Test Wholesale", connector: "file", accountNumber: "ACCT-77", layout: ["SKU = itemNumber", "Qty = quantity", "Unit = unit", "Bolts = bolts", "PO = poNumber", "Acct = account", "Ship via = text: Best way", "Cost = costPerYard"].join("\n") }));
    const po = await createOrderFor(user(a), "Test Wholesale");
    await addLineFor(user(a), po, fd({ itemNumber: "BE-100", qty: "2", unit: "BOLT", cost: "4.10" }));
    await addLineFor(user(a), po, fd({ itemNumber: "BE-200", qty: "7.5", unit: "YD", cost: "5.25" }));
    const o = (await orderFor(a.shopId, po))!;
    assert.equal(o.supplier.connector, "file");
    assert.equal(o.supplier.accountNumber, "ACCT-77");
    const rows = orderCsvRows(o);
    assert.deepEqual(rows[0], ["SKU", "Qty", "Unit", "Bolts", "PO", "Acct", "Ship via", "Cost"]);
    assert.deepEqual(rows[1], ["BE-100", 2, "bolt", 2, String(o.number), "ACCT-77", "Best way", "4.10"]);
    assert.deepEqual(rows[2], ["BE-200", 7.5, "yd", 0.5, String(o.number), "ACCT-77", "Best way", "5.25"], "7.5 yd on a 15 yd bolt is 0.5 bolt");
    assert.equal(csvText([["=1+1", "a,b", "x\"y"]]), "'=1+1,\"a,b\",\"x\"\"y\"\r\n", "formula cells defused, quoting");
    // Blank layout: the plain one. Bad layouts: refused with the line named.
    await saveConnectorFor(user(a), fd({ name: "Test Wholesale", connector: "file", accountNumber: "", layout: "" }));
    const plain = orderCsvRows((await orderFor(a.shopId, po))!);
    assert.deepEqual(plain[0], DEFAULT_ORDER_LAYOUT.map((c) => c.header));
    assert.deepEqual(plain[0], ["item_number", "description", "quantity", "unit", "yards", "cost_per_yard", "line_total"]);
    await expectError("layout line without =", () => saveConnectorFor(user(a), fd({ name: "Test Wholesale", connector: "file", layout: "just a heading" })), /Heading = what goes in it/);
    await expectError("layout field unknown", () => saveConnectorFor(user(a), fd({ name: "Test Wholesale", connector: "file", layout: "Pw = password" })), /isn't something an order column can hold/);
    await expectError("unknown connector", () => saveConnectorFor(user(a), fd({ name: "Test Wholesale", connector: "evil" })), /Pick one of the ways/);
    assert.deepEqual(parseLayoutText(layoutText(NOTIONS_MARKETING_LAYOUT)), NOTIONS_MARKETING_LAYOUT, "the layout text round-trips");
    assert.deepEqual(cleanLayout([{ header: "x", field: "itemNumber", password: "p" }, { header: "y", field: "nope" }]), [{ header: "x", field: "itemNumber" }]);
    ok("order export: the supplier's own columns (item, amount, unit, bolts, order number, account, fixed text, cost), blank = the plain layout, formula cells defused, bad layouts refused naming the problem");

    // 5. Notions Marketing: the file connector with placeholder columns.
    const nm = connectorFor("notions-marketing");
    assert.deepEqual([nm.channel, nm.placeholder], ["file", true]);
    await saveConnectorFor(user(a), fd({ name: "Notions Marketing", connector: "notions-marketing" }));
    const poN = await createOrderFor(user(a), "Notions Marketing");
    await addLineFor(user(a), poN, fd({ itemNumber: "BE-100", qty: "1", unit: "BOLT" }));
    const nmRows = nm.exportOrder!({ shopId: a.shopId, supplier: { id: "x", name: "Notions Marketing", orderEmail: null, accountNumber: null, catalogMap: null, orderLayout: null } }, (await orderFor(a.shopId, poN))!).rows;
    assert.deepEqual(nmRows[0], ["SKU", "Quantity", "PO Number"]);
    assert.deepEqual(nmRows[1].slice(0, 2), ["BE-100", 1]);
    assert.ok(nm.readCatalog!([["SKU", "Description", "Cost"], ["Z-1", "Thing", "2.00"]], {}).rows.length === 1, "the placeholder map reads a sheet with its guessed headings");
    ok("Notions Marketing adapter: file channel, placeholder columns (SKU, Quantity, PO Number) until their layout arrives");

    // 6. The email: body, sent through the shop's own SMTP, and the fallbacks.
    const sink = await withSink();
    await saveConnectorFor(user(a), fd({ name: "Test Wholesale", connector: "email", accountNumber: "ACCT-77", layout: "SKU = itemNumber\nQty = quantity\nUnit = unit" }));
    const poE = await createOrderFor(user(a), "Test Wholesale");
    await addLineFor(user(a), poE, fd({ itemNumber: "BE-100", qty: "2", unit: "BOLT", cost: "4.10" }));
    await addLineFor(user(a), poE, fd({ itemNumber: "BE-200", qty: "7.5", unit: "YD", cost: "5.25" }));
    const oE = (await orderFor(a.shopId, poE))!;
    const parts = orderEmailParts(oE, "ACCT-77", { phone: "555-0100", address: null });
    assert.equal(parts.subject, `Purchase order #${oE.number} from ${a.name}`);
    assert.match(parts.text, /Our account number: ACCT-77/);
    assert.match(parts.text, /BE-100 {2}2 bolts \(30 yd\) {2}@ \$4\.10\/yd/);
    assert.match(parts.text, /Total: 37 1\/2 yd, \$\d+\.\d\d at our cost/);
    assert.match(parts.text, /attached as a spreadsheet/);
    // No mail account set up yet: marked sent, the mailto fallback, and the order says so.
    const noMail = await createOrderFor(user(a), "Test Wholesale");
    await addLineFor(user(a), noMail, fd({ itemNumber: "BE-100", qty: "1", unit: "BOLT" }));
    assert.match(await sendOrderFor(user(a), noMail), /Email isn't set up in Settings -> Messages/);
    let r = (await orderFor(a.shopId, noMail))!;
    assert.deepEqual([r.status, r.sentVia], ["SENT", "mailto"]);
    await messagingFor(a.shopId, { email: { sink } });
    const msg = await sendOrderFor(user(a), poE);
    assert.match(msg, /was emailed to orders@testwholesale\.example from your mail account/);
    r = (await orderFor(a.shopId, poE))!;
    assert.deepEqual([r.status, r.sentVia], ["SENT", "smtp"]);
    assert.equal(sink.messages.length, 1);
    const mail = sink.messages[0];
    assert.deepEqual(mail.to, ["orders@testwholesale.example"]);
    assert.equal(mail.user, "check-user", "sent through the shop's own SMTP login");
    assert.match(mail.raw, new RegExp(`Subject: Purchase order #${oE.number} from`));
    assert.match(mail.raw, /filename="?order-\d+-Test-Wholesale\.csv"?/);
    const b64 = /Content-Type: text\/csv[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(mail.raw)?.[1];
    assert.ok(b64, "the CSV is attached");
    const attached = Buffer.from(b64!.replace(/\s+/g, ""), "base64").toString("utf8").replace(/^﻿/, "");
    assert.equal(attached, "SKU,Qty,Unit\r\nBE-100,2,bolt\r\nBE-200,7.5,yd\r\n", "the attachment is the order in the supplier's layout");
    await expectError("send twice", () => sendOrderFor(user(a), poE), /already sent/);
    assert.equal(sink.messages.length, 1, "a second send sends nothing");
    // A mail server that is down: nothing is sent, the order goes back to a draft, and says why.
    const down = await createOrderFor(user(a), "Test Wholesale");
    await addLineFor(user(a), down, fd({ itemNumber: "BE-100", qty: "1", unit: "BOLT" }));
    await sink.stop();
    await expectError("mail server down", () => sendOrderFor(user(a), down), /The order wasn't sent: .*still a draft/);
    r = (await orderFor(a.shopId, down))!;
    assert.deepEqual([r.status, r.sentAt, r.sentVia], ["DRAFT", null, null]);
    // ...and "mark sent by hand" still works.
    assert.match(await sendOrderFor(user(a), down, "manual"), /is marked sent/);
    r = (await orderFor(a.shopId, down))!;
    assert.deepEqual([r.status, r.sentVia], ["SENT", "none"]);
    await sink.start();
    // The file connector: marked sent, the upload file waiting.
    await saveConnectorFor(user(a), fd({ name: "Test Wholesale", connector: "file" }));
    const poF = await createOrderFor(user(a), "Test Wholesale");
    await addLineFor(user(a), poF, fd({ itemNumber: "BE-100", qty: "1", unit: "BOLT" }));
    assert.match(await sendOrderFor(user(a), poF), /upload it on Test Wholesale's site/);
    assert.equal((await orderFor(a.shopId, poF))!.sentVia, "file");
    assert.equal(sink.messages.length, 0, "the file connector emails nothing (the sink was restarted empty)");
    ok("email: a formatted body with the account number; sent through the shop's own SMTP login with the CSV (the supplier's layout) attached; no mail account -> marked sent with the mailto fallback; a mail server down -> still a draft with the reason; mark sent by hand; the file connector emails nothing; a second send does nothing");

    // 7. No wholesaler login is kept.
    const cols = await db.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'FabricSupplier'`;
    assert.ok(cols.every((c) => !/pass|login|secret|token|credential|username|apikey/i.test(c.column_name)), `FabricSupplier columns: ${cols.map((c) => c.column_name).join(", ")}`);
    await saveConnectorFor(user(a), fd({ name: "Test Wholesale", connector: "file", password: "hunter2-secret", username: "bruce", layout: "SKU = itemNumber" }));
    const raw = JSON.stringify(await db.fabricSupplier.findMany({ where: { shopId: a.shopId } }));
    assert.ok(!/hunter2|bruce@|"username"/.test(raw), "a typed password or user name goes nowhere");
    for (const c of connectorList()) assert.ok(!("login" in c) && !("password" in c));
    ok("no credentials: the supplier has no column or field for a login, and a password typed into the form is not saved anywhere");

    // 8. Framework: five optional answers; the file and email connectors answer only what they can.
    for (const c of connectorList()) assert.deepEqual([typeof c.prices, typeof c.stock, typeof c.orderStatus], ["undefined", "undefined", "undefined"], `${c.id}: no API answers`);
    assert.equal(connectorFor("nonsense").id, "email", "an unknown connector falls back to email");
    assert.equal(connectorFor(null).id, "email");
    assert.deepEqual(connectorList().map((c) => c.id), ["email", "file", "notions-marketing"]);
    assert.ok(connectorFor("file").readCatalog && connectorFor("file").exportOrder && connectorFor("email").placeOrder && !connectorFor("email").readCatalog);
    assert.equal((await suppliersFor(a.shopId)).find((s) => s.name === "Test Wholesale")!.connector, "file");
    ok("framework: registry with email, file and notions-marketing; unknown ids fall back to email; prices, stock and order status stay unanswered by the file and email connectors");

    // 9. Tenant.
    const tables = ["Part", "FabricSupplier", "PurchaseOrder", "PurchaseOrderLine", "StockMove", "FabricMarkdown", "Shop"];
    const snap = await snapshot(a.shopId, tables);
    await expectNotFound("sheetViewFor(B, A's supplier)", () => sheetViewFor(user(b), sup.id, "w.csv", bytes(sheet)));
    await expectNotFound("previewCatalogFor(B)", () => previewCatalogFor(user(b), sup.id, "w.csv", bytes(sheet), mapA));
    await expectNotFound("applyCatalogFor(B)", () => applyCatalogFor(user(b), sup.id, "w.csv", bytes(sheet), mapA, true));
    await expectNotFound("sendOrderFor(B, A's order)", () => sendOrderFor(user(b), poF));
    assert.equal(await orderFor(b.shopId, poE), null);
    assert.equal(await db.part.count({ where: { shopId: b.shopId } }), 0);
    assertUnchanged("tenant", snap, await snapshot(a.shopId, tables));
    // B's own supplier of the same name has its own connector, account and layout.
    await saveConnectorFor(user(b), fd({ name: "Test Wholesale", connector: "email", accountNumber: "B-1" }));
    const bs = await db.fabricSupplier.findFirstOrThrow({ where: { shopId: b.shopId, name: "Test Wholesale" } });
    assert.deepEqual([bs.connector, bs.accountNumber, bs.catalogMap], ["email", "B-1", null]);
    const as = await db.fabricSupplier.findFirstOrThrow({ where: { shopId: a.shopId, name: "Test Wholesale" } });
    assert.deepEqual([as.connector, as.accountNumber], ["file", null]);
    ok("tenant: B can't read, preview or apply a catalog on A's supplier or send A's order; A's rows are unchanged; the same supplier name has separate connector settings");
  } finally {
    await cleanup();
  }
  console.log(`connectors.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
