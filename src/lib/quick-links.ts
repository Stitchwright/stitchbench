// One-tap searches for a brand + model. Search addresses checked 2026-09-24; eBay, Janome and Bernina
// block scripted checks but open normally in a browser.
const q = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");

const SUPPORT: Record<string, string> = {
  BROTHER: "https://www.brother-usa.com/support",
  BABYLOCK: "https://babylock.com/support",
  SINGER: "https://www.singer.com/pages/support",
  JANOME: "https://www.janome.com/support/",
  BERNINA: "https://www.bernina.com/en-US/Support",
  JUKI: "https://www.juki.co.jp/industrial_e/support/",
  BARUDAN: "https://www.barudanamerica.com/maintenance",
  MELCO: "https://www.melco.com/support",
  APQS: "https://www.apqs.com/support/",
  GAMMILL: "https://www.gammill.com/support",
  HANDIQUILTER: "https://www.handiquilter.com/support/",
};

export type QuickLink = { group: string; label: string; url: string };

export function quickLinks(brand: string, model: string, category?: string | null): QuickLink[] {
  const bm = `${brand} ${model}`.trim();
  const key = brand.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const industrial = category === "Industrial-Sewing";
  const links: QuickLink[] = [
    { group: "Parts", label: "eBay parts", url: `https://www.ebay.com/sch/i.html?_nkw=${q(bm + " parts")}` },
  ];
  if (!industrial) {
    links.push(
      { group: "Parts", label: "Sewing Parts Online", url: `https://www.sewingpartsonline.com/search?q=${q(bm)}` },
      { group: "Parts", label: "AllBrands", url: `https://www.allbrands.com/search?q=${q(bm)}` },
      { group: "Parts", label: "Sewing Machines Plus", url: `https://www.sewingmachinesplus.com/search.php?search_query=${q(bm)}` },
    );
  } else {
    links.push({ group: "Parts", label: "Parts book search", url: `https://www.google.com/search?q=${q(bm + " parts book")}` });
  }
  links.push(
    { group: "Videos", label: "YouTube: timing", url: `https://www.youtube.com/results?search_query=${q(bm + " timing adjustment")}` },
    { group: "Videos", label: "YouTube: repair", url: `https://www.youtube.com/results?search_query=${q(bm + " repair")}` },
    { group: "Manuals", label: "Service manual search", url: `https://www.google.com/search?q=${q(bm + " service manual pdf")}` },
    { group: "Market", label: "eBay: machines", url: `https://www.ebay.com/sch/i.html?_nkw=${q(bm + (industrial ? " industrial sewing machine" : " sewing machine"))}` },
    {
      group: "Maker",
      label: `${brand} support`,
      url: SUPPORT[key] ?? `https://www.google.com/search?q=${q(brand + " sewing machine support")}`,
    },
  );
  return links;
}
