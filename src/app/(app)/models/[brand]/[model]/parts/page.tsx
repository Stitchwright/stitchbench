import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { modelKey } from "@/lib/format";
import { brandMatches } from "@/lib/model-info";
import { hubJoined } from "@/lib/hub";
import { EVIDENCE_LABEL, KIND_LABEL, partsFittingModel, type XFit, type XNumber } from "@/lib/parts";
import { PageHeader, Empty, modelHref } from "@/components/ui";

// The whole parts list for one machine, from the community cross-reference, with this shop's stock and the marketplace.
export default async function ModelParts({ params, searchParams }: { params: Promise<{ brand: string; model: string }>; searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const p = await params;
  const brand = decodeURIComponent(p.brand);
  const model = decodeURIComponent(p.model);
  const term = (await searchParams).q?.trim().toLowerCase() ?? "";
  const key = modelKey(model);
  const [joined, { xparts, stocked }] = await Promise.all([hubJoined(), partsFittingModel(user.shopId, brand, model, 5000)]);
  const rows = term
    ? xparts.filter((x) => `${x.name} ${x.category ?? ""} ${(x.numbers as XNumber[]).map((n) => n.number).join(" ")}`.toLowerCase().includes(term))
    : xparts;
  const listings = await db.listing.findMany({
    where: { status: "ACTIVE", mine: false, OR: [{ xpartId: { in: rows.map((x) => x.id) } }, { numberKey: { in: rows.flatMap((x) => x.numberKeys) } }] },
    select: { id: true, xpartId: true, numberKey: true, priceCents: true },
  });
  const offer = (x: (typeof rows)[number]) => listings.find((l) => l.xpartId === x.id || (l.numberKey && x.numberKeys.includes(l.numberKey)));

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        back={{ href: modelHref(brand, model), label: `${brand} ${model}` }}
        title={`Parts list: ${brand} ${model}`}
        sub={`${xparts.length} parts from the community cross-reference. Parts marked "fitted" were tried by a tech; the rest are in this model's parts list.`}
      />
      {!joined ? (
        <Empty>
          Join the community hub (<Link href="/settings#hub" className="link">Settings</Link>) to get the cross-reference.
        </Empty>
      ) : (
        <>
          <form className="flex gap-2">
            <label htmlFor="mp-q" className="sr-only">
              Find a part
            </label>
            <input id="mp-q" name="q" defaultValue={term} className="input max-w-md" placeholder="Part name or number" />
            <button className="btn">Find</button>
          </form>
          <div className="card">
            {rows.length === 0 ? (
              <div className="card-pad">
                <Empty>{term ? "No part matches." : `No parts for the ${model} in the cross-reference yet.`}</Empty>
              </div>
            ) : (
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Part number</th>
                      <th>Part</th>
                      <th>How we know</th>
                      <th className="text-right">Your stock</th>
                      <th className="text-right">Marketplace</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((x) => {
                      const nums = x.numbers as XNumber[];
                      const own = nums.filter((n) => brandMatches(n.brand, brand));
                      const fit = (x.fits as XFit[]).find((f) => f.modelKey === key && brandMatches(f.brand, brand));
                      const s = stocked.get(x.id);
                      const o = offer(x);
                      return (
                        <tr key={x.id}>
                          <td className="mono text-sm">{(own.length ? own : nums).map((n) => n.number).join(", ")}</td>
                          <td>
                            <Link href={`/xref/${x.id}`} className="link">
                              {x.name}
                            </Link>
                            <div className="muted text-xs">{[KIND_LABEL[x.kind] ?? x.kind, x.category, x.specs].filter(Boolean).join(" · ")}</div>
                          </td>
                          <td className="text-xs">
                            {fit ? <span className={`pill ${fit.evidence === "listed" ? "tone-neutral" : "tone-ready"}`}>{EVIDENCE_LABEL[fit.evidence] ?? fit.evidence}</span> : null}
                          </td>
                          <td className="num text-right">
                            {s ? (
                              <Link href={`/parts/${s.id}`} className="link">
                                {s.qtyOnHand}
                                {s.location ? <span className="muted text-xs"> · {s.location}</span> : null}
                              </Link>
                            ) : (
                              <span className="muted text-xs">-</span>
                            )}
                          </td>
                          <td className="num text-right">
                            {o ? (
                              <Link href={`/market/${o.id}`} className="link">
                                ${(o.priceCents / 100).toFixed(2)}
                              </Link>
                            ) : (
                              <span className="muted text-xs">-</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
