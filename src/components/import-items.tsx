"use client";

import { parseTable } from "@/lib/parse-table";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { askMatchColumns } from "@/actions/assistant";
import { runAction } from "@/components/action-form";
import { importItems, type ImportRow } from "@/actions/inventory-import";
import { money, parseCost, toCents } from "@/lib/format";
import { EXCEL_NUMBER } from "@/lib/input";
import { CONDITION_NAME, ORIGIN_NAME, conditionFromText, originFromText } from "@/lib/part-labels";

type Field = "partNumber" | "barcode" | "description" | "brand" | "cost" | "price" | "qty" | "location" | "condition" | "origin";

const FIELDS: { key: Field; label: string; words: RegExp }[] = [
  { key: "partNumber", label: "Item / style / SKU number", words: /^(sku|item|item ?(no|#|number)|style|part ?(no|#|number)?|product ?(code|no|#)|article|mfg ?(no|#)|stock ?(no|#|number)|number)$/i },
  { key: "barcode", label: "Barcode (UPC / EAN)", words: /(upc|ean|gtin|barcode|bar code)/i },
  { key: "description", label: "Description", words: /(desc|name|title|product$|color ?name)/i },
  { key: "brand", label: "Brand / maker", words: /(brand|manufacturer|maker|mfr|vendor|designer|company)/i },
  { key: "cost", label: "Your cost", words: /(cost|wholesale|net|dealer)/i },
  { key: "price", label: "Selling price", words: /(retail|msrp|price|srp|sell)/i },
  // Whole header words only: "Discount" isn't "count", "Stock #" is a number, not a quantity.
  { key: "qty", label: "Quantity", words: /^(qty|quantity|on ?hand|in ?stock|stock ?(qty|on ?hand)|count|yards|yds|qty ?(on ?hand|ordered|shipped))$/i },
  { key: "location", label: "Bin / location", words: /(bin|location|shelf|aisle)/i },
  // Optional: new / used / refurbished, and genuine (OEM) / compatible (aftermarket, generic) / 3D printed.
  { key: "condition", label: "Condition (new, used, refurbished)", words: /^(condition|cond)$/i },
  { key: "origin", label: "Made by (genuine, compatible, 3D printed)", words: /^(made ?by|origin|oem)$/i },
];

/** The text of a chosen file. Excel's plain "CSV (Comma delimited)" is Windows-1252, its "Unicode Text" is UTF-16; only UTF-8 reads as UTF-8. */
async function readText(f: File) {
  const buf = await f.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

/** "12", "2.5", ".5", "2 1/2", "3/4", "1,200", "12 yd" -> a number; anything else -> NaN (the row shows "?" and isn't sent). */
function parseQty(v: string): number {
  const t = v.replace(/,/g, "").replace(/\s*(yds?|yards?|ea|each|pcs?)\.?$/i, "").trim();
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return /^-?(\d+(\.\d+)?|\.\d+)$/.test(t) ? Number(t) : NaN;
}

/** A price or cost in cents. A minus sign in a price column is a discount or a typo, never a price: left unset. */
function cents(v: string): number | null {
  const c = toCents(v);
  return c != null && c >= 0 ? c : null;
}

/** The same cost to 4 decimals (ten-thousandths of a dollar), for a supplier price finer than a cent. */
function tenThou(v: string): number | null {
  const t = parseCost(v);
  return t != null && t >= 0 ? t : null;
}

function guess(headers: string[]): Record<Field, number> {
  const used = new Set<number>();
  const map = {} as Record<Field, number>;
  for (const f of FIELDS) {
    const i = headers.findIndex((h, j) => !used.has(j) && f.words.test(h.trim()));
    map[f.key] = i;
    if (i >= 0) used.add(i);
  }
  return map;
}

/**
 * `assist`: the Assistant's "Match the columns" can be offered here (module on, switch on); `unavailable` is the plain reason
 * it can't ask now. Without it the picker works exactly as before.
 */
export function ImportItems({ assist }: { assist?: { unavailable?: string } | null }) {
  const [text, setText] = useState("");
  const [map, setMap] = useState<Record<Field, number> | null>(null);
  const [opts, setOpts] = useState({ kind: "NOTION", unit: "", supplier: "", addQty: true, updateExisting: true });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);
  const [proposed, setProposed] = useState(false);
  const table = useMemo(() => (text.trim() ? parseTable(text) : []), [text]);
  const headers = table[0] ?? [];
  const body = table.slice(1);
  const m = map ?? guess(headers);
  // The fields an import needs to be useful: an item number (or a barcode), a description, a price and a quantity. Two or more
  // left unmapped by the word guess is where the Assistant can propose the rest.
  const unmapped = [m.partNumber < 0 && m.barcode < 0, m.description < 0, m.price < 0, m.qty < 0].filter(Boolean).length;
  async function matchColumns() {
    setMatching(true);
    const r = await runAction(() => askMatchColumns(FIELDS.map((f) => ({ key: f.key, label: f.label })), headers, body.slice(0, 3)));
    setMatching(false);
    if (r?.error) return toast.error(r.error);
    if (!r?.shown) return;
    const found = (JSON.parse(r.shown) as { map: Partial<Record<Field, number>> }).map;
    const next = { ...m };
    // A column the Assistant gives to one field is taken from any other field the word guess had put on it.
    for (const f of FIELDS) if (found[f.key] === undefined && Object.values(found).includes(next[f.key])) next[f.key] = -1;
    for (const [k, v] of Object.entries(found)) next[k as Field] = v as number;
    setMap(next);
    setProposed(true);
  }
  const cell = (r: string[], f: Field) => (m[f] >= 0 ? (r[m[f]] ?? "") : "");
  const typedCode = (r: string[]) => cell(r, "barcode").replace(/\s/g, "");
  const rows: ImportRow[] = body.map((r) => {
    // "7.44272E+11" is what Excel makes of a long number in a General cell: the digits are gone, so it is no barcode.
    const barcode = (EXCEL_NUMBER.test(typedCode(r)) ? "" : typedCode(r)) || null;
    return {
      partNumber: cell(r, "partNumber") || barcode || "",
      barcode,
      description: cell(r, "description") || null,
      brand: cell(r, "brand") || null,
      costCents: cents(cell(r, "cost")),
      costTenThou: tenThou(cell(r, "cost")),
      priceCents: cents(cell(r, "price")),
      qty: cell(r, "qty") === "" ? null : parseQty(cell(r, "qty")),
      location: cell(r, "location") || null,
      condition: conditionFromText(cell(r, "condition")),
      origin: originFromText(cell(r, "origin")),
    };
  });
  // A cell in those columns that says none of the choices is ignored: the item comes in as if it were empty.
  const unclear = (f: "condition" | "origin", read: (t: string) => string | null) => body.flatMap((r, i) => (cell(r, f) !== "" && !read(cell(r, f)) ? [i + 2] : []));
  const unclearCondition = m.condition >= 0 ? unclear("condition", conditionFromText) : [];
  const unclearOrigin = m.origin >= 0 ? unclear("origin", originFromText) : [];
  // A quantity that can't be read ("TBD", "2 bolts") must not turn into stock quietly not received: those rows stay
  // here, and the user is told which ones (sheet row numbers, the header being row 1).
  const unreadable = opts.addQty ? rows.flatMap((r, i) => (Number.isNaN(r.qty) ? [i + 2] : [])) : [];
  const toImport = opts.addQty ? rows.filter((r) => !Number.isNaN(r.qty)) : rows;
  const shortened = body.flatMap((r, i) => (EXCEL_NUMBER.test(typedCode(r)) ? [i + 2] : []));

  return (
    <div className="space-y-4">
      <div className="card card-pad space-y-2">
        <label htmlFor="paste" className="label">
          Paste the cells from Excel (include the header row), or open a CSV file
        </label>
        <textarea
          id="paste"
          rows={6}
          className="textarea mono text-xs"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setMap(null);
            setResult(null);
          }}
          placeholder={"SKU\tUPC\tDescription\tWholesale\tRetail\tQty\n3148\t0442717314803\tClover Seam Ripper\t4.10\t8.25\t6"}
        />
        <input
          type="file"
          accept=".csv,.txt,text/csv"
          aria-label="CSV file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              setText(await readText(f));
              setMap(null);
              setResult(null);
            }
          }}
        />
      </div>

      {headers.length > 0 && (
        <>
          {assist && unmapped >= 2 && (
            <div className="card card-pad space-y-1 text-sm" data-match-columns>
              {assist.unavailable ? (
                <p className="muted">{assist.unavailable}</p>
              ) : (
                <>
                  <button type="button" className="btn btn-sm" disabled={matching} onClick={matchColumns}>
                    {matching ? "Matching..." : "Match the columns"}
                  </button>
                  <p className="muted text-xs">Some columns weren&apos;t recognised by name. This sends the column headings and the first three rows to the Assistant, which proposes a match; you check it in the lists below before anything is imported.</p>
                </>
              )}
            </div>
          )}
          {proposed && <p className="card card-pad text-sm" role="status">The Assistant proposed these columns. Check each list below and change any that is wrong.</p>}
          <div className="card card-pad grid-form">
            {FIELDS.map((f) => (
              <div key={f.key} className="field">
                <label htmlFor={`map-${f.key}`} className="label">
                  {f.label}
                </label>
                <select
                  id={`map-${f.key}`}
                  className="select"
                  value={m[f.key]}
                  onChange={(e) => setMap({ ...m, [f.key]: Number(e.target.value) })}
                >
                  <option value={-1}>(none)</option>
                  {headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div className="field">
              <label htmlFor="imp-kind" className="label">
                These items are
              </label>
              <select id="imp-kind" className="select" value={opts.kind} onChange={(e) => setOpts({ ...opts, kind: e.target.value })}>
                <option value="NOTION">Notions</option>
                <option value="FABRIC">Fabric</option>
                <option value="THREAD">Thread</option>
                <option value="PATTERN">Patterns / books</option>
                <option value="ACCESSORY">Accessories</option>
                <option value="SUPPLY">Supplies</option>
                <option value="PART">Parts</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="imp-unit" className="label">
                Sold
              </label>
              <select id="imp-unit" className="select" value={opts.unit} onChange={(e) => setOpts({ ...opts, unit: e.target.value })}>
                <option value="">Each</option>
                <option value="yd">By the yard</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="imp-supplier" className="label">
                Supplier (optional)
              </label>
              <input id="imp-supplier" className="input" value={opts.supplier} onChange={(e) => setOpts({ ...opts, supplier: e.target.value })} />
            </div>
            <div className="space-y-1 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="check" checked={opts.addQty} onChange={(e) => setOpts({ ...opts, addQty: e.target.checked })} /> Add the
                quantities to stock (received)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="check" checked={opts.updateExisting} onChange={(e) => setOpts({ ...opts, updateExisting: e.target.checked })} />{" "}
                Update prices and details of items already in inventory
              </label>
            </div>
          </div>

          <div className="card scroll-x">
            <table className="table" aria-label="Preview">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Barcode</th>
                  <th>Description</th>
                  <th>Brand</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Qty</th>
                  {(m.condition >= 0 || m.origin >= 0) && <th>Labels</th>}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r.partNumber || <span className="pill tone-bad">missing</span>}</td>
                    <td className="mono">{r.barcode}</td>
                    <td>{r.description}</td>
                    <td>{r.brand}</td>
                    <td className="num text-right">{money(r.costCents)}</td>
                    <td className="num text-right">{money(r.priceCents)}</td>
                    <td className="num text-right">{r.qty == null ? "" : Number.isNaN(r.qty) ? <span className="pill tone-bad">?</span> : r.qty}</td>
                    {(m.condition >= 0 || m.origin >= 0) && (
                      <td className="text-xs">{[r.condition && CONDITION_NAME[r.condition as keyof typeof CONDITION_NAME], r.origin && ORIGIN_NAME[r.origin as keyof typeof ORIGIN_NAME]].filter(Boolean).join(" · ")}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted card-pad text-xs">
              {rows.length} rows{rows.length > 8 ? " (first 8 shown)" : ""}. Rows without a number, or with neither a description nor a barcode, are skipped.
              {unreadable.length > 0 && (
                <>
                  {" "}
                  <span className="text-[var(--bad)]">
                    {unreadable.length} row{unreadable.length === 1 ? " has" : "s have"} a quantity that can&apos;t be read (row
                    {unreadable.length === 1 ? "" : "s"} {unreadable.slice(0, 10).join(", ")}
                    {unreadable.length > 10 ? ` and ${unreadable.length - 10} more` : ""}): {unreadable.length === 1 ? "it" : "they"} won&apos;t be
                    imported.
                  </span>{" "}
                  Fix those cells, or set Quantity to (none) to bring the items in without stock.
                </>
              )}
              {unclearCondition.length + unclearOrigin.length > 0 && (
                <>
                  {" "}
                  <span className="text-[var(--bad)]">
                    {unclearCondition.length > 0 && `${unclearCondition.length} condition${unclearCondition.length === 1 ? "" : "s"} (row${unclearCondition.length === 1 ? "" : "s"} ${unclearCondition.slice(0, 10).join(", ")}) aren't new, used or refurbished. `}
                    {unclearOrigin.length > 0 && `${unclearOrigin.length} made-by value${unclearOrigin.length === 1 ? "" : "s"} (row${unclearOrigin.length === 1 ? "" : "s"} ${unclearOrigin.slice(0, 10).join(", ")}) aren't genuine, compatible or 3D printed. `}
                    Those cells are ignored.
                  </span>
                </>
              )}
              {shortened.length > 0 && (
                <>
                  {" "}
                  <span className="text-[var(--bad)]">
                    {shortened.length} barcode{shortened.length === 1 ? " was" : "s were"} shortened by Excel to a form like 7.44272E+11 (row
                    {shortened.length === 1 ? "" : "s"} {shortened.slice(0, 10).join(", ")}
                    {shortened.length > 10 ? ` and ${shortened.length - 10} more` : ""}): the digits are lost, so {shortened.length === 1 ? "it is" : "they are"} left out.
                  </span>{" "}
                  Format the barcode column as Text in Excel and copy it again.
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            // Once imported, the same sheet can't be sent again (it would receive every quantity twice) until it's changed.
            disabled={busy || result !== null || !toImport.length || (m.partNumber < 0 && m.barcode < 0)}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await importItems(toImport, { ...opts, unit: opts.unit || null, supplier: opts.supplier || null });
                if ("error" in r) toast.error(r.error);
                else {
                  const skipped = r.skipped + unreadable.length;
                  const msg = `Imported: ${r.added} added, ${r.updated} updated, ${skipped} skipped${unreadable.length ? ` (${unreadable.length} with a quantity that couldn't be read)` : ""}${r.unmatched?.length ? `. Not imported, because more than one item already has the number: ${r.unmatched.slice(0, 10).join(", ")}${r.unmatched.length > 10 ? ` and ${r.unmatched.length - 10} more` : ""}` : ""}`;
                  setResult(msg);
                  toast.success(msg);
                }
              } catch {
                toast.error("The import didn't finish, and nothing was changed. Try again, or send fewer rows.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Importing..." : result !== null ? "Imported: paste another sheet" : `Import ${toImport.length} items`}
          </button>
          {result && (
            <p role="status" className="text-sm">
              {result}
            </p>
          )}
        </>
      )}
    </div>
  );
}
