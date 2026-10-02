"use client";
// The booking form (scheduling-messaging-design.md 12.2): the type, then the next 7 days' free start times as buttons
// that fill the date and time, "Another time" inputs, the customer, staff, a ticket or tag, a note, tell. Admins can
// "Block this time" instead (a reason, no customer).
import { useState } from "react";
import type { ActionResult } from "@/lib/action";
import { ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import type { CustomerHit } from "@/actions/register";

export type ApptTypeOption = { id: string; name: string; minutes: number; feeText: string; hoursText: string; location: string | null };
export type FreeDay = { ymd: string; label: string; starts: { hm: string; label: string; free: number }[] };

export function AppointmentForm({
  action,
  types,
  free,
  typeId,
  date,
  start,
  customer,
  staff,
  admin,
  marketing,
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  types: ApptTypeOption[];
  /** The free times of the picked type (the server computed them for `typeId`). */
  free: FreeDay[];
  typeId: string;
  date: string;
  start: string;
  customer: CustomerHit | null;
  staff: { id: string; name: string }[];
  admin: boolean;
  marketing: boolean;
}) {
  const [picked, setPicked] = useState<{ date: string; start: string }>({ date, start });
  const [block, setBlock] = useState(false);
  const type = types.find((t) => t.id === typeId) ?? null;
  return (
    <ActionForm action={action} className="space-y-4">
      <div className="field">
        <label htmlFor="ap-type" className="label">
          What are they booking?
        </label>
        <select
          id="ap-type"
          name="typeId"
          className="select"
          defaultValue={typeId}
          onChange={(e) => {
            // The server works out the free times for the picked type: reload with it in the address.
            const u = new URL(window.location.href);
            u.searchParams.set("type", e.target.value);
            window.location.assign(u.toString());
          }}
        >
          <option value="">Pick one</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.minutes} min{t.feeText ? ` · ${t.feeText}` : ""}
            </option>
          ))}
        </select>
        {type && (
          <div className="muted mt-1 text-xs">
            Bookable {type.hoursText}
            {type.location ? ` · ${type.location}` : ""}
          </div>
        )}
      </div>

      {type && (
        <fieldset className="space-y-2">
          <legend className="label">Free times in the next 7 days</legend>
          {free.every((d) => d.starts.length === 0) ? (
            <p className="muted text-sm">Nothing free this week: pick another time below.</p>
          ) : (
            <div className="space-y-1 text-sm">
              {free.map((d) => (
                <div key={d.ymd} className="flex flex-wrap items-center gap-1">
                  <span className="w-24 shrink-0 font-semibold">{d.label}</span>
                  {d.starts.length === 0 && <span className="muted">full</span>}
                  {d.starts.map((s) => (
                    <button key={s.hm} type="button" className={`btn btn-sm ${picked.date === d.ymd && picked.start === s.hm ? "btn-primary" : ""}`} onClick={() => setPicked({ date: d.ymd, start: s.hm })} title={s.free > 1 ? `${s.free} free` : undefined}>
                      {s.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </fieldset>
      )}

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="label">Another time</legend>
        <div className="field">
          <label htmlFor="ap-date" className="label">
            Date
          </label>
          <input id="ap-date" name="date" type="date" className="input" required value={picked.date} onChange={(e) => setPicked({ ...picked, date: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="ap-start" className="label">
            Starts
          </label>
          <input id="ap-start" name="start" type="time" className="input" required value={picked.start} onChange={(e) => setPicked({ ...picked, start: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="ap-end" className="label">
            Ends (blank: the usual length)
          </label>
          <input id="ap-end" name="end" type="time" className="input" />
        </div>
      </fieldset>

      {admin && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="block" className="check" checked={block} onChange={(e) => setBlock(e.target.checked)} /> Block this time (no customer: maintenance, a day off)
        </label>
      )}

      {block ? (
        <div className="field">
          <label htmlFor="ap-title" className="label">
            Why
          </label>
          <input id="ap-title" name="title" className="input" maxLength={120} placeholder="Longarm maintenance" />
        </div>
      ) : (
        <>
          <CustomerPicker initial={customer} notifyRequired={false} />
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="field">
              <label htmlFor="customerName" className="label">
                New customer name
              </label>
              <input id="customerName" name="customerName" className="input" autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="customerPhone" className="label">
                Phone
              </label>
              <input id="customerPhone" name="customerPhone" type="tel" className="input" />
            </div>
            <div className="field">
              <label htmlFor="customerEmail" className="label">
                Email address
              </label>
              <input id="customerEmail" name="customerEmail" type="email" className="input" />
            </div>
          </div>
        </>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="field">
          <label htmlFor="ap-staff" className="label">
            With (staff)
          </label>
          <select id="ap-staff" name="staffId" className="select" defaultValue="">
            <option value="">Anyone</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {!block && (
          <div className="field">
            <label htmlFor="ap-ticket" className="label">
              Ticket # or tag # (optional)
            </label>
            <input id="ap-ticket" name="ticketNo" className="input" />
          </div>
        )}
        <div className="field">
          <label htmlFor="ap-note" className="label">
            Note
          </label>
          <input id="ap-note" name="note" className="input" maxLength={1000} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        {admin && (
          <label className="flex items-center gap-2">
            <input type="checkbox" name="outsideHours" className="check" /> Outside the usual hours
          </label>
        )}
        {marketing && !block && (
          <label className="flex items-center gap-2">
            <input type="checkbox" name="tell" className="check" defaultChecked /> Tell them (booking confirmation)
          </label>
        )}
      </div>
      <Submit>{block ? "Block this time" : "Book it"}</Submit>
    </ActionForm>
  );
}
