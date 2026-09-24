import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { modelKey } from "@/lib/format";
import { PageHeader } from "@/components/ui";
import { SpecsTable } from "@/components/model-panel";

export default async function Specs({ searchParams }: { searchParams: Promise<{ q?: string; brand?: string }> }) {
  await requireUser();
  const { q, brand } = await searchParams;
  const term = q?.trim() ?? "";
  const key = modelKey(term);
  const [brands, specs] = await Promise.all([
    db.tensionSpec.groupBy({ by: ["brand"], _count: { _all: true }, orderBy: { brand: "asc" } }),
    term || brand
      ? db.tensionSpec.findMany({
          where: {
            ...(brand ? { brand } : {}),
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
  const total = brands.reduce((s, b) => s + b._count._all, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Factory tension specs"
        sub={`${total} gauge values read out of OEM service, technical and operator manuals. Upper = needle-thread pull-off, bobbin = bobbin-case pull-off, in grams-force.`}
      />
      <form className="flex flex-wrap gap-2">
        <label htmlFor="sq" className="sr-only">
          Model or brand
        </label>
        <input id="sq" name="q" defaultValue={term} className="input max-w-md" placeholder="Model or brand, e.g. PR655, Tajima, DDL-8700" />
        <label htmlFor="sb" className="sr-only">
          Brand
        </label>
        <select id="sb" name="brand" defaultValue={brand ?? ""} className="select w-48">
          <option value="">All brands</option>
          {brands.map((b) => (
            <option key={b.brand} value={b.brand}>
              {b.brand} ({b._count._all})
            </option>
          ))}
        </select>
        <button className="btn btn-primary">Search</button>
      </form>
      {term || brand ? (
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
      <p className="muted text-xs">
        Values are as printed, converted to grams at 1 N = 101.97 gf. Conditions matter: dial setting, thread size and where the thread is pulled.
        &ldquo;Open p.&rdquo; appears when the same manual is in your own manuals folder.
      </p>
    </div>
  );
}
