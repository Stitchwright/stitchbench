"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Camera, CameraOff, Trash2, Undo2, Wrench, Plus } from "lucide-react";
import { completeSale, findCustomers, findItems, itemByCode, pickupJobs, type CustomerHit, type PickupJob, type RegisterItem } from "@/actions/register";
import { beep, useBarcodeCamera } from "@/components/barcode-camera";
import { money, toCents } from "@/lib/format";
import { discountBase, lineNet, qtyText, saleTotals, TENDER_LABEL, TENDER_METHODS, type Tender, type TenderMethod } from "@/lib/register-math";

type CartLine = {
  key: string;
  partId?: string;
  repairJobId?: string;
  pickedUp?: boolean;
  description: string;
  partNumber?: string;
  unit: string | null;
  qty: number;
  unitPriceCents: number;
  discountPct: number;
  taxable: boolean;
  consigned?: boolean;
  // The item came with a stored price (a tech rings it up as priced; an unpriced item is priced on the line)
  priced?: boolean;
};

const discountOf = (l: CartLine) => Math.round((Math.abs(Math.round(l.qty * l.unitPriceCents)) * l.discountPct) / 100);
const newKey = () => Math.random().toString(36).slice(2);

export function Register({ taxRatePct, hasPartners, canSell }: { taxRatePct: number; hasPartners: boolean; canSell: boolean }) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [returnMode, setReturnMode] = useState(false);
  const [results, setResults] = useState<RegisterItem[]>([]);
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [custQ, setCustQ] = useState("");
  const [custHits, setCustHits] = useState<CustomerHit[]>([]);
  const [orderDisc, setOrderDisc] = useState({ kind: "%" as "%" | "$", value: "" });
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [tenderAmt, setTenderAmt] = useState("");
  const [misc, setMisc] = useState<{ description: string; price: string; taxable: boolean } | null>(null);
  const [jobs, setJobs] = useState<PickupJob[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; number: number; change: number } | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const code = useRef<HTMLInputElement>(null);
  const last = useRef({ code: "", at: 0 });

  // A partner's repair bill is paid as billed: a whole-sale discount doesn't come off it.
  const lines = useMemo(() => cart.map((l) => ({ ...l, discountCents: discountOf(l), discountable: !l.repairJobId })), [cart]);
  const base = discountBase(lines);
  const orderDiscountCents =
    orderDisc.value === "" ? 0 : orderDisc.kind === "%" ? Math.round((base * Math.min(100, Number(orderDisc.value) || 0)) / 100) : Math.min(base, toCents(orderDisc.value) ?? 0);
  const t = saleTotals(lines, orderDiscountCents, taxRatePct, tenders);

  useEffect(() => code.current?.focus(), []);

  function addItem(it: RegisterItem) {
    const sign = returnMode ? -1 : 1;
    setDone(null);
    setCart((c) => {
      // The same item scanned again adds one more (not for fabric: each cut is its own line).
      const i = c.findIndex((l) => l.partId === it.id && it.unit !== "yd" && Math.sign(l.qty) === sign);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qty: l.qty + sign } : l));
      return [
        ...c,
        {
          key: newKey(),
          partId: it.id,
          description: it.description,
          partNumber: it.partNumber,
          unit: it.unit,
          qty: sign * (it.unit === "yd" ? 1 : 1),
          unitPriceCents: it.priceCents ?? 0,
          discountPct: 0,
          taxable: true,
          consigned: it.consigned,
          priced: it.priceCents != null,
        },
      ];
    });
    if (it.priceCents == null) toast.warning(`${it.partNumber} has no price. Type the price on the line.`);
  }

  async function lookup(raw: string) {
    const c = raw.trim();
    if (!c) return;
    const it = await itemByCode(c);
    if (it) {
      beep(true);
      setResults([]);
      setMissing(null);
      addItem(it);
      return;
    }
    const hits = await findItems(c);
    beep(hits.length > 0);
    setResults(hits);
    setMissing(hits.length ? null : c);
  }

  // A camera sees the same code many times a second: count it once. A handheld scanner's every scan counts.
  const cam = useBarcodeCamera((c) => {
    if (c === last.current.code && Date.now() - last.current.at < 1500) return;
    last.current = { code: c, at: Date.now() };
    lookup(c);
  });

  function setLine(key: string, patch: Partial<CartLine>) {
    setCart((c) => c.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function addTender(method: TenderMethod) {
    const typed = toCents(tenderAmt);
    const amount = typed ?? (t.total < 0 ? t.total - t.paid : t.due);
    if (!amount) return;
    setTenders((x) => [...x, { method, amountCents: t.total < 0 ? -Math.abs(amount) : amount }]);
    setTenderAmt("");
  }

  async function finish() {
    setBusy(true);
    try {
      const r = await completeSale({
        customerId: customer?.id ?? null,
        lines: lines.map((l) => ({
          partId: l.partId ?? null,
          repairJobId: l.repairJobId ?? null,
          pickedUp: l.pickedUp,
          description: l.description,
          qty: l.qty,
          unitPriceCents: l.unitPriceCents,
          discountCents: l.discountCents,
          taxable: l.taxable,
        })),
        orderDiscountCents,
        tenders,
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setDone({ id: r.saleId, number: r.number, change: r.changeCents });
      toast.success(`Sale #${r.number} done${r.changeCents ? `. Change: ${money(r.changeCents)}` : ""}`);
      setCart([]);
      setTenders([]);
      setOrderDisc({ kind: "%", value: "" });
      setCustomer(null);
      setReturnMode(false);
      setJobs(null);
      code.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-3">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = code.current!.value;
            code.current!.value = "";
            lookup(v);
          }}
        >
          <div className="field min-w-64 flex-1">
            <label htmlFor="register-code" className="label">
              Scan a barcode or search
            </label>
            <input id="register-code" ref={code} autoComplete="off" className="input mono text-lg" placeholder="Scan, or type a number or words" />
          </div>
          <button className="btn btn-primary">Add</button>
          <button type="button" className="btn" onClick={() => (cam.on ? cam.stop() : cam.start())}>
            {cam.on ? <CameraOff size={14} aria-hidden /> : <Camera size={14} aria-hidden />} {cam.on ? "Stop camera" : "Camera"}
          </button>
        </form>
        <video ref={cam.video} className={cam.on ? "w-full max-w-sm rounded border border-line" : "hidden"} muted playsInline aria-label="Camera" />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-sm"
            disabled={!canSell && returnMode}
            title={!canSell && returnMode ? "Only an owner or admin can refund a misc item" : undefined}
            onClick={() => setMisc({ description: "", price: "", taxable: true })}
          >
            <Plus size={14} aria-hidden /> Misc item
          </button>
          {hasPartners && (
            <button type="button" className="btn btn-sm" onClick={async () => setJobs(await pickupJobs())}>
              <Wrench size={14} aria-hidden /> Repair pickup
            </button>
          )}
          <button type="button" className={`btn btn-sm ${returnMode ? "btn-primary" : ""}`} aria-pressed={returnMode} onClick={() => setReturnMode((r) => !r)}>
            <Undo2 size={14} aria-hidden /> Return mode {returnMode ? "on" : "off"}
          </button>
        </div>
        {missing && (
          <p className="card card-pad text-sm" role="alert">
            Nothing matches <span className="mono">{missing}</span>.{" "}
            <Link href={`/parts?new=${encodeURIComponent(missing)}#add`} className="link" target="_blank">
              Add it to inventory
            </Link>{" "}
            (a store barcode can be looked up online there), or ring it up as a misc item.
          </p>
        )}
        {returnMode && <p className="pill tone-wait">Return mode: scanned items come off the sale (negative quantity) and go back on the shelf.</p>}

        {results.length > 0 && (
          <div className="card">
            <ul className="divide-y divide-line text-sm" aria-label="Search results">
              {results.map((it) => (
                <li key={it.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-2"
                    onClick={() => {
                      addItem(it);
                      setResults([]);
                      code.current?.focus();
                    }}
                  >
                    <span>
                      <span className="mono">{it.partNumber}</span> {it.description}
                      {it.consigned && <span className="pill tone-neutral ml-1">consigned</span>}
                    </span>
                    <span className="num">
                      {money(it.priceCents)}
                      {it.unit === "yd" ? "/yd" : ""} · {qtyText(it.qtyOnHand, it.unit)} on hand
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {misc && (
          <form
            className="card card-pad flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const price = toCents(misc.price);
              if (!misc.description.trim() || price == null) return toast.error("Give the item a description and a price.");
              setCart((c) => [
                ...c,
                { key: newKey(), description: misc.description.trim(), unit: null, qty: returnMode ? -1 : 1, unitPriceCents: price, discountPct: 0, taxable: misc.taxable },
              ]);
              setMisc(null);
              code.current?.focus();
            }}
          >
            <div className="field min-w-48 flex-1">
              <label htmlFor="misc-desc" className="label">
                Description
              </label>
              <input id="misc-desc" autoFocus className="input" value={misc.description} onChange={(e) => setMisc({ ...misc, description: e.target.value })} />
            </div>
            <div className="field w-28">
              <label htmlFor="misc-price" className="label">
                Price
              </label>
              <input id="misc-price" inputMode="decimal" className="input num" value={misc.price} onChange={(e) => setMisc({ ...misc, price: e.target.value })} />
            </div>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={misc.taxable} onChange={(e) => setMisc({ ...misc, taxable: e.target.checked })} /> Taxable
            </label>
            <button className="btn btn-primary btn-sm">Add to sale</button>
            <button type="button" className="btn btn-sm" onClick={() => setMisc(null)}>
              Cancel
            </button>
          </form>
        )}

        {jobs && (
          <div className="card card-pad space-y-2">
            <strong className="text-sm">Repairs ready to pay for</strong>
            {jobs.length === 0 ? (
              <p className="muted text-sm">No repairs are back and waiting for payment.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {jobs.map((j) => (
                  <li key={j.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span>
                      Tag <strong>{j.tag}</strong> · {j.customerName} · {j.machine}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={cart.some((l) => l.repairJobId === j.id)}
                      onClick={() => {
                        setCart((c) => [
                          ...c,
                          { key: newKey(), repairJobId: j.id, pickedUp: true, description: `Repair, tag ${j.tag}: ${j.machine}`, unit: null, qty: 1, unitPriceCents: j.dueCents, discountPct: 0, taxable: false },
                        ]);
                        setJobs(null);
                      }}
                    >
                      Add {money(j.dueCents)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="card overflow-x-auto">
          <table className="table w-full text-sm" aria-label="Sale">
            <thead>
              <tr>
                <th>Item</th>
                <th className="w-28">Qty</th>
                <th className="w-28">Price</th>
                <th className="w-20">Disc %</th>
                <th className="w-24 text-right">Line</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted py-6 text-center">
                    Scan an item to start a sale.
                  </td>
                </tr>
              )}
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    {l.partNumber && <span className="mono mr-1">{l.partNumber}</span>}
                    {l.description}
                    {l.consigned && <span className="pill tone-neutral ml-1">consigned</span>}
                    {l.repairJobId && (
                      <label className="ml-2 inline-flex items-center gap-1 text-xs">
                        <input type="checkbox" checked={l.pickedUp !== false} onChange={(e) => setLine(l.key, { pickedUp: e.target.checked })} /> taking the machine home
                      </label>
                    )}
                    {!l.taxable && <span className="muted ml-1 text-xs">(no tax)</span>}
                  </td>
                  <td>
                    <input
                      type="number"
                      aria-label={`Qty for ${l.description}`}
                      className="input num"
                      step={l.unit === "yd" ? 0.125 : 1}
                      disabled={Boolean(l.repairJobId)}
                      value={l.qty}
                      onChange={(e) => setLine(l.key, { qty: Number(e.target.value) })}
                    />
                    {l.unit === "yd" && <div className="muted text-xs">{qtyText(l.qty, "yd")}</div>}
                  </td>
                  <td>
                    <input
                      aria-label={`Price for ${l.description}`}
                      inputMode="decimal"
                      className="input num"
                      disabled={Boolean(l.repairJobId) || (!canSell && l.priced)}
                      defaultValue={(l.unitPriceCents / 100).toFixed(2)}
                      onBlur={(e) => setLine(l.key, { unitPriceCents: toCents(e.target.value) ?? l.unitPriceCents })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      aria-label={`Discount for ${l.description}`}
                      className="input num"
                      min={0}
                      max={100}
                      disabled={!canSell || Boolean(l.repairJobId)}
                      value={l.discountPct || ""}
                      onChange={(e) => setLine(l.key, { discountPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
                    />
                  </td>
                  <td className="num text-right">{money(lineNet(l))}</td>
                  <td>
                    <button type="button" className="btn btn-sm" aria-label={`Remove ${l.description}`} onClick={() => setCart((c) => c.filter((x) => x.key !== l.key))}>
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <aside className="space-y-3">
        <div className="card card-pad space-y-2">
          <div className="field">
            <label htmlFor="register-customer" className="label">
              Customer (optional)
            </label>
            {customer ? (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {customer.name} {customer.phone && <span className="muted">{customer.phone}</span>}
                </span>
                <button type="button" className="link text-xs" onClick={() => setCustomer(null)}>
                  change
                </button>
              </div>
            ) : (
              <input
                id="register-customer"
                className="input"
                placeholder="Name or phone"
                value={custQ}
                onChange={async (e) => {
                  setCustQ(e.target.value);
                  setCustHits(await findCustomers(e.target.value));
                }}
              />
            )}
            {!customer && custHits.length > 0 && (
              <ul className="divide-y divide-line rounded border border-line text-sm">
                {custHits.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="w-full px-2 py-1 text-left hover:bg-surface-2"
                      onClick={() => {
                        setCustomer(c);
                        setCustHits([]);
                        setCustQ("");
                      }}
                    >
                      {c.name} <span className="muted">{c.phone}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="card card-pad space-y-1 text-sm">
          <Row k="Subtotal" v={money(t.subtotal)} />
          <div className="flex items-center justify-between gap-2">
            <span>Discount on sale</span>
            <span className="flex items-center gap-1">
              <input
                aria-label="Discount on the whole sale"
                inputMode="decimal"
                className="input num w-20"
                disabled={!canSell}
                value={orderDisc.value}
                onChange={(e) => setOrderDisc({ ...orderDisc, value: e.target.value })}
              />
              <select aria-label="Discount type" className="select w-16" disabled={!canSell} value={orderDisc.kind} onChange={(e) => setOrderDisc({ ...orderDisc, kind: e.target.value as "%" | "$" })}>
                <option>%</option>
                <option>$</option>
              </select>
            </span>
          </div>
          {t.orderDiscount > 0 && <Row k="" v={`-${money(t.orderDiscount)}`} />}
          <Row k={`Tax (${taxRatePct}%)`} v={money(t.tax)} />
          <div className="flex justify-between border-t border-line pt-1 text-lg font-bold">
            <span>{t.total < 0 ? "Refund" : "Total"}</span>
            <span className="num" data-testid="sale-total">
              {money(Math.abs(t.total))}
            </span>
          </div>
        </div>

        <div className="card card-pad space-y-2">
          <div className="field">
            <label htmlFor="tender-amount" className="label">
              {t.total < 0 ? "Refund amount" : "Amount tendered"} (blank = {money(Math.abs(t.total < 0 ? t.total - t.paid : t.due))})
            </label>
            <input id="tender-amount" inputMode="decimal" className="input num" value={tenderAmt} onChange={(e) => setTenderAmt(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-1">
            {TENDER_METHODS.map((m) => (
              <button key={m} type="button" className="btn btn-sm" disabled={!lines.length} onClick={() => addTender(m)}>
                {TENDER_LABEL[m]}
              </button>
            ))}
          </div>
          {tenders.length > 0 && (
            <ul className="text-sm">
              {tenders.map((x, i) => (
                <li key={i} className="flex justify-between">
                  <span>
                    {TENDER_LABEL[x.method]}{" "}
                    <button type="button" className="link text-xs" onClick={() => setTenders((ts) => ts.filter((_, j) => j !== i))}>
                      remove
                    </button>
                  </span>
                  <span className="num">{money(x.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
          {t.total >= 0 && t.due > 0 && tenders.length > 0 && <Row k="Still due" v={money(t.due)} />}
          {t.change > 0 && (
            <div className="flex justify-between text-lg font-bold text-[var(--ok)]">
              <span>Change</span>
              <span className="num">{money(t.change)}</span>
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={busy || !lines.length || (t.total >= 0 ? t.due > 0 : t.paid !== t.total)}
            onClick={finish}
          >
            {busy ? "Saving..." : t.total < 0 ? "Complete refund" : "Complete sale"}
          </button>
          <p className="muted text-xs">Cards run on your own card reader; record them here as Card.</p>
        </div>

        {done && (
          <div className="card card-pad text-sm" role="status">
            Sale #{done.number} done{done.change ? `. Change due ${money(done.change)}` : ""}.{" "}
            <Link href={`/register/sales/${done.id}`} className="link">
              Print receipt
            </Link>
          </div>
        )}
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span>{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}
