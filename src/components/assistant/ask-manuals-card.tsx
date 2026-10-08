"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { askTheManuals } from "@/actions/assistant";
import { runAction } from "@/components/action-form";
import type { AskResult } from "@/lib/assistant/manuals";
import { NOT_FOUND_MESSAGE } from "@/lib/assistant/manuals-prompt";

/** The answer's text with each [m3] marker turned into a link to that page of the shop's own PDF viewer. */
function Answer({ r }: { r: AskResult }) {
  const by = new Map(r.citations.map((c) => [c.ref, c]));
  return (
    <p className="whitespace-pre-wrap">
      {r.answer.split(/(\[m\d+\])/).map((part, i) => {
        const ref = /^\[(m\d+)\]$/.exec(part)?.[1];
        const c = ref ? by.get(ref) : undefined;
        if (!c) return part;
        return (
          <a key={i} href={c.href} target="_blank" rel="noreferrer" className="link whitespace-nowrap font-medium" data-manual-cite={c.ref}>
            [p.&nbsp;{c.page}]
          </a>
        );
      })}
    </p>
  );
}

/**
 * "Ask the manuals" (ai-assistant-scope.md 1.4): a question about this machine's model, answered from the pages of its
 * indexed manuals, each fact followed by its page as a link that opens the PDF there. Only the question and the few
 * matching pages are sent. When nothing in the manuals answers it, it says so. `unavailable` is the plain reason it can't
 * ask now (no internet); `blocked` is why asking isn't possible yet (nothing indexed).
 */
export function AskManualsCard({ brand, model, ticketId, unavailable, blocked }: { brand: string; model: string; ticketId?: string; unavailable?: string; blocked?: string }) {
  const [pending, start] = useTransition();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<(AskResult & { asked: string }) | null>(null);

  function ask() {
    const q = question.trim();
    if (q.length < 3) return toast.error("Type a question first.");
    start(async () => {
      const r = await runAction(() => askTheManuals(brand, model, q, ticketId ?? null));
      if (r?.error) toast.error(r.error);
      else if (r?.shown) setResult({ ...(JSON.parse(r.shown) as AskResult), asked: q });
    });
  }

  if (unavailable || blocked) return <p className="muted text-sm">{unavailable ?? blocked}</p>;
  return (
    <div className="space-y-2 text-sm" data-ask-manuals>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={400}
          placeholder={`Where is the hook timing procedure for the ${model}?`}
          className="input min-w-48 flex-1"
          aria-label={`Ask the ${brand} ${model} manuals`}
        />
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Asking..." : "Ask"}
        </button>
      </form>
      <p className="muted text-xs">Only your question and the few best-matching pages go to the Assistant. It answers only from those pages.</p>
      {result && (
        <div className="space-y-2 rounded border border-line p-3" data-ask-manuals-answer>
          <div className="muted text-xs">You asked: {result.asked}</div>
          {result.found ? (
            <>
              <Answer r={result} />
              <div className="muted text-xs">
                Pages:{" "}
                {result.citations.map((c, i) => (
                  <span key={c.ref}>
                    {i > 0 && "; "}
                    <a href={c.href} target="_blank" rel="noreferrer" className="link">
                      {c.label}
                    </a>
                  </span>
                ))}
              </div>
              <p className="muted text-xs">Check the page before you act on it: the Assistant can misread a table.</p>
            </>
          ) : (
            <p>
              <strong>{NOT_FOUND_MESSAGE}</strong>{" "}
              <span className="muted">{result.sent === 0 ? "No indexed page of this model's manuals has those words. Try other words." : "The pages that matched don't answer it."}</span>
            </p>
          )}
          {result.scanned > 0 && (
            <p className="muted text-xs">
              {result.scanned} page{result.scanned === 1 ? "" : "s"}{" "}of these manuals are scans and can&apos;t be searched yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
