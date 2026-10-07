"use client";

// The register's quiet lines for accessories that fit (shop-features-round-2-design.md 2.4): with a customer chosen,
// "3 items fit her Brother PE800" opens the list; with a machine for sale on the sale, "Goes with this machine" lists
// what fits it. Never a pop-up: a line under the search box, opened with one tap; each item has its own Add.
import { useEffect, useState } from "react";
import { fitsForCustomerNow, fitsForUnitsNow } from "@/actions/fits";
import type { MachineFits } from "@/lib/fits";
import type { RegisterItem } from "@/lib/register-item";
import { money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";

function FitList({ fits, title, onAdd }: { fits: MachineFits; title: string; onAdd: (it: RegisterItem) => void }) {
  const [open, setOpen] = useState(false);
  const n = fits.items.length;
  return (
    <div className="text-base">
      <button type="button" className="link min-h-11 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {title.replace("{n}", String(n)).replace("{items}", n === 1 ? "item fits" : "items fit")}
      </button>
      {open && (
        <ul className="mt-1 divide-y divide-line rounded border border-line">
          {fits.items.map((it) => (
            <li key={it.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="mono">{it.partNumber}</span> {it.description}
                <span className="muted text-sm">
                  {" "}
                  · {qtyText(it.qtyOnHand, it.unit)} on the shelf · {money(it.priceCents)}
                </span>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => onAdd(it)}>
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "3 items fit Jane's Brother PE800", one line a machine of hers that has something on the shelf. */
export function CustomerFits({ customerId, customerName, onAdd }: { customerId: string | null; customerName: string | null; onAdd: (it: RegisterItem) => void }) {
  const [fits, setFits] = useState<{ customerId: string; list: MachineFits[] } | null>(null);
  useEffect(() => {
    if (!customerId) return;
    let live = true;
    fitsForCustomerNow(customerId)
      .then((list) => live && setFits({ customerId, list }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [customerId]);
  if (!customerId || fits?.customerId !== customerId || !fits.list.length) return null;
  const who = customerName ? `${customerName.split(" ")[0]}'s` : "their";
  return (
    <div className="space-y-1" aria-label="What fits the customer's machines">
      {fits.list.map((f) => (
        <FitList key={f.machineId} fits={f} title={`{n} {items} ${who} ${f.label}`} onAdd={onAdd} />
      ))}
    </div>
  );
}

/** "Goes with this machine": for each machine for sale on the sale, what on the shelf fits it. */
export function GoesWith({ unitIds, onAdd }: { unitIds: string[]; onAdd: (it: RegisterItem) => void }) {
  const key = unitIds.join(",");
  const [fits, setFits] = useState<{ key: string; list: MachineFits[] } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    fitsForUnitsNow(key.split(","))
      .then((list) => live && setFits({ key, list }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key]);
  if (!key || fits?.key !== key) return null;
  const shown = fits.list.filter((f) => f.items.length);
  if (!shown.length) return null;
  return (
    <div className="space-y-1" aria-label="Goes with this machine">
      {shown.map((f) => (
        <FitList key={f.machineId} fits={f} title={`Goes with this ${f.label}: {n} {items} it`} onAdd={onAdd} />
      ))}
    </div>
  );
}
