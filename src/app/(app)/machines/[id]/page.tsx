import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, Circle } from "lucide-react";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money, ticketNo } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { ticketTotals } from "@/lib/ticket-math";
import { MACHINE_TYPES, OPEN_STATUSES } from "@/lib/constants";
import { DEFAULT_CHECKLIST } from "@/lib/service-menu";
import { PageHeader, Section, StatusPill, KV, Empty, modelHref } from "@/components/ui";
import { PhotoStrip, PHOTO_SELECT } from "@/components/photo-strip";
import { ModelPanel } from "@/components/model-panel";
import { ModelMachines, ModelPhotos } from "@/components/model-history";
import { ShareForm } from "@/components/share-form";
import { SharedPosts } from "@/components/shared-posts";
import { ManualLinks } from "@/components/manual-links";
import { PartsThatFit } from "@/components/parts-that-fit";
import { ActionForm, Submit } from "@/components/action-form";
import { updateMachine } from "@/actions/records";

type Done = Record<string, { done: boolean; by?: string; at?: string }>;

function g(v: number | null) {
  return v == null ? "-" : `${v} g`;
}

export default async function MachinePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const { id } = await params;
  const m = await db.machine.findFirst({
    where: { id, shopId: user.shopId },
    include: {
      shop: { select: { checklistItems: true } },
      customer: true,
      photos: { select: PHOTO_SELECT, orderBy: { createdAt: "desc" } },
      tickets: { orderBy: { intakeAt: "desc" }, include: { lines: true, payments: true, tech: { select: { name: true } } } },
    },
  });
  if (!m) notFound();
  const customers = await db.customer.findMany({ where: { shopId: user.shopId }, orderBy: { name: "asc" }, select: { id: true, name: true } });

  const current = m.tickets.find((t) => OPEN_STATUSES.includes(t.status)) ?? m.tickets[0];
  const items = m.shop.checklistItems?.length ? m.shop.checklistItems : DEFAULT_CHECKLIST;
  const done = (current?.checklist ?? {}) as Done;
  // Show every item from the template, plus any item done on this ticket that the template no longer lists.
  const allItems = [...items, ...Object.keys(done).filter((k) => !items.includes(k))];

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/machines", label: "Machines" }}
        title={`${m.brand} ${m.model}`}
        sub={
          <>
            {m.serial ? <span className="mono">SN {m.serial}</span> : "No serial recorded"}
            {m.machineType && ` · ${m.machineType}`}
            {m.customer && (
              <>
                {" · "}
                <Link href={`/customers/${m.customer.id}`} className="link">
                  {m.customer.name}
                </Link>
              </>
            )}
          </>
        }
        actions={
          <>
            <Link href={modelHref(m.brand, m.model)} className="btn">
              Model page
            </Link>
            <Link href={`/tickets/new?machineId=${m.id}`} className="btn btn-primary">
              Start a ticket
            </Link>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          <Section title="Photos">
            <PhotoStrip machineId={m.id} ticketId={current && OPEN_STATUSES.includes(current.status) ? current.id : undefined} photos={m.photos} timeZone={tz} />
          </Section>

          <ShareForm
            machineId={m.id}
            model={`${m.brand} ${m.model}`}
            photos={m.photos}
            defaultBody={[current?.diagnosis, current?.workDone].filter(Boolean).join("\n\n") || undefined}
          />

          <ModelPhotos shopId={user.shopId} brand={m.brand} model={m.model} excludeMachineId={m.id} title={`Inside & wiring photos from other ${m.model}s`} hideWhenEmpty />

          {current ? (
            <Section
              title={
                <>
                  {OPEN_STATUSES.includes(current.status) ? "This visit" : "Last visit"}:{" "}
                  <Link href={`/tickets/${current.id}`} className="link mono">
                    #{ticketNo(current.number)}
                  </Link>
                </>
              }
              actions={<StatusPill status={current.status} />}
            >
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <h3 className="label mb-2">Accessories</h3>
                  {current.accessories.length === 0 ? (
                    <Empty>Machine only.</Empty>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {current.accessories.map((a, i) => {
                        const back = current.accessoriesReturned.includes(a);
                        return (
                          <li key={a + i} className="flex items-center gap-2">
                            {back ? (
                              <CheckCircle2 size={16} className="text-[var(--ok)]" aria-label="Returned" />
                            ) : (
                              <Circle size={16} className="text-ink-2" aria-label="Still with us" />
                            )}
                            {a}
                            {back && <span className="muted text-xs">returned</span>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <h3 className="label mt-5 mb-2">Tension readings</h3>
                  <dl className="num grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
                    <dt />
                    <dt className="muted text-xs">As found</dt>
                    <dt className="muted text-xs">As left</dt>
                    <dt>Upper</dt>
                    <dd>{g(current.upperFoundG)}</dd>
                    <dd className="font-semibold">{g(current.upperLeftG)}</dd>
                    <dt>Bobbin</dt>
                    <dd>{g(current.bobbinFoundG)}</dd>
                    <dd className="font-semibold">{g(current.bobbinLeftG)}</dd>
                  </dl>
                </div>
                <div>
                  <h3 className="label mb-2">
                    Service checklist ({allItems.filter((i) => done[i]?.done).length}/{allItems.length})
                  </h3>
                  <ul className="space-y-1.5 text-sm">
                    {allItems.map((item) => {
                      const d = done[item];
                      return (
                        <li key={item} className="flex gap-2">
                          {d?.done ? (
                            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[var(--ok)]" aria-label="Done" />
                          ) : (
                            <Circle size={16} className="mt-0.5 shrink-0 text-ink-2" aria-label="Not done" />
                          )}
                          <span className={d?.done ? "" : "muted"}>
                            {item}
                            {d?.done && (
                              <span className="muted block text-xs">
                                {d.by || "Someone"}
                                {d.at ? `, ${fmtDate(d.at, tz)}` : ""}
                              </span>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <Link href={`/tickets/${current.id}`} className="link mt-3 inline-block text-sm">
                    Open the ticket to tick items off
                  </Link>
                </div>
              </div>
            </Section>
          ) : (
            <Section title="Visits">
              <Empty>No tickets yet for this machine.</Empty>
            </Section>
          )}

          {m.tickets.length > 0 && (
            <Section title="Service history">
              <ul className="divide-y divide-line">
                {m.tickets.map((t) => {
                  const tot = ticketTotals(t.lines, t.payments, t.taxRatePct);
                  const ck = (t.checklist ?? {}) as Done;
                  const doneCount = Object.values(ck).filter((v) => v?.done).length;
                  return (
                    <li key={t.id} className="py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Link href={`/tickets/${t.id}`} className="link mono font-semibold">
                            #{ticketNo(t.number)}
                          </Link>
                          <span className="num text-sm">{fmtDate(t.intakeAt, tz)}</span>
                          <StatusPill status={t.status} />
                        </div>
                        <span className="num text-sm">{money(tot.total)}</span>
                      </div>
                      <div className="mt-1 text-sm">{t.workDone ?? t.diagnosis ?? t.problem ?? <span className="muted">No notes</span>}</div>
                      <div className="muted mt-1 text-xs">
                        {doneCount} checklist item{doneCount === 1 ? "" : "s"} done
                        {t.tech && ` · ${t.tech.name}`}
                        {(t.upperLeftG != null || t.bobbinLeftG != null) && ` · left at upper ${g(t.upperLeftG)}, bobbin ${g(t.bobbinLeftG)}`}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          <Section title="Machine details">
            <ActionForm action={updateMachine.bind(null, m.id)} success="Saved" className="grid-form">
              <div className="field">
                <label htmlFor="brand" className="label">
                  Brand
                </label>
                <input id="brand" name="brand" defaultValue={m.brand} required className="input" />
              </div>
              <div className="field">
                <label htmlFor="model" className="label">
                  Model
                </label>
                <input id="model" name="model" defaultValue={m.model} required className="input" />
              </div>
              <div className="field">
                <label htmlFor="serial" className="label">
                  Serial
                </label>
                <input id="serial" name="serial" defaultValue={m.serial ?? ""} className="input mono" />
              </div>
              <div className="field">
                <label htmlFor="machineType" className="label">
                  Type
                </label>
                <select id="machineType" name="machineType" defaultValue={m.machineType ?? ""} className="select">
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
                <select id="customerId" name="customerId" defaultValue={m.customerId ?? ""} className="select">
                  <option value="">-</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field sm:col-span-2">
                <label htmlFor="notes" className="label">
                  Notes about this machine
                </label>
                <textarea id="notes" name="notes" rows={2} defaultValue={m.notes ?? ""} className="textarea" />
              </div>
              <div className="sm:col-span-2">
                <Submit>Save</Submit>
              </div>
            </ActionForm>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <KV k="First seen" v={fmtDate(m.createdAt, tz)} />
              <KV k="Visits" v={String(m.tickets.length)} />
            </div>
          </Section>

          <ModelMachines shopId={user.shopId} brand={m.brand} model={m.model} excludeMachineId={m.id} title={`Other ${m.brand} ${m.model}s we've worked on`} hideWhenEmpty />
        </div>

        <div className="space-y-6 xl:col-span-2">
          <ModelPanel shopId={user.shopId} brand={m.brand} model={m.model} />
          <ManualLinks brand={m.brand} model={m.model} timeZone={tz} />
          <PartsThatFit shopId={user.shopId} brand={m.brand} model={m.model} />
          <SharedPosts user={user} brand={m.brand} model={m.model} title="Shared by techs" />
        </div>
      </div>
    </div>
  );
}
