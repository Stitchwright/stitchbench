"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { importItems, type ImportRow } from "@/actions/inventory-import";
import { money, toCents } from "@/lib/format";

type Field = "partNumber" | "barcode" | "description" | "brand" | "cost" | "price" | "qty" | "location";

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
];

/** Split pasted Excel cells (tabs) or a CSV file into rows, honouring "quoted, fields". */
function parseTable(text: string): string[][] {
  const delim = text.split("\n").slice(0, 5).some((l) => l.includes("\t")) ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((c) => c)) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c)) rows.push(row);
  return rows;
}

/** "12", "2.5", "2 1/2", "3/4", "1,200", "12 yd" -> a number; anything else -> NaN (the row shows it and is skipped). */
function parseQty(v: string): number {
  const t = v.replace(/,/g, "").replace(/\s*(yds?|yards?|ea|each|pcs?)\.?$/i, "").trim();
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
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

export function ImportItems() {
  const [text, setText] = useState("");
  const [map, setMap] = useState<Record<Field, number> | null>(null);
  const [opts, setOpts] = useState({ kind: "NOTION", unit: "", supplier: "", addQty: true, updateExisting: true });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const table = useMemo(() => (text.trim() ? parseTable(text) : []), [text]);
  const headers = table[0] ?? [];
  const body = table.slice(1);
  const m = map ?? guess(headers);
  const cell = (r: string[], f: Field) => (m[f] >= 0 ? (r[m[f]] ?? "") : "");
  const rows: ImportRow[] = body.map((r) => {
    const barcode = cell(r, "barcode").replace(/\s/g, "") || null;
    return {
      partNumber: cell(r, "partNumber") || barcode || "",
      barcode,
      description: cell(r, "description") || null,
      brand: cell(r, "brand") || null,
      costCents: toCents(cell(r, "cost")),
      priceCents: toCents(cell(r, "price")),
      qty: cell(r, "qty") === "" ? null : parseQty(cell(r, "qty")),
      location: cell(r, "location") || null,
    };
  });

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
              setText(await f.text());
              setMap(null);
            }
          }}
        />
      </div>

      {headers.length > 0 && (
        <>
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
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted card-pad text-xs">
              {rows.length} rows{rows.length > 8 ? " (first 8 shown)" : ""}. Rows without a number or a description are skipped.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !rows.length || m.partNumber < 0 && m.barcode < 0}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await importItems(rows, { ...opts, unit: opts.unit || null, supplier: opts.supplier || null });
                if ("error" in r) toast.error(r.error);
                else {
                  const msg = `Imported: ${r.added} added, ${r.updated} updated, ${r.skipped} skipped`;
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
            {busy ? "Importing..." : `Import ${rows.length} items`}
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
