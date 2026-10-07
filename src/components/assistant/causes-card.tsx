"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { askLikelyCauses, markAssistantCall } from "@/actions/assistant";
import { runAction } from "@/components/action-form";
import type { Cause } from "@/lib/assistant/prompts";

/**
 * "What's likely wrong" (ai-assistant-scope.md 1.2, 2.6): up to five causes with the checks to make, each followed by
 * its sources as links (a past ticket, a gotcha, a community note, the specs) or the plain label "general knowledge".
 * "Ask again with what I found" sends the ticket again with the diagnosis typed since. Prints nothing.
 */
export function CausesCard({
  ticketId,
  latest,
  preview,
  unavailable,
}: {
  ticketId: string;
  latest: { id: string; causes: Cause[] | null; raw: string; accepted: boolean | null; at: string } | null;
  preview?: string;
  unavailable?: string;
}) {
  const [pending, start] = useTransition();
  const [instruction, setInstruction] = useState("");

  function ask() {
    start(async () => {
      const r = await runAction(() => askLikelyCauses(ticketId, instruction));
      if (r?.error) toast.error(r.error);
      else setInstruction("");
    });
  }
  function mark(accepted: boolean) {
    if (!latest) return;
    start(async () => {
      const r = await runAction(() => markAssistantCall(latest.id, accepted));
      if (r?.error) toast.error(r.error);
    });
  }

  return (
    <div className="rounded border border-line p-3 text-sm" data-assistant-causes>
      <div className="flex flex-wrap items-center gap-2">
        <strong>What&apos;s likely wrong</strong>
        {unavailable ? (
          <span className="muted">{unavailable}</span>
        ) : (
          <button type="button" className="btn btn-sm" disabled={pending} onClick={ask}>
            {pending ? "Asking..." : latest ? "Ask again with what I found" : "Ask"}
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
          {latest.causes ? (
            <ol className="list-decimal space-y-2 pl-5">
              {latest.causes.map((c, i) => (
                <li key={i}>
                  <div className="font-medium">{c.cause}</div>
                  {c.checks.length > 0 && (
                    <ul className="list-disc pl-5">
                      {c.checks.map((k, j) => (
                        <li key={j}>{k}</li>
                      ))}
                    </ul>
                  )}
                  <div className="muted text-xs">
                    {c.general ? (
                      "general knowledge"
                    ) : (
                      <>
                        From:{" "}
                        {c.sources.map((s, j) => (
                          <span key={s.ref}>
                            {j > 0 && ", "}
                            {s.href ? (
                              <Link href={s.href} className="link">
                                {s.label}
                              </Link>
                            ) : (
                              s.label
                            )}
                          </span>
                        ))}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="whitespace-pre-wrap">{latest.raw}</p>
          )}
          <p className="muted text-xs">Asked {latest.at}. These are suggestions to check, not a diagnosis.</p>
          {!unavailable && (
            <div className="flex flex-wrap items-center gap-2">
              <input value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={160} placeholder="Ask again: it's a Mark II, skip the motor..." className="input h-8 min-w-48 flex-1 text-xs" aria-label="One line for the next try" />
              <button type="button" className="btn btn-sm" disabled={pending || latest.accepted === true} onClick={() => mark(true)}>
                Helped
              </button>
              <button type="button" className="btn btn-sm" disabled={pending || latest.accepted === false} onClick={() => mark(false)}>
                Not useful
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
