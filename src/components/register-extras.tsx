"use client";

// The register's quiet lines when a customer is chosen (shop-features-round-2-design.md section 1): "Jane has a special
// order waiting" with one tap to add it (the item at the order's price and what she paid coming off); her price group
// ("Guild 10% on her items") and "Club card ends 3 Nov: renew?" with one tap. Never a pop-up: lines under the search box.
import { useEffect, useState } from "react";
import { customerExtras } from "@/actions/register-extras";
import type { CustomerExtras, WaitingOrder } from "@/lib/register-extras";
import { money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";

export type ExtraLine = {
  partId?: string;
  partNumber?: string;
  description: string;
  unit: string | null;
  qty: number;
  unitPriceCents: number;
  taxable: boolean;
  kind?: string;
  specialOrderId?: string;
  depositUsed?: boolean;
};

/** The lines a special order adds: the item at the order's price, and what was paid toward it coming off. */
export function orderLines(o: WaitingOrder): ExtraLine[] {
  return [
    { partId: o.partId ?? undefined, partNumber: o.partNumber ?? undefined, description: `${o.description} (special order ${o.number})`, unit: o.unit, qty: o.qty, unitPriceCents: o.priceCents, taxable: true, specialOrderId: o.id },
    ...(o.paidCents > 0 ? [{ description: `Special order ${o.number}: paid before`, unit: null, qty: -1, unitPriceCents: o.paidCents, taxable: false, specialOrderId: o.id, depositUsed: true }] : []),
  ];
}

/** The chosen customer's extras, read once per customer (null while none is chosen or it is loading). */
export function useCustomerExtras(customerId: string | null): CustomerExtras | null {
  const [x, setX] = useState<{ customerId: string; extras: CustomerExtras | null } | null>(null);
  useEffect(() => {
    if (!customerId) return;
    let live = true;
    customerExtras(customerId)
      .then((extras) => live && setX({ customerId, extras }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [customerId]);
  return x && x.customerId === customerId ? x.extras : null;
}

const fmtDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

export function CustomerExtrasLines({ extras: e, inCart, onAdd }: { extras: CustomerExtras | null; inCart: string[]; onAdd: (lines: ExtraLine[]) => void }) {
  if (!e) return null;
  const first = e.name.split(" ")[0];
  const orders = e.specialOrders.filter((o) => !inCart.includes(o.id));
  const g = e.group;
  const renew = g?.renew && !inCart.includes(`member:${g.renew.partId}`) ? g.renew : null;
  if (!orders.length && !g && !e.lifetime.length) return null;
  return (
    <div className="card card-pad space-y-2 text-base" role="status">
      {g && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            <span className={`pill mr-1 ${g.inForce ? "tone-ready" : "tone-neutral"}`}>{g.name}</span>
            {g.inForce ? `${first} gets ${g.useWholesale ? "the wholesale price" : `${g.pctOff}% off`}${g.kinds.length ? " on some items" : ""}` : `${first}'s ${g.name} ended`}
            {g.until ? ` (${g.inForce ? "until" : "on"} ${fmtDay(g.until)})` : ""}.
            {g.endsSoon && renew ? " Renew?" : ""}
          </span>
          {g.endsSoon && renew && (
            <button
              type="button"
              className="btn min-h-11"
              onClick={() => onAdd([{ partId: renew.partId, description: renew.description, unit: null, qty: 1, unitPriceCents: renew.priceCents ?? 0, taxable: false, kind: "MEMBERSHIP" }])}
            >
              Renew {renew.priceCents != null ? money(renew.priceCents) : ""}
            </button>
          )}
        </div>
      )}
      {e.lifetime.length > 0 && (
        <p className="muted text-sm">
          Lifetime {e.lifetime.map((l) => `${l.pctOff}%`).join(", ")} off supplies for {e.lifetime.length === 1 ? "the machine" : "the machines"} she bought here (pick the supply for her machine).
        </p>
      )}
      {orders.map((o) => (
        <div key={o.id} className="flex flex-wrap items-center justify-between gap-2">
          <span>
            <span className="pill tone-ready mr-1">Special order waiting</span> {first}&apos;s {o.description}
            {o.qty !== 1 ? ` x ${qtyText(o.qty, o.unit)}` : ""} ({money(o.priceCents)} each{o.paidCents > 0 ? `, ${money(o.paidCents)} paid` : ""})
          </span>
          <button type="button" className="btn btn-primary min-h-11" onClick={() => onAdd(orderLines(o))}>
            Add it
          </button>
        </div>
      ))}
    </div>
  );
}
