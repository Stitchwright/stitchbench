"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { placePartnerOrder } from "@/actions/partner-orders";
import { money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";
import type { CatalogItem } from "@/lib/partners";

/** The repair shop's catalog with a quantity box per item; the order goes to the repair shop. */
export function PartnerOrderForm({ linkId, items, kindLabel }: { linkId: string; items: CatalogItem[]; kindLabel: Record<string, string> }) {
  const [q, setQ] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((i) => words.every((w) => `${i.partNumber} ${i.description} ${i.brand ?? ""} ${i.kind}`.toLowerCase().includes(w)));
  const wanted = items.filter((i) => Number(qty[i.itemKey]) > 0);
  const total = wanted.reduce((a, i) => a + Math.round(Number(qty[i.itemKey]) * i.wholesaleCents), 0);

  return (
    <div className="space-y-3">
      <div className="field max-w-md">
        <label htmlFor="cat-q" className="label">
          Search the catalog
        </label>
        <input id="cat-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="card scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Type</th>
              <th className="text-right">Your price</th>
              <th className="text-right">Suggested retail</th>
              <th className="text-right">They have</th>
              <th className="w-24">Qty</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 500).map((i) => (
              <tr key={i.itemKey}>
                <td>
                  <span className="mono">{i.partNumber}</span> {i.description}
                  {i.brand && <span className="muted"> · {i.brand}</span>}
                </td>
                <td className="text-xs">{kindLabel[i.kind] ?? i.kind}</td>
                <td className="num text-right">
                  {money(i.wholesaleCents)}
                  {i.unit === "yd" ? "/yd" : ""}
                </td>
                <td className="num text-right">{money(i.retailCents)}</td>
                <td className="num text-right">{i.inStock > 0 ? qtyText(i.inStock, i.unit) : <span className="pill tone-wait">out</span>}</td>
                <td>
                  <input
                    aria-label={`Quantity of ${i.partNumber}`}
                    inputMode="decimal"
                    className="input num"
                    value={qty[i.itemKey] ?? ""}
                    onChange={(e) => setQty({ ...qty, [i.itemKey]: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card card-pad flex flex-wrap items-end gap-3">
        <div className="field min-w-64 flex-1">
          <label htmlFor="order-note" className="label">
            Note for the repair shop
          </label>
          <input id="order-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bring it on Tuesday's route" />
        </div>
        <div className="text-sm">
          {wanted.length} items · <strong className="num">{money(total)}</strong>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !wanted.length}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await placePartnerOrder(
                linkId,
                wanted.map((i) => ({ itemKey: i.itemKey, qty: Number(qty[i.itemKey]) })),
                note || null,
              );
              if ("error" in r) toast.error(r.error);
              else {
                toast.success("Order sent");
                router.push(`/partners/${linkId}/orders/${r.id}`);
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          Send order
        </button>
      </div>
    </div>
  );
}
