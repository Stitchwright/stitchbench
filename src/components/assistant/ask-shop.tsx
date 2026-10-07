"use client";
// Ask your shop (shop-features-round-2-design.md 5.1): the box at the top of Reports. A question in her own words; the
// answer in a sentence or two, the report's table underneath and Open this report. The numbers are the program's.
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { askYourShop } from "@/actions/assistant";
import { runAction } from "@/components/action-form";
import type { AskResult } from "@/lib/assistant/ask";

export function AskShop({ unavailable }: { unavailable?: string }) {
  const [q, setQ] = useState("");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<AskResult | null>(null);
  const ask = () =>
    start(async () => {
      const r = await runAction(() => askYourShop(q));
      if (r?.error) toast.error(r.error);
      else if (r?.shown) setResult(JSON.parse(r.shown) as AskResult);
    });
  return (
    <section className="card card-pad no-print space-y-3" aria-label="Ask your shop" data-ask-shop>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!unavailable) ask();
        }}
      >
        <div className="field min-w-64 flex-1">
          <label htmlFor="ask-q" className="label">
            Ask your shop
          </label>
          <input id="ask-q" value={q} onChange={(e) => setQ(e.target.value)} className="input" maxLength={300} placeholder="Which precuts sold best since spring?" disabled={!!unavailable} />
        </div>
        <button className="btn btn-primary" disabled={pending || !!unavailable || q.trim().length < 3}>
          {pending ? "Looking..." : "Ask"}
        </button>
      </form>
      {unavailable ? (
        <p className="muted text-sm">{unavailable}</p>
      ) : (
        !result && <p className="muted text-sm">Your own reports work out the numbers; the Assistant only picks the report and says the answer. Item names and counts are sent, never a customer. Each question uses two Assistant calls.</p>
      )}
      {result && (
        <div className="space-y-3" data-ask-answer>
          <p className="text-base font-semibold">{result.answer}</p>
          {result.cant && (
            <div className="text-sm">
              <p>It can answer questions like these:</p>
              <ul className="mt-1 list-disc pl-5">
                {result.cant.map((c) => (
                  <li key={c.label}>
                    <strong>{c.label}:</strong> &quot;{c.example}&quot;
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.report && (
            <div className="space-y-2">
              <p className="muted text-sm">{result.report.title}</p>
              {result.report.rows.length === 0 ? (
                <p className="text-sm">Nothing matched in that report.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        {result.report.columns.map((c, i) => (
                          <th key={i} className={c.num ? "text-right" : undefined}>
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.report.rows.map((row, i) => (
                        <tr key={i}>
                          {row.map((cell, j) => (
                            <td key={j} className={result.report!.columns[j]?.num ? "num text-right" : undefined}>
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Link href={result.report.href} className="btn btn-sm">
                Open this report
              </Link>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
