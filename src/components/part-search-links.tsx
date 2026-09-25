// "Search for XA1234-001 at: eBay · Amazon · ...": works for every part number, no scraping.
import { ExternalLink } from "lucide-react";
import { SEARCH_SITES } from "@/lib/parts";

export function PartSearchLinks({ numbers }: { numbers: string[] }) {
  const list = [...new Set(numbers.filter(Boolean))].slice(0, 3);
  if (!list.length) return null;
  return (
    <div className="space-y-1 text-xs">
      {list.map((n) => (
        <div key={n} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="muted">
            Search for <span className="mono">{n}</span> at
          </span>
          {SEARCH_SITES.map((s) => (
            <a key={s.name} href={s.url(n)} target="_blank" rel="noreferrer" className="link">
              {s.name} <ExternalLink size={9} className="inline" aria-hidden />
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}
