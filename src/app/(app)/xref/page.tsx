import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { modelKey } from "@/lib/format";
import { hubJoined } from "@/lib/hub";
import { KIND_LABEL, numberKey, type XFit, type XNumber } from "@/lib/parts";
import { PageHeader, Section, Empty } from "@/components/ui";
import { XrefForm } from "@/components/xref-form";

export default async function CrossRef({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireUser();
  const term = (await searchParams).q?.trim() ?? "";
  const [joined, total] = await Promise.all([hubJoined(), db.xPart.count()]);
  const nk = numberKey(term);
  const mk = modelKey(term);
  const rows = term
    ? await db.xPart.findMany({
        where: {
          OR: [
            ...(nk.length >= 3 ? [{ numberKeys: { has: nk } }] : []),
            ...(mk.length >= 2 ? [{ fitKeys: { has: mk } }] : []),
            { name: { contains: term, mode: "insensitive" as const } },
            { category: { contains: term, mode: "insensitive" as const } },
            { specs: { contains: term, mode: "insensitive" as const } },
          ],
        },
        orderBy: { name: "asc" },
        take: 150,
      })
    : [];

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Parts cross-reference"
        sub="One entry per physical part: every number it's sold under, the machines and makers it fits, and where to buy it. Shared by every shop on the community hub."
        back={{ href: "/parts", label: "Parts" }}
      />
      {!joined ? (
        <p className="pill tone-wait inline-block">
          Not connected to the community hub. <Link href="/settings#hub" className="link">Join it in Settings</Link> to get the shared cross-reference.
        </p>
      ) : (
        <>
          <form className="flex gap-2">
            <label htmlFor="xq" className="sr-only">
              Search the cross-reference
            </label>
            <input id="xq" name="q" defaultValue={term} className="input max-w-md" placeholder="Part number, machine model, or a name like bobbin case" />
            <button className="btn">Search</button>
          </form>
          <p className="muted text-xs">{total.toLocaleString()} parts in the cross-reference.</p>
          {term && (
            <div className="card">
              {rows.length === 0 ? (
                <div className="card-pad">
                  <Empty>Nothing matches. If you know the part, add it below.</Empty>
                </div>
              ) : (
                <div className="scroll-x">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Part</th>
                        <th>Numbers</th>
                        <th>Fits</th>
                        <th className="text-right">Where to buy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((x) => {
                        const nums = x.numbers as XNumber[];
                        const fits = x.fits as XFit[];
                        const tested = fits.filter((f) => f.evidence === "tested").length;
                        return (
                          <tr key={x.id}>
                            <td>
                              <Link href={`/xref/${x.id}`} className="link font-semibold">
                                {x.name}
                              </Link>
                              <div className="muted text-xs">
                                {KIND_LABEL[x.kind] ?? x.kind}
                                {x.category && ` · ${x.category}`}
                                {x.specs && ` · ${x.specs}`}
                              </div>
                            </td>
                            <td className="mono text-xs">
                              {nums.slice(0, 3).map((n) => (
                                <div key={n.brand + n.number}>
                                  {n.brand} {n.number}
                                </div>
                              ))}
                              {nums.length > 3 && <div className="muted">+{nums.length - 3} more</div>}
                            </td>
                            <td className="text-xs">
                              {fits.length} model{fits.length === 1 ? "" : "s"}
                              {tested > 0 && <span className="pill tone-ready ml-1">{tested} fitted by techs</span>}
                            </td>
                            <td className="num text-right">{(x.sources as unknown[]).length || "-"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          <Section title="Add a part to the cross-reference">
            <XrefForm defaults={nk.length >= 3 && !rows.length ? { numbers: term } : undefined} />
          </Section>
        </>
      )}
    </div>
  );
}
