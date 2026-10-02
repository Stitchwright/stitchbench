"use client";
// A shift (scheduling-messaging-design.md 12.4): who (a login, or "Someone else" by name), the date and times, a role
// and a note. Used to add one and, inside <details>, to change one.
import { useState } from "react";
import type { ActionResult } from "@/lib/action";
import { ActionForm, Submit } from "@/components/action-form";

export type ShiftDraft = { userId: string | null; name: string; date: string; start: string; end: string; role: string | null; note: string | null };

export function ShiftForm({
  action,
  users,
  names,
  draft,
  submitLabel,
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  users: { id: string; name: string }[];
  /** Names used before for people without a login (the datalist). */
  names: string[];
  draft: ShiftDraft | null;
  submitLabel: string;
}) {
  const [who, setWho] = useState<string>(draft?.userId ?? (draft?.name ? "other" : (users[0]?.id ?? "other")));
  const other = who === "other";
  const listId = `shift-names-${draft ? draft.date + draft.start : "new"}`;
  return (
    <ActionForm action={action} success="Saved" reset={!draft} className="flex flex-wrap items-end gap-2 text-sm">
      <div className="field">
        <label className="label" htmlFor={`${listId}-who`}>
          Who
        </label>
        <select id={`${listId}-who`} name="userId" className="select" value={other ? "" : who} onChange={(e) => setWho(e.target.value || "other")}>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
          <option value="">Someone else</option>
        </select>
      </div>
      {other && (
        <div className="field">
          <label className="label" htmlFor={`${listId}-name`}>
            Name
          </label>
          <input id={`${listId}-name`} name="name" className="input" maxLength={60} list={listId} defaultValue={draft?.userId ? "" : (draft?.name ?? "")} placeholder="Ann (Saturdays)" />
          <datalist id={listId}>
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>
      )}
      <div className="field">
        <label className="label" htmlFor={`${listId}-date`}>
          Date
        </label>
        <input id={`${listId}-date`} name="date" type="date" className="input" required defaultValue={draft?.date ?? ""} />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${listId}-start`}>
          From
        </label>
        <input id={`${listId}-start`} name="start" type="time" className="input" required defaultValue={draft?.start ?? "09:00"} />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${listId}-end`}>
          To
        </label>
        <input id={`${listId}-end`} name="end" type="time" className="input" required defaultValue={draft?.end ?? "17:00"} />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${listId}-role`}>
          Role
        </label>
        <input id={`${listId}-role`} name="role" className="input" maxLength={40} defaultValue={draft?.role ?? ""} placeholder="Counter" />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${listId}-note`}>
          Note
        </label>
        <input id={`${listId}-note`} name="note" className="input" maxLength={200} defaultValue={draft?.note ?? ""} />
      </div>
      <Submit className="btn btn-sm btn-primary">{submitLabel}</Submit>
    </ActionForm>
  );
}
