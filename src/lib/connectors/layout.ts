// The file connector's pure parts (package F6): reading a catalog spreadsheet through a column map, writing an order in
// a supplier's own column layout, and the order as an email. No database; scripts/checks/connectors.check.ts exercises
// each on hand-made sheets.
import { csvCell } from "@/lib/csv";
import { parseCost, tenThouToCents, toCents } from "@/lib/format";
import { MAX_CENTS } from "@/lib/parts";
import { inEighths } from "@/lib/register-math";
import { UserError } from "@/lib/user-error";
import { amountText, costPer, lineCostTotal, lineYards } from "@/lib/fabric-orders-math";
import type { OrderView } from "@/lib/fabric-orders";
import { CATALOG_FIELDS, ORDER_FIELDS, type CatalogField, type CatalogRead, type CatalogRow, type ColumnMap, type OrderColumn, type OrderLayout } from "./types";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#/]+/g, " ").trim();
const FIELD_KEYS = new Set<string>(CATALOG_FIELDS.map((f) => f.key));
const ORDER_KEYS = new Set<string>(ORDER_FIELDS.map((f) => f.key));
const MAX_COLUMNS = 20;

// ---------------------------------------------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------------------------------------------

/** The heading row: the first of the first ten rows with at least two filled cells (title lines above it are skipped). */
export function headerRowIndex(table: string[][]): number {
  const i = table.slice(0, 10).findIndex((r) => r.filter((c) => c.trim()).length >= 2);
  return i < 0 ? 0 : i;
}

/** A saved map cleaned up: only known fields, each a heading of at most 80 characters. Anything else is dropped. */
export function cleanMap(raw: unknown): ColumnMap {
  const out: ColumnMap = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!FIELD_KEYS.has(k) || typeof v !== "string") continue;
    const t = v.trim().slice(0, 80);
    if (t) out[k as CatalogField] = t;
  }
  return out;
}

/** The map a sheet's headings suggest: the first heading whose words match a field's hints (a heading is used once). */
export function suggestMap(headers: string[]): ColumnMap {
  const out: ColumnMap = {};
  const used = new Set<number>();
  for (const f of CATALOG_FIELDS) {
    const hints = f.hints.map(norm);
    let at = headers.findIndex((h, i) => !used.has(i) && hints.includes(norm(h)));
    if (at < 0) at = headers.findIndex((h, i) => !used.has(i) && hints.some((x) => x.length >= 4 && norm(h).includes(x)));
    if (at >= 0) {
      used.add(at);
      out[f.key] = headers[at].trim();
    }
  }
  return out;
}

/**
 * Rows of a sheet as catalog rows, through the map (field -> heading). A row with no item number is skipped; a figure
 * that isn't a number is left out of that row (named in `problems`, 25 at most shown by the caller). `missing` lists
 * the fields the map names that this sheet has no column for.
 */
export function readCatalogRows(table: string[][], map: ColumnMap): CatalogRead {
  const problems: string[] = [];
  const missing: CatalogField[] = [];
  if (!table.length) return { rows: [], problems: ["The sheet is empty."], missing };
  const h0 = headerRowIndex(table);
  const headers = table[h0].map((c) => norm(c));
  const col = new Map<CatalogField, number>();
  for (const f of CATALOG_FIELDS) {
    const want = map[f.key];
    if (!want) continue;
    const at = headers.indexOf(norm(want));
    if (at < 0) missing.push(f.key);
    else col.set(f.key, at);
  }
  if (!col.has("itemNumber")) return { rows: [], problems: ["Pick the column that holds the maker's item number."], missing };
  const rows: CatalogRow[] = [];
  const cell = (r: string[], f: CatalogField) => (col.has(f) ? (r[col.get(f)!] ?? "").trim() : "");
  for (let i = h0 + 1; i < table.length; i++) {
    const r = table[i];
    const line = i + 1;
    const itemNumber = cell(r, "itemNumber").slice(0, 60);
    if (!itemNumber) {
      problems.push(`Row ${line}: no item number, skipped.`);
      continue;
    }
    const row: CatalogRow = { line, itemNumber };
    const description = cell(r, "description");
    if (description) row.description = description.slice(0, 200);
    for (const f of ["collection", "designer", "brand"] as const) {
      const v = cell(r, f);
      if (v) row[f] = v.slice(0, 80);
    }
    const cost = cell(r, "costPerYard");
    if (cost) {
      const t = parseCost(cost);
      if (t == null || t < 0 || tenThouToCents(t) > MAX_CENTS) problems.push(`Row ${line} (${itemNumber}): cost "${cost}" isn't a dollar amount, left alone.`);
      else {
        row.costTenThou = t;
        row.costCents = tenThouToCents(t);
      }
    }
    const price = cell(r, "pricePerYard");
    if (price) {
      const c = toCents(price);
      if (c == null || c < 0 || c > MAX_CENTS) problems.push(`Row ${line} (${itemNumber}): price "${price}" isn't a dollar amount, left alone.`);
      else row.priceCents = c;
    }
    const bolt = cell(r, "boltYards");
    if (bolt) {
      const y = Number(bolt.replace(/,/g, ""));
      if (!Number.isFinite(y) || y <= 0 || y > 100 || !inEighths(y)) problems.push(`Row ${line} (${itemNumber}): "${bolt}" isn't a bolt length in yards, left alone.`);
      else row.boltYards = y;
    }
    rows.push(row);
  }
  return { rows, problems, missing };
}

// ---------------------------------------------------------------------------------------------------------------
// Order layout (the cart-upload spreadsheet)
// ---------------------------------------------------------------------------------------------------------------

/** What a supplier gets until the shop sets its own columns: the same layout as the plain order download. */
export const DEFAULT_ORDER_LAYOUT: OrderLayout = [
  { header: "item_number", field: "itemNumber" },
  { header: "description", field: "description" },
  { header: "quantity", field: "quantity" },
  { header: "unit", field: "unit" },
  { header: "yards", field: "yards" },
  { header: "cost_per_yard", field: "costPerYard" },
  { header: "line_total", field: "lineTotal" },
];

/** A saved layout cleaned up: known fields only, at most 20 columns, headings of at most 60 characters. */
export function cleanLayout(raw: unknown): OrderLayout {
  if (!Array.isArray(raw)) return [];
  const out: OrderLayout = [];
  for (const c of raw) {
    if (typeof c !== "object" || c === null) continue;
    const { header, field, text } = c as Record<string, unknown>;
    if (typeof field !== "string" || !ORDER_KEYS.has(field)) continue;
    const col: OrderColumn = { header: typeof header === "string" ? header.trim().slice(0, 60) : "", field: field as OrderColumn["field"] };
    if (field === "text") col.text = typeof text === "string" ? text.slice(0, 100) : "";
    out.push(col);
    if (out.length >= MAX_COLUMNS) break;
  }
  return out;
}

/**
 * The layout typed in the form: one column a line, "Heading = field" (the field's name or its words), or
 * `Heading = text: fixed words`. Refuses a line it can't read, naming it.
 */
export function parseLayoutText(text: string): OrderLayout {
  const out: OrderLayout = [];
  const byName = new Map<string, OrderColumn["field"]>();
  for (const f of ORDER_FIELDS) {
    byName.set(norm(f.key), f.key);
    byName.set(norm(f.label), f.key);
  }
  for (const f of ORDER_FIELDS) byName.set(norm(f.label.replace(/ \(.*\)$/, "")), f.key);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.lastIndexOf("=");
    if (eq < 1) throw new UserError(`"${line.slice(0, 40)}": write each column as Heading = what goes in it (for example SKU = itemNumber).`);
    const header = line.slice(0, eq).trim();
    const what = line.slice(eq + 1).trim();
    const fixed = /^text\s*:(.*)$/i.exec(what);
    if (fixed) {
      out.push({ header, field: "text", text: fixed[1].trim() });
      continue;
    }
    const field = byName.get(norm(what));
    if (!field || field === "text") throw new UserError(`"${what.slice(0, 40)}" isn't something an order column can hold. Use: ${ORDER_FIELDS.filter((f) => f.key !== "text").map((f) => f.key).join(", ")}, or text: fixed words.`);
    out.push({ header, field });
  }
  if (out.length > MAX_COLUMNS) throw new UserError(`At most ${MAX_COLUMNS} columns.`);
  return cleanLayout(out);
}

/** The layout as the lines the form shows (the inverse of parseLayoutText). */
export function layoutText(layout: OrderLayout): string {
  return layout.map((c) => `${c.header} = ${c.field === "text" ? `text: ${c.text ?? ""}` : c.field}`).join("\n");
}

const dollars = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));

/** The order's rows in the layout (a heading row, then a row a line). The layout is the supplier's own, or the default. */
export function orderRows(o: OrderView, layout: OrderLayout | null | undefined, account: string | null): unknown[][] {
  const cols = layout && layout.length ? layout : DEFAULT_ORDER_LAYOUT;
  const value = (c: OrderColumn, l: OrderView["lines"][number]): unknown => {
    switch (c.field) {
      case "itemNumber":
        return l.itemNumber;
      case "description":
        return l.description;
      case "quantity":
        return l.qty;
      case "unit":
        return l.unit === "BOLT" ? "bolt" : l.unit === "EACH" ? "each" : "yd";
      case "yards":
        // An item sold each (shop-features-round-2-design.md 1.1) has no yards or bolts: the quantity column says how many.
        return l.unit === "EACH" ? "" : lineYards(l);
      case "bolts":
        return l.unit === "EACH" ? "" : l.unit === "BOLT" ? l.qty : Math.round((l.qty / (l.boltYards || 15)) * 1000) / 1000;
      case "costPerYard":
        return dollars(l.costCents);
      case "lineTotal":
        return l.costCents == null ? "" : dollars(lineCostTotal(l));
      case "poNumber":
        return String(o.number);
      case "account":
        return account ?? "";
      case "note":
        return o.note ?? "";
      case "text":
        return c.text ?? "";
    }
  };
  return [cols.map((c) => c.header), ...o.lines.map((l) => cols.map((c) => value(c, l)))];
}

/** Rows as CSV text (CRLF line ends, spreadsheet-formula cells defused), with Excel's byte order mark when asked. */
export function csvText(rows: unknown[][], bom = false): string {
  return (bom ? "﻿" : "") + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export const fileNameFor = (o: OrderView) => `order-${o.number}-${o.supplier.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "supplier"}.csv`;

// ---------------------------------------------------------------------------------------------------------------
// The order as an email
// ---------------------------------------------------------------------------------------------------------------

/** The email for the rep: a formatted body (the lines in columns, the total, the note, the shop's account number). */
export function orderEmailParts(o: OrderView, account: string | null, shop: { phone: string | null; address: string | null }) {
  const subject = `Purchase order #${o.number} from ${o.shopName}`;
  const w = Math.min(24, Math.max(6, ...o.lines.map((l) => l.itemNumber.length)));
  const rows = o.lines.map((l) => `${l.itemNumber.padEnd(w)}  ${amountText(l)}${l.costCents != null ? `  @ $${dollars(l.costCents)}${costPer(l)}` : ""}  ${l.description}`);
  const text = [
    `Purchase order #${o.number}`,
    `From: ${o.shopName}`,
    ...(account ? [`Our account number: ${account}`] : []),
    "",
    ...rows,
    "",
    `Total: ${o.amountText}${o.totalCents ? `, $${dollars(o.totalCents)} at our cost` : ""}`,
    ...(o.note ? ["", o.note] : []),
    "",
    "The same order is attached as a spreadsheet (CSV).",
    ...(shop.phone || shop.address ? ["--", [o.shopName, shop.address, shop.phone].filter(Boolean).join(" | ")] : []),
  ].join("\n");
  return { subject, text };
}
