"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ActionForm, Submit, runAction } from "@/components/action-form";
import { applyCatalog, previewCatalog, readCatalogSheet } from "@/actions/connectors";
import { saveConnector } from "@/actions/fabric-orders";
import { CATALOG_FIELDS } from "@/lib/connectors/types";
import type { CatalogPreview, SheetView } from "@/lib/connectors/catalog";
import type { ColumnMap } from "@/lib/connectors/types";
import { KIND_CHOICES } from "@/lib/item-details";

/** "What's on this list?": the item form's choices, fabric by the yard first (the list's own type column, if any, wins per row). */
const LIST_KINDS = [{ value: "FABRIC", label: "Fabric by the yard" }, ...KIND_CHOICES.filter((c) => c.value !== "FABRIC")];

export type ConnectorChoice = { id: string; label: string; blurb: string; placeholder: boolean };

/** How orders go to one supplier: the connector, the shop's account number there (not a login), and the cart-upload columns. */
export function ConnectorForm({ name, connector, accountNumber, layout, choices, defaultLayout }: { name: string; connector: string; accountNumber: string | null; layout: string; choices: ConnectorChoice[]; defaultLayout: string }) {
  const [picked, setPicked] = useState(connector);
  const choice = choices.find((c) => c.id === picked);
  return (
    <ActionForm action={saveConnector} success="Saved" className="grid gap-2 sm:grid-cols-2">
      <input type="hidden" name="name" value={name} />
      <div className="field">
        <label className="label" htmlFor={`conn-${name}`}>
          Orders go by
        </label>
        <select id={`conn-${name}`} name="connector" className="input" value={picked} onChange={(e) => setPicked(e.currentTarget.value)}>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        {choice && <p className="muted text-xs">{choice.blurb}</p>}
      </div>
      <div className="field">
        <label className="label" htmlFor={`acct-${name}`}>
          Your account number with them
        </label>
        <input id={`acct-${name}`} name="accountNumber" defaultValue={accountNumber ?? ""} maxLength={60} className="input" autoComplete="off" />
        <p className="muted text-xs">Goes on the order. Never enter a password for their site: this program doesn&apos;t log in to wholesalers.</p>
      </div>
      <div className="field sm:col-span-2">
        <label className="label" htmlFor={`layout-${name}`}>
          Order spreadsheet columns (one a line: Heading = what goes in it)
        </label>
        <textarea id={`layout-${name}`} name="layout" defaultValue={layout} rows={4} className="input mono text-xs" placeholder={defaultLayout} spellCheck={false} />
        <p className="muted text-xs">
          What goes in a column: itemNumber, description, quantity, unit, yards, bolts, costPerYard, lineTotal, poNumber, account, note, or text: fixed words. Blank: the plain layout shown above.
          {choice?.placeholder ? " This wholesaler's real layout isn't known yet: the columns are a guess until they share it." : ""}
        </p>
      </div>
      <div className="sm:col-span-2">
        <Submit className="btn btn-sm">Save</Submit>
      </div>
    </ActionForm>
  );
}

/**
 * Catalog import: choose the file, say what is on it, check the column mapping, preview the counts (a dry run), then
 * "Bring them in". Fabric, thread, notions, accessories, patterns and supplies (shop-features-round-2-design.md 2.3).
 */
export function CatalogImport({ supplierId, supplierName, placeholder }: { supplierId: string; supplierName: string; placeholder: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [view, setView] = useState<SheetView | null>(null);
  const [map, setMap] = useState<ColumnMap>({});
  const [kind, setKind] = useState("FABRIC");
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [save, setSave] = useState(true);
  const [pending, start] = useTransition();

  const body = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("file", file!);
    fd.set("map", JSON.stringify(map));
    fd.set("defaultKind", kind);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return fd;
  };

  function choose(f: File | null) {
    setFile(f);
    setView(null);
    setPreview(null);
    if (!f) return;
    start(async () => {
      const fd = new FormData();
      fd.set("file", f);
      try {
        const r = await readCatalogSheet(supplierId, fd);
        if ("error" in r) toast.error(r.error);
        else {
          setView(r.view);
          setMap(r.view.map);
          setKind(r.view.defaultKind);
        }
      } catch {
        toast.error("Couldn't read the file: check the connection and try again.");
      }
    });
  }

  function dryRun() {
    start(async () => {
      try {
        const r = await previewCatalog(supplierId, body());
        if ("error" in r) toast.error(r.error);
        else setPreview(r.preview);
      } catch {
        toast.error("Couldn't check the file: check the connection and try again.");
      }
    });
  }

  function apply() {
    start(async () => {
      const r = await runAction(() => applyCatalog(supplierId, body(save ? { saveMap: "on" } : {})));
      if (r?.error) toast.error(r.error);
      else {
        toast.success(r?.note ?? "Imported", { duration: 10_000 });
        setFile(null);
        setView(null);
        setPreview(null);
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="field">
        <label className="label" htmlFor={`cat-${supplierId}`}>
          {supplierName}&apos;s catalog (CSV or Excel .xlsx)
        </label>
        <input id={`cat-${supplierId}`} type="file" accept=".csv,.txt,.tsv,.xlsx,text/csv" className="input" disabled={pending} onChange={(e) => choose(e.currentTarget.files?.[0] ?? null)} />
      </div>
      {view && (
        <div className="space-y-3">
          <p className="muted text-xs">
            {view.rowCount.toLocaleString("en-US")} rows.{" "}
            {view.mapFrom === "saved" ? "These columns are the ones saved for this supplier." : view.mapFrom === "placeholder" ? "These columns are a placeholder until this wholesaler shares its layout: check them." : "These columns are a guess from the headings: check them."}
            {placeholder && view.mapFrom !== "placeholder" ? " (This wholesaler's own layout isn't known yet.)" : ""}
          </p>
          <div className="field max-w-md">
            <label className="label" htmlFor={`kind-${supplierId}`}>
              What&apos;s on this list?
            </label>
            <select
              id={`kind-${supplierId}`}
              className="input"
              value={kind}
              onChange={(e) => {
                setKind(e.currentTarget.value);
                setPreview(null);
              }}
            >
              {LIST_KINDS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="muted text-sm">A row whose own Type column says otherwise (&quot;Thread&quot;, &quot;Notions&quot;) goes in as that.</p>
          </div>
          {(["main", "fabric", "details"] as const).map((group) => {
            const fields = CATALOG_FIELDS.filter((f) => f.group === group);
            const grid = (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {fields.map((f) => (
              <div className="field" key={f.key}>
                <label className="label" htmlFor={`map-${supplierId}-${f.key}`}>
                  {f.label}
                  {"required" in f && f.required ? " *" : ""}
                </label>
                <select
                  id={`map-${supplierId}-${f.key}`}
                  className="input"
                  value={map[f.key] ?? ""}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setPreview(null);
                    setMap((m) => {
                      const next = { ...m };
                      if (v) next[f.key] = v;
                      else delete next[f.key];
                      return next;
                    });
                  }}
                >
                  <option value="">(not in the sheet)</option>
                  {view.headers.map((h, i) => (
                    <option key={`${h}-${i}`} value={h}>
                      {h || `(column ${i + 1})`}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            </div>
            );
            if (group === "main") return <div key={group}>{grid}</div>;
            // The rarer columns fold away, open when the sheet's headings already filled one.
            const used = fields.some((f) => map[f.key]);
            return (
              <details key={group} open={used} className="text-sm">
                <summary className="cursor-pointer py-2">{group === "fabric" ? "Fabric columns (collection, designer, bolt size)" : "Color and detail columns (color number, weight, spool, material...)"}</summary>
                {grid}
              </details>
            );
          })}
          {view.sample.length > 0 && (
            <div className="scroll-x">
              <table className="table text-xs">
                <thead>
                  <tr>
                    {view.headers.map((h, i) => (
                      <th key={i}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.sample.map((r, i) => (
                    <tr key={i}>
                      {view.headers.map((_, c) => (
                        <td key={c}>{r[c] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-sm" disabled={pending || !map.itemNumber} onClick={dryRun}>
              {pending ? "Checking..." : "Preview (nothing changes yet)"}
            </button>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" className="check" checked={save} onChange={(e) => setSave(e.currentTarget.checked)} /> Save these columns for {supplierName}
            </label>
          </div>
        </div>
      )}
      {preview && (
        <div className="card card-pad space-y-2" role="status">
          <p className="text-sm">
            <span className="font-semibold">{preview.create}</span> new items, <span className="font-semibold">{preview.update}</span> updated, <span className="font-semibold">{preview.unchanged}</span> already right
            {preview.skipped ? (
              <>
                , <span className="font-semibold">{preview.skipped}</span> rows skipped or partly read
              </>
            ) : null}
            . New items start with no stock; nothing here changes how many you have.
          </p>
          {preview.newSample.length > 0 && <p className="muted text-xs">New: {preview.newSample.join("; ")}{preview.create > preview.newSample.length ? "..." : ""}</p>}
          {preview.changeSample.length > 0 && (
            <ul className="muted text-xs">
              {preview.changeSample.map((c) => (
                <li key={c.itemNumber}>
                  <span className="mono">{c.itemNumber}</span>: {c.what.join(", ")}
                </li>
              ))}
            </ul>
          )}
          {preview.problems.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer">Skipped or partly read ({preview.skipped})</summary>
              <ul className="muted">
                {preview.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </details>
          )}
          <button type="button" className="btn btn-primary btn-sm" disabled={pending || preview.create + preview.update === 0} onClick={apply}>
            {pending ? "Bringing them in..." : `Bring them in: add ${preview.create}, update ${preview.update}`}
          </button>
        </div>
      )}
    </div>
  );
}
