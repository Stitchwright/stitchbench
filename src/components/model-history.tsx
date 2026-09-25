// What this shop has seen of one model: every machine (by serial) and the inside/wiring photos taken on them.
import Link from "next/link";
import { db } from "@/lib/db";
import { fmtDate, modelKey, ticketNo } from "@/lib/format";
import { MODEL_PHOTO_KINDS, PHOTO_KIND_LABEL } from "@/lib/constants";
import { Section, Empty, StatusPill } from "@/components/ui";

type Props = { shopId: string; brand: string; model: string; excludeMachineId?: string; title: string; hideWhenEmpty?: boolean };

function sameModel(shopId: string, brand: string, model: string, excludeMachineId?: string) {
  return {
    shopId,
    modelKey: modelKey(model),
    brand: { equals: brand, mode: "insensitive" as const },
    ...(excludeMachineId ? { id: { not: excludeMachineId } } : {}),
  };
}

export async function ModelMachines({ shopId, brand, model, excludeMachineId, title, hideWhenEmpty }: Props) {
  const machines = await db.machine.findMany({
    where: sameModel(shopId, brand, model, excludeMachineId),
    include: {
      customer: { select: { id: true, name: true } },
      _count: { select: { tickets: true } },
      tickets: {
        orderBy: { intakeAt: "desc" },
        take: 1,
        select: { id: true, number: true, intakeAt: true, status: true, workDone: true, diagnosis: true, problem: true, tech: { select: { name: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  if (hideWhenEmpty && machines.length === 0) return null;
  return (
    <Section title={`${title} (${machines.length})`}>
      {machines.length === 0 ? (
        <Empty>None yet. Each machine checked in with this model shows up here with its serial and history.</Empty>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {machines.map((m) => {
            const last = m.tickets[0];
            return (
              <li key={m.id} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/machines/${m.id}`} className="link font-semibold">
                    {m.serial ? <span className="mono">SN {m.serial}</span> : "No serial"}
                  </Link>
                  <span className="muted text-xs">
                    {m.customer?.name ?? "No owner"} · {m._count.tickets} visit{m._count.tickets === 1 ? "" : "s"}
                  </span>
                </div>
                {last && (
                  <div className="muted mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <Link href={`/tickets/${last.id}`} className="link mono">
                      #{ticketNo(last.number)}
                    </Link>
                    <span>{fmtDate(last.intakeAt)}</span>
                    <StatusPill status={last.status} />
                    {last.tech && <span>{last.tech.name}</span>}
                    <span className="min-w-0 truncate">{last.workDone ?? last.diagnosis ?? last.problem ?? ""}</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

export async function ModelPhotos({ shopId, brand, model, excludeMachineId, title, hideWhenEmpty }: Props) {
  const photos = await db.machinePhoto.findMany({
    where: { shopId, kind: { in: MODEL_PHOTO_KINDS }, machine: sameModel(shopId, brand, model, excludeMachineId) },
    select: { id: true, kind: true, caption: true, createdAt: true, machine: { select: { id: true, serial: true } } },
    orderBy: [{ kind: "desc" }, { createdAt: "desc" }],
    take: 36,
  });
  if (hideWhenEmpty && photos.length === 0) return null;
  return (
    <Section title={`${title} (${photos.length})`}>
      {photos.length === 0 ? (
        <Empty>No inside or wiring photos yet. Add them from a machine page (&ldquo;Photo of: Wiring &amp; connectors&rdquo;) and they show up here for every {model}.</Empty>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos.map((p) => (
            <li key={p.id}>
              <a href={`/api/photos/${p.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded border border-line">
                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset */}
                <img src={`/api/photos/${p.id}`} alt={p.caption ?? PHOTO_KIND_LABEL[p.kind]} className="aspect-square w-full object-cover" loading="lazy" />
              </a>
              <p className="mt-1 text-xs">
                <span className="pill tone-neutral">{PHOTO_KIND_LABEL[p.kind]}</span> {p.caption}
              </p>
              <Link href={`/machines/${p.machine.id}`} className="link muted text-xs">
                {p.machine.serial ? `SN ${p.machine.serial}` : "Machine"} · {fmtDate(p.createdAt)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
