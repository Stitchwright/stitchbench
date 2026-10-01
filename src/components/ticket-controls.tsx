"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import type { TicketStatus } from "@/generated/prisma/enums";
import { CLOSING_STATUSES, STATUS_LABEL, STATUS_ORDER } from "@/lib/constants";
import { fmtDateTime } from "@/lib/format";
import { setStatus, toggleChecklist } from "@/actions/tickets";
import { runAction } from "@/components/action-form";

/**
 * partnerOwns: a partner sewing shop's machine that hasn't been picked up. They mark it collected, not the bench.
 * order / labels: the statuses offered and their names (central vac installs use SITE_STATUS_ORDER / SITE_STATUS_LABEL).
 * closingOnly: the ticket's module has ended, so only the current status and the closing ones are offered.
 */
export function StatusSelect({
  ticketId,
  status,
  partnerOwns,
  order = STATUS_ORDER,
  labels = STATUS_LABEL,
  closingOnly = false,
}: {
  ticketId: string;
  status: TicketStatus;
  partnerOwns?: boolean;
  order?: TicketStatus[];
  labels?: Record<TicketStatus, string>;
  closingOnly?: boolean;
}) {
  const [pending, start] = useTransition();
  // The current status is always offered, even one this list doesn't usually show.
  const offered = order.includes(status) ? order : [status, ...order];
  const options = closingOnly ? offered.filter((s) => s === status || CLOSING_STATUSES.includes(s)) : offered;
  return (
    <div className="field">
      <label htmlFor="status" className="label">
        Status
      </label>
      <select
        id="status"
        className="select"
        defaultValue={status}
        disabled={pending}
        onChange={(e) => {
          const el = e.currentTarget;
          const next = el.value as TicketStatus;
          start(async () => {
            const r = await runAction(() => setStatus(ticketId, next));
            if (r?.error) {
              toast.error(r.error);
              el.value = status; // not saved: show what the ticket still says
            } else toast.success(`Status: ${labels[next]}`);
          });
        }}
      >
        {options.map((s) => (
          <option key={s} value={s} disabled={partnerOwns && s === "COLLECTED" && s !== status}>
            {labels[s]}
          </option>
        ))}
      </select>
      {closingOnly && <p className="muted mt-1 text-xs">Only closing it out is left: mark it picked up, returned unrepaired or abandoned.</p>}
      {partnerOwns && <p className="muted mt-1 text-xs">The partner shop marks it collected when their customer picks it up.</p>}
    </div>
  );
}

type Done = { done: boolean; by?: string; at?: string };

export function Checklist({
  ticketId,
  items,
  state,
  timeZone,
}: {
  ticketId: string;
  items: string[];
  state: Record<string, Done>;
  timeZone: string;
}) {
  const [pending, start] = useTransition();
  const doneCount = items.filter((i) => state[i]?.done).length;
  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded bg-surface-2" aria-hidden>
          <div className="h-full bg-navy" style={{ width: `${items.length ? (doneCount / items.length) * 100 : 0}%` }} />
        </div>
        <span className="num text-sm font-semibold">
          {doneCount}/{items.length} done
        </span>
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => {
          const s = state[item];
          const id = `chk-${i}`;
          return (
            <li key={item} className="flex items-start gap-3 rounded px-1 py-1.5 hover:bg-surface-2">
              <input
                id={id}
                type="checkbox"
                className="check mt-0.5"
                defaultChecked={!!s?.done}
                disabled={pending}
                onChange={(e) => {
                  const el = e.currentTarget;
                  const done = el.checked;
                  start(async () => {
                    const r = await runAction(() => toggleChecklist(ticketId, item, done));
                    if (r?.error) {
                      toast.error(r.error);
                      el.checked = !done;
                    }
                  });
                }}
              />
              <label htmlFor={id} className="flex-1 cursor-pointer">
                <span className={s?.done ? "text-ink" : ""}>{item}</span>
                {s?.done && (
                  <span className="muted block text-xs">
                    {s.by || "Someone"}, {fmtDateTime(s.at, timeZone)}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
