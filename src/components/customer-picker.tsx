"use client";

import { useState } from "react";
import { findCustomers, type CustomerHit } from "@/actions/register";
import { NotifyByField } from "@/components/notify-by-field";

/**
 * The "Find the customer" box on check-in: a search of the shop's own retail customers as you type (10 at most),
 * instead of every customer on the shop being sent down for a <select>. Picking one fills the hidden customerId the
 * same way the old <select> did; leaving it blank means "new customer" (fill in the fields below), as before.
 * `prefix` names the fields `${prefix}customerId` / `${prefix}notifyBy`; with `notifyRequired`, a picked customer
 * who hasn't been asked how to be told gets the required "How should we tell them" radios under the pick.
 */
export function CustomerPicker({ initial, prefix = "", notifyRequired = false }: { initial: CustomerHit | null; prefix?: string; notifyRequired?: boolean }) {
  const [customer, setCustomer] = useState<CustomerHit | null>(initial);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CustomerHit[]>([]);
  // The search the hits answer, so "No customer matches" waits for the answer to what is typed.
  const [searched, setSearched] = useState("");
  const notAsked = !!customer && !((customer as { notifyBy?: string }).notifyBy ?? "");

  return (
    <div className="field sm:col-span-2">
      <label htmlFor="customer-search" className="label">
        Find the customer
      </label>
      <input type="hidden" name={`${prefix}customerId`} value={customer?.id ?? ""} />
      {customer ? (
        <>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>
              {customer.name}
              {customer.phone ? ` · ${customer.phone}` : ""}
            </span>
            <button type="button" className="link text-xs" onClick={() => setCustomer(null)}>
              change
            </button>
          </div>
          {notifyRequired && notAsked && <NotifyByField required id={`${prefix}notifyBy`} name={`${prefix}notifyBy`} />}
        </>
      ) : (
        <>
          <input
            id="customer-search"
            className="input"
            autoComplete="off"
            placeholder="Search name or phone, or leave blank for a new customer"
            value={q}
            onChange={async (e) => {
              const v = e.target.value;
              setQ(v);
              setHits(v.trim().length >= 2 ? await findCustomers(v) : []);
              setSearched(v.trim().length >= 2 ? v.trim() : "");
            }}
          />
          {searched && searched === q.trim() && hits.length === 0 && (
            <p className="text-sm">No customer matches &lsquo;{searched}&rsquo;. For a new customer, type their name in the next box.</p>
          )}
          {hits.length > 0 && (
            <ul className="divide-y divide-line rounded border border-line text-sm">
              {hits.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="w-full px-2 py-1 text-left hover:bg-surface-2"
                    onClick={() => {
                      setCustomer(c);
                      setQ("");
                      setHits([]);
                    }}
                  >
                    {c.name} <span className="muted">{c.phone}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
