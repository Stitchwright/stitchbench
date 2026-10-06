"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { draftTicketText, markAssistantCall } from "@/actions/assistant";
import { runAction } from "@/components/action-form";

export type Latest = { id: string; text: string; accepted: boolean | null } | null;

/**
 * One "Draft it" row on a ticket (ai-assistant-scope.md 2.6): Draft it, "Asking...", the answer, then Use this (fills the
 * field, which still has to be saved; or copies, for a message), Try again with a one-line instruction, and Not useful.
 * `preview` is "What we'll send", the exact redacted request, shown until the first use on the ticket. `unavailable`
 * is the reason the button can't work now (no internet), shown in its place. Prints nothing.
 */
export function DraftBox({
  ticketId,
  kind,
  label,
  targetId,
  latest,
  preview,
  unavailable,
}: {
  ticketId: string;
  kind: "work_done" | "diagnosis" | "partner_note" | "estimate" | "ready";
  label: string;
  /** The id of the form field "Use this" fills; none: the text is copied. */
  targetId?: string;
  latest: Latest;
  preview?: string;
  unavailable?: string;
}) {
  const [pending, start] = useTransition();
  const [instruction, setInstruction] = useState("");
  const field = () => (targetId ? (document.getElementById(targetId) as HTMLTextAreaElement | HTMLInputElement | null) : null);

  function ask() {
    start(async () => {
      const r = await runAction(() => draftTicketText(ticketId, kind, field()?.value ?? "", instruction));
      if (r?.error) toast.error(r.error);
      else setInstruction("");
    });
  }

  function use() {
    if (!latest) return;
    start(async () => {
      const f = field();
      if (f) {
        f.value = latest.text;
        f.dispatchEvent(new Event("input", { bubbles: true }));
        toast.success("Filled in. Press Save to keep it.");
      } else {
        await navigator.clipboard?.writeText(latest.text).then(
          () => toast.success("Copied"),
          () => toast.error("Couldn't copy: select the text and copy it."),
        );
      }
      const r = await runAction(() => markAssistantCall(latest.id, true));
      if (r?.error) toast.error(r.error);
    });
  }

  function notUseful() {
    if (!latest) return;
    start(async () => {
      const r = await runAction(() => markAssistantCall(latest.id, false));
      if (r?.error) toast.error(r.error);
    });
  }

  return (
    <div className="rounded border border-line p-3 text-sm" data-assistant-draft={kind}>
      <div className="flex flex-wrap items-center gap-2">
        <strong>{label}</strong>
        {unavailable ? (
          <span className="muted">{unavailable}</span>
        ) : (
          <button type="button" className="btn btn-sm" disabled={pending} onClick={ask}>
            {pending ? "Asking..." : latest ? "Draft again" : "Draft it"}
          </button>
        )}
      </div>
      {!latest && preview && !unavailable && (
        <details className="mt-2 text-xs">
          <summary className="muted cursor-pointer">What we&apos;ll send</summary>
          <pre className="mt-1 whitespace-pre-wrap">{preview}</pre>
        </details>
      )}
      {latest && (
        <div className="mt-2 space-y-2">
          <p className="whitespace-pre-wrap rounded bg-surface-2 p-2" data-assistant-text>
            {latest.text}
          </p>
          {!unavailable && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={use}>
                {targetId ? "Use this" : "Copy"}
              </button>
              <input value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={160} placeholder="Try again: shorter, mention the belt..." className="input h-8 min-w-48 flex-1 text-xs" aria-label="One line for the next try" />
              <button type="button" className="btn btn-sm" disabled={pending} onClick={ask}>
                Try again
              </button>
              <button type="button" className="btn btn-sm" disabled={pending || latest.accepted === false} onClick={notUseful}>
                Not useful
              </button>
            </div>
          )}
          {latest.accepted === true && <p className="muted text-xs">Used.</p>}
        </div>
      )}
    </div>
  );
}
