"use client";

import { useEffect, useRef, useState } from "react";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { addOrderLine, cancelOrder, closeOrder, findFabricItems, receiveOrder, saveOrder, saveSupplier, sendOrder, startOrder } from "@/actions/fabric-orders";

/** A supplier's figures: its own lead time (blank: the shop's), minimum order and the address orders go to. */
export function SupplierForm({ name, leadDays, minOrder, orderEmail, placeholderLead }: { name: string; leadDays: number | null; minOrder: string; orderEmail: string | null; placeholderLead: number }) {
  return (
    <ActionForm action={saveSupplier} success="Saved" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="name" value={name} />
      <div className="field">
        <label className="label" htmlFor={`lead-${name}`}>
          Lead time (days)
        </label>
        <input id={`lead-${name}`} name="leadDays" defaultValue={leadDays ?? ""} placeholder={String(placeholderLead)} inputMode="numeric" className="input num w-24" />
      </div>
      <div className="field">
        <label className="label" htmlFor={`min-${name}`}>
          Minimum order ($)
        </label>
        <input id={`min-${name}`} name="minOrder" defaultValue={minOrder} inputMode="decimal" className="input num w-28" />
      </div>
      <div className="field min-w-[12rem] flex-1">
        <label className="label" htmlFor={`mail-${name}`}>
          Order email
        </label>
        <input id={`mail-${name}`} name="orderEmail" type="email" defaultValue={orderEmail ?? ""} className="input" autoComplete="off" />
      </div>
      <Submit className="btn btn-sm">Save</Submit>
    </ActionForm>
  );
}

export function NewOrderForm({ suppliers }: { suppliers: string[] }) {
  return (
    <ActionForm action={startOrder} className="flex flex-wrap items-end gap-2">
      <div className="field">
        <label className="label" htmlFor="new-order-supplier">
          Start an order by hand: supplier
        </label>
        <input id="new-order-supplier" name="supplier" list="po-suppliers" className="input" autoComplete="off" required />
        <datalist id="po-suppliers">
          {suppliers.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      <Submit className="btn btn-sm">Start order</Submit>
    </ActionForm>
  );
}

export type EditLine = { id: string; itemNumber: string; description: string; unit: "YD" | "BOLT"; qty: number; costDollars: string; yardsText: string };

/** A draft's lines (amount, yards or bolts, cost a yard, remove) and its note, saved together. */
export function OrderEditForm({ orderId, lines, note }: { orderId: string; lines: EditLine[]; note: string }) {
  return (
    <ActionForm action={saveOrder.bind(null, orderId)} success="Saved" className="space-y-3">
      {lines.length === 0 ? (
        <p className="muted text-sm">No lines yet. Add a fabric below, or tick rows on the Reorder tab.</p>
      ) : (
        <ul className="divide-y divide-line">
          {lines.map((l) => (
            <li key={l.id} className="flex flex-wrap items-end gap-3 py-2">
              <div className="min-w-[10rem] flex-1">
                <div className="mono text-sm">{l.itemNumber}</div>
                <div className="muted text-xs">{l.description}</div>
                <div className="muted text-xs">{l.yardsText}</div>
              </div>
              <div className="field">
                <label className="label" htmlFor={`qty-${l.id}`}>
                  Amount
                </label>
                <input id={`qty-${l.id}`} name={`qty.${l.id}`} defaultValue={l.qty} inputMode="decimal" className="input num w-24" />
              </div>
              <div className="field">
                <label className="label" htmlFor={`unit-${l.id}`}>
                  In
                </label>
                <select id={`unit-${l.id}`} name={`unit.${l.id}`} defaultValue={l.unit} className="input">
                  <option value="BOLT">bolts</option>
                  <option value="YD">yards</option>
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor={`cost-${l.id}`}>
                  Cost a yard ($)
                </label>
                <input id={`cost-${l.id}`} name={`cost.${l.id}`} defaultValue={l.costDollars} inputMode="decimal" className="input num w-24" />
              </div>
              <label className="flex items-center gap-1 pb-2 text-sm">
                <input type="checkbox" name={`remove.${l.id}`} className="check" /> Remove
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="field">
        <label className="label" htmlFor="po-note">
          Note to the supplier (printed and emailed with the order)
        </label>
        <textarea id="po-note" name="note" defaultValue={note} rows={2} maxLength={1000} className="input" />
      </div>
      <Submit>Save changes</Submit>
    </ActionForm>
  );
}

/** "Add a line": the maker's item number (suggestions from the shop's own fabric), an amount, yards or bolts. */
export function AddLineForm({ orderId }: { orderId: string }) {
  const [options, setOptions] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const asked = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  function typed(value: string) {
    clearTimeout(timer.current);
    if (value.includes(" | ")) return;
    if (value.trim().length < 2) {
      setOptions([]);
      return;
    }
    const mine = ++asked.current;
    timer.current = setTimeout(async () => {
      try {
        const found = await findFabricItems(value);
        if (mine === asked.current) setOptions(found);
      } catch {
        // No suggestions this time; a number typed in full still works.
      }
    }, 250);
  }
  return (
    <ActionForm action={addOrderLine.bind(null, orderId)} reset className="flex flex-wrap items-end gap-2">
      <div className="field min-w-[12rem] flex-1">
        <label className="label" htmlFor="po-item">
          Add a fabric: the maker&apos;s item number
        </label>
        <input id="po-item" name="itemNumber" list="po-items" className="input mono" autoComplete="off" onChange={(e) => typed(e.currentTarget.value)} required />
        <datalist id="po-items">
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </div>
      <div className="field">
        <label className="label" htmlFor="po-qty">
          Amount
        </label>
        <input id="po-qty" name="qty" inputMode="decimal" className="input num w-24" required />
      </div>
      <div className="field">
        <label className="label" htmlFor="po-unit">
          In
        </label>
        <select id="po-unit" name="unit" className="input" defaultValue="BOLT">
          <option value="BOLT">bolts</option>
          <option value="YD">yards</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="po-cost">
          Cost a yard ($, blank: the item&apos;s)
        </label>
        <input id="po-cost" name="cost" inputMode="decimal" className="input num w-24" />
      </div>
      <Submit className="btn btn-sm">Add line</Submit>
    </ActionForm>
  );
}

export type ReceiveLine = { id: string; itemNumber: string; description: string; outstanding: number; text: string };

/** Receive: the yards that came on each line (prefilled with what is outstanding; blank skips a line). */
export function ReceiveForm({ orderId, lines, partly }: { orderId: string; lines: ReceiveLine[]; partly: boolean }) {
  return (
    <ActionForm action={receiveOrder.bind(null, orderId)} className="space-y-3">
      <ul className="divide-y divide-line">
        {lines.map((l) => (
          <li key={l.id} className="flex flex-wrap items-end gap-3 py-2">
            <div className="min-w-[10rem] flex-1">
              <div className="mono text-sm">{l.itemNumber}</div>
              <div className="muted text-xs">{l.description}</div>
              <div className="muted text-xs">{l.text}</div>
            </div>
            <div className="field">
              <label className="label" htmlFor={`got-${l.id}`}>
                Yards that came
              </label>
              <input id={`got-${l.id}`} name={`yards.${l.id}`} defaultValue={l.outstanding > 0 ? l.outstanding : ""} inputMode="decimal" className="input num w-28" />
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Submit>Receive these yards</Submit>
        {partly && (
          <ActionButton action={closeOrder.bind(null, orderId)} className="btn" confirm="Tap again: the rest isn't coming">
            Close order (the rest isn&apos;t coming)
          </ActionButton>
        )}
      </div>
    </ActionForm>
  );
}

/** Send uses the supplier's connector; "Mark sent by hand" only records it (the shop emails, prints or phones it itself). */
export function SendButton({ orderId, label }: { orderId: string; label: string }) {
  return (
    <>
      <ActionButton action={sendOrder.bind(null, orderId, false)} className="btn btn-primary">
        {label}
      </ActionButton>
      <ActionButton action={sendOrder.bind(null, orderId, true)} className="btn" confirm="Tap again: mark it sent without sending">
        Mark sent by hand
      </ActionButton>
    </>
  );
}

export function CancelOrderButton({ orderId }: { orderId: string }) {
  return (
    <ActionButton action={cancelOrder.bind(null, orderId)} className="btn" confirm="Tap again to cancel the order">
      Cancel order
    </ActionButton>
  );
}
