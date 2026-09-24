import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { MACHINE_TYPES } from "@/lib/constants";
import { PageHeader, Section, Empty, modelHref } from "@/components/ui";
import { picturesFor } from "@/lib/model-info";
import { modelKey } from "@/lib/format";
import { ActionForm, Submit } from "@/components/action-form";
import { createMachine } from "@/actions/records";

export default async function Machines({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const { q } = await searchParams;
  const term = q?.trim();
  const [machines, customers] = await Promise.all([
    db.machine.findMany({
      where: {
        shopId: user.shopId,
        ...(term
          ? {
              OR: [
                { serial: { contains: term, mode: "insensitive" } },
                { model: { contains: term, mode: "insensitive" } },
                { brand: { contains: term, mode: "insensitive" } },
                { customer: { name: { contains: term, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      include: { customer: true, _count: { select: { tickets: true, photos: true } } },
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
    db.customer.findMany({ where: { shopId: user.shopId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  const pics = await picturesFor(machines.map((m) => ({ brand: m.brand, model: m.model })));
  return (
    <div className="space-y-6">
      <PageHeader title="Machines" sub="Every machine we've had on the bench, by serial number." />
      <form className="flex gap-2">
        <label htmlFor="mq" className="sr-only">
          Search machines
        </label>
        <input id="mq" name="q" defaultValue={term} className="input max-w-md" placeholder="Serial, model, brand or owner" />
        <button className="btn">Search</button>
      </form>
      <div className="card">
        {machines.length === 0 ? (
          <div className="card-pad">
            <Empty>{term ? "No machine matches that." : "No machines yet. They're added when you check one in."}</Empty>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Machine</th>
                  <th>Serial</th>
                  <th>Owner</th>
                  <th className="text-right">Visits</th>
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        {pics.get(`${m.brand}|${modelKey(m.model)}`) ? (
                          // eslint-disable-next-line @next/next/no-img-element -- authenticated image route
                          <img
                            src={`/api/model-images/${pics.get(`${m.brand}|${modelKey(m.model)}`)}`}
                            alt=""
                            className="h-10 w-14 shrink-0 rounded border border-line bg-white object-contain"
                            loading="lazy"
                          />
                        ) : (
                          <div className="h-10 w-14 shrink-0 rounded border border-dashed border-line" aria-hidden />
                        )}
                        <div>
                          <Link href={`/machines/${m.id}`} className="link font-semibold">
                            {m.brand} {m.model}
                          </Link>
                          {m.machineType && <div className="muted text-xs">{m.machineType}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="mono">{m.serial ?? "-"}</td>
                    <td>{m.customer?.name ?? "-"}</td>
                    <td className="num text-right">{m._count.tickets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Section title="Add a machine without a ticket">
        <ActionForm action={createMachine} className="grid-form">
          <div className="field">
            <label htmlFor="brand" className="label">
              Brand
            </label>
            <input id="brand" name="brand" required className="input" />
          </div>
          <div className="field">
            <label htmlFor="model" className="label">
              Model
            </label>
            <input id="model" name="model" required className="input" />
          </div>
          <div className="field">
            <label htmlFor="serial" className="label">
              Serial
            </label>
            <input id="serial" name="serial" className="input mono" />
          </div>
          <div className="field">
            <label htmlFor="machineType" className="label">
              Type
            </label>
            <select id="machineType" name="machineType" className="select" defaultValue="">
              <option value="">-</option>
              {MACHINE_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="field sm:col-span-2">
            <label htmlFor="customerId" className="label">
              Owner
            </label>
            <select id="customerId" name="customerId" className="select" defaultValue="">
              <option value="">-</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Submit>Add machine</Submit>
          </div>
        </ActionForm>
      </Section>
      <p className="muted text-sm">
        Looking up a model you haven&apos;t seen? Open{" "}
        <Link className="link" href={modelHref("Brother", "PR655")}>
          a model page
        </Link>{" "}
        directly, or search <Link className="link" href="/specs">tension specs</Link>.
      </p>
    </div>
  );
}
