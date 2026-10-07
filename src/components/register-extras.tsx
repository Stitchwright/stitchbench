"use client";

// The register's quiet lines when a customer is chosen (shop-features-round-2-design.md section 1): "Jane has a special
// order waiting" with one tap to add it (the item at the order's price and what she paid coming off). Never a pop-up:
// lines under the search box.
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

export function CustomerExtrasLines({ customerId, inCart, onAdd }: { customerId: string | null; inCart: string[]; onAdd: (lines: ExtraLine[]) => void }) {
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
  const e = x && x.customerId === customerId ? x.extras : null;
  if (!customerId || !e) return null;
  const first = e.name.split(" ")[0];
  const orders = e.specialOrders.filter((o) => !inCart.includes(o.id));
  if (!orders.length) return null;
  return (
    <div className="card card-pad space-y-2 text-base" role="status">
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
