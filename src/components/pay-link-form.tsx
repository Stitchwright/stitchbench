"use client";
// "Send a pay link" (shop-features-round-2-design.md 1.3): the customer, what she's paying for (a line or more: what it
// is, the amount, taxed or not), an optional note, and how it goes. Sending is a money step that can't be taken back
// once she pays, so the button asks once in one plain sentence (the second tap sends).
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { CustomerHit } from "@/actions/register";
import { sendPayLink } from "@/actions/pay-links";
import { ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";

type Row = { what: string; amount: string; qty: string; taxed: boolean };
const EMPTY: Row = { what: "", amount: "", qty: "1", taxed: false };

const cents = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};

export function PayLinkForm({ customer, taxRatePct }: { customer: CustomerHit | null; taxRatePct: number }) {
  const [rows, setRows] = useState<Row[]>([EMPTY]);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);
  const set = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const subtotal = rows.reduce((a, r) => a + cents(r.amount) * (Number(r.qty) || 1), 0);
  const tax = Math.round(rows.reduce((a, r) => a + (r.taxed ? cents(r.amount) * (Number(r.qty) || 1) : 0), 0) * (taxRatePct / 100));
  const total = subtotal + tax;
  return (
    <ActionForm action={sendPayLink} reset className="card card-pad space-y-4">
      <h2 className="h2">Send a pay link</h2>
      <CustomerPicker initial={customer} />
      <fieldset className="space-y-3">
        <legend className="label">What she&apos;s paying for</legend>
        {rows.map((r, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem_5rem_auto] sm:items-end">
            <div className="field">
              <label htmlFor={`pl-what-${i}`} className="label">
                What it is
              </label>
              <input id={`pl-what-${i}`} name="what" className="input text-base" placeholder="Balance on the Tula Pink kit" value={r.what} onChange={(e) => set(i, { what: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`pl-amount-${i}`} className="label">
                Amount
              </label>
              <input id={`pl-amount-${i}`} name="amount" inputMode="decimal" className="input num text-base" placeholder="$0.00" value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`pl-qty-${i}`} className="label">
                How many
              </label>
              <input id={`pl-qty-${i}`} name="qty" inputMode="numeric" className="input num text-base" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} />
            </div>
            <label className="flex min-h-11 items-center gap-2 text-base">
              <input type="checkbox" name="taxed" value={String(i)} checked={r.taxed} onChange={(e) => set(i, { taxed: e.target.checked })} className="h-5 w-5" /> Charge sales tax
            </label>
          </div>
        ))}
        <button type="button" className="link text-base" onClick={() => setRows((r) => [...r, EMPTY])}>
          <Plus size={14} aria-hidden className="inline" /> Add a line
        </button>
      </fieldset>
      <details>
        <summary className="link cursor-pointer text-base">More choices</summary>
        <div className="mt-3 space-y-3">
          <div className="field">
            <label htmlFor="pl-note" className="label">
              A note for her (goes with the link)
            </label>
            <input id="pl-note" name="note" className="input text-base" maxLength={300} placeholder="Thanks for your order!" />
          </div>
          <fieldset className="space-y-1">
            <legend className="label">How it goes</legend>
            <label className="flex min-h-11 items-center gap-2 text-base">
              <input type="radio" name="send" value="usual" defaultChecked className="h-5 w-5" /> Text or email it her usual way
            </label>
            <label className="flex min-h-11 items-center gap-2 text-base">
              <input type="radio" name="send" value="none" className="h-5 w-5" /> Don&apos;t send it: I&apos;ll copy the link
            </label>
          </fieldset>
        </div>
      </details>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-base">
          Total <span className="num text-xl font-semibold">${(total / 100).toFixed(2)}</span>
          {tax > 0 && <span className="muted text-sm"> with ${(tax / 100).toFixed(2)} tax</span>}
        </span>
        {armed ? (
          <Submit className="btn btn-primary min-h-11 text-base">Tap again to send ${(total / 100).toFixed(2)}</Submit>
        ) : (
          <button type="button" className="btn btn-primary min-h-11 text-base" disabled={total <= 0} onClick={() => setArmed(true)}>
            Send the pay link
          </button>
        )}
      </div>
    </ActionForm>
  );
}
