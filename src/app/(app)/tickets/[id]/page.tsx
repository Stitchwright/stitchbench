import Link from "next/link";
import { notFound } from "next/navigation";
import { Trash2, Printer } from "lucide-react";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money, ticketNo } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { lineTotal, ticketTotals } from "@/lib/ticket-math";
import { LINE_LABEL, PAYMENT_LABEL, SITE_STATUS_LABEL, SITE_STATUS_ORDER } from "@/lib/constants";
import { specsFor, settingsFor, gRange } from "@/lib/model-info";
import { valueRange } from "@/lib/adjustments";
import { getModules } from "@/lib/modules";
import { canWorkOn } from "@/lib/equipment/gate";
import { checklistFor, kindOf, servicesFor } from "@/lib/equipment/shop";
import { INSTALL_CHECKLIST } from "@/lib/vac/installs";
import { PageHeader, Section, KV, modelHref } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Checklist, StatusSelect } from "@/components/ticket-controls";
import { PartPicker } from "@/components/part-picker";
import { PhotoStrip, PHOTO_SELECT } from "@/components/photo-strip";
import { ModelPanel } from "@/components/model-panel";
import { ModuleNotice } from "@/components/module-notice";
import { HintForm } from "@/components/hint-form";
import { IntakeFields } from "@/components/equipment/intake-fields";
import { ReadingsPanel } from "@/components/equipment/readings-panel";
import { DetailsList } from "@/components/equipment/details-list";
import { SitePanel } from "@/components/vac/site-panel";
import { TicketEstimateSlot } from "@/components/slots/ticket-estimate";
import { TicketWaitsSlot } from "@/components/slots/ticket-waits";
import { TicketNoticesSlot } from "@/components/slots/ticket-notices";
import { TicketAssistantSlot } from "@/components/slots/ticket-assistant";
import { UnitBadge } from "@/components/vac/unit-badge";
import { addLine, addPayment, removeAccessory, removeLine, removePayment, saveAccessories, saveIntake, saveMeasurements, saveTension, saveTicketText } from "@/actions/tickets";
import { saveNoteForShop } from "@/actions/repair-jobs";

function inRange(v: number | null, min: number | null, max: number | null) {
  if (v == null || min == null) return null;
  return v >= min && (max == null || v <= max);
}

function Reading({ id, label, value, min, max }: { id: string; label: string; value: number | null; min: number | null; max: number | null }) {
  const ok = inRange(value, min, max);
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input id={id} name={id} defaultValue={value ?? ""} inputMode="decimal" className="input num" placeholder="g" />
        {ok === true && <span className="pill tone-ready">in spec</span>}
        {ok === false && <span className="pill tone-bad">out</span>}
      </div>
    </div>
  );
}

const grams = (v: number | null) => (v == null ? null : `${v} g`);
const sewing = (k: { key: string }) => k.key === "sewing";

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const { id } = await params;
  const t = await db.ticket.findFirst({
    where: { id, shopId: user.shopId },
    include: {
      shop: true,
      machine: { include: { photos: { select: PHOTO_SELECT, orderBy: { createdAt: "desc" } } } },
      customer: true,
      viaAccount: true,
      lines: { orderBy: { createdAt: "asc" } },
      payments: { orderBy: { paidAt: "asc" } },
      tech: true,
      site: true,
    },
  });
  if (!t) notFound();
  const m = t.machine;
  // What kind of thing it is, and whether its module still allows work on this ticket (modules-design.md 6.3: a ticket
  // that came in before the module ended can be finished; otherwise only closing it out is left).
  const kind = await kindOf(user.shopId, m);
  const canWork = await canWorkOn(user.shopId, m.equipment, { intakeAt: t.intakeAt, status: t.status });
  const isSite = t.jobType === "SITE";
  // Came in through a partner sewing shop (StitchShop)?
  const job = await db.repairJob.findUnique({ where: { ticketId: t.id } });
  const jobLink = job ? await db.partnerLink.findUnique({ where: { shopId_id: { shopId: user.shopId, id: job.linkId } } }) : null;

  const [services, techs, specs, settings, mods] = await Promise.all([
    servicesFor(user.shopId, kind.key),
    db.user.findMany({ where: { shopId: user.shopId, active: true }, orderBy: { name: "asc" } }),
    kind.panels.tension ? specsFor(m.brand, m.model) : ([] as Awaited<ReturnType<typeof specsFor>>),
    kind.panels.timing ? settingsFor(m.brand, m.model) : ([] as Awaited<ReturnType<typeof settingsFor>>),
    canWork ? null : getModules(user.shopId),
  ]);
  const blocked = !canWork && kind.module && mods ? mods.states[kind.module] : null;
  const measurable = settings.filter((x) => (x.valueMin != null || x.valueMax != null) && (x.unit === "mm" || x.unit === "deg"));
  const meas = (t.measurements ?? {}) as Record<string, { found?: number; left?: number }>;
  const spec = specs.find((s) => s.upperMinG != null || s.bobbinMinG != null);
  // Payments that were removed stay on the ticket, each beside the negative one that undid it.
  const reversed = new Set(t.payments.map((p) => p.reversesId).filter((x): x is string => !!x));
  const tot = ticketTotals(t.lines, t.payments, t.taxRatePct, t.tradeCommissionPct ?? t.viaAccount?.commissionPct, job?.commissionCents);
  const checklistItems = isSite ? INSTALL_CHECKLIST : checklistFor(kind, t.shop);
  const checklist = (t.checklist ?? {}) as Record<string, { done: boolean; by?: string; at?: string }>;
  const readings = (t.readings ?? {}) as Record<string, { found?: string | number; left?: string | number }>;
  const details = (m.details ?? {}) as Record<string, unknown>;
  const intake = (t.intake ?? {}) as Record<string, unknown>;
  const noun = kind.noun;
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const hasIntake = kind.intakeFields.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/tickets", label: "Tickets" }}
        title={
          isSite ? (
            <>
              Install <span className="mono">#{ticketNo(t.number)}</span> · {t.site?.address ?? `${m.brand} ${m.model}`}
            </>
          ) : (
            <>
              <span className="mono">#{ticketNo(t.number)}</span> {m.brand} {m.model}
            </>
          )
        }
        sub={
          <>
            {t.customer ? (
              <Link href={`/customers/${t.customer.id}`} className="link">
                {t.customer.name}
              </Link>
            ) : (
              "No customer"
            )}
            {t.customer?.phone && ` · ${t.customer.phone}`}
            {t.viaAccount && ` · via ${t.viaAccount.name}`}
            {isSite && ` · ${m.brand} ${m.model}`}
            {m.serial && (
              <>
                {" · "}
                <span className="mono">SN {m.serial}</span>
              </>
            )}{" "}
            · in {fmtDate(t.intakeAt, tz)}
          </>
        }
        actions={
          <>
            <Link href={`/machines/${m.id}`} className="btn">
              {sewing(kind) ? "Machine history" : `${Noun} history`}
            </Link>
            <Link href={`/tickets/${t.id}/invoice`} className="btn">
              <Printer size={14} aria-hidden /> Invoice
            </Link>
          </>
        }
      />
      {m.equipment === "VACUUM" && <UnitBadge machineId={m.id} user={user} />}

      {!canWork &&
        (blocked ? (
          <ModuleNotice state={blocked} what={`This ${isSite ? "install" : "ticket"}`} admin={user.role !== "TECH"} shop={t.shop} />
        ) : (
          <div className="card card-pad text-sm" role="status">
            This record was made by a newer version of StitchBench. Update the program to change it.
          </div>
        ))}

      {job && (
        <section className="card card-pad mb-6 space-y-2 text-sm">
          <div>
            From partner shop{" "}
            <Link href={`/partners/${job.linkId}`} className="link font-semibold">
              {jobLink?.partnerName ?? "partner"}
            </Link>
            : their tag <strong className="mono">{job.tag}</strong>, customer {job.customerName}
            <div className="muted text-xs">They see this ticket&apos;s status and bill. Set &quot;Waiting on customer OK&quot; and they call the customer.</div>
            {job.approval && (
              <span className={`pill ml-1 ${job.approval === "APPROVED" ? "tone-done" : "tone-bad"}`}>
                customer {job.approval === "APPROVED" ? `approved${job.approvedCents != null ? ` up to ${money(job.approvedCents)}` : ""}` : "declined"}
              </span>
            )}
          </div>
          <ActionForm action={saveNoteForShop.bind(null, t.id)} className="flex flex-wrap items-end gap-2" success="The shop will see it">
            <div className="field min-w-64 flex-1">
              <label htmlFor="repairNote" className="label">
                Note for {jobLink?.partnerName ?? "the shop"} (what it needs, what it&apos;ll cost, when it&apos;s back)
              </label>
              <input id="repairNote" name="repairNote" defaultValue={job.repairNote ?? ""} className="input" />
            </div>
            <Submit className="btn btn-sm">Send note</Submit>
          </ActionForm>
        </section>
      )}

      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          {isSite && <SitePanel ticketId={t.id} user={user} readOnly={!canWork} />}

          <TicketEstimateSlot ticketId={t.id} user={user} />
          <TicketWaitsSlot ticketId={t.id} user={user} canWork={canWork} />
          <Section title="Status and work">
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <StatusSelect
                ticketId={t.id}
                status={t.status}
                partnerOwns={job?.side === "repair" && !job.pickedUpAt}
                order={isSite ? SITE_STATUS_ORDER : undefined}
                labels={isSite ? SITE_STATUS_LABEL : undefined}
                closingOnly={!canWork}
              />
              <KV k={isSite ? "Done" : "Ready"} v={t.readyAt ? fmtDate(t.readyAt, tz) : null} />
              <KV k="Warranty until" v={t.warrantyUntil ? fmtDate(t.warrantyUntil, tz) : null} />
            </div>
            {canWork ? (
              <ActionForm action={saveTicketText.bind(null, t.id)} success="Saved" className="space-y-3">
                {/* What each field showed when the page loaded: only what's changed here is saved, so a change made
                  meanwhile by someone else isn't put back. */}
                {(
                  [
                    ["serviceRequested", t.serviceRequested],
                    ["techId", t.techId],
                    ["problem", t.problem],
                    ["diagnosis", t.diagnosis],
                    ["workDone", t.workDone],
                    ["preApproved", t.preApprovedCents != null ? (t.preApprovedCents / 100).toFixed(2) : null],
                    ["approved", t.approvedCents != null ? (t.approvedCents / 100).toFixed(2) : null],
                    ["notes", t.notes],
                  ] as const
                ).map(([k, v]) => (
                  <input key={k} type="hidden" name={`was:${k}`} value={v ?? ""} />
                ))}
                <div className="grid-form">
                  <div className="field">
                    <label htmlFor="serviceRequested" className="label">
                      Service requested
                    </label>
                    <input id="serviceRequested" name="serviceRequested" defaultValue={t.serviceRequested ?? ""} className="input" />
                  </div>
                  <div className="field">
                    <label htmlFor="techId" className="label">
                      Tech
                    </label>
                    <select id="techId" name="techId" defaultValue={t.techId ?? ""} className="select">
                      <option value="">-</option>
                      {techs.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field sm:col-span-2">
                    <label htmlFor="problem" className="label">
                      Problem reported
                    </label>
                    <textarea id="problem" name="problem" rows={2} defaultValue={t.problem ?? ""} className="textarea" />
                  </div>
                  <div className="field sm:col-span-2">
                    <label htmlFor="diagnosis" className="label">
                      What we found
                    </label>
                    <textarea id="diagnosis" name="diagnosis" rows={3} defaultValue={t.diagnosis ?? ""} className="textarea" />
                  </div>
                  <div className="field sm:col-span-2">
                    <label htmlFor="workDone" className="label">
                      Work done (prints on the invoice)
                    </label>
                    <textarea id="workDone" name="workDone" rows={3} defaultValue={t.workDone ?? ""} className="textarea" />
                  </div>
                  <div className="field">
                    <label htmlFor="preApproved" className="label">
                      Pre-approved over service ($)
                    </label>
                    <input id="preApproved" name="preApproved" defaultValue={t.preApprovedCents != null ? (t.preApprovedCents / 100).toFixed(2) : ""} className="input num" />
                  </div>
                  <div className="field">
                    <label htmlFor="approved" className="label">
                      Customer approved ($)
                    </label>
                    <input id="approved" name="approved" defaultValue={t.approvedCents != null ? (t.approvedCents / 100).toFixed(2) : ""} className="input num" />
                  </div>
                  <div className="field sm:col-span-2">
                    <label htmlFor="notes" className="label">
                      Internal notes
                    </label>
                    <textarea id="notes" name="notes" rows={2} defaultValue={t.notes ?? ""} className="textarea" />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Submit>Save</Submit>
                </div>
              </ActionForm>
            ) : (
              // Read only: what the ticket says, with nothing to change.
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <KV k="Service requested" v={t.serviceRequested} />
                <KV k="Tech" v={t.tech?.name} />
                <KV k="Pre-approved" v={t.preApprovedCents != null ? money(t.preApprovedCents) : null} />
                <KV k="Customer approved" v={t.approvedCents != null ? money(t.approvedCents) : null} />
                <div className="col-span-2 sm:col-span-3">
                  <KV k="Problem reported" v={t.problem && <span className="whitespace-pre-wrap">{t.problem}</span>} />
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <KV k="What we found" v={t.diagnosis && <span className="whitespace-pre-wrap">{t.diagnosis}</span>} />
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <KV k="Work done" v={t.workDone && <span className="whitespace-pre-wrap">{t.workDone}</span>} />
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <KV k="Internal notes" v={t.notes && <span className="whitespace-pre-wrap">{t.notes}</span>} />
                </div>
              </div>
            )}
          </Section>

          <TicketAssistantSlot ticketId={t.id} user={user} canWork={canWork} partnerJob={job?.side === "repair"} />

          <Section title={isSite ? "Install checklist" : "Service checklist"}>
            <fieldset disabled={!canWork} className="min-w-0">
              <Checklist ticketId={t.id} items={checklistItems} state={checklist} timeZone={tz} />
            </fieldset>
            {kind.panels.tension && (
              <div className="mt-5 border-t border-line pt-4">
                <h3 className="font-semibold">Tension gauge readings</h3>
                <p className="muted mb-3 text-sm">
                  {spec ? (
                    <>
                      Factory: upper <strong className="num">{gRange(spec.upperMinG, spec.upperMaxG) || "-"}</strong>, bobbin{" "}
                      <strong className="num">{gRange(spec.bobbinMinG, spec.bobbinMaxG) || "-"}</strong>
                      {spec.upperConditions && ` (${spec.upperConditions})`}
                    </>
                  ) : (
                    "No factory gauge spec on file for this model. Readings are still worth recording."
                  )}
                </p>
                {canWork ? (
                  <ActionForm action={saveTension.bind(null, t.id)} success="Readings saved">
                    <div className="grid gap-3 sm:grid-cols-4">
                      <Reading id="upperFoundG" label="Upper as found" value={t.upperFoundG} min={spec?.upperMinG ?? null} max={spec?.upperMaxG ?? null} />
                      <Reading id="upperLeftG" label="Upper as left" value={t.upperLeftG} min={spec?.upperMinG ?? null} max={spec?.upperMaxG ?? null} />
                      <Reading id="bobbinFoundG" label="Bobbin as found" value={t.bobbinFoundG} min={spec?.bobbinMinG ?? null} max={spec?.bobbinMaxG ?? null} />
                      <Reading id="bobbinLeftG" label="Bobbin as left" value={t.bobbinLeftG} min={spec?.bobbinMinG ?? null} max={spec?.bobbinMaxG ?? null} />
                    </div>
                    <div className="mt-3 flex justify-end">
                      <Submit className="btn">Save tension readings</Submit>
                    </div>
                  </ActionForm>
                ) : (
                  <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <KV k="Upper as found" v={grams(t.upperFoundG)} />
                    <KV k="Upper as left" v={grams(t.upperLeftG)} />
                    <KV k="Bobbin as found" v={grams(t.bobbinFoundG)} />
                    <KV k="Bobbin as left" v={grams(t.bobbinLeftG)} />
                  </div>
                )}
              </div>
            )}
            {kind.panels.timing && measurable.length > 0 && canWork && (
              <div className="mt-5 border-t border-line pt-4">
                <h3 className="font-semibold">Timing and adjustment readings</h3>
                <p className="muted mb-3 text-sm">Factory standard from the service manual. Enter what you measured before and after.</p>
                <ActionForm action={saveMeasurements.bind(null, t.id)} success="Timing readings saved">
                  <div className="scroll-x">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Adjustment</th>
                          <th>Factory</th>
                          <th>As found</th>
                          <th>As left</th>
                        </tr>
                      </thead>
                      <tbody>
                        {measurable.map((x) => {
                          const r = meas[x.id] ?? {};
                          const ok = (v?: number) => (v == null ? null : (x.valueMin == null || v >= x.valueMin) && (x.valueMax == null || v <= x.valueMax));
                          const unit = x.unit === "deg" ? "°" : "mm";
                          return (
                            <tr key={x.id}>
                              <td>
                                <div className="font-semibold">{x.label}</div>
                                {x.conditions && <div className="muted text-xs">{x.conditions}</div>}
                              </td>
                              <td className="num whitespace-nowrap">{valueRange(x.valueMin, x.valueMax, x.unit)}</td>
                              {(["found", "left"] as const).map((k) => (
                                <td key={k}>
                                  <div className="flex items-center gap-1">
                                    <input name={`${k}:${x.id}`} aria-label={`${x.label} as ${k}`} defaultValue={r[k] ?? ""} inputMode="decimal" className="input num w-20" placeholder={unit} />
                                    {ok(r[k]) === true && <span className="pill tone-ready">ok</span>}
                                    {ok(r[k]) === false && <span className="pill tone-bad">out</span>}
                                  </div>
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Submit className="btn">Save timing readings</Submit>
                  </div>
                </ActionForm>
              </div>
            )}
            {!isSite && !kind.panels.tension && kind.readings.length > 0 && (
              <div className="mt-5 border-t border-line pt-4">
                <h3 className="mb-3 font-semibold">Readings</h3>
                <ReadingsPanel ticketId={t.id} defs={kind.readings} values={readings} readOnly={!canWork} />
              </div>
            )}
          </Section>

          <Section title="Charges">
            {t.lines.length > 0 && (
              <div className="scroll-x mb-4">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="text-right">Qty</th>
                      <th className="text-right">Each</th>
                      <th className="text-right">Total</th>
                      {canWork && <th className="no-print" />}
                    </tr>
                  </thead>
                  <tbody>
                    {t.lines.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <span className="label mr-2">{LINE_LABEL[l.kind]}</span>
                          {l.description}
                        </td>
                        <td className="num text-right">{l.qty}</td>
                        <td className="num text-right">{money(l.unitPriceCents)}</td>
                        <td className="num text-right">{money(lineTotal(l))}</td>
                        {canWork && (
                          <td className="no-print text-right">
                            <ActionButton action={removeLine.bind(null, l.id)} className="btn btn-sm btn-danger" confirm="Remove?" title="Remove line">
                              <Trash2 size={12} aria-label="Remove" />
                            </ActionButton>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <dl className="num mb-4 ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
              <dt className="muted">Subtotal</dt>
              <dd className="text-right">{money(tot.subtotal)}</dd>
              <dt className="muted">Tax ({t.taxRatePct}%)</dt>
              <dd className="text-right">{money(tot.tax)}</dd>
              <dt className="font-semibold">Total</dt>
              <dd className="text-right font-semibold">{money(tot.total)}</dd>
              <dt className="muted">Paid</dt>
              <dd className="text-right">{money(tot.paid)}</dd>
              <dt className="font-semibold">Balance</dt>
              <dd className={`text-right font-semibold ${tot.balance > 0 ? "text-thread" : ""}`}>{money(tot.balance)}</dd>
              {tot.commission > 0 && (
                <>
                  <dt className="muted">Shop commission</dt>
                  <dd className="text-right">{money(tot.commission)}</dd>
                </>
              )}
            </dl>

            {canWork && (
              <div className="grid gap-4 md:grid-cols-2">
                <ActionForm action={addLine.bind(null, t.id)} reset className="space-y-2 rounded border border-line p-3">
                  <input type="hidden" name="kind" value="SERVICE" />
                  <div className="label">Add service</div>
                  <select name="serviceItemId" aria-label="Service" className="select" defaultValue="">
                    <option value="">Custom (type below)</option>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {money(s.priceCents)}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <input name="description" aria-label="Custom description" className="input" placeholder="Custom description" />
                    <input name="price" aria-label="Price" inputMode="decimal" className="input num w-28" placeholder="$ price" />
                  </div>
                  <Submit className="btn btn-sm">Add service</Submit>
                </ActionForm>

                <ActionForm action={addLine.bind(null, t.id)} reset className="space-y-2 rounded border border-line p-3">
                  <input type="hidden" name="kind" value="LABOR" />
                  <div className="label">Add labor ({money(t.shop.laborRateCents)}/hr)</div>
                  <div className="flex gap-2">
                    <input name="hours" aria-label="Hours" inputMode="decimal" className="input num w-28" placeholder="hours" required />
                    <input name="description" aria-label="Labor description" className="input" placeholder="Repair labor" />
                  </div>
                  <Submit className="btn btn-sm">Add labor</Submit>
                </ActionForm>

                <ActionForm action={addLine.bind(null, t.id)} reset className="space-y-2 rounded border border-line p-3">
                  <input type="hidden" name="kind" value="PART" />
                  <div className="label">Add part from inventory</div>
                  <PartPicker />
                  <div className="flex gap-2">
                    <input name="qty" aria-label="Quantity" inputMode="numeric" defaultValue="1" className="input num w-20" />
                    <input name="price" aria-label="Price each" inputMode="decimal" className="input num" placeholder="$ each (blank = list price)" />
                  </div>
                  <input name="description" aria-label="Description if not stocked" className="input" placeholder="Not stocked? Describe it here" />
                  <Submit className="btn btn-sm">Add part</Submit>
                </ActionForm>

                <ActionForm action={addLine.bind(null, t.id)} reset className="space-y-2 rounded border border-line p-3">
                  <div className="label">Add fee or discount</div>
                  <select name="kind" aria-label="Fee or discount" className="select" defaultValue="FEE">
                    <option value="FEE">Fee</option>
                    <option value="DISCOUNT">Discount</option>
                  </select>
                  <div className="flex gap-2">
                    <input name="description" aria-label="Description" className="input" placeholder="e.g. Storage fee" />
                    <input name="price" aria-label="Amount" inputMode="decimal" className="input num w-28" placeholder="$" required />
                  </div>
                  <Submit className="btn btn-sm">Add</Submit>
                </ActionForm>
              </div>
            )}
          </Section>

          <Section title="Payments">
            {t.payments.length > 0 && (
              <ul className="mb-4 divide-y divide-line text-sm">
                {t.payments.map((p) => (
                  <li key={p.id} className={`flex items-center justify-between gap-3 py-2${reversed.has(p.id) ? " muted" : ""}`}>
                    <span>
                      {fmtDate(p.paidAt, tz)} · {PAYMENT_LABEL[p.method]}
                      {reversed.has(p.id) && <span> · removed</span>}
                      {p.method === "INVOICE" && <span className="muted"> · billed to the account: owed until it&apos;s paid</span>}
                      {p.note && <span className="muted"> · {p.note}</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="num font-semibold">{money(p.amountCents)}</span>
                      {!p.reversesId && !reversed.has(p.id) && (
                        <ActionButton action={removePayment.bind(null, p.id)} className="btn btn-sm btn-danger" confirm="Remove?" title="Remove payment">
                          <Trash2 size={12} aria-label="Remove" />
                        </ActionButton>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <ActionForm
              // remount when the balance changes so the amount box always shows the current balance
              key={tot.balance}
              action={addPayment.bind(null, t.id)}
              reset
              success="Payment recorded"
              className="flex flex-wrap items-end gap-2"
            >
              <div className="field">
                <label htmlFor="amount" className="label">
                  Amount
                </label>
                <input id="amount" name="amount" inputMode="decimal" className="input num w-32" defaultValue={tot.balance > 0 ? (tot.balance / 100).toFixed(2) : ""} required />
              </div>
              <div className="field">
                <label htmlFor="method" className="label">
                  Method
                </label>
                <select id="method" name="method" className="select" defaultValue="CARD">
                  {Object.entries(PAYMENT_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field min-w-40 flex-1">
                <label htmlFor="payNote" className="label">
                  Note
                </label>
                <input id="payNote" name="note" className="input" placeholder="check #, last 4..." />
              </div>
              <Submit>Record payment</Submit>
            </ActionForm>
          </Section>
        </div>

        <div className="space-y-6 xl:col-span-2">
          {!isSite && hasIntake && (
            <Section title="Details">
              <DetailsList kind={kind} details={details} intake={intake} />
              {canWork && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer font-semibold">Change</summary>
                  <ActionForm action={saveIntake.bind(null, t.id)} success="Saved" className="mt-3 space-y-3">
                    <div className="grid-form">
                      <IntakeFields defs={kind.intakeFields} on="machine" values={details} />
                      <IntakeFields defs={kind.intakeFields} on="ticket" values={intake} />
                    </div>
                    <div className="flex justify-end">
                      <Submit className="btn btn-sm">Save details</Submit>
                    </div>
                  </ActionForm>
                </details>
              )}
            </Section>
          )}

          <TicketNoticesSlot ticketId={t.id} user={user} />
          <Section title="Photos">
            <fieldset disabled={!canWork} className="min-w-0">
              <PhotoStrip machineId={m.id} ticketId={t.id} photos={m.photos} timeZone={tz} />
            </fieldset>
          </Section>

          {/* A hint about the model for every shop on the hub: brand, model and the photos to tick, nothing from this ticket. */}
          {!isSite && <HintForm hint={{ machineId: m.id, brand: m.brand, model: m.model, photos: m.photos }} />}

          {!isSite && (
            <Section title="Accessories">
              {t.accessories.length === 0 ? (
                <p className="muted mb-3 text-sm">Nothing logged. {Noun} only.</p>
              ) : (
                <ActionForm action={saveAccessories.bind(null, t.id)} success="Saved" className="mb-3">
                  <p className="muted mb-2 text-xs">Tick each item as it goes back to the customer.</p>
                  <ul className="space-y-1">
                    {t.accessories.map((a, i) => (
                      <li key={a + i} className="flex items-center gap-2">
                        <input id={`acc-${i}`} type="checkbox" name="returned" value={a} className="check" defaultChecked={t.accessoriesReturned.includes(a)} />
                        <label htmlFor={`acc-${i}`} className="flex-1 text-sm">
                          {a}
                        </label>
                        {canWork && (
                          <ActionButton action={removeAccessory.bind(null, t.id, a)} className="btn btn-sm btn-danger" confirm="Remove?" title="Remove item">
                            <Trash2 size={12} aria-label="Remove" />
                          </ActionButton>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs">
                      {t.accessoriesReturned.length}/{t.accessories.length} returned
                    </span>
                    <Submit className="btn btn-sm">Save returned</Submit>
                  </div>
                </ActionForm>
              )}
              {canWork && (
                <ActionForm action={saveAccessories.bind(null, t.id)} reset className="flex gap-2">
                  {t.accessoriesReturned.map((a) => (
                    <input key={a} type="hidden" name="returned" value={a} />
                  ))}
                  <label htmlFor="acc-add" className="sr-only">
                    Add accessories
                  </label>
                  <input id="acc-add" name="add" className="input" placeholder="Add items, comma separated" />
                  <Submit className="btn">Add</Submit>
                </ActionForm>
              )}
            </Section>
          )}

          <ModelPanel shopId={user.shopId} brand={m.brand} model={m.model} kind={kind} />
          <p className="text-sm">
            <Link href={modelHref(m.brand, m.model, kind.key)} className="link">
              Everything about the {m.brand} {m.model}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
