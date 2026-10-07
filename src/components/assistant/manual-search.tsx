"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { searchTheManuals } from "@/actions/assistant";
import { runAction } from "@/components/action-form";
import type { TextHit } from "@/lib/assistant/manuals";

/** A snippet with the words the search found (marked « ») shown in bold. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/(«[^»]*»)/).map((part, i) => (part.startsWith("«") ? <mark key={i}>{part.slice(1, -1)}</mark> : part))}
    </>
  );
}

/**
 * The manuals page's search box (ai-assistant-scope.md 1.4): the words you type, found in the text of the manuals you
 * indexed, each hit a link that opens the PDF at that page. Plain search in this company's own database: it works
 * offline, sends nothing anywhere and doesn't count against the Assistant's calls.
 */
export function ManualSearch() {
  const [pending, start] = useTransition();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ asked: string; rows: TextHit[] } | null>(null);

  function run() {
    const q = query.trim();
    if (q.length < 2) return toast.error("Type a word or two to look for.");
    start(async () => {
      const r = await runAction(() => searchTheManuals(q));
      if (r?.error) toast.error(r.error);
      else if (r?.shown) setHits({ asked: q, rows: JSON.parse(r.shown) as TextHit[] });
    });
  }

  return (
    <div className="space-y-2 text-sm" data-manual-search>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={120} placeholder="Search inside your indexed manuals: hook timing, E3 error..." className="input min-w-48 flex-1" aria-label="Search inside your manuals" />
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Searching..." : "Search"}
        </button>
      </form>
      {hits && (
        <div className="space-y-1">
          {hits.rows.length === 0 ? (
            <p className="muted">Nothing in your indexed manuals has all of those words.</p>
          ) : (
            <ul className="divide-y divide-line">
              {hits.rows.map((h) => (
                <li key={`${h.docId}:${h.page}`} className="py-2">
                  <a href={h.href} target="_blank" rel="noreferrer" className="link font-medium">
                    {h.label}, p.&nbsp;{h.page}
                  </a>
                  <div className="muted text-xs">
                    <Snippet text={h.snippet} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
