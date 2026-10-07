"use client";
// The class form (scheduling-messaging-design.md 12.1): the class's details and, for a new class, its first meeting and
// how it repeats. The same meeting fields serve "Add meetings" on the class page (MeetingFields).
import { useState } from "react";
import type { ActionResult } from "@/lib/action";
import { ActionForm, Submit } from "@/components/action-form";
import { DraftFill } from "@/components/assistant/marketing-drafts";
import { EVENT_KINDS, choicesOf, optionsText } from "@/lib/events-math";

export type ClassDraft = {
  title: string;
  teacher: string | null;
  location: string | null;
  description: string | null;
  supplies: string | null;
  feeCents: number;
  taxable: boolean;
  seats: number;
  waitlist: boolean;
  remind: string;
  // Events (shop-features-round-2-design.md 4.5)
  kind?: string;
  earlyCents?: number | null;
  earlyUntil?: string | null;
  depositCents?: number | null;
  depositRefundable?: boolean;
  balanceDays?: number;
  choices?: unknown;
  doorCents?: number | null;
};

const dollars = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

/** The rooms or meals choice's options as typed ("Single +120, Double"). */
function optionsOf(choices: unknown, key: string): string {
  const ch = choicesOf(choices).list.find((c) => c.key === key);
  return ch ? optionsText(ch.options) : "";
}

/** A retreat's or event's extras (4.5), folded under More choices: early-bird, deposit and balance, rooms, meals, door. */
function EventFields({ draft, kind }: { draft: ClassDraft | null; kind: string }) {
  return (
    <details className="rounded border border-line p-3" open={!draft}>
      <summary className="link cursor-pointer text-base">More choices: early-bird price, deposit, rooms and meals, door price</summary>
      <div className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="ev-early" label="Early-bird price (optional)">
            <input id="ev-early" name="earlyFee" className="input num" inputMode="decimal" defaultValue={dollars(draft?.earlyCents)} placeholder="0.00" />
          </Field>
          <Field id="ev-early-until" label="Early-bird price until">
            <input id="ev-early-until" name="earlyUntil" type="date" className="input" defaultValue={draft?.earlyUntil ?? ""} />
          </Field>
          <Field id="ev-deposit" label="Deposit each (optional)" hint="Taken at sign-up; the rest is the balance.">
            <input id="ev-deposit" name="deposit" className="input num" inputMode="decimal" defaultValue={dollars(draft?.depositCents)} placeholder="150.00" />
          </Field>
          <Field id="ev-days" label="Balance due, days before the first day">
            <input id="ev-days" name="balanceDays" className="input num" inputMode="numeric" defaultValue={String(draft?.balanceDays ?? 60)} />
          </Field>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-base">
          <input type="checkbox" name="depositRefundable" className="check" defaultChecked={draft?.depositRefundable ?? false} /> The deposit can be refunded (otherwise the receipt says non-refundable)
        </label>
        {kind === "RETREAT" && (
          <>
            <Field id="ev-rooms" label="Rooms, with any extra price" hint='Like "Single +120, Double, Shared".'>
              <input id="ev-rooms" name="rooms" className="input" defaultValue={optionsOf(draft?.choices, "room")} placeholder="Single +120, Double, Shared" />
            </Field>
            <Field id="ev-meals" label="Meals, with any extra price" hint='Like "None, Lunches +45, All meals +90".'>
              <input id="ev-meals" name="meals" className="input" defaultValue={optionsOf(draft?.choices, "meals")} placeholder="None, Lunches +45, All meals +90" />
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-base">
              <input type="checkbox" name="askDietary" className="check" defaultChecked={choicesOf(draft?.choices).dietary} /> Ask about dietary needs
            </label>
          </>
        )}
        <Field id="ev-door" label="Price at the door (optional)" hint="For selling tickets on the day.">
          <input id="ev-door" name="doorFee" className="input num" inputMode="decimal" defaultValue={dollars(draft?.doorCents)} placeholder="0.00" />
        </Field>
      </div>
    </details>
  );
}

const REPEATS = [
  { key: "once", label: "Once" },
  { key: "weekly", label: "Every week" },
  { key: "biweekly", label: "Every 2 weeks" },
  { key: "monthly_weekday", label: "Monthly, same weekday (the 3rd Saturday)" },
  { key: "monthly_date", label: "Monthly, same date" },
] as const;

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

/** Date, start, end, repeat and count: a class's first meeting, or more meetings for one. */
export function MeetingFields({ prefix = "", defaults }: { prefix?: string; defaults?: { date?: string; start?: string; end?: string } }) {
  const [repeat, setRepeat] = useState<string>("once");
  const monthly = repeat === "monthly_weekday" || repeat === "monthly_date";
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field id={`${prefix}date`} label="Date">
        <input id={`${prefix}date`} name={`${prefix}date`} type="date" className="input" required defaultValue={defaults?.date ?? ""} />
      </Field>
      <Field id={`${prefix}start`} label="Starts">
        <input id={`${prefix}start`} name={`${prefix}start`} type="time" className="input" required defaultValue={defaults?.start ?? "18:00"} />
      </Field>
      <Field id={`${prefix}end`} label="Ends">
        <input id={`${prefix}end`} name={`${prefix}end`} type="time" className="input" required defaultValue={defaults?.end ?? "20:00"} />
      </Field>
      <Field id={`${prefix}repeat`} label="How often">
        <select id={`${prefix}repeat`} name="repeat" className="select" value={repeat} onChange={(e) => setRepeat(e.target.value)}>
          {REPEATS.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>
      {repeat !== "once" && (
        <Field id={`${prefix}count`} label="How many times" hint={monthly ? "1 to 24" : "1 to 52"}>
          <input id={`${prefix}count`} name="count" className="input num" inputMode="numeric" defaultValue="4" />
        </Field>
      )}
    </div>
  );
}

/**
 * `drafting`: the Assistant's "Draft it" for "About the class" (shop-features-round-2-design.md 5.2), when its marketing
 * drafts are on; the class's id for a saved class (its meetings go in too), null for a new one. `kind`: a new event's kind (4.5).
 */
export function ClassForm({
  action,
  draft,
  isNew,
  drafting,
  kind: startKind,
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  draft: ClassDraft | null;
  isNew: boolean;
  drafting?: { classId: string | null; unavailable?: string } | null;
  kind?: string;
}) {
  const [kind, setKind] = useState<string>(draft?.kind ?? startKind ?? "CLASS");
  const event = kind !== "CLASS";
  return (
    <ActionForm action={action} success={isNew ? undefined : "Saved"} className="space-y-4">
      <Field id="cl-kind" label="What is it?">
        <select id="cl-kind" name="kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(EVENT_KINDS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field id="cl-title" label={event ? "Name" : "Class name"}>
        <input id="cl-title" name="title" className="input" maxLength={120} required defaultValue={draft?.title ?? ""} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="cl-teacher" label="Teacher">
          <input id="cl-teacher" name="teacher" className="input" maxLength={80} defaultValue={draft?.teacher ?? ""} />
        </Field>
        <Field id="cl-location" label="Where">
          <input id="cl-location" name="location" className="input" maxLength={120} defaultValue={draft?.location ?? ""} placeholder="The shop classroom" />
        </Field>
        <Field id="cl-fee" label={event ? "Price" : "Fee"} hint={draft ? "Changing it never re-prices people already signed up." : undefined}>
          <input id="cl-fee" name="fee" className="input num" inputMode="decimal" defaultValue={draft ? (draft.feeCents / 100).toFixed(2) : "0.00"} />
        </Field>
        <Field id="cl-seats" label="Seats">
          <input id="cl-seats" name="seats" className="input num" inputMode="numeric" defaultValue={String(draft?.seats ?? 8)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="taxable" className="check" defaultChecked={draft?.taxable ?? false} /> Taxable
        </label>
        <label className="flex items-center gap-2">
          <input type="hidden" name="waitlist" value="off" />
          <input type="checkbox" name="waitlist" value="on" className="check" defaultChecked={draft?.waitlist ?? true} /> Keep a waiting list when it&apos;s full
        </label>
      </div>
      <Field id="cl-remind" label="Reminders the day before">
        <select id="cl-remind" name="remind" className="select" defaultValue={draft?.remind ?? "every"}>
          <option value="every">Before every meeting</option>
          <option value="first">Before the first meeting only</option>
          <option value="never">No reminders</option>
        </select>
      </Field>
      <Field id="cl-description" label="About the class" hint="Shown on the roster and the newsletter print.">
        <textarea id="cl-description" name="description" rows={3} maxLength={4000} className="input" defaultValue={draft?.description ?? ""} />
        {drafting && <DraftFill what={{ kind: "class", classId: drafting.classId, bodyId: "cl-description" }} unavailable={drafting.unavailable} />}
      </Field>
      <Field id="cl-supplies" label="What to bring" hint="Goes in the sign-up message and the reminders.">
        <textarea id="cl-supplies" name="supplies" rows={2} maxLength={4000} className="input" defaultValue={draft?.supplies ?? ""} />
      </Field>
      {event && <EventFields draft={draft} kind={kind} />}
      {isNew && (
        <fieldset className="space-y-2">
          <legend className="label">First meeting</legend>
          <MeetingFields />
        </fieldset>
      )}
      <Submit>{isNew ? (event ? "Create the event" : "Create the class") : "Save"}</Submit>
    </ActionForm>
  );
}
