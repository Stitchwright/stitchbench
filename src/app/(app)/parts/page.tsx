import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { PartFields } from "@/components/part-fields";
import { createPart } from "@/actions/parts";

export default async function Parts({ searchParams }: { searchParams: Promise<{ q?: string; low?: string }> }) {
  const user = await requireUser();
  const { q, low } = await searchParams;
  const term = q?.trim();
  let parts = await db.part.findMany({
    where: {
      shopId: user.shopId,
      ...(term
        ? {
            OR: [
              { partNumber: { contains: term, mode: "insensitive" } },
              { description: { contains: term, mode: "insensitive" } },
              { fits: { contains: term, mode: "insensitive" } },
              { brand: { contains: term, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { partNumber: "asc" },
    take: 1000,
  });
  if (low === "1") parts = parts.filter((p) => p.qtyOnHand <= p.reorderAt);
  const value = parts.reduce((s, p) => s + (p.costCents ?? 0) * Math.max(0, p.qtyOnHand), 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Parts" sub={`${parts.length} part numbers · ${money(value)} on the shelf at cost`} />
      <form className="flex flex-wrap gap-2">
        <label htmlFor="pq" className="sr-only">
          Search parts
        </label>
        <input id="pq" name="q" defaultValue={term} className="input max-w-md" placeholder="Part number, description, fits model" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="low" value="1" defaultChecked={low === "1"} className="check" /> Low stock only
        </label>
        <button className="btn">Search</button>
      </form>
      <div className="card">
        {parts.length === 0 ? (
          <div className="card-pad">
            <Empty>No parts yet. Add the wear parts you keep on the shelf below.</Empty>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Part #</th>
                  <th>Description</th>
                  <th>Fits</th>
                  <th>Bin</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Price</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">
                      <Link href={`/parts/${p.id}`} className="link">
                        {p.partNumber}
                      </Link>
                    </td>
                    <td>
                      {p.description}
                      {p.brand && <div className="muted text-xs">{p.brand}</div>}
                    </td>
                    <td className="max-w-56 text-xs">{p.fits}</td>
                    <td>{p.location}</td>
                    <td className="num text-right">
                      <span className={p.qtyOnHand <= p.reorderAt ? `pill ${p.qtyOnHand <= 0 ? "tone-bad" : "tone-wait"}` : ""}>{p.qtyOnHand}</span>
                    </td>
                    <td className="num text-right">{money(p.priceCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Section title="Add a part">
        <ActionForm action={createPart} className="grid-form">
          <PartFields withQty />
          <div className="sm:col-span-2">
            <Submit>Add part</Submit>
          </div>
        </ActionForm>
      </Section>
    </div>
  );
}
