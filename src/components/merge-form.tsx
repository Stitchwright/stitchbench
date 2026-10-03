"use client";
// The last step of a merge or a delete (src/components/merge-panel.tsx): type the record's name and the button works.
// The server checks the typed name too (src/lib/merge.ts).
import { useState } from "react";
import type { ActionResult } from "@/lib/action";
import { ActionForm } from "@/components/action-form";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function ConfirmForm({ id, action, word, label }: { id: string; action: (fd: FormData) => Promise<ActionResult>; word: string; label: string }) {
  const [typed, setTyped] = useState("");
  const ready = norm(typed) === norm(word);
  return (
    <ActionForm action={action} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="field">
        <label htmlFor={id} className="label">
          Type <span className="mono">{word.trim()}</span> to confirm
        </label>
        <input id={id} name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="input" />
      </div>
      <button type="submit" className="btn btn-danger" disabled={!ready}>
        {label}
      </button>
    </ActionForm>
  );
}
