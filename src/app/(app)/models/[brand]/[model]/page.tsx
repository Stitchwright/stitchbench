import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { modelKey } from "@/lib/format";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ModelPanel } from "@/components/model-panel";

export default async function ModelPage({ params }: { params: Promise<{ brand: string; model: string }> }) {
  const user = await requireUser();
  const p = await params;
  const brand = decodeURIComponent(p.brand);
  const model = decodeURIComponent(p.model);
  const key = modelKey(model);
  const [machines, parts] = await Promise.all([
    db.machine.findMany({
      where: { shopId: user.shopId, modelKey: key, brand: { equals: brand, mode: "insensitive" } },
      include: { customer: true, _count: { select: { tickets: true } } },
      orderBy: { createdAt: "desc" },
    }),
    db.part.findMany({
      where: { shopId: user.shopId, OR: [{ fits: { contains: model, mode: "insensitive" } }, { fits: { contains: key, mode: "insensitive" } }] },
      orderBy: { partNumber: "asc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title={`${brand} ${model}`} sub="Factory tension, gotchas, manuals, parts and every one we've serviced." back={{ href: "/machines", label: "Machines" }} />
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <ModelPanel shopId={user.shopId} brand={brand} model={model} showLink={false} />
        </div>
        <div className="space-y-6 xl:col-span-2">
          <Section title={`Serviced here (${machines.length})`}>
            {machines.length === 0 ? (
              <Empty>None yet.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {machines.map((m) => (
                  <li key={m.id} className="flex justify-between gap-2 py-2">
                    <Link href={`/machines/${m.id}`} className="link">
                      {m.serial ? <span className="mono">SN {m.serial}</span> : "No serial"}
                    </Link>
                    <span className="muted">
                      {m.customer?.name ?? ""} · {m._count.tickets} visit{m._count.tickets === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Parts in stock that fit">
            {parts.length === 0 ? (
              <Empty>No stocked part lists this model in its &ldquo;fits&rdquo; field.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {parts.map((pt) => (
                  <li key={pt.id} className="flex justify-between gap-2 py-2">
                    <Link href={`/parts/${pt.id}`} className="link min-w-0 truncate">
                      <span className="mono">{pt.partNumber}</span> {pt.description}
                    </Link>
                    <span className="num">{pt.qtyOnHand}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
