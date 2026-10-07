// The bag / belt / filter finder (modules-design.md 10.b): one brand box and one "model, bag type or part number" box;
// results grouped Bags / Belts / Filters / Other, each with the shop's stock, "Details" and "This fits another model"
// (the existing /xref editor); "New bag / belt / filter" opens the add form filled in. A tool, not records: anything
// but a writable module shows the notice alone.
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { hubJoined, hubOfflineSince } from "@/lib/hub";
import { EVIDENCE_LABEL } from "@/lib/parts";
import { VACUUM_BRANDS } from "@/lib/equipment/vacuum";
import { newSupplyHref, suppliesFor, VAC_SEARCH_SITES, type Supply } from "@/lib/vac/finder";
import { Empty } from "@/components/ui";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";

const GROUPS: { category: Supply["category"]; label: string }[] = [
  { category: "Vacuum bag", label: "Bags" },
  { category: "Vacuum belt", label: "Belts" },
  { category: "Vacuum filter", label: "Filters" },
  { category: null, label: "Other parts" },
];
const TONE: Record<string, string> = {
  tested: "tone-ready",
  maker: "tone-work",
  listed: "tone-neutral",
};

export default async function VacFinder({ searchParams }: { searchParams: Promise<{ brand?: string | string[]; q?: string | string[] }> }) {
  const user = await requireUser();
  const s = await vacPageState(user);
  const sp = await searchParams;
  const one = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const brand = one(sp.brand);
  const q = one(sp.q);
  if (s.gate !== "write") {
    return <VacFrame title="Bag, belt and filter finder" tab="finder" needsRegister {...s} what="the finder" />;
  }
  const shopId = user.shopId;
  const [joined, hasVacuums, result] = await Promise.all([
    hubJoined(),
    db.machine
      .count({
        where: { shopId, equipment: "VACUUM", customerId: { not: null } },
      })
      .then((n) => n > 0),
    q
      ? suppliesFor(shopId, {
          brand: brand || null,
          model: brand ? q : null,
          text: q,
        })
      : Promise.resolve(null),
  ]);
  const offline = joined && hubOfflineSince() != null;
  const what = [brand, q].filter(Boolean).join(" ");
  return (
    <VacFrame title="Bag, belt and filter finder" tab="finder" needsRegister {...s}>
      <form className="flex flex-wrap items-end gap-2" role="search">
        <div className="field">
          <label htmlFor="vf-brand" className="label">
            Brand
          </label>
          <input id="vf-brand" name="brand" list="vf-brands" defaultValue={brand} className="input w-44" placeholder="Hoover" />
          <datalist id="vf-brands">
            {VACUUM_BRANDS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </div>
        <div className="field min-w-64 flex-1">
          <label htmlFor="vf-q" className="label">
            Model, bag type or part number
          </label>
          <input id="vf-q" name="q" defaultValue={q} className="input" placeholder="UH70120, Type Y, 4010100Y, HEPA" required />
        </div>
        <button className="btn btn-primary">Find</button>
      </form>
      {hasVacuums && (
        <p className="muted text-sm">
          Or pick a customer&apos;s vacuum on the{" "}
          <Link href="/register" className="link">
            register
          </Link>
          .
        </p>
      )}
      {!joined && (
        <p className="card card-pad text-sm">
          <Link href="/settings#hub" className="link">
            Join StitchHub
          </Link>{" "}
          (Settings) to see and share what fits. For now this shows your own parts that list this model in their Fits.
        </p>
      )}
      {offline && <p className="pill tone-wait">You&apos;re offline. Showing what was last synced. To note a fit for now, add the model to your part&apos;s Fits list.</p>}
      {result && (
        <>
          {result.supplies.length === 0 ? (
            <Empty>
              Nothing listed for {what} yet.
              {joined ? " Add what you know fits: it's shared with every shop on the hub." : ""}
            </Empty>
          ) : (
            GROUPS.map((g) => {
              const rows = result.supplies.filter((x) => x.category === g.category);
              if (!rows.length) return null;
              return (
                <section key={g.label} className="card">
                  <h2 className="label border-b border-line px-3 py-2">
                    {g.label} ({rows.length})
                  </h2>
                  <ul className="divide-y divide-line text-sm">
                    {rows.map((x) => (
                      <li key={x.xpartId ?? `local:${x.items[0]?.id}`} className="space-y-1 px-3 py-2">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="font-semibold">{x.name}</span>
                          {x.numbers.slice(0, 4).map((n) => (
                            <span key={n.brand + n.number} className="mono muted text-xs">
                              {n.brand} {n.number}
                            </span>
                          ))}
                          {x.evidence && <span className={`pill ${TONE[x.evidence]}`}>{EVIDENCE_LABEL[x.evidence] ?? x.evidence}</span>}
                          {x.close && <span className="pill tone-wait">Close match: {x.close}</span>}
                          {x.source === "local" && <span className="pill tone-neutral">Your part</span>}
                        </div>
                        {x.items.length === 0 ? (
                          <div className="muted text-xs">
                            Not stocked
                            {x.numbers[0] && (
                              <>
                                {" "}
                                · search{" "}
                                {VAC_SEARCH_SITES.map((site) => (
                                  <a key={site.label} href={site.url(x.numbers[0].number)} target="_blank" rel="noreferrer" className="link mr-2">
                                    {site.label} <ExternalLink size={9} className="inline" aria-hidden />
                                  </a>
                                ))}
                              </>
                            )}
                          </div>
                        ) : (
                          <ul className="space-y-0.5 text-xs">
                            {x.items.map((it) => (
                              <li key={it.id}>
                                <Link href={`/parts/${it.id}`} className="link mono">
                                  {it.partNumber}
                                </Link>{" "}
                                · {it.qtyOnHand} on hand
                                {it.priceCents != null ? ` · ${money(it.priceCents)}` : " · no price"}
                                {it.disclosure ? ` · ${it.disclosure}` : ""}
                              </li>
                            ))}
                          </ul>
                        )}
                        {x.xpartId && (
                          <div className="flex flex-wrap gap-3 text-xs">
                            <Link href={`/xref/${x.xpartId}`} className="link">
                              Details
                            </Link>
                            <Link href={`/xref/${x.xpartId}`} className="link">
                              This fits another model
                            </Link>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          )}
          {result.truncated && <p className="muted text-xs">Showing the first 60. Narrow it down with a brand or a type.</p>}
          {joined && (
            <p className="flex flex-wrap items-center gap-3 text-sm">
              <span className="muted">Not here yet?</span>
              <Link href={newSupplyHref("Vacuum bag", brand, brand ? q : "")} className="btn btn-sm">
                New bag
              </Link>
              <Link href={newSupplyHref("Vacuum belt", brand, brand ? q : "")} className="btn btn-sm">
                New belt
              </Link>
              <Link href={newSupplyHref("Vacuum filter", brand, brand ? q : "")} className="btn btn-sm">
                New filter
              </Link>
            </p>
          )}
        </>
      )}
    </VacFrame>
  );
}
