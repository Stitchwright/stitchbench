"use client";

// The register's "Special order" button (shop-features-round-2-design.md 1.2): the customer on the sale, the item (one
// of the shop's, found by number or words, or typed: "Tula Pink Untamed charm pack"), how many, the price, the deposit
// (the shop's default filled in) and when it's expected. One main button, "Take the order": the order is made and the
// deposit rung up as its own sale; the register then shows the receipt link and the slip to print.
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ClipboardList } from "lucide-react";
import { findItems } from "@/actions/register";
import { takeSpecialOrder } from "@/actions/special-orders";
import type { RegisterItem } from "@/lib/register-item";
import { money, toCents } from "@/lib/format";
import { saleTotals, TENDER_LABEL, type TenderMethod } from "@/lib/register-math";

export type SpecialOrderDefaults = { depositPct: number; depositCents: number; taxRatePct: number };
const METHODS: TenderMethod[] = ["CASH", "CARD", "CHECK", "CREDIT", "GIFT", "OTHER"];
const key = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export function SpecialOrderPanel({
  customerId,
  customerName,
  defaults,
  item: given,
  canPrice,
  onNeedCustomer,
  onDone,
  onClose,
}: {
  customerId: string | null;
  customerName: string | null;
  defaults: SpecialOrderDefaults;
  /** Opened from a "Coming soon: take a pre-order" search hit: that item. */
  item?: RegisterItem | null;
  /** An owner or admin may price something typed in words or change an item's price. */
  canPrice: boolean;
  onNeedCustomer: () => void;
  onDone: (r: { saleId: string; number: number } | null, order: { id: string; number: number }) => void;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(!!given);
  const [item, setItem] = useState<RegisterItem | null>(given ?? null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<RegisterItem[]>([]);
  const [words, setWords] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState(given?.priceCents != null ? (given.priceCents / 100).toFixed(2) : "");
  const [deposit, setDeposit] = useState("");
  const [expected, setExpected] = useState("");
  const [method, setMethod] = useState<TenderMethod>("CASH");
  const [card, setCard] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  // A new "Coming soon" item handed over: open on it (state adjusted while rendering, not in an effect).
  const [seen, setSeen] = useState(given ?? null);
  if (given && given !== seen) {
    setSeen(given);
    setItem(given);
    setOpen(true);
    setPrice(given.priceCents != null ? (given.priceCents / 100).toFixed(2) : "");
  }

  const qtyN = Number(qty) || 0;
  const priceCents = toCents(price) ?? 0;
  const owed = saleTotals([{ qty: qtyN, unitPriceCents: priceCents, taxable: true }], 0, defaults.taxRatePct).total;
  const suggested = defaults.depositCents > 0 ? Math.min(defaults.depositCents, owed) : defaults.depositPct > 0 ? Math.round((owed * defaults.depositPct) / 100) : 0;
  const depositCents = deposit === "" ? suggested : (toCents(deposit) ?? -1);

  async function take() {
    if (!customerId) {
      toast.error("Pick the customer first: a special order is for someone.");
      onNeedCustomer();
      return;
    }
    setBusy(true);
    try {
      const input = {
        customerId,
        partId: item?.id ?? null,
        description: item ? null : words,
        qty: qtyN,
        priceCents,
        depositCents,
        expectedOn: expected || null,
        tender: depositCents > 0 ? { method, amountCents: depositCents, cardNumber: card.trim() || null } : null,
      };
      const body = JSON.stringify(input);
      const k = sent?.startsWith(body) ? sent.slice(body.length) : key();
      setSent(body + k);
      const r = await takeSpecialOrder({ ...input, clientKey: k });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Special order ${r.orderNumber} taken${depositCents > 0 ? `, deposit ${money(depositCents)}` : ""}.`);
      setSent(null);
      setOpen(false);
      setItem(null);
      setWords("");
      setQty("1");
      setPrice("");
      setDeposit("");
      setExpected("");
      onDone(r.saleId && r.number ? { saleId: r.saleId, number: r.number } : null, { id: r.orderId!, number: r.orderNumber! });
    } catch {
      toast.error("It didn't go through (no connection?). Press Take the order again: an order that did save won't be made twice.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => (open ? (setOpen(false), onClose?.()) : setOpen(true))}>
        <ClipboardList size={14} aria-hidden /> Special order
      </button>
      {open && (
        <div className="card card-pad w-full space-y-4 text-base" role="region" aria-label="Special order">
          <h2 className="h2">Take a special order{customerName ? ` for ${customerName}` : ""}</h2>
          {!customerId && (
            <p className="text-base">
              Pick the customer on the right first.{" "}
              <button type="button" className="link" onClick={onNeedCustomer}>
                New customer
              </button>
            </p>
          )}
          {item ? (
            <p>
              <span className="mono">{item.partNumber}</span> {item.description}{" "}
              <button type="button" className="link text-sm" onClick={() => setItem(null)}>
                change
              </button>
            </p>
          ) : (
            <div className="space-y-2">
              <div className="field">
                <label htmlFor="so-find" className="label">
                  Find the item (number or words)
                </label>
                <input
                  id="so-find"
                  className="input text-base"
                  autoComplete="off"
                  value={q}
                  onChange={async (e) => {
                    const v = e.target.value;
                    setQ(v);
                    setHits(v.trim().length >= 2 ? (await findItems(v)).filter((x) => !x.stockUnitId).slice(0, 8) : []);
                  }}
                />
              </div>
              {hits.length > 0 && (
                <ul className="divide-y divide-line rounded border border-line text-sm">
                  {hits.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left hover:bg-surface-2"
                        onClick={() => {
                          setItem(h);
                          setHits([]);
                          setQ("");
                          setPrice(h.priceCents != null ? (h.priceCents / 100).toFixed(2) : "");
                        }}
                      >
                        <span>
                          <span className="mono">{h.partNumber}</span> {h.description}
                        </span>
                        <span className="num">{money(h.priceCents)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="field">
                <label htmlFor="so-words" className="label">
                  Or say what she wants
                </label>
                <input id="so-words" className="input text-base" placeholder="Tula Pink Untamed charm pack" value={words} onChange={(e) => setWords(e.target.value)} disabled={!canPrice} />
                {!canPrice && <p className="muted text-sm">Only an owner or admin can price something that isn&apos;t in your items.</p>}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="field">
              <label htmlFor="so-qty" className="label">
                How many{item?.unit === "yd" ? " (yards)" : ""}
              </label>
              <input id="so-qty" className="input num w-24 text-base" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="so-price" className="label">
                Price each
              </label>
              <input id="so-price" className="input num w-32 text-base" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} disabled={!canPrice && !!item && item.priceCents != null} />
            </div>
            <div className="field">
              <label htmlFor="so-deposit" className="label">
                Deposit
              </label>
              <input id="so-deposit" className="input num w-32 text-base" inputMode="decimal" placeholder={(suggested / 100).toFixed(2)} value={deposit} onChange={(e) => setDeposit(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="so-expected" className="label">
                Expected (if known)
              </label>
              <input id="so-expected" type="date" className="input text-base" value={expected} onChange={(e) => setExpected(e.target.value)} />
            </div>
          </div>
          {depositCents > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Deposit paid by">
                {METHODS.map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={method === m} className={`btn min-h-11 ${method === m ? "btn-primary" : ""}`} onClick={() => setMethod(m)}>
                    {TENDER_LABEL[m]}
                  </button>
                ))}
              </div>
              {(method === "GIFT" || method === "CREDIT") && (
                <div className="field max-w-xs">
                  <label htmlFor="so-card" className="label">
                    {method === "GIFT" ? "Gift card number" : "Store credit number (blank: hers)"}
                  </label>
                  <input id="so-card" className="input mono" autoComplete="off" value={card} onChange={(e) => setCard(e.target.value)} />
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span>
              {money(owed)} with tax
              {depositCents > 0 ? `; deposit ${money(depositCents)}, ${money(Math.max(0, owed - depositCents))} when it arrives` : "; no deposit"}
            </span>
            <button type="button" className="btn btn-primary min-h-11 text-base" disabled={busy || (!item && !words.trim()) || qtyN <= 0 || depositCents < 0} onClick={take}>
              {busy ? "Taking it..." : "Take the order"}
            </button>
          </div>
          <p className="muted text-sm">
            Every special order is under{" "}
            <Link href="/special-orders" className="link" target="_blank">
              Special orders
            </Link>
            .
          </p>
        </div>
      )}
    </>
  );
}
