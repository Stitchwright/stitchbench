import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { firstValues } from "@/lib/search-params";
import { MACHINE_TYPES } from "@/lib/constants";
import { shopKinds } from "@/lib/equipment/shop";
import { PageHeader, Section, Empty, modelHref } from "@/components/ui";
import { KindChips } from "@/components/equipment/kind-chips";
import { picturesFor } from "@/lib/model-info";
import { modelKey } from "@/lib/format";
import { ActionForm, Submit } from "@/components/action-form";
import { createMachine } from "@/actions/records";

export default async function Machines({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string }> }) {
  const user = await requireUser();
  const { q, kind: kindParam } = firstValues(await searchParams);
  const term = q?.trim();
  // The kinds to filter by: those that have machines here, plus those that may take new work.
  const [{ all, usable }, used] = await Promise.all([shopKinds(user.shopId), db.machine.groupBy({ by: ["kind"], where: { shopId: user.shopId } })]);
  const usedKeys = new Set(used.map((u) => u.kind));
  const chips = all.filter((k) => usedKeys.has(k.key) || usable.includes(k));
  const active = kindParam && chips.some((k) => k.key === kindParam) ? kindParam : null;
  const showKind = chips.length > 1;
  const labelOf = new Map(all.map((k) => [k.key, k.label]));
  const listHref = (kind: string | null) => {
    const sp = new URLSearchParams();
    if (term) sp.set("q", term);
    if (kind) sp.set("kind", kind);
    const s = sp.toString();
    return s ? `/machines?${s}` : "/machines";
  };

  const [machines, customers] = await Promise.all([
    db.machine.findMany({
      where: {
        shopId: user.shopId,
        ...(active ? { kind: active } : {}),
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
  // With only sewing machines to add, the form is as it always was; with more, "What is it" and the kinds' types.
  const sewingOnly = usable.length === 1;
  return (
    <div className="space-y-6">
      <PageHeader title="Machines" sub="Every machine we've had on the bench, by serial number." />
      <form className="flex gap-2">
        <label htmlFor="mq" className="sr-only">
          Search machines
        </label>
        <input id="mq" name="q" defaultValue={term} className="input max-w-md" placeholder="Serial, model, brand or owner" />
        {active && <input type="hidden" name="kind" value={active} />}
        <button className="btn">Search</button>
      </form>
      {showKind && (
        <div className="no-print flex flex-wrap items-center gap-2 text-sm">
          <Link href={listHref(null)} className={`btn btn-sm ${active ? "" : "btn-primary"}`} aria-current={active ? undefined : "true"}>
            All
          </Link>
          <KindChips kinds={chips} active={active} hrefFor={(key) => listHref(key)} />
        </div>
      )}
      <div className="card">
        {machines.length === 0 ? (
          <div className="card-pad">
            <Empty>{term || active ? "No machine matches that." : "No machines yet. They're added when you check one in."}</Empty>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Machine</th>
                  {showKind && <th>Kind</th>}
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
                    {showKind && <td className="text-sm">{labelOf.get(m.kind) ?? m.kind}</td>}
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
          {sewingOnly ? (
            <input type="hidden" name="kind" value="sewing" />
          ) : (
            <div className="field sm:col-span-2">
              <label htmlFor="kind" className="label">
                What is it
              </label>
              <select id="kind" name="kind" className="select" defaultValue={active && usable.some((k) => k.key === active) ? active : "sewing"}>
                {usable.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
          )}
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
              {sewingOnly
                ? MACHINE_TYPES.map((t) => <option key={t}>{t}</option>)
                : usable
                    .filter((k) => k.types.length)
                    .map((k) => (
                      <optgroup key={k.key} label={k.label}>
                        {k.types.map((t) => (
                          <option key={`${k.key}:${t}`} value={t}>
                            {t}
                          </option>
                        ))}
                      </optgroup>
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
