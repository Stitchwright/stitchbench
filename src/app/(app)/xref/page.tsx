import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { modelKey } from "@/lib/format";
import { hubJoined } from "@/lib/hub";
import { KIND_LABEL, baseNumber, numberKey, splitList, type XFit, type XNumber } from "@/lib/parts";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ActionButton } from "@/components/action-form";
import { XrefForm } from "@/components/xref-form";
import { restoreCrossRef } from "@/actions/xref";

const daysAgo = (days: number) => new Date(Date.now() - days * 86400_000);

/** A part's Fits as "Brand, model" lines: lines already written that way keep their brand, bare models get the part's. */
function fitsLines(fits: string | null, brand: string | null): string {
  const out: string[] = [];
  for (const line of (fits ?? "").split(/[\n;]+/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.includes(",")) out.push(t);
    else if (brand) out.push(...splitList(t).map((m) => `${brand}, ${m}`));
  }
  return out.join("\n");
}

export default async function CrossRef({ searchParams }: { searchParams: Promise<{ q?: string; add?: string; category?: string; kind?: string; fits?: string; name?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  // A repeated parameter (?add=a&add=b) arrives as a list: only a single value counts.
  const one = (v: unknown) => (typeof v === "string" ? v : undefined);
  const term = one(sp.q)?.trim() ?? "";
  const add = one(sp.add);
  // The finder's "New bag / belt / filter" links: the category, kind and vacuum come filled in.
  const given = { category: one(sp.category)?.trim(), kind: one(sp.kind)?.trim(), fits: one(sp.fits)?.trim(), name: one(sp.name)?.trim() };
  const hasGiven = Object.values(given).some(Boolean);
  const [joined, total, removed, offered] = await Promise.all([
    hubJoined(),
    db.xPart.count(),
    db.removedXPart.findMany({ where: { removedAt: { gte: daysAgo(90) } }, orderBy: { removedAt: "desc" }, take: 20 }),
    add ? db.part.findFirst({ where: { id: add, shopId: user.shopId }, select: { description: true, kind: true, brand: true, partNumber: true, altNumbers: true, fits: true, ownNumber: true } }) : null,
  ]);
  // A part of this shop's offered to the cross-reference: the form comes filled in to check before it goes to every
  // shop. Its own suffixes ("(own)", "(used)", a partner's name) come off the number; its notes stay here. A shop
  // number isn't the maker's, so it is left out: such a part is known by its name and the models it fits.
  const offer = offered
    ? {
        name: offered.description,
        kind: offered.kind,
        numbers: [...new Set([...(offered.ownNumber ? [] : [baseNumber(offered.partNumber)]), ...offered.altNumbers.map(baseNumber)])].map((n) => (offered.brand ? `${offered.brand}, ${n}` : n)).join("\n"),
        // A Fits line written "Brand, model" (an aftermarket bag listing the vacuum's maker) keeps its brand; a bare
        // model gets the part's own brand.
        fits: fitsLines(offered.fits, offered.brand),
      }
    : undefined;
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
        title="Other part numbers"
        sub="One entry per physical part: every number it's sold under, the machines and makers it fits, and where to buy it. Shared by every shop on StitchHub."
        back={{ href: "/parts", label: "Parts" }}
      />
      {!joined ? (
        <p className="pill tone-wait inline-block">
          Not connected to StitchHub. <Link href="/settings#hub" className="link">Join it in Settings</Link> to get the shared cross-reference.
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
            <div id="add">
              {offer && (
                <p className="pill tone-wait mb-3 inline-block">
                  Filled in from your part. Check it before adding: everything here goes to every shop on the hub (your part&apos;s notes don&apos;t).
                  {!offered?.brand && " Put the maker's name before each number (Brand, number)."}
                </p>
              )}
              <XrefForm defaults={offer ?? (hasGiven ? given : nk.length >= 3 && !rows.length ? { numbers: term } : undefined)} />
            </div>
          </Section>
          {removed.length > 0 && (
            <Section title="Recently removed">
              <p className="muted mb-2 text-xs">Removed by a shop in the last 90 days. Put one back if it was removed by mistake.</p>
              <ul className="divide-y divide-line text-sm">
                {removed.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-semibold">{r.name}</span>{" "}
                      <span className="mono muted text-xs">
                        {(r.numbers as XNumber[])
                          .slice(0, 3)
                          .map((n) => `${n.brand} ${n.number}`)
                          .join(" · ")}
                      </span>
                    </span>
                    <ActionButton action={restoreCrossRef.bind(null, r.id)} className="btn btn-sm" confirm="Put it back for everyone?" title="Put back">
                      Put back
                    </ActionButton>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
