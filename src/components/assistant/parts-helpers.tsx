"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { askLooksLike, askPartsForJob, markAssistantCall } from "@/actions/assistant";
import { runAction } from "@/components/action-form";
import type { JobPartsResult, LooksLikeResult } from "@/lib/assistant/parts";

/** Helped / Not useful on the call that made the answer (the company's own log). */
function Marks({ callId }: { callId?: string }) {
  const [done, setDone] = useState<string | null>(null);
  if (!callId) return null;
  const mark = async (v: boolean) => {
    const r = await runAction(() => markAssistantCall(callId, v));
    if (r?.error) toast.error(r.error);
    else setDone(v ? "Marked as helpful." : "Marked as not useful.");
  };
  return done ? (
    <p className="muted text-xs">{done}</p>
  ) : (
    <p className="flex gap-2 text-xs">
      <button type="button" className="link" onClick={() => mark(true)}>
        Helped
      </button>
      <button type="button" className="link" onClick={() => mark(false)}>
        Not useful
      </button>
    </p>
  );
}

/**
 * "Looks like" on a part page (ai-assistant-scope.md 1.5 a): for a part the cross-reference doesn't know by number, the
 * entries and stock items that look like the same part. Each is a link: the tech opens the entry and decides; nothing is
 * added or merged from here. `unavailable` is the plain reason it can't ask now (no internet).
 */
export function LooksLikeCard({ partId, unavailable }: { partId: string; unavailable?: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<LooksLikeResult | null>(null);
  if (unavailable) return <p className="muted text-sm">{unavailable}</p>;
  return (
    <div className="space-y-2 text-sm" data-looks-like>
      <button
        type="button"
        className="btn btn-sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await runAction(() => askLooksLike(partId));
            if (r?.error) toast.error(r.error);
            else if (r?.shown) setResult(JSON.parse(r.shown) as LooksLikeResult);
          })
        }
      >
        {pending ? "Looking..." : "Looks like..."}
      </button>
      <p className="muted text-xs">Sends this part&apos;s number, name and fits, and up to 40 candidate parts (names and numbers) to the Assistant.</p>
      {result &&
        (result.matches.length === 0 ? (
          <p>{result.sent === 0 ? "Nothing in your stock or the shared cross-reference looks close." : "Nothing the Assistant is confident enough to suggest."}</p>
        ) : (
          <div className="space-y-2" data-looks-like-answer>
            <ul className="divide-y divide-line">
              {result.matches.map((m) => (
                <li key={m.ref} className="py-2">
                  <Link href={m.href} className="link font-semibold">
                    {m.name}
                  </Link>{" "}
                  <span className="pill tone-neutral">{m.confidence}</span> <span className="muted text-xs">{m.kind === "xpart" ? "community cross-reference" : `your stock${m.qty != null ? `, ${m.qty} on hand` : ""}`}</span>
                  <div className="mono text-xs">{m.numbers}</div>
                  {m.why && <div className="text-xs">{m.why}</div>}
                </li>
              ))}
            </ul>
            <p className="muted text-xs">Open one and check before you add a number to it: the Assistant can be wrong about fit.</p>
            <Marks callId={result.callId} />
          </div>
        ))}
    </div>
  );
}

/** "Parts this job usually needs" on a ticket (1.5 b): from this shop's past jobs on the model and what the cross-reference says fits it. */
export function JobPartsCard({ ticketId, unavailable }: { ticketId: string; unavailable?: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<JobPartsResult | null>(null);
  if (unavailable) return <p className="muted text-sm">{unavailable}</p>;
  return (
    <div className="space-y-2" data-job-parts>
      <div className="flex flex-wrap items-center gap-2">
        <strong>Parts this job usually needs</strong>
        <button
          type="button"
          className="btn btn-sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await runAction(() => askPartsForJob(ticketId, ""));
              if (r?.error) toast.error(r.error);
              else if (r?.shown) setResult(JSON.parse(r.shown) as JobPartsResult);
            })
          }
        >
          {pending ? "Looking..." : "Suggest parts"}
        </button>
      </div>
      <p className="muted text-xs">Sends the model, the problem as typed (names and numbers blanked), part descriptions from your past jobs on this model, and fitting parts from the shared cross-reference.</p>
      {result &&
        (result.parts.length === 0 ? (
          <p>{result.sent === 0 ? "Not enough history on this model yet: no past jobs with parts, and no parts listed as fitting it." : "Nothing in the history points to a part for this problem."}</p>
        ) : (
          <div className="space-y-1" data-job-parts-answer>
            <ul className="divide-y divide-line">
              {result.parts.map((p) => (
                <li key={p.ref} className="py-1.5">
                  <Link href={p.stockHref ?? p.href} className="link font-semibold">
                    {p.label}
                  </Link>{" "}
                  <span className="muted text-xs">
                    {p.kind === "used" ? "used on past jobs" : "fits this model"}
                    {p.qty != null ? `, ${p.qty} in stock` : p.kind === "fits" ? ", not in stock" : ""}
                  </span>
                  {p.reason && <div className="text-xs">{p.reason}</div>}
                </li>
              ))}
            </ul>
            <Marks callId={result.callId} />
          </div>
        ))}
    </div>
  );
}
