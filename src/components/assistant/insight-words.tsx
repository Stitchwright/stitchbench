"use client";
// Words on fabric insight (shop-features-round-2-design.md 5.5): "At a glance" cards made from the page's own numbers,
// and, with the Assistant, "Say it in words" puts one plain sentence on each. The sentences are shown, not stored.
import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { explainFabricInsight } from "@/actions/assistant";
import { runAction } from "@/components/action-form";
import type { InsightCard } from "@/lib/assistant/insight-words";

export function InsightWords({ tab, cards, entry }: { tab: "sells" | "slow"; cards: InsightCard[]; entry: { show: boolean; unavailable?: string } }) {
  const [pending, start] = useTransition();
  const [words, setWords] = useState<Record<string, string>>({});
  if (!cards.length) return null;
  const run = () =>
    start(async () => {
      const r = await runAction(() => explainFabricInsight(tab));
      if (r?.error) toast.error(r.error);
      else if (r?.shown) setWords((JSON.parse(r.shown) as { words: Record<string, string> }).words);
    });
  return (
    <section className="card card-pad space-y-3" aria-label="At a glance" data-insight-words>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">At a glance</h2>
        {entry.show &&
          (entry.unavailable ? (
            <span className="muted text-xs">{entry.unavailable}</span>
          ) : (
            <button type="button" className="btn btn-sm" disabled={pending} onClick={run}>
              <Sparkles size={14} aria-hidden /> {pending ? "Wording..." : "Say it in words"}
            </button>
          ))}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {cards.map((c) => (
          <li key={c.ref} className="rounded border border-line p-3 text-sm">
            <div className="font-semibold">{c.title}</div>
            {words[c.ref] && <p className="mt-1 text-base">{words[c.ref]}</p>}
            <p className="muted mt-1 text-xs">{c.facts}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
