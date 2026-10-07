"use client";

// An online order's label through Shippo (shop-features-round-2-design.md 9.5): the parcel's weight (the usual box's
// filled in), "Get rates", the cheapest few, and Buy (asked once: it costs the shop money). The tracking number lands on
// the order; print the label, pack, then Shipped.
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { buyLabel, labelRates } from "@/actions/shippo";
import { runAction } from "@/components/action-form";
import { money } from "@/lib/format";
import type { RateChoice } from "@/lib/shippo";

export function ShippoLabel({ orderId, weightOz, canBuy }: { orderId: string; weightOz: number; canBuy: boolean }) {
  const router = useRouter();
  const [oz, setOz] = useState(String(weightOz));
  const [rates, setRates] = useState<RateChoice[] | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const getRates = () =>
    start(async () => {
      const fd = new FormData();
      fd.set("weightOz", oz);
      const r = await runAction(() => labelRates(orderId, fd));
      if (r?.error) return void toast.error(r.error);
      setRates(JSON.parse(r?.shown ?? "[]"));
    });

  const buy = (rate: RateChoice) => {
    if (armed !== rate.id) return setArmed(rate.id);
    setArmed(null);
    start(async () => {
      const r = await runAction(() => buyLabel(orderId, rate.id));
      if (r?.error) return void toast.error(r.error);
      toast.success(r?.note ?? "Label bought.");
      router.refresh();
    });
  };

  return (
    <div className="space-y-2 rounded border border-line p-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="field">
          <label className="label" htmlFor={`oz-${orderId}`}>
            Weight (ounces)
          </label>
          <input id={`oz-${orderId}`} inputMode="decimal" className="input num w-24" value={oz} onChange={(e) => setOz(e.target.value)} />
        </div>
        <button type="button" className="btn btn-sm" disabled={pending} onClick={getRates}>
          {pending && !rates ? "Asking..." : "Get label rates"}
        </button>
      </div>
      {rates && (
        <ul className="space-y-1">
          {rates.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-base">
              <span>
                {r.carrier} {r.service}
                {r.days ? <span className="muted text-sm"> · about {r.days} days</span> : null}
              </span>
              {canBuy ? (
                <button type="button" className={`btn btn-sm ${armed === r.id ? "btn-primary" : ""}`} disabled={pending} onClick={() => buy(r)}>
                  {armed === r.id ? `Tap again: buy for ${money(r.cents)}` : `Buy ${money(r.cents)}`}
                </button>
              ) : (
                <span className="num">{money(r.cents)}</span>
              )}
            </li>
          ))}
          {!canBuy && <li className="muted text-sm">An owner or admin buys the label.</li>}
        </ul>
      )}
    </div>
  );
}
