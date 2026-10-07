"use client";

// The register's "Machine for sale", "Trade-in", "Service plan" and "Return a machine" tools (modules-design.md 10.c;
// every shop since tax-machine-sales-layaway-design.md section 3). A sale or a trade-in needs a customer first (the
// warranty and the credit need the buyer); a plan is for a machine on this sale or one of the customer's; a return
// works whatever the modules say.
import { useState } from "react";
import { ArrowLeftRight, ShieldCheck, ShoppingBag, Undo2 } from "lucide-react";
import { planChoices, unitsForSale, unitsToReturn } from "@/actions/units";
import { UNIT_CONDITION_LABEL } from "@/lib/constants";
import { money, toCents } from "@/lib/format";
import type { UnitForSale, UnitToReturn } from "@/lib/units/units";
import type { TradeInInput, UnitCartLine } from "@/lib/units/types";
import { TradeInHelper } from "@/components/units/trade-in-helper";

/** A kind the shop may take in trade (from the register page): its key, words, types and brand suggestions. */
export type TradeKind = { key: string; label: string; types: string[]; brands: string[]; modelHint: string };

type Panel = "sell" | "trade" | "plan" | "return" | null;
type Choices = Awaited<ReturnType<typeof planChoices>>;
const CONDITIONS = ["NEW", "OPEN_BOX", "REFURB", "USED"] as const;
const emptyTrade = (kind: string) => ({ kind, brand: "", model: "", serial: "", machineType: "", condition: "USED" as TradeInInput["condition"], bagged: "" as "" | "Bagged" | "Bagless", bagType: "", credit: "", note: "" });

export function UnitTools({
  kinds,
  returnMode,
  customerId,
  inCart,
  onAdd,
  onNeedCustomer,
  tradeNote,
}: {
  /** Kinds the shop may sell and take in trade now; empty: returns only. */
  kinds: TradeKind[];
  returnMode: boolean;
  customerId: string | null;
  inCart: { stockUnitId?: string; qty: number; description: string }[];
  onAdd: (line: UnitCartLine) => void;
  onNeedCustomer: () => void;
  /** The Assistant's "Draft a condition note" on the trade-in (shop-features-round-2-design.md 5.4), when it can be used. */
  tradeNote?: { unavailable?: string } | null;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [q, setQ] = useState("");
  const [forSale, setForSale] = useState<UnitForSale[] | null>(null);
  const [toReturn, setToReturn] = useState<UnitToReturn[] | null>(null);
  const [trade, setTrade] = useState(emptyTrade(kinds[0]?.key ?? "sewing"));
  const [choices, setChoices] = useState<Choices | null>(null);
  const [plan, setPlan] = useState({ planId: "", target: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inCartIds = new Set(inCart.map((l) => l.stockUnitId).filter(Boolean));
  const tradeKind = kinds.find((k) => k.key === trade.kind) ?? kinds[0];
  const vacuum = tradeKind?.key === "vacuum";
  // A plan is for a machine being sold on this sale or one of the customer's own machines.
  const unitsOnSale = inCart.filter((l) => l.stockUnitId && l.qty > 0);

  async function open(p: Panel) {
    setPanel((cur) => (cur === p ? null : p));
    setErr(null);
    setForSale(null);
    setToReturn(null);
    if (p === "plan" && panel !== "plan") {
      try {
        setChoices(await planChoices(customerId));
      } catch {
        setErr("Couldn't load the plans. Check the connection, then try again.");
      }
    }
  }

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
    if (vacuum && !trade.bagged) return setErr("Say whether it takes bags.");
    if (credit == null || credit < 0) return setErr("Enter the credit (0 or more).");
    const t: TradeInInput = {
      kind: tradeKind?.key ?? null,
      brand: trade.brand.trim(),
      model: trade.model.trim(),
      serial: trade.serial.trim() || null,
      machineType: trade.machineType || null,
      condition: trade.condition,
      bagged: vacuum && trade.bagged ? trade.bagged : null,
      bagType: vacuum ? trade.bagType.trim() || null : null,
      note: trade.note.trim() || null,
    };
    onAdd({ description: `Trade-in: ${t.brand} ${t.model}${t.serial ? ` S/N ${t.serial}` : ""}`, qty: -1, unitPriceCents: credit, taxable: false, unit: null, tradeIn: t });
    setTrade(emptyTrade(trade.kind));
    setPanel(null);
    setErr(null);
  }

  function addPlan() {
    const p = choices?.plans.find((x) => x.id === plan.planId);
    if (!p) return setErr("Pick the plan.");
    const [kind, id] = plan.target.split(":");
    if (!id) return setErr("Pick the machine the plan is for.");
    const what = kind === "unit" ? unitsOnSale.find((l) => l.stockUnitId === id)?.description : choices?.machines.find((m) => m.id === id)?.label;
    onAdd({
      description: `Service plan: ${p.name}${what ? ` for ${what}` : ""}`,
      qty: 1,
      unitPriceCents: p.priceCents,
      taxable: p.taxable,
      unit: null,
      servicePlan: kind === "unit" ? { planId: p.id, stockUnitId: id } : { planId: p.id, machineId: id },
    });
    setPlan({ planId: "", target: "" });
    setPanel(null);
    setErr(null);
  }

  const needsCustomer = !customerId && (panel === "sell" || panel === "trade");
  const label = panel === "sell" ? "Machine for sale" : panel === "trade" ? "Trade-in" : panel === "plan" ? "Service plan" : "Return a machine";
  return (
    <>
      {!returnMode && kinds.length > 0 && (
        <>
          <button type="button" className={`btn btn-sm ${panel === "sell" ? "btn-primary" : ""}`} aria-expanded={panel === "sell"} onClick={() => open("sell")}>
            <ShoppingBag size={14} aria-hidden /> Machine for sale
          </button>
          <button type="button" className={`btn btn-sm ${panel === "trade" ? "btn-primary" : ""}`} aria-expanded={panel === "trade"} onClick={() => open("trade")}>
            <ArrowLeftRight size={14} aria-hidden /> Trade-in
          </button>
          <button type="button" className={`btn btn-sm ${panel === "plan" ? "btn-primary" : ""}`} aria-expanded={panel === "plan"} onClick={() => open("plan")}>
            <ShieldCheck size={14} aria-hidden /> Service plan
          </button>
        </>
      )}
      {returnMode && (
        <button type="button" className={`btn btn-sm ${panel === "return" ? "btn-primary" : ""}`} aria-expanded={panel === "return"} onClick={() => open("return")}>
          <Undo2 size={14} aria-hidden /> Return a machine
        </button>
      )}
      {panel && (!returnMode || panel === "return") && (
        <div className="card card-pad w-full space-y-3 text-sm" aria-label={label}>
          {needsCustomer ? (
            <p className="flex flex-wrap items-center gap-2">
              Pick or add the customer first.
              <button type="button" className="btn btn-sm" onClick={onNeedCustomer}>
                New customer
              </button>
            </p>
          ) : panel === "plan" ? (
            !choices ? (
              <p className="muted">Loading the plans...</p>
            ) : choices.plans.length === 0 ? (
              <p className="muted">No service plans yet. An owner or admin adds them under Settings → Sales.</p>
            ) : (
              <div className="space-y-2">
                <div className="grid-form">
                  <div className="field">
                    <label htmlFor="sp-plan" className="label">
                      Plan
                    </label>
                    <select id="sp-plan" value={plan.planId} onChange={(e) => setPlan({ ...plan, planId: e.target.value })} className="select">
                      <option value="">-</option>
                      {choices.plans.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({money(p.priceCents)}, {p.terms})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="sp-for" className="label">
                      For which machine
                    </label>
                    <select id="sp-for" value={plan.target} onChange={(e) => setPlan({ ...plan, target: e.target.value })} className="select">
                      <option value="">-</option>
                      {unitsOnSale.map((l) => (
                        <option key={l.stockUnitId} value={`unit:${l.stockUnitId}`}>
                          {l.description} (on this sale)
                        </option>
                      ))}
                      {choices.machines.map((m) => (
                        <option key={m.id} value={`machine:${m.id}`}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {!customerId && !unitsOnSale.length && <p className="muted">Pick the customer to see their machines, or add the machine being sold first.</p>}
                <button type="button" className="btn btn-primary btn-sm" onClick={addPlan}>
                  Add plan
                </button>
              </div>
            )
          ) : panel === "trade" ? (
            <div className="space-y-2">
              <div className="grid-form">
                {kinds.length > 1 && (
                  <div className="field">
                    <label htmlFor="ti-kind" className="label">
                      What kind
                    </label>
                    <select id="ti-kind" value={trade.kind} onChange={(e) => setTrade({ ...trade, kind: e.target.value, machineType: "" })} className="select">
                      {kinds.map((k) => (
                        <option key={k.key} value={k.key}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="ti-brand" className="label">
                    Brand
                  </label>
                  <input id="ti-brand" list="ti-brands" value={trade.brand} onChange={(e) => setTrade({ ...trade, brand: e.target.value })} className="input" />
                  <datalist id="ti-brands">
                    {(tradeKind?.brands ?? []).map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </div>
                <div className="field">
                  <label htmlFor="ti-model" className="label">
                    Model
                  </label>
                  <input id="ti-model" value={trade.model} onChange={(e) => setTrade({ ...trade, model: e.target.value })} className="input" placeholder={tradeKind?.modelHint} />
                </div>
                <div className="field">
                  <label htmlFor="ti-serial" className="label">
                    Serial
                  </label>
                  <input id="ti-serial" value={trade.serial} onChange={(e) => setTrade({ ...trade, serial: e.target.value })} className="input mono" />
                </div>
                {tradeKind && tradeKind.types.length > 0 && (
                  <div className="field">
                    <label htmlFor="ti-type" className="label">
                      Type
                    </label>
                    <select id="ti-type" value={trade.machineType} onChange={(e) => setTrade({ ...trade, machineType: e.target.value })} className="select">
                      <option value="">-</option>
                      {tradeKind.types.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                )}
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
                {vacuum && (
                  <>
                    <div className="field">
                      <label htmlFor="ti-bagged" className="label">
                        Bags or bagless
                      </label>
                      <select id="ti-bagged" value={trade.bagged} onChange={(e) => setTrade({ ...trade, bagged: e.target.value as "" | "Bagged" | "Bagless" })} className="select" required>
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
                  </>
                )}
                <TradeInHelper
                  kind={tradeKind?.key ?? null}
                  brand={trade.brand}
                  model={trade.model}
                  note={trade.note}
                  onNote={(note) => setTrade((t) => ({ ...t, note }))}
                  onCredit={(credit) => setTrade((t) => ({ ...t, credit }))}
                  noteEntry={tradeNote}
                />
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
                <ul className="divide-y divide-line" aria-label="Machines in stock">
                  {forSale.length === 0 && <li className="muted py-2">Nothing in stock matches.</li>}
                  {forSale.map((u) => (
                    <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>{u.description}</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={inCartIds.has(u.id)}
                        onClick={() => {
                          onAdd({ description: u.description, qty: 1, unitPriceCents: u.priceCents ?? 0, taxable: true, unit: null, stockUnitId: u.id, brand: u.brand });
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
                <ul className="divide-y divide-line" aria-label="Machines sold">
                  {toReturn.length === 0 && <li className="muted py-2">No sold machine matches.</li>}
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
