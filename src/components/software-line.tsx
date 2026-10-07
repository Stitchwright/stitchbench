"use client";

// The register's software line (shop-features-round-2-design.md 2.5): scan or type the activation code, or "Add the code
// later" (it goes on the Codes to fill in list), or nothing when codes are on hand (the next one is used); the machine it
// is for, from the customer's machines; "Renew her licence" for a subscription she has. A return of activated software
// takes an owner's or admin's reason.
import { useEffect, useState } from "react";
import { softwareChoices } from "@/actions/software";
import type { SoftwareLineInput } from "@/lib/software";

export function SoftwareLineFields({
  partId,
  customerId,
  value,
  returning,
  canOverride,
  onChange,
}: {
  partId: string;
  customerId: string | null;
  value: SoftwareLineInput;
  returning: boolean;
  canOverride: boolean;
  onChange: (v: SoftwareLineInput) => void;
}) {
  const [choices, setChoices] = useState<{ key: string; onHand: number; machines: { id: string; label: string }[]; renewable: { id: string; label: string }[] } | null>(null);
  const key = `${partId}|${customerId ?? ""}`;
  useEffect(() => {
    if (returning) return;
    let live = true;
    softwareChoices(partId, customerId)
      .then((c) => live && setChoices({ key, ...c }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [partId, customerId, key, returning]);
  if (returning) {
    return canOverride ? (
      <div className="mt-1 text-sm">
        <label className="flex flex-col gap-1">
          <span className="muted">If it was activated: why the shop is taking it back (owner or admin)</span>
          <input className="input" value={value.returnReason ?? ""} maxLength={200} onChange={(e) => onChange({ ...value, returnReason: e.target.value })} />
        </label>
      </div>
    ) : null;
  }
  const c = choices?.key === key ? choices : null;
  const renewing = !!value.renewId;
  return (
    <div className="mt-1 space-y-1 text-sm">
      {c && c.renewable.length > 0 && (
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="check" checked={renewing} onChange={(e) => onChange({ ...value, renewId: e.target.checked ? c.renewable[0].id : null })} />
          Renew their subscription ({c.renewable[0].label})
        </label>
      )}
      {!renewing && (
        <>
          <label className="flex flex-col gap-1">
            <span className="muted">Activation code {c && c.onHand > 0 ? `(blank: the next of the ${c.onHand} on hand)` : "(scan or type it)"}</span>
            <input className="input mono" value={value.code ?? ""} maxLength={80} autoComplete="off" disabled={value.later} onChange={(e) => onChange({ ...value, code: e.target.value })} />
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" className="check" checked={!!value.later} onChange={(e) => onChange({ ...value, later: e.target.checked, code: e.target.checked ? "" : value.code })} />
            Add the code later
          </label>
        </>
      )}
      {c && c.machines.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="muted">For which machine (optional)</span>
          <select className="select" value={value.machineId ?? ""} onChange={(e) => onChange({ ...value, machineId: e.target.value || null })}>
            <option value="">Not saying</option>
            {c.machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
