// The generic quick links of a non-sewing kind (modules-design.md 9.3), in its own module so the kinds can import it
// without loading the registry (which imports the kinds: a cycle otherwise).
import type { QuickLink } from "@/lib/quick-links";

const q = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");

/** Four searches (Google, eBay, YouTube) for a non-sewing kind: no maker-specific URLs. */
export function genericLinks(noun: string): (brand: string, model: string) => QuickLink[] {
  return (brand, model) => {
    const bm = `${brand} ${model}`.trim();
    return [
      { group: "Parts", label: "eBay parts", url: `https://www.ebay.com/sch/i.html?_nkw=${q(bm + " parts")}` },
      { group: "Videos", label: "YouTube: repair", url: `https://www.youtube.com/results?search_query=${q(bm + " repair")}` },
      { group: "Manuals", label: "Service manual search", url: `https://www.google.com/search?q=${q(bm + " service manual pdf")}` },
      { group: "Maker", label: `${brand} support`, url: `https://www.google.com/search?q=${q(`${brand} ${noun} support`)}` },
    ];
  };
}
