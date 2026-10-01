"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Camera, CameraOff, Trash2, Undo2, Wrench, Plus } from "lucide-react";
import {
  completeSale,
  findCustomers,
  findItems,
  itemByCode,
  pickupJobByTag,
  pickupJobs,
  quickAddCustomer,
  saleForReturn,
  type CustomerHit,
  type PickupJob,
  type RegisterItem,
  type SaleForReturn,
} from "@/actions/register";
import { beep, useBarcodeCamera } from "@/components/barcode-camera";
import { VacSupplyPicker } from "@/components/vac/supply-picker";
import { VacUnitTools } from "@/components/vac/unit-tools";
import { money, toCents } from "@/lib/format";
import { parseScanCode } from "@/lib/scan-codes";
import { discountBase, inEighths, lineNet, qtyText, roundCents, saleTotals, tenderProblem, TENDER_LABEL, TENDER_METHODS, type Tender, type TenderMethod } from "@/lib/register-math";
import type { TradeInInput, VacCartLine } from "@/lib/vac/types";

type CartLine = {
  key: string;
  partId?: string;
  repairJobId?: string;
  pickedUp?: boolean;
  /** A repair's machine that already went home (this line pays the rest of its bill). */
  handedOver?: boolean;
  description: string;
  partNumber?: string;
  unit: string | null;
  qty: number;
  unitPriceCents: number;
  /** The item has a price in inventory: only an owner or admin changes it. */
  priced?: boolean;
  /** How many the shop had when the item was scanned (a warning when the sale asks for more). */
  onHand?: number;
  discountPct: number;
  taxable: boolean;
  consigned?: boolean;
  /** "used", "compatible, not genuine Brother"...: the receipt says it after the description. */
  disclosure?: string;
  /** Vac Shop: the customer's vacuum this supply is for; a vacuum sold from stock; a trade-in taken as credit. */
  machineId?: string | null;
  stockUnitId?: string;
  tradeIn?: TradeInInput;
};

type NewCustomer = { name: string; phone: string; email: string; address: string };
const EMPTY_CUSTOMER: NewCustomer = { name: "", phone: "", email: "", address: "" };

const discountOf = (l: CartLine) => Math.round((Math.abs(roundCents(l.qty * l.unitPriceCents)) * l.discountPct) / 100);
const newKey = () => Math.random().toString(36).slice(2);
// Names a sale for the server, so one sent twice is made once. getRandomValues works on the shop's plain-http network.
const saleKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

// A handheld scanner types a code much faster than anyone can, then presses Enter.
const SCAN_MIN_CHARS = 4;
const SCAN_MAX_GAP_MS = 60;
const SCAN_AVG_GAP_MS = 35;

/** Puts text back in a field the way typing would, so the page's own state follows. */
function setFieldText(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function Register({ taxRatePct, hasPartners, canSell, vac }: { taxRatePct: number; hasPartners: boolean; canSell: boolean; vac?: "on" | "readonly" | "off" }) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [returnMode, setReturnMode] = useState(false);
  const [results, setResults] = useState<RegisterItem[]>([]);
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [custQ, setCustQ] = useState("");
  const [custHits, setCustHits] = useState<CustomerHit[]>([]);
  // The "New customer" form: open with its fields, or closed.
  const [newCustomer, setNewCustomerForm] = useState<NewCustomer | null>(null);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const setNewCustomer = (open: boolean) => setNewCustomerForm(open ? EMPTY_CUSTOMER : null);
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
  // The sale as last sent and the key it went with: sent again unchanged (after a lost answer), it keeps the key.
  const pending = useRef<{ key: string; sent: string } | null>(null);

  // A partner's repair bill is paid as billed, and a trade-in is credit: a whole-sale discount doesn't come off them.
  const lines = useMemo(() => cart.map((l) => ({ ...l, discountCents: discountOf(l), discountable: !l.repairJobId && !l.tradeIn })), [cart]);
  const base = discountBase(lines);
  const orderDiscountCents =
    orderDisc.value === "" ? 0 : orderDisc.kind === "%" ? Math.round((base * Math.min(100, Number(orderDisc.value) || 0)) / 100) : Math.min(base, toCents(orderDisc.value) ?? 0);
  const t = saleTotals(lines, orderDiscountCents, taxRatePct, tenders);
  const refund = t.total < 0;
  // Why the payments so far can't settle the sale (the server checks the same); it can't be completed until there is none.
  const problem = tenderProblem(t, tenders);
  // Still to pay back on a refund: below 0 when too much was paid back.
  const refundLeft = t.paid - t.total;

  useEffect(() => code.current?.focus(), []);

  // Enter in a line's Qty, Price or Disc % field: back to the scan box for the next item.
  const backToScan = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") code.current?.focus();
  };

  /** An item scanned or picked, with the customer's vacuum it was bought for when the Vac Shop's picker found it. */
  function addItem(it: RegisterItem, machineId: string | null = null) {
    const sign = returnMode ? -1 : 1;
    // A vacuum in stock is sold once, as one line of 1.
    if (it.stockUnitId) {
      if (cart.some((l) => l.stockUnitId === it.stockUnitId)) {
        toast.warning("That vacuum is already on this sale.");
        return;
      }
      setDone(null);
      setCart((c) => [...c, { key: newKey(), stockUnitId: it.stockUnitId!, description: it.description, unit: null, qty: 1, unitPriceCents: it.priceCents ?? 0, priced: it.priceCents != null, discountPct: 0, taxable: true }]);
      return;
    }
    setDone(null);
    setCart((c) => {
      // The same item scanned again adds one more (not for fabric: each cut is its own line; not across vacuums: a
      // supply bought for another vacuum is its own line).
      const i = c.findIndex((l) => l.partId === it.id && it.unit !== "yd" && Math.sign(l.qty) === sign && (l.machineId ?? null) === machineId);
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
          priced: it.priceCents != null,
          onHand: it.qtyOnHand,
          discountPct: 0,
          taxable: true,
          consigned: it.consigned,
          disclosure: it.disclosure,
          machineId,
        },
      ];
    });
    if (it.priceCents == null) toast.warning(`${it.partNumber} has no price. Type the price on the line.`);
  }

  /** A unit, trade-in or return line the Vac Shop tools made: added as it comes. */
  function addLine(line: VacCartLine) {
    setDone(null);
    setCart((c) => [...c, { key: newKey(), discountPct: 0, ...line }]);
  }

  /** The "New customer" form: adds the customer and puts them on the sale. */
  async function submitNewCustomer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!newCustomer) return;
    setAddingCustomer(true);
    try {
      const fd = new FormData();
      for (const [k, v] of Object.entries(newCustomer)) fd.set(k, v);
      const r = await quickAddCustomer(fd);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setCustomer(r);
      setCustHits([]);
      setCustQ("");
      setNewCustomerForm(null);
      toast.success(`${r.name} added`);
    } catch {
      toast.error("Couldn't add the customer. Check the connection, then try again.");
    } finally {
      setAddingCustomer(false);
    }
  }

  // A claim tag's barcode (T<tag>, or plain digits typed by hand) found a repair to pay for: the same line "Repair
  // pickup" adds, so the tag doesn't have to be found in that list by hand.
  function addPickupLine(job: PickupJob) {
    if (cart.some((l) => l.repairJobId === job.id)) {
      toast.warning(`Tag ${job.tag} is already on this sale.`);
      return;
    }
    setDone(null);
    setCart((c) => [
      ...c,
      {
        key: newKey(),
        repairJobId: job.id,
        pickedUp: !job.pickedUp,
        handedOver: job.pickedUp,
        description: `Repair, tag ${job.tag}: ${job.machine}${job.paidCents > 0 ? " (rest of the bill)" : ""}`,
        unit: null,
        qty: 1,
        unitPriceCents: job.dueCents,
        discountPct: 0,
        taxable: false,
      },
    ]);
  }

  // A receipt's barcode (S<number>) found the sale it printed on: its lines come back in as a return, priced (and
  // discounted) exactly as they were sold, ready to adjust or remove before completing the refund.
  function loadReturnSale(sale: SaleForReturn) {
    if (!sale.lines.length) {
      toast.warning(sale.skippedRepairLines ? `Sale #${sale.number} only paid a repair bill. Sort that out with the repair shop.` : `Sale #${sale.number} has nothing to return.`);
      return;
    }
    setDone(null);
    setCart((c) => [
      ...c,
      ...sale.lines.map((l) => ({
        key: newKey(),
        partId: l.partId ?? undefined,
        description: l.description,
        partNumber: l.partNumber ?? undefined,
        unit: l.unit,
        // Already the return's own quantity (splitForReturn negates it server-side), not the original sale's.
        qty: l.qty,
        unitPriceCents: l.unitPriceCents,
        priced: true,
        discountPct: 0,
        taxable: l.taxable,
      })),
    ]);
    setReturnMode(true);
    if (sale.customer) setCustomer(sale.customer);
    toast.success(
      `Sale #${sale.number}: ${sale.lines.length} item${sale.lines.length === 1 ? "" : "s"} added as a return.${sale.skippedRepairLines ? " A repair payment on it was left out; sort that out with the repair shop." : ""}`,
    );
  }

  async function lookup(raw: string) {
    const c = raw.trim();
    if (!c) return;
    try {
      const it = await itemByCode(c);
      if (it) {
        beep(true);
        setResults([]);
        setMissing(null);
        addItem(it);
        return;
      }
      const scan = parseScanCode(c);
      if (scan.kind === "tag") {
        const job = await pickupJobByTag(scan.tag);
        if (job) {
          beep(true);
          setResults([]);
          setMissing(null);
          addPickupLine(job);
          return;
        }
      } else if (scan.kind === "sale") {
        const sale = await saleForReturn(scan.number);
        if (sale) {
          beep(true);
          setResults([]);
          setMissing(null);
          loadReturnSale(sale);
          return;
        }
      }
      const hits = await findItems(c);
      beep(hits.length > 0);
      setResults(hits);
      setMissing(hits.length ? null : c);
    } catch {
      beep(false);
      toast.error(`Couldn't look up ${c.slice(0, 40)}. Check the connection, then scan it again.`);
    }
  }

  // A camera sees the same code many times a second: count it once. A handheld scanner's every scan counts.
  const { video: camVideo, on: camOn, start: camStart, stop: camStop } = useBarcodeCamera((c) => {
    if (c === last.current.code && Date.now() - last.current.at < 1500) return;
    last.current = { code: c, at: Date.now() };
    lookup(c);
  });

  // A scanner types into whatever has focus: a Qty or Disc % field just typed in, a payment button just clicked. A scan
  // that lands anywhere but the scan box is taken back out of that field and rung up.
  const onScan = useEffectEvent((scanned: string) => {
    code.current?.focus();
    lookup(scanned);
  });
  useEffect(() => {
    let burst = { text: "", start: 0, last: 0, target: null as EventTarget | null, before: null as string | null };
    function onKey(e: KeyboardEvent) {
      if (e.target === code.current || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) {
        burst.text = "";
        return;
      }
      if (e.key.length === 1) {
        if (!burst.text || e.target !== burst.target || e.timeStamp - burst.last > SCAN_MAX_GAP_MS) {
          // What the field held before this burst of keys, to put back if it turns out to be a scan.
          const field = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement ? e.target : null;
          burst = { text: "", start: e.timeStamp, last: e.timeStamp, target: e.target, before: field ? field.value : null };
        }
        burst.text += e.key;
        burst.last = e.timeStamp;
        return;
      }
      const scanned =
        e.key === "Enter" &&
        burst.text.length >= SCAN_MIN_CHARS &&
        e.timeStamp - burst.last <= SCAN_MAX_GAP_MS &&
        (burst.last - burst.start) / (burst.text.length - 1) <= SCAN_AVG_GAP_MS;
      if (scanned) {
        e.preventDefault();
        e.stopPropagation();
        const { text, target, before } = burst;
        if (before != null && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) setFieldText(target, before);
        onScan(text);
      }
      if (e.key !== "Shift") burst.text = "";
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  function setLine(key: string, patch: Partial<CartLine>) {
    setCart((c) => c.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function addTender(method: TenderMethod) {
    const typed = toCents(tenderAmt);
    // Something typed that isn't an amount is not the same as blank (which takes what is still to pay).
    if (tenderAmt.trim() && typed == null) return toast.error("Type the amount like 12.50, or leave it blank.");
    // A refund is paid out in negative amounts, whatever sign was typed. Blank is what is still to pay (back).
    const amount = typed != null ? (refund ? -Math.abs(typed) : typed) : refund ? -refundLeft : t.due;
    if (!amount) return;
    if (refund && amount > 0) return toast.error(`Already refunded ${money(amount)} too much. Take a payment off first.`);
    setTenders((x) => [...x, { method, amountCents: amount }]);
    setTenderAmt("");
    // Ready for the next scan (a scanner's Enter on this button would take the payment again).
    code.current?.focus();
  }

  async function finish() {
    setBusy(true);
    setDone(null);
    const sale = {
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
        machineId: l.machineId ?? null,
        stockUnitId: l.stockUnitId ?? null,
        tradeIn: l.tradeIn ?? null,
      })),
      orderDiscountCents,
      tenders,
    };
    const sent = JSON.stringify(sale);
    if (pending.current?.sent !== sent) pending.current = { key: saleKey(), sent };
    try {
      const r = await completeSale({ ...sale, clientKey: pending.current.key });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      pending.current = null;
      setDone({ id: r.saleId, number: r.number, change: r.changeCents });
      toast.success(`Sale #${r.number} done${r.changeCents ? `. Change: ${money(r.changeCents)}` : ""}`);
      setCart([]);
      setTenders([]);
      setOrderDisc({ kind: "%", value: "" });
      setCustomer(null);
      setReturnMode(false);
      setJobs(null);
      code.current?.focus();
    } catch {
      toast.error("The sale didn't go through (no connection, or a problem on the server). Press Complete sale again: a sale that did save won't be saved twice.");
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
            <input id="register-code" ref={code} autoComplete="off" className="input mono text-lg" placeholder="Scan, or type a number, words, a claim tag, or a receipt number" />
          </div>
          <button className="btn btn-primary">Add</button>
          <button type="button" className="btn" onClick={() => (camOn ? camStop() : camStart())}>
            {camOn ? <CameraOff size={14} aria-hidden /> : <Camera size={14} aria-hidden />} {camOn ? "Stop camera" : "Camera"}
          </button>
        </form>
        <video ref={camVideo} className={camOn ? "w-full max-w-sm rounded border border-line" : "hidden"} muted playsInline aria-label="Camera" />

        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm" onClick={() => setMisc({ description: "", price: "", taxable: true })}>
            <Plus size={14} aria-hidden /> Misc item
          </button>
          {hasPartners && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                try {
                  setJobs(await pickupJobs());
                } catch {
                  toast.error("Couldn't load the repairs. Check the connection, then try again.");
                }
              }}
            >
              <Wrench size={14} aria-hidden /> Repair pickup
            </button>
          )}
          {vac === "on" && <VacSupplyPicker customerId={customer?.id ?? null} returnMode={returnMode} onAdd={(it, m) => addItem(it, m)} />}
          {vac && vac !== "off" && (
            <VacUnitTools vac={vac} returnMode={returnMode} customerId={customer?.id ?? null} inCart={cart} onAdd={addLine} onNeedCustomer={() => setNewCustomer(true)} />
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
            {vac === "on" && (
              <>
                {" "}
                A vacuum for sale? Add it under{" "}
                <Link href="/vac/units" className="link" target="_blank">
                  Vac Shop → For sale
                </Link>
                .
              </>
            )}
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
                      {it.disclosure && <span className="pill tone-wait ml-1">{it.disclosure}</span>}
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
                      {j.paidCents > 0 && <span className="muted"> · paid {money(j.paidCents)} here before the repair shop added to the bill</span>}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={cart.some((l) => l.repairJobId === j.id)}
                      onClick={() => {
                        addPickupLine(j);
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
                    {l.disclosure && <span className="pill tone-wait ml-1">{l.disclosure}</span>}
                    {l.consigned && <span className="pill tone-neutral ml-1">consigned</span>}
                    {l.repairJobId && !l.handedOver && (
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
                      // A repair is paid as one line; a vacuum from stock or a trade-in is one machine.
                      disabled={Boolean(l.repairJobId || l.stockUnitId || l.tradeIn)}
                      value={l.qty}
                      onChange={(e) => setLine(l.key, { qty: Number(e.target.value) })}
                      onKeyDown={backToScan}
                    />
                    {l.unit === "yd" &&
                      (inEighths(l.qty) ? <div className="muted text-xs">{qtyText(l.qty, "yd")}</div> : <div className="text-xs text-[var(--bad)]">Use 1/8 yd steps</div>)}
                    {l.partId && l.onHand != null && l.qty > l.onHand && (
                      <div className="text-xs text-[var(--bad)]">
                        Only {qtyText(Math.max(0, l.onHand), l.unit)} {l.consigned ? "left on the shelf" : "on hand"}
                      </div>
                    )}
                  </td>
                  <td>
                    <input
                      aria-label={`Price for ${l.description}`}
                      inputMode="decimal"
                      className="input num"
                      // A tech can type the price of an item that has none, not change one that has.
                      disabled={(!canSell && l.priced) || Boolean(l.repairJobId)}
                      defaultValue={(l.unitPriceCents / 100).toFixed(2)}
                      onBlur={(e) => {
                        const cents = toCents(e.target.value);
                        if (cents == null) {
                          toast.error("Type the price like 12.50.");
                          e.target.value = (l.unitPriceCents / 100).toFixed(2);
                        } else setLine(l.key, { unitPriceCents: cents });
                      }}
                      onKeyDown={backToScan}
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
                      onKeyDown={backToScan}
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
              <div className="flex items-end gap-2">
                <input
                  id="register-customer"
                  className="input flex-1"
                  placeholder="Name or phone"
                  value={custQ}
                  onChange={async (e) => {
                    setCustQ(e.target.value);
                    setCustHits(await findCustomers(e.target.value));
                  }}
                />
                <button type="button" className="btn btn-sm whitespace-nowrap" aria-expanded={Boolean(newCustomer)} onClick={() => setNewCustomer(!newCustomer)}>
                  <Plus size={14} aria-hidden /> New customer
                </button>
              </div>
            )}
            {!customer && newCustomer && (
              <form className="space-y-2 rounded border border-line p-2" onSubmit={submitNewCustomer} aria-label="New customer">
                <div className="field">
                  <label htmlFor="new-customer-name" className="label">
                    Name
                  </label>
                  <input id="new-customer-name" autoFocus className="input" value={newCustomer.name} onChange={(e) => setNewCustomerForm({ ...newCustomer, name: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="new-customer-phone" className="label">
                    Phone
                  </label>
                  <input id="new-customer-phone" type="tel" className="input" value={newCustomer.phone} onChange={(e) => setNewCustomerForm({ ...newCustomer, phone: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="new-customer-email" className="label">
                    Email
                  </label>
                  <input id="new-customer-email" type="email" className="input" value={newCustomer.email} onChange={(e) => setNewCustomerForm({ ...newCustomer, email: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="new-customer-address" className="label">
                    Address
                  </label>
                  <input id="new-customer-address" className="input" value={newCustomer.address} onChange={(e) => setNewCustomerForm({ ...newCustomer, address: e.target.value })} />
                </div>
                <div className="flex gap-2">
                  <button className="btn btn-primary btn-sm" disabled={addingCustomer}>
                    {addingCustomer ? "Adding..." : "Add customer"}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setNewCustomerForm(null)}>
                    Cancel
                  </button>
                </div>
              </form>
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
              <select
                aria-label="Discount type"
                className="select w-16"
                disabled={!canSell}
                value={orderDisc.kind}
                onChange={(e) => setOrderDisc({ ...orderDisc, kind: e.target.value as "%" | "$" })}
              >
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
              {refund ? "Refund amount" : "Amount tendered"} (blank = {money(refund ? Math.max(0, refundLeft) : t.due)})
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
          {problem && tenders.length > 0 && (refund || t.due === 0) && (
            <p className="text-sm text-[var(--bad)]" role="alert">
              {problem}
            </p>
          )}
          {t.change > 0 && !problem && (
            <div className="flex justify-between text-lg font-bold text-[var(--ok)]">
              <span>Change</span>
              <span className="num">{money(t.change)}</span>
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={busy || !lines.length || Boolean(problem)}
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
