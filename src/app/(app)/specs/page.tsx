import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { firstValues } from "@/lib/search-params";
import { modelKey } from "@/lib/format";
import { ADJUSTMENTS, ADJ_NAME, valueRange } from "@/lib/adjustments";
import { PageHeader } from "@/components/ui";
import { SpecsTable } from "@/components/model-panel";
import { ManualFigure } from "@/components/manual-figure";
import { withFigures } from "@/lib/model-info";

type SP = { q?: string; brand?: string; tab?: string; adj?: string };

export default async function Specs({ searchParams }: { searchParams: Promise<SP> }) {
  await requireUser();
  const sp = firstValues(await searchParams);
  const tab = sp.tab === "settings" ? "settings" : "tension";
  const [tCount, sCount] = await Promise.all([db.tensionSpec.count(), db.factorySetting.count()]);

  return (
    <div className="space-y-6">
      <PageHeader title="Factory specs" sub="Values read out of OEM service, technical and operator manuals, with the page they came from." />
      <nav className="flex gap-2" aria-label="Spec type">
        <Link href="/specs" className={`btn ${tab === "tension" ? "btn-primary" : ""}`} aria-current={tab === "tension" ? "page" : undefined}>
          Thread tension <span className="num opacity-80">{tCount}</span>
        </Link>
        <Link href="/specs?tab=settings" className={`btn ${tab === "settings" ? "btn-primary" : ""}`} aria-current={tab === "settings" ? "page" : undefined}>
          Timing and adjustments <span className="num opacity-80">{sCount}</span>
        </Link>
      </nav>
      {tab === "tension" ? <Tension sp={sp} /> : <Settings sp={sp} />}
    </div>
  );
}

async function Tension({ sp }: { sp: SP }) {
  const term = sp.q?.trim() ?? "";
  const key = modelKey(term);
  const [brands, specs] = await Promise.all([
    db.tensionSpec.groupBy({ by: ["brand"], _count: { _all: true }, orderBy: { brand: "asc" } }),
    term || sp.brand
      ? db.tensionSpec.findMany({
          where: {
            ...(sp.brand ? { brand: sp.brand } : {}),
            ...(term
              ? {
                  OR: [
                    { brand: { contains: term, mode: "insensitive" } },
                    { models: { contains: term, mode: "insensitive" } },
                    ...(key.length >= 2 ? [{ modelKeys: { has: key } }] : []),
                    { sourceFile: { contains: term, mode: "insensitive" } },
                  ],
                }
              : {}),
          },
          orderBy: [{ brand: "asc" }, { models: "asc" }],
          take: 300,
        })
      : Promise.resolve([]),
  ]);
  return (
    <div className="space-y-4">
      <p className="muted text-sm">Upper = needle-thread pull-off, bobbin = bobbin-case pull-off, in grams-force (1 N = 101.97 gf).</p>
      <form className="flex flex-wrap gap-2">
        <label htmlFor="sq" className="sr-only">
          Model or brand
        </label>
        <input id="sq" name="q" defaultValue={term} className="input max-w-md" placeholder="Model or brand, e.g. PR655, Tajima, DDL-8700" />
        <label htmlFor="sb" className="sr-only">
          Brand
        </label>
        <select id="sb" name="brand" defaultValue={sp.brand ?? ""} className="select w-48">
          <option value="">All brands</option>
          {brands.map((b) => (
            <option key={b.brand} value={b.brand}>
              {b.brand} ({b._count._all})
            </option>
          ))}
        </select>
        <button className="btn btn-primary">Search</button>
      </form>
      {term || sp.brand ? (
        specs.length ? (
          <div className="card">
            <SpecsTable specs={specs} />
          </div>
        ) : (
          <p className="muted">No spec matches. Many operator manuals give no gauge number, so the model may simply not have one.</p>
        )
      ) : (
        <div className="flex flex-wrap gap-2">
          {brands.map((b) => (
            <a key={b.brand} href={`/specs?brand=${encodeURIComponent(b.brand)}`} className="btn btn-sm">
              {b.brand} <span className="muted num">{b._count._all}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

async function Settings({ sp }: { sp: SP }) {
  const term = sp.q?.trim() ?? "";
  const key = modelKey(term);
  const adj = ADJUSTMENTS.some((a) => a.key === sp.adj) ? sp.adj : undefined;
  const [brands, rawRows] = await Promise.all([
    db.factorySetting.groupBy({ by: ["brand"], _count: { _all: true }, orderBy: { brand: "asc" } }),
    term || sp.brand || adj
      ? db.factorySetting.findMany({
          where: {
            ...(sp.brand ? { brand: sp.brand } : {}),
            ...(adj ? { adjustment: adj } : {}),
            ...(term
              ? {
                  OR: [
                    { brand: { contains: term, mode: "insensitive" } },
                    { models: { contains: term, mode: "insensitive" } },
                    ...(key.length >= 2 ? [{ modelKeys: { has: key } }] : []),
                    { label: { contains: term, mode: "insensitive" } },
                  ],
                }
              : {}),
          },
          orderBy: [{ brand: "asc" }, { models: "asc" }, { adjustment: "asc" }],
          take: 300,
        })
      : Promise.resolve([]),
  ]);
  const rows = await withFigures(rawRows);
  return (
    <div className="space-y-4">
      <form className="flex flex-wrap gap-2">
        <input type="hidden" name="tab" value="settings" />
        <label htmlFor="aq" className="sr-only">
          Model or brand
        </label>
        <input id="aq" name="q" defaultValue={term} className="input max-w-md" placeholder="Model or brand, e.g. MC6700P, Bernina, BES-1216" />
        <label htmlFor="ab" className="sr-only">
          Brand
        </label>
        <select id="ab" name="brand" defaultValue={sp.brand ?? ""} className="select w-44">
          <option value="">All brands</option>
          {brands.map((b) => (
            <option key={b.brand} value={b.brand}>
              {b.brand} ({b._count._all})
            </option>
          ))}
        </select>
        <label htmlFor="aa" className="sr-only">
          Adjustment
        </label>
        <select id="aa" name="adj" defaultValue={adj ?? ""} className="select w-56">
          <option value="">All adjustments</option>
          {ADJUSTMENTS.map((a) => (
            <option key={a.key} value={a.key}>
              {a.name}
            </option>
          ))}
        </select>
        <button className="btn btn-primary">Search</button>
      </form>
      {!(term || sp.brand || adj) ? (
        <div className="flex flex-wrap gap-2">
          {brands.map((b) => (
            <a key={b.brand} href={`/specs?tab=settings&brand=${encodeURIComponent(b.brand)}`} className="btn btn-sm">
              {b.brand} <span className="muted num">{b._count._all}</span>
            </a>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="muted">No setting matches.</p>
      ) : (
        <div className="card scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Model(s)</th>
                <th>Adjustment</th>
                <th>Factory</th>
                <th>Details</th>
                <th>Figure</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="font-semibold">{r.brand}</div>
                    <div className="text-xs">{r.models}</div>
                  </td>
                  <td>
                    <div className="font-semibold">{r.label}</div>
                    <div className="muted text-xs">{ADJ_NAME[r.adjustment]}</div>
                  </td>
                  <td className="num font-semibold whitespace-nowrap">{valueRange(r.valueMin, r.valueMax, r.unit) || r.valueText}</td>
                  <td className="min-w-56 text-xs">
                    {r.reference && <div>{r.reference}</div>}
                    {r.conditions && <div className="muted">{r.conditions}</div>}
                    {r.tools && <div>Tools: {r.tools}</div>}
                  </td>
                  <td className="min-w-40 text-xs">
                    <div className="muted max-w-48 truncate" title={r.sourceFile}>
                      {r.sourceFile}
                    </div>
                    <ManualFigure file={r.sourceFile} sourcePath={r.sourcePath} page={r.figurePage} box={r.figureBox} figureId={r.figureId} stored={r.figureStored} width={360} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
