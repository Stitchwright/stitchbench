"use client";

import { useState } from "react";
import { ActionForm, Submit } from "@/components/action-form";
import type { ActionResult } from "@/lib/action";

type C = {
  name: string;
  kind: "RETAIL" | "TRADE";
  phone: string | null;
  email: string | null;
  address: string | null;
  code: string | null;
  commissionPct: number | null;
  routeDay: string | null;
  notes: string | null;
};

export function CustomerForm({ action, customer, submitLabel }: { action: (fd: FormData) => Promise<ActionResult>; customer?: C; submitLabel: string }) {
  const [kind, setKind] = useState<C["kind"]>(customer?.kind ?? "RETAIL");
  return (
    <ActionForm action={action} success={customer ? "Saved" : undefined} className="grid-form">
      <div className="field">
        <label htmlFor="name" className="label">
          Name
        </label>
        <input id="name" name="name" required defaultValue={customer?.name} className="input" />
      </div>
      <div className="field">
        <label htmlFor="kind" className="label">
          Type
        </label>
        <select id="kind" name="kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as C["kind"])}>
          <option value="RETAIL">Retail customer</option>
          <option value="TRADE">Quilt shop / dealer account</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="phone" className="label">
          Phone
        </label>
        <input id="phone" name="phone" type="tel" defaultValue={customer?.phone ?? ""} className="input" />
      </div>
      <div className="field">
        <label htmlFor="email" className="label">
          Email
        </label>
        <input id="email" name="email" type="email" defaultValue={customer?.email ?? ""} className="input" />
      </div>
      <div className="field sm:col-span-2">
        <label htmlFor="address" className="label">
          Address
        </label>
        <input id="address" name="address" defaultValue={customer?.address ?? ""} className="input" />
      </div>
      {kind === "TRADE" && (
        <>
          <div className="field">
            <label htmlFor="code" className="label">
              Route code
            </label>
            <input id="code" name="code" defaultValue={customer?.code ?? ""} className="input mono" placeholder="QS1" />
          </div>
          <div className="field">
            <label htmlFor="commissionPct" className="label">
              Commission (% of service price)
            </label>
            <input id="commissionPct" name="commissionPct" inputMode="decimal" defaultValue={customer?.commissionPct ?? ""} className="input num" placeholder="10" />
          </div>
          <div className="field">
            <label htmlFor="routeDay" className="label">
              Route day
            </label>
            <input id="routeDay" name="routeDay" defaultValue={customer?.routeDay ?? ""} className="input" placeholder="Thursday" />
          </div>
        </>
      )}
      <div className="field sm:col-span-2">
        <label htmlFor="notes" className="label">
          Notes
        </label>
        <textarea id="notes" name="notes" rows={2} defaultValue={customer?.notes ?? ""} className="textarea" />
      </div>
      <div className="sm:col-span-2">
        <Submit>{submitLabel}</Submit>
      </div>
    </ActionForm>
  );
}
