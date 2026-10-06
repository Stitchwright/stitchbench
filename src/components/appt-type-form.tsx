"use client";
// An appointment type (scheduling-messaging-design.md 12.2): name, length, fee, how many at once, what it uses up, the
// bookable hours as 7 day rows, location, active, order.
import type { ActionResult } from "@/lib/action";
import { ActionForm, Submit } from "@/components/action-form";

export type ApptTypeDraft = {
  name: string;
  minutes: number;
  feeCents: number;
  hourlyCents?: number | null;
  needsCert?: boolean;
  taxable: boolean;
  capacity: number;
  resource: string | null;
  hours: { day: number; from: string; to: string }[];
  location: string | null;
  active: boolean;
  sortOrder: number;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children}
      {hint && <div className="muted mt-1 text-xs">{hint}</div>}
    </div>
  );
}

export function ApptTypeForm({ action, draft }: { action: (fd: FormData) => Promise<ActionResult>; draft: ApptTypeDraft | null }) {
  const p = draft ? "" : "new-";
  return (
    <ActionForm action={action} success="Saved" reset={!draft} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${p}name`} label="Name">
          <input id={`${p}name`} name="name" className="input" maxLength={80} required defaultValue={draft?.name ?? ""} placeholder="Longarm rental" />
        </Field>
        <Field id={`${p}minutes`} label="How long (minutes)">
          <input id={`${p}minutes`} name="minutes" className="input num" inputMode="numeric" defaultValue={String(draft?.minutes ?? 60)} />
        </Field>
        <Field id={`${p}fee`} label="Fee">
          <input id={`${p}fee`} name="fee" className="input num" inputMode="decimal" defaultValue={draft ? (draft.feeCents / 100).toFixed(2) : "0.00"} />
        </Field>
        <Field id={`${p}hourly`} label="By the hour (optional)" hint="A rental: dollars an hour. The fee is this x the hours booked, and the fee above is ignored.">
          <input id={`${p}hourly`} name="hourly" className="input num" inputMode="decimal" defaultValue={draft?.hourlyCents ? (draft.hourlyCents / 100).toFixed(2) : ""} placeholder="25.00" />
        </Field>
        <Field id={`${p}capacity`} label="How many at once" hint="Two longarms: 2.">
          <input id={`${p}capacity`} name="capacity" className="input num" inputMode="numeric" defaultValue={String(draft?.capacity ?? 1)} />
        </Field>
        <Field id={`${p}resource`} label="What it uses up (optional)" hint="Types naming the same thing share its capacity: a rental and a lesson both use the Longarm.">
          <input id={`${p}resource`} name="resource" className="input" maxLength={40} defaultValue={draft?.resource ?? ""} placeholder="Longarm" />
        </Field>
        <Field id={`${p}location`} label="Where (optional)">
          <input id={`${p}location`} name="location" className="input" maxLength={120} defaultValue={draft?.location ?? ""} />
        </Field>
      </div>
      <fieldset className="space-y-1">
        <legend className="label">Bookable hours (leave every day unticked for any time)</legend>
        {DAYS.map((d, i) => {
          const w = draft?.hours.find((h) => h.day === i);
          return (
            <div key={d} className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex w-32 items-center gap-2">
                <input type="checkbox" name={`day${i}`} className="check" defaultChecked={!!w} /> {d}
              </label>
              <input name={`from${i}`} type="time" className="input w-32" defaultValue={w?.from ?? "10:00"} aria-label={`${d} from`} />
              <span className="muted">to</span>
              <input name={`to${i}`} type="time" className="input w-32" defaultValue={w?.to ?? "17:00"} aria-label={`${d} to`} />
            </div>
          );
        })}
      </fieldset>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="taxable" className="check" defaultChecked={draft?.taxable ?? false} /> Taxable
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="needsCert" className="check" defaultChecked={draft?.needsCert ?? false} /> Certified customers only (not bookable online)
        </label>
        <label className="flex items-center gap-2">
          <input type="hidden" name="active" value="off" />
          <input type="checkbox" name="active" value="on" className="check" defaultChecked={draft?.active ?? true} /> Bookable now
        </label>
        <label className="flex items-center gap-2">
          Order <input name="sortOrder" className="input num w-20" inputMode="numeric" defaultValue={String(draft?.sortOrder ?? 0)} aria-label="Order" />
        </label>
      </div>
      <Submit className="btn btn-sm btn-primary">{draft ? "Save" : "Add this type"}</Submit>
    </ActionForm>
  );
}
