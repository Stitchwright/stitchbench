"use client";
// One purchase order line's back order (shop-features-round-2-design.md 4.4): "Back ordered" opens the day it's expected
// (optional) and Save; a marked line says "Back ordered, expected 20 Nov" with Change and "It came off back order".
import { useState } from "react";
import type { ActionResult } from "@/lib/action";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";

export function BackorderControl({
  mark,
  clear,
  backordered,
  expectedOn,
  words,
}: {
  mark: (fd: FormData) => Promise<ActionResult>;
  clear: () => Promise<ActionResult>;
  backordered: boolean;
  expectedOn: string | null;
  words: string;
}) {
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <ActionForm
        action={async (fd) => {
          // Saved: close the form so the line shows "Back ordered, expected ..." again.
          const r = await mark(fd);
          if (!r?.error) setOpen(false);
          return r;
        }}
        success="Saved"
        className="mt-1 flex flex-wrap items-end gap-2"
      >
        <div className="field">
          <label className="label text-sm">
            Expected (if they said)
            <input type="date" name="expectedOn" defaultValue={expectedOn ?? ""} className="input text-base" />
          </label>
        </div>
        <Submit className="btn btn-sm min-h-11">Save</Submit>
        <button type="button" className="link min-h-11 text-sm" onClick={() => setOpen(false)}>
          Close
        </button>
      </ActionForm>
    );
  if (backordered)
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
        <span className="pill tone-wait">{words}</span>
        <button type="button" className="link min-h-11" onClick={() => setOpen(true)}>
          Change
        </button>
        <ActionButton action={clear} className="link min-h-11" success="Taken off back order">
          It came off back order
        </ActionButton>
      </div>
    );
  return (
    <button type="button" className="btn btn-sm mt-1 min-h-11" onClick={() => setOpen(true)}>
      Back ordered
    </button>
  );
}
