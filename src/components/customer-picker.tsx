"use client";

import { useState } from "react";
import { findCustomers, type CustomerHit } from "@/actions/register";

/**
 * The "Existing customer" box on check-in: a search of the shop's own retail customers as you type (10 at most),
 * instead of every customer on the shop being sent down for a <select>. Picking one fills the hidden customerId the
 * same way the old <select> did; leaving it blank means "new customer" (fill in the fields below), as before.
 */
export function CustomerPicker({ initial }: { initial: CustomerHit | null }) {
  const [customer, setCustomer] = useState<CustomerHit | null>(initial);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CustomerHit[]>([]);

  return (
    <div className="field sm:col-span-2">
      <label htmlFor="customer-search" className="label">
        Existing customer
      </label>
      <input type="hidden" name="customerId" value={customer?.id ?? ""} />
      {customer ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>
            {customer.name}
            {customer.phone ? ` · ${customer.phone}` : ""}
          </span>
          <button type="button" className="link text-xs" onClick={() => setCustomer(null)}>
            change
          </button>
        </div>
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
            }}
          />
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
