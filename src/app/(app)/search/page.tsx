import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { firstValues } from "@/lib/search-params";
import { modelKey, ticketNo } from "@/lib/format";
import { customerIdsByPhone } from "@/lib/phone-search";
import { PageHeader, Section, StatusPill, Empty, modelHref } from "@/components/ui";

export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const q = firstValues(await searchParams).q?.trim() ?? "";
  if (!q) redirect("/");
  const shopId = user.shopId;

  // A bare number is probably a ticket number.
  if (/^\d{1,6}$/.test(q)) {
    const t = await db.ticket.findFirst({ where: { shopId, number: Number(q) } });
    if (t) redirect(`/tickets/${t.id}`);
  }
  // Or a claim tag at a sewing shop ("T101" is how the tag's barcode reads): straight to that repair.
  if (/^t?\d{1,10}$/i.test(q)) {
    const job = await db.repairJob.findFirst({ where: { shopId, side: "retail", tag: q.replace(/^t/i, "") }, select: { id: true } });
    if (job) redirect(`/repairs/${job.id}`);
  }
  const key = modelKey(q);
  const phoneIds = await customerIdsByPhone(shopId, q);
  const [machines, customers, specs, parts] = await Promise.all([
    db.machine.findMany({
      where: {
        shopId,
        OR: [
          { serial: { contains: q, mode: "insensitive" } },
          { model: { contains: q, mode: "insensitive" } },
          ...(key ? [{ modelKey: { contains: key } }] : []),
        ],
      },
      include: { customer: true, tickets: { orderBy: { intakeAt: "desc" }, take: 1 } },
      take: 50,
    }),
    db.customer.findMany({
      where: { shopId, OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { id: { in: phoneIds } }, { email: { contains: q, mode: "insensitive" } }] },
      take: 20,
    }),
    key ? db.tensionSpec.findMany({ where: { modelKeys: { has: key } }, select: { brand: true, models: true }, take: 20 }) : Promise.resolve([]),
    db.part.findMany({
      where: { shopId, OR: [{ partNumber: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }] },
      take: 20,
    }),
  ]);
  const specModels = [...new Set(specs.map((s) => s.brand))];

  return (
    <div className="space-y-6">
      <PageHeader title={`Search: ${q}`} />
      <Section title={`Machines (${machines.length})`}>
        {machines.length === 0 ? (
          <Empty>No machine with that serial or model.</Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {machines.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <Link href={`/machines/${m.id}`} className="link font-semibold">
                    {m.brand} {m.model}
                  </Link>{" "}
                  {m.serial && <span className="mono muted">SN {m.serial}</span>} {m.customer && <span className="muted">· {m.customer.name}</span>}
                </span>
                {m.tickets[0] && (
                  <span className="flex items-center gap-2">
                    <Link href={`/tickets/${m.tickets[0].id}`} className="link mono">
                      #{ticketNo(m.tickets[0].number)}
                    </Link>
                    <StatusPill status={m.tickets[0].status} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {specModels.length > 0 && (
        <Section title="Model pages">
          <div className="flex flex-wrap gap-2">
            {specModels.map((b) => (
              <Link key={b} href={modelHref(b, q)} className="btn btn-sm">
                {b} {q}
              </Link>
            ))}
          </div>
        </Section>
      )}
      <Section title={`Customers (${customers.length})`}>
        {customers.length === 0 ? (
          <Empty>No customer matches.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {customers.map((c) => (
              <li key={c.id}>
                <Link href={`/customers/${c.id}`} className="link">
                  {c.name}
                </Link>{" "}
                <span className="muted">{c.phone}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {parts.length > 0 && (
        <Section title={`Parts (${parts.length})`}>
          <ul className="space-y-1 text-sm">
            {parts.map((p) => (
              <li key={p.id}>
                <Link href={`/parts/${p.id}`} className="link">
                  <span className="mono">{p.partNumber}</span> {p.description}
                </Link>{" "}
                <span className="muted">{p.qtyOnHand} on hand</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
