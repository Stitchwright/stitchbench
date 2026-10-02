"use client";

// The register's bag / belt / filter picker (modules-design.md 10.b): "Bags, belts, filters" opens a card; with a
// customer picked, their vacuums as buttons; otherwise a brand and a model / type / number box. Every stocked item has
// its own Add, which names the customer's vacuum the supply is for.
import { useEffect, useState } from "react";
import { Package } from "lucide-react";
import { customerVacuums, vacSupplies } from "@/actions/vac-finder";
import type { RegisterItem } from "@/lib/register-item";
import type { CustomerVacuum, FinderQuery, Supply } from "@/lib/vac/finder";
import { money } from "@/lib/format";

const GROUPS: { category: string | null; label: string }[] = [
  { category: "Vacuum bag", label: "Bags" },
  { category: "Vacuum belt", label: "Belts" },
  { category: "Vacuum filter", label: "Filters" },
  { category: null, label: "Other parts" },
];

function finderUrl(q: FinderQuery) {
  const p = new URLSearchParams();
  if (q.brand) p.set("brand", q.brand);
  const t = q.model || q.text;
  if (t) p.set("q", t);
  return `/vac/finder${p.size ? `?${p.toString()}` : ""}`;
}

export function VacSupplyPicker({ customerId, returnMode, onAdd }: { customerId: string | null; returnMode: boolean; onAdd: (item: RegisterItem, machineId: string | null) => void }) {
  const [open, setOpen] = useState(false);
  // The vacuums loaded, and whose: another customer's list is never shown for this one.
  const [loaded, setLoaded] = useState<{ customerId: string; list: CustomerVacuum[] } | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [brand, setBrand] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState<FinderQuery | null>(null);
  const [result, setResult] = useState<{
    supplies: Supply[];
    truncated: boolean;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The customer's vacuums, when the card is open and a customer is picked (and again when the customer changes).
  useEffect(() => {
    if (!open || !customerId) return;
    let live = true;
    customerVacuums(customerId).then((r) => {
      if (!live) return;
      if ("error" in r) setErr(r.error);
      else setLoaded({ customerId, list: r });
    });
    return () => {
      live = false;
    };
  }, [open, customerId]);
  const vacuums = customerId && loaded?.customerId === customerId ? loaded.list : null;
  const picked = vacuums?.find((v) => v.id === pickedId) ?? null;

  async function look(next: FinderQuery, vac: CustomerVacuum | null) {
    setBusy(true);
    setErr(null);
    setPickedId(vac?.id ?? null);
    setQuery(next);
    try {
      const r = await vacSupplies(next);
      if ("error" in r) {
        setErr(r.error);
        setResult(null);
      } else setResult(r);
    } finally {
      setBusy(false);
    }
  }

  const machineId = picked?.id ?? null;
  const verb = returnMode ? "Return" : "Add";
  return (
    <>
      <button type="button" className={`btn btn-sm ${open ? "btn-primary" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Package size={14} aria-hidden /> Bags, belts, filters
      </button>
      {open && (
        <div className="card card-pad w-full space-y-3 text-sm" aria-label="Bags, belts and filters">
          {customerId && vacuums && vacuums.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="muted">Their vacuum:</span>
              {vacuums.map((v) => (
                <button key={v.id} type="button" className={`btn btn-sm ${picked?.id === v.id ? "btn-primary" : ""}`} onClick={() => look({ brand: v.brand, model: v.model, text: v.bagType }, v)}>
                  {v.brand} {v.model}
                  {v.bagType ? ` · ${v.bagType}` : ""}
                </button>
              ))}
            </div>
          )}
          {customerId && vacuums && vacuums.length === 0 && <p className="muted">No vacuum on file for this customer yet. Look one up:</p>}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const text = q.trim();
              if (!text) return;
              look(
                {
                  brand: brand.trim() || null,
                  model: brand.trim() ? text : null,
                  text,
                },
                null,
              );
            }}
          >
            <div className="field">
              <label htmlFor="vsp-brand" className="label">
                Brand
              </label>
              <input id="vsp-brand" value={brand} onChange={(e) => setBrand(e.target.value)} className="input w-36" placeholder="Hoover" />
            </div>
            <div className="field min-w-56 flex-1">
              <label htmlFor="vsp-q" className="label">
                Model, bag type or part number
              </label>
              <input id="vsp-q" value={q} onChange={(e) => setQ(e.target.value)} className="input" placeholder="UH70120, Type Y, 4010100Y" />
            </div>
            <button className="btn btn-sm" disabled={busy}>
              {busy ? "Looking..." : "Look up"}
            </button>
          </form>
          {err && (
            <p className="text-[var(--bad)]" role="alert">
              {err}
            </p>
          )}
          {result && query && (
            <div className="space-y-3">
              {result.supplies.length === 0 && (
                <p className="muted">
                  Nothing listed
                  {query.brand ? ` for ${query.brand} ${query.model ?? query.text ?? ""}` : ""} yet.{" "}
                  <a href={finderUrl(query)} target="_blank" rel="noreferrer" className="link">
                    Open the finder
                  </a>{" "}
                  to add what fits.
                </p>
              )}
              {GROUPS.map((g) => {
                const rows = result.supplies.filter((s) => s.category === g.category);
                if (!rows.length) return null;
                return (
                  <div key={g.label}>
                    <div className="label">{g.label}</div>
                    <ul className="divide-y divide-line">
                      {rows.map((s) => (
                        <li key={s.xpartId ?? `local:${s.items[0]?.id}`} className="py-2">
                          <div className="flex flex-wrap items-center gap-x-2">
                            <span className="font-semibold">{s.name}</span>
                            {s.numbers.slice(0, 3).map((n) => (
                              <span key={n.brand + n.number} className="mono muted text-xs">
                                {n.brand} {n.number}
                              </span>
                            ))}
                            {s.close && <span className="pill tone-wait">Close match: {s.close}</span>}
                          </div>
                          {s.items.length === 0 ? (
                            <div className="muted text-xs">Not stocked</div>
                          ) : (
                            <ul className="mt-1 space-y-1">
                              {s.items.map((it) => (
                                <li key={it.id} className="flex flex-wrap items-center justify-between gap-2">
                                  <span>
                                    <span className="mono">{it.partNumber}</span> · {it.qtyOnHand} on hand
                                    {it.priceCents != null ? ` · ${money(it.priceCents)}` : " · no price"}
                                    {it.disclosure && <span className="muted"> · {it.disclosure}</span>}
                                  </span>
                                  <button type="button" className="btn btn-sm" onClick={() => onAdd(it, machineId)}>
                                    {verb}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
              {result.supplies.length > 0 && (
                <p className="muted text-xs">
                  {result.truncated ? "Showing the first 60. " : ""}
                  <a href={finderUrl(query)} target="_blank" rel="noreferrer" className="link">
                    Open the finder
                  </a>{" "}
                  for details, or to add a fit.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
