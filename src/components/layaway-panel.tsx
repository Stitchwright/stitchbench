"use client";

// The register's "Layaway" button (tax-machine-sales-layaway-design.md section 4): hold the items on the sale for the
// customer and take the deposit, or take a payment on one of their layaways, or pick one up (the rest paid, the items
// sold today). Each rings up its own sale through the server; the register then shows the receipt link.
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PiggyBank } from "lucide-react";
import { openLayaways, payLayaway, pickUpLayaway, startLayaway } from "@/actions/layaway";
import { money, toCents } from "@/lib/format";
import { dueByOf, EVERY_LABEL, isEvery, layawayPlan, LAYAWAY_EVERY, minDeposit, type LayawayEvery } from "@/lib/layaway-math";
import { TENDER_LABEL, type Tender, type TenderMethod } from "@/lib/register-math";

export type LayawayDefaults = { depositPct: number; days: number; every: LayawayEvery; today: string };
type CartItem = { partId?: string; stockUnitId?: string; description: string; qty: number; unitPriceCents: number; discountCents: number };
type Open = Awaited<ReturnType<typeof openLayaways>>[number];

const METHODS: TenderMethod[] = ["CASH", "CARD", "CHECK", "CREDIT", "GIFT", "OTHER"];
const key = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const fmtDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

/** How they pay: the method, and the card's number for a gift card or store credit. */
function PayBy({ value, onChange, idPrefix }: { value: { method: TenderMethod; card: string }; onChange: (v: { method: TenderMethod; card: string }) => void; idPrefix: string }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Paid by">
        {METHODS.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={value.method === m} className={`btn ${value.method === m ? "btn-primary" : ""}`} onClick={() => onChange({ ...value, method: m })}>
            {TENDER_LABEL[m]}
          </button>
        ))}
      </div>
      {(value.method === "GIFT" || value.method === "CREDIT") && (
        <div className="field max-w-xs">
          <label htmlFor={`${idPrefix}-card`} className="label">
            {value.method === "GIFT" ? "Gift card number" : "Store credit number (blank: the customer's own)"}
          </label>
          <input id={`${idPrefix}-card`} className="input mono" autoComplete="off" value={value.card} onChange={(e) => onChange({ ...value, card: e.target.value })} />
        </div>
      )}
    </div>
  );
}

const tenderOf = (p: { method: TenderMethod; card: string }, amountCents: number): Tender => ({ method: p.method, amountCents, cardNumber: p.card.trim() || null });

export function LayawayPanel({
  customerId,
  customerName,
  cart,
  priceCents,
  totalCents,
  defaults,
  onNeedCustomer,
  onDone,
}: {
  customerId: string | null;
  customerName: string | null;
  cart: CartItem[];
  /** The cart's items after their discounts, and with today's tax. */
  priceCents: number;
  totalCents: number;
  defaults: LayawayDefaults;
  onNeedCustomer: () => void;
  onDone: (r: { saleId: string; number: number }, startedId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Open[] | null>(null);
  const least = minDeposit(priceCents, defaults.depositPct);
  const [deposit, setDeposit] = useState("");
  const [every, setEvery] = useState<LayawayEvery>(defaults.every);
  const [days, setDays] = useState(String(defaults.days));
  const [pay, setPay] = useState({ method: "CASH" as TenderMethod, card: "" });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState<{ key: string; sent: string } | null>(null);
  const items = cart.filter((l) => (l.partId || l.stockUnitId) && l.qty > 0);
  const others = cart.length - items.length;
  const depositCents = deposit === "" ? least : (toCents(deposit) ?? -1);
  const term = Number(days) >= 7 && Number(days) <= 730 ? Math.round(Number(days)) : defaults.days;
  const dueBy = dueByOf(defaults.today, term);
  const plan = depositCents >= 0 ? layawayPlan(defaults.today, dueBy, every, totalCents - depositCents) : [];

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && (!cart.length || others > 0 || !items.length)) {
      try {
        setList(await openLayaways(customerId));
      } catch {
        toast.error("Couldn't load the layaways. Check the connection, then try again.");
      }
    }
  }

  /** The same request sent again (a lost answer) keeps its key, so it isn't rung up twice. */
  function keyFor(what: unknown) {
    const sent = JSON.stringify(what);
    if (sending?.sent === sent) return sending.key;
    const k = key();
    setSending({ key: k, sent });
    return k;
  }

  async function run(fn: () => Promise<{ saleId: string; number: number; layawayId?: string; layawayNumber?: number } | { error: string }>, what: string) {
    setBusy(true);
    try {
      const r = await fn();
      if ("error" in r) return toast.error(r.error);
      setSending(null);
      setOpen(false);
      setList(null);
      setAmounts({});
      toast.success(r.layawayNumber ? `Layaway #${r.layawayNumber} started. Print the terms for them to sign.` : `${what}: sale #${r.number}`);
      onDone(r, r.layawayId);
    } catch {
      toast.error("That didn't go through (no connection, or a problem on the server). Try again: it won't be taken twice.");
    } finally {
      setBusy(false);
    }
  }

  function start() {
    if (depositCents < 0) return toast.error("Enter the deposit, like 120.00.");
    const input = {
      customerId,
      lines: items.map((l) => ({ partId: l.partId ?? null, stockUnitId: l.stockUnitId ?? null, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents })),
      depositCents,
      every,
      days: term,
      tender: tenderOf(pay, depositCents),
    };
    run(() => startLayaway({ ...input, clientKey: keyFor(input) }), "Layaway");
  }

  const starting = items.length > 0 && others === 0;
  return (
    <>
      <button type="button" className={`btn btn-sm ${open ? "btn-primary" : ""}`} aria-expanded={open} onClick={toggle}>
        <PiggyBank size={14} aria-hidden /> Layaway
      </button>
      {open && (
        <div className="card card-pad w-full space-y-4 text-base" aria-label="Layaway">
          {starting && !customerId ? (
            <p className="flex flex-wrap items-center gap-2">
              Pick or add the customer first: a layaway is held for someone.
              <button type="button" className="btn btn-sm" onClick={onNeedCustomer}>
                New customer
              </button>
            </p>
          ) : starting ? (
            <div className="space-y-3">
              <h3 className="text-lg font-semibold">Hold these items for {customerName}</h3>
              <p className="muted text-sm">
                {money(totalCents)}{" "}with today&apos;s tax. The tax is worked out again on the day they pick it up.
              </p>
              <div className="grid-form">
                <div className="field">
                  <label htmlFor="lw-deposit" className="label">
                    Deposit today
                  </label>
                  <input id="lw-deposit" className="input num text-lg" inputMode="decimal" placeholder={(least / 100).toFixed(2)} value={deposit} onChange={(e) => setDeposit(e.target.value)} aria-describedby="lw-deposit-hint" />
                  <p id="lw-deposit-hint" className="muted text-xs">
                    At least {money(least)} ({defaults.depositPct}%).
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="lw-every" className="label">
                    They pay
                  </label>
                  <select id="lw-every" className="select" value={every} onChange={(e) => isEvery(e.target.value) && setEvery(e.target.value)}>
                    {LAYAWAY_EVERY.map((e) => (
                      <option key={e} value={e}>
                        {EVERY_LABEL[e]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <details>
                <summary className="link cursor-pointer text-sm">More options</summary>
                <div className="field mt-2 max-w-xs">
                  <label htmlFor="lw-days" className="label">
                    Days to pay it off
                  </label>
                  <input id="lw-days" className="input num" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
                </div>
              </details>
              {plan.length > 0 && (
                <div>
                  <p className="text-sm font-semibold">Their payments (paid off by {fmtDay(dueBy)})</p>
                  <ul className="text-sm">
                    {plan.map((p) => (
                      <li key={p.due} className="flex max-w-xs justify-between">
                        <span>{fmtDay(p.due)}</span>
                        <span className="num">{money(p.cents)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <PayBy value={pay} onChange={setPay} idPrefix="lw-start" />
              <button type="button" className="btn btn-primary btn-lg" disabled={busy || depositCents < 0} onClick={start}>
                {busy ? "Working..." : `Start layaway and take ${money(Math.max(0, depositCents))}`}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {others > 0 && items.length > 0 && <p className="muted text-sm">A layaway holds stock items and machines for sale only. Take the other lines off this sale to start one.</p>}
              {!cart.length && <p className="muted text-sm">To start a layaway, ring up the items first. Or take a payment on one below.</p>}
              {list == null ? (
                <p className="muted">Loading...</p>
              ) : list.length === 0 ? (
                <p className="muted">{customerId ? "This customer has no layaway being paid for." : "No layaways are being paid for."}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {list.map((l) => {
                    const typed = amounts[l.id] ?? "";
                    const amount = typed === "" ? (l.behindCents || l.nextCents) : (toCents(typed) ?? -1);
                    return (
                      <li key={l.id} className="space-y-2 py-3">
                        <p>
                          <Link href={`/layaways/${l.id}`} className="link font-semibold" target="_blank">
                            Layaway #{l.number}
                          </Link>{" "}
                          {l.customer} · {l.items}
                        </p>
                        <p className="text-sm">
                          Paid {money(l.paidCents)} · {money(l.leftCents)} left
                          {l.behindCents > 0 && <span className="pill tone-wait ml-2">{money(l.behindCents)} behind</span>}
                        </p>
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="field">
                            <label htmlFor={`lw-amt-${l.id}`} className="label">
                              Payment
                            </label>
                            <input id={`lw-amt-${l.id}`} className="input num w-32" inputMode="decimal" placeholder={(amount / 100).toFixed(2)} value={typed} onChange={(e) => setAmounts({ ...amounts, [l.id]: e.target.value })} />
                          </div>
                          <button type="button" className="btn btn-primary" disabled={busy || amount <= 0} onClick={() => run(() => payLayaway(l.id, amount, tenderOf(pay, amount), keyFor({ pay: l.id, amount, pay2: pay })), "Payment taken")}>
                            Take {amount > 0 ? money(amount) : "payment"}
                          </button>
                          <button type="button" className="btn" disabled={busy} onClick={() => run(() => pickUpLayaway(l.id, l.pickUpCents > 0 ? tenderOf(pay, l.pickUpCents) : null, keyFor({ pickup: l.id, pay })), "Picked up")}>
                            Pick up{l.pickUpCents > 0 ? ` (${money(l.pickUpCents)} to pay)` : ""}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {list && list.length > 0 && <PayBy value={pay} onChange={setPay} idPrefix="lw-pay" />}
            </div>
          )}
        </div>
      )}
    </>
  );
}
