"use client";

// The register's "Vacuum for sale", "Trade-in" and "Return a vacuum" tools (modules-design.md 10.c). A sale or a
// trade-in needs a customer first (the warranty and the credit need the buyer); a return works in any module state.
import { useState } from "react";
import { ArrowLeftRight, ShoppingBag, Undo2 } from "lucide-react";
import { unitsForSale, unitsToReturn } from "@/actions/vac-units";
import { UNIT_CONDITION_LABEL } from "@/lib/constants";
import { VACUUM_KIND } from "@/lib/equipment/vacuum";
import { money, toCents } from "@/lib/format";
import type { UnitForSale, UnitToReturn } from "@/lib/vac/units";
import type { TradeInInput, VacCartLine } from "@/lib/vac/types";

type Panel = "sell" | "trade" | "return" | null;
const CONDITIONS = ["NEW", "OPEN_BOX", "REFURB", "USED"] as const;
const EMPTY_TRADE = { brand: "", model: "", serial: "", machineType: "", condition: "USED" as TradeInInput["condition"], bagged: "" as "" | "Bagged" | "Bagless", bagType: "", credit: "" };

export function VacUnitTools({ vac, returnMode, customerId, inCart, onAdd, onNeedCustomer }: {
  vac: "on" | "readonly";
  returnMode: boolean;
  customerId: string | null;
  inCart: { stockUnitId?: string }[];
  onAdd: (line: VacCartLine) => void;
  onNeedCustomer: () => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [q, setQ] = useState("");
  const [forSale, setForSale] = useState<UnitForSale[] | null>(null);
  const [toReturn, setToReturn] = useState<UnitToReturn[] | null>(null);
  const [trade, setTrade] = useState(EMPTY_TRADE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inCartIds = new Set(inCart.map((l) => l.stockUnitId).filter(Boolean));

  const open = (p: Panel) => {
    setPanel((cur) => (cur === p ? null : p));
    setErr(null);
    setForSale(null);
    setToReturn(null);
  };

  async function look() {
    setBusy(true);
    setErr(null);
    try {
      if (panel === "return") setToReturn(await unitsToReturn(q));
      else setForSale(await unitsForSale(q));
    } catch {
      setErr("Couldn't look that up. Check the connection, then try again.");
    } finally {
      setBusy(false);
    }
  }

  function addTradeIn() {
    const credit = toCents(trade.credit);
    if (!trade.brand.trim() || !trade.model.trim()) return setErr("Enter the trade-in's brand and model.");
    if (!trade.bagged) return setErr("Say whether it takes bags.");
    if (credit == null || credit < 0) return setErr("Enter the credit (0 or more).");
    const t: TradeInInput = {
      brand: trade.brand.trim(),
      model: trade.model.trim(),
      serial: trade.serial.trim() || null,
      machineType: trade.machineType || null,
      condition: trade.condition,
      bagged: trade.bagged,
      bagType: trade.bagType.trim() || null,
    };
    onAdd({ description: `Trade-in: ${t.brand} ${t.model}${t.serial ? ` S/N ${t.serial}` : ""}`, qty: -1, unitPriceCents: credit, taxable: false, unit: null, tradeIn: t });
    setTrade(EMPTY_TRADE);
    setPanel(null);
    setErr(null);
  }

  const needsCustomer = !customerId && (panel === "sell" || panel === "trade");
  return (
    <>
      {!returnMode && vac === "on" && (
        <>
          <button type="button" className={`btn btn-sm ${panel === "sell" ? "btn-primary" : ""}`} aria-expanded={panel === "sell"} onClick={() => open("sell")}>
            <ShoppingBag size={14} aria-hidden /> Vacuum for sale
          </button>
          <button type="button" className={`btn btn-sm ${panel === "trade" ? "btn-primary" : ""}`} aria-expanded={panel === "trade"} onClick={() => open("trade")}>
            <ArrowLeftRight size={14} aria-hidden /> Trade-in
          </button>
        </>
      )}
      {returnMode && (
        <button type="button" className={`btn btn-sm ${panel === "return" ? "btn-primary" : ""}`} aria-expanded={panel === "return"} onClick={() => open("return")}>
          <Undo2 size={14} aria-hidden /> Return a vacuum
        </button>
      )}
      {panel && (!returnMode || panel === "return") && (
        <div className="card card-pad w-full space-y-3 text-sm" aria-label={panel === "sell" ? "Vacuum for sale" : panel === "trade" ? "Trade-in" : "Return a vacuum"}>
          {needsCustomer ? (
            <p className="flex flex-wrap items-center gap-2">
              Pick or add the customer first.
              <button type="button" className="btn btn-sm" onClick={onNeedCustomer}>
                New customer
              </button>
            </p>
          ) : panel === "trade" ? (
            <div className="space-y-2">
              <div className="grid-form">
                <div className="field">
                  <label htmlFor="ti-brand" className="label">
                    Brand
                  </label>
                  <input id="ti-brand" list="ti-brands" value={trade.brand} onChange={(e) => setTrade({ ...trade, brand: e.target.value })} className="input" />
                  <datalist id="ti-brands">
                    {VACUUM_KIND.brands.map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </div>
                <div className="field">
                  <label htmlFor="ti-model" className="label">
                    Model
                  </label>
                  <input id="ti-model" value={trade.model} onChange={(e) => setTrade({ ...trade, model: e.target.value })} className="input" placeholder={VACUUM_KIND.modelHint} />
                </div>
                <div className="field">
                  <label htmlFor="ti-serial" className="label">
                    Serial
                  </label>
                  <input id="ti-serial" value={trade.serial} onChange={(e) => setTrade({ ...trade, serial: e.target.value })} className="input mono" />
                </div>
                <div className="field">
                  <label htmlFor="ti-type" className="label">
                    Type
                  </label>
                  <select id="ti-type" value={trade.machineType} onChange={(e) => setTrade({ ...trade, machineType: e.target.value })} className="select">
                    <option value="">-</option>
                    {VACUUM_KIND.types.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ti-cond" className="label">
                    Condition
                  </label>
                  <select id="ti-cond" value={trade.condition} onChange={(e) => setTrade({ ...trade, condition: e.target.value as TradeInInput["condition"] })} className="select">
                    {CONDITIONS.map((c) => (
                      <option key={c} value={c}>
                        {UNIT_CONDITION_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ti-bagged" className="label">
                    Bags or bagless
                  </label>
                  <select id="ti-bagged" value={trade.bagged} onChange={(e) => setTrade({ ...trade, bagged: e.target.value as typeof trade.bagged })} className="select" required>
                    <option value="">-</option>
                    <option>Bagged</option>
                    <option>Bagless</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ti-bagtype" className="label">
                    Bag type
                  </label>
                  <input id="ti-bagtype" value={trade.bagType} onChange={(e) => setTrade({ ...trade, bagType: e.target.value })} className="input" placeholder="e.g. Hoover Type Y" />
                </div>
                <div className="field">
                  <label htmlFor="ti-credit" className="label">
                    Credit ($)
                  </label>
                  <input id="ti-credit" value={trade.credit} onChange={(e) => setTrade({ ...trade, credit: e.target.value })} className="input num" inputMode="decimal" placeholder="0.00" />
                </div>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={addTradeIn}>
                Add trade-in
              </button>
            </div>
          ) : (
            <>
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  look();
                }}
              >
                <div className="field min-w-56 flex-1">
                  <label htmlFor="vu-q" className="label">
                    {panel === "return" ? "Serial, brand, model or buyer" : "Serial, brand or model"}
                  </label>
                  <input id="vu-q" value={q} onChange={(e) => setQ(e.target.value)} className="input" placeholder={panel === "return" ? "Leave blank for the latest sales" : "Leave blank for everything in stock"} />
                </div>
                <button className="btn btn-sm" disabled={busy}>
                  {busy ? "Looking..." : "Look up"}
                </button>
              </form>
              {panel === "sell" && forSale && (
                <ul className="divide-y divide-line" aria-label="Vacuums in stock">
                  {forSale.length === 0 && <li className="muted py-2">Nothing in stock matches.</li>}
                  {forSale.map((u) => (
                    <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>{u.description}</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={inCartIds.has(u.id)}
                        onClick={() => {
                          onAdd({ description: u.description, qty: 1, unitPriceCents: u.priceCents ?? 0, taxable: true, unit: null, stockUnitId: u.id });
                          setPanel(null);
                        }}
                      >
                        {inCartIds.has(u.id) ? "On this sale" : u.priceCents == null ? "Add (no price yet)" : `Add ${money(u.priceCents)}`}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {panel === "return" && toReturn && (
                <ul className="divide-y divide-line" aria-label="Vacuums sold">
                  {toReturn.length === 0 && <li className="muted py-2">No sold vacuum matches.</li>}
                  {toReturn.map((u) => (
                    <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        {u.description}
                        {u.buyer && <span className="muted"> · {u.buyer}</span>}
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={inCartIds.has(u.id)}
                        onClick={() => {
                          onAdd({ description: `Return: ${u.description}`, qty: -1, unitPriceCents: u.refundCents, taxable: true, unit: null, stockUnitId: u.id });
                          setPanel(null);
                        }}
                      >
                        {inCartIds.has(u.id) ? "On this sale" : `Refund ${money(u.refundCents)}`}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {err && (
            <p className="text-[var(--bad)]" role="alert">
              {err}
            </p>
          )}
        </div>
      )}
    </>
  );
}
