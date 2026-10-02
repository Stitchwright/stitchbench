// One vacuum for sale (modules-design.md 10.c): details, its history, links to the receipt and the machine; admins
// edit it and take it off sale or put it back; anyone records the maker's warranty registration once it is sold.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { UNIT_CONDITION_LABEL, UNIT_STATUS_LABEL, UNIT_STATUS_TONE } from "@/lib/constants";
import { VACUUM_KIND } from "@/lib/equipment/vacuum";
import { fmtYmdLong, UNIT_CONDITIONS, unitDetail, warrantyThrough } from "@/lib/vac/units";
import { ymdOf } from "@/lib/zoned";
import { recordRegistration, setUnitOffSale, updateUnit } from "@/actions/vac-units";
import { ActionForm, Submit } from "@/components/action-form";
import { IntakeFields } from "@/components/equipment/intake-fields";
import { Empty, KV, Section } from "@/components/ui";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";

export default async function VacUnitPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const u = await unitDetail(user.shopId, id);
  if (!u) notFound();
  const [s, tz] = await Promise.all([vacPageState(user, true), shopTimeZone(user.shopId)]);
  const write = s.gate === "write";
  const title = `${u.brand} ${u.model}`;
  const through = u.warrantyUntil ? fmtYmdLong(warrantyThrough(u.warrantyUntil, tz)) : null;
  return (
    <VacFrame
      title={title}
      sub={
        <span className="flex flex-wrap items-center gap-2">
          <span className={`pill tone-${UNIT_STATUS_TONE[u.status] ?? "neutral"}`}>{UNIT_STATUS_LABEL[u.status] ?? u.status}</span>
          <span>{UNIT_CONDITION_LABEL[u.condition] ?? u.condition}</span>
          {u.serial && <span className="mono">S/N {u.serial}</span>}
        </span>
      }
      tab="units"
      what="This vacuum"
      {...s}
    >
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          <Section title="Details">
            <div className="grid gap-4 sm:grid-cols-3">
              <KV k="Price" v={u.priceCents != null ? money(u.priceCents) : null} />
              {s.admin && <KV k="Cost" v={u.costCents != null ? money(u.costCents) : null} />}
              <KV k="Type" v={u.machineType} />
              <KV k="Bags or bagless" v={typeof u.details.bagged === "string" ? u.details.bagged : null} />
              <KV k="Bag type" v={typeof u.details.bagType === "string" ? u.details.bagType : null} />
              <KV k="Warranty" v={u.warrantyMonths != null ? `${u.warrantyMonths} months${u.warrantyBy ? ` from ${u.warrantyBy}` : ""}` : u.warrantyBy} />
              {u.status === "SOLD" && (
                <>
                  <KV
                    k="Sold"
                    v={
                      <>
                        {u.soldAt ? fmtDate(u.soldAt, tz) : ""}
                        {u.buyer && (
                          <>
                            {" "}
                            to{" "}
                            <Link href={`/customers/${u.buyer.id}`} className="link">
                              {u.buyer.name}
                            </Link>
                          </>
                        )}
                        {u.sale && (
                          <>
                            {" "}
                            <Link href={`/register/sales/${u.sale.id}`} className="link">
                              sale #{u.sale.number}
                            </Link>
                          </>
                        )}
                        {u.soldNetCents != null && <span className="muted"> · {money(u.soldNetCents)} before tax</span>}
                      </>
                    }
                  />
                  <KV k="Warranty through" v={through} />
                  <KV k="Registered with the maker" v={u.registeredAt ? `${fmtDate(u.registeredAt, tz)}${u.registrationRef ? ` (${u.registrationRef})` : ""}` : "Not yet"} />
                </>
              )}
              {u.tradeInSale && (
                <KV
                  k="Traded in"
                  v={
                    <Link href={`/register/sales/${u.tradeInSale.id}`} className="link">
                      sale #{u.tradeInSale.number}
                    </Link>
                  }
                />
              )}
              <KV k="Note" v={u.note} />
              <KV
                k="Machine record"
                v={
                  <Link href={`/machines/${u.machineId}`} className="link">
                    History, photos and tickets
                  </Link>
                }
              />
            </div>
          </Section>

          {u.status === "SOLD" && write && (
            <Section title="Warranty registration">
              <p className="muted mb-2 text-sm">Register it on the maker&apos;s site, then note it here so the &quot;Warranty to register&quot; list clears.</p>
              <ActionForm action={recordRegistration.bind(null, u.id)} success="Registration recorded" className="flex flex-wrap items-end gap-2">
                <div className="field">
                  <label htmlFor="reg-on" className="label">
                    Registered on
                  </label>
                  <input id="reg-on" name="registeredOn" type="date" required defaultValue={u.registeredAt ? ymdOf(u.registeredAt, tz) : ymdOf(new Date(), tz)} className="input" />
                </div>
                <div className="field">
                  <label htmlFor="reg-ref" className="label">
                    Reference (optional)
                  </label>
                  <input id="reg-ref" name="registrationRef" defaultValue={u.registrationRef ?? ""} maxLength={80} className="input" />
                </div>
                <Submit className="btn">Record registration</Submit>
              </ActionForm>
            </Section>
          )}

          <Section title="History">
            {u.events.length === 0 ? (
              <Empty>Nothing yet.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {[...u.events].reverse().map((e, i) => (
                  <li key={i} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>{e.note}</span>
                    <span className="muted whitespace-nowrap">{fmtDateTime(new Date(e.at), tz)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="space-y-6 xl:col-span-2">
          {s.admin && write && (
            <>
              <Section title="Change">
                <ActionForm action={updateUnit.bind(null, u.id)} success="Saved" className="space-y-3">
                  <div className="grid-form">
                    <div className="field">
                      <label htmlFor="eu-price" className="label">
                        Price ($)
                      </label>
                      <input id="eu-price" name="priceCents" className="input num" inputMode="decimal" defaultValue={u.priceCents != null ? (u.priceCents / 100).toFixed(2) : ""} />
                    </div>
                    <div className="field">
                      <label htmlFor="eu-cost" className="label">
                        Cost ($)
                      </label>
                      <input id="eu-cost" name="costCents" className="input num" inputMode="decimal" defaultValue={u.costCents != null ? (u.costCents / 100).toFixed(2) : ""} />
                    </div>
                    <div className="field">
                      <label htmlFor="eu-cond" className="label">
                        Condition
                      </label>
                      <select id="eu-cond" name="condition" className="select" defaultValue={u.condition}>
                        {UNIT_CONDITIONS.map((c) => (
                          <option key={c} value={c}>
                            {UNIT_CONDITION_LABEL[c]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="eu-months" className="label">
                        Warranty months
                      </label>
                      <input id="eu-months" name="warrantyMonths" className="input num" inputMode="numeric" defaultValue={u.warrantyMonths ?? ""} />
                    </div>
                    <div className="field">
                      <label htmlFor="eu-by" className="label">
                        Warranty from
                      </label>
                      <input id="eu-by" name="warrantyBy" className="input" defaultValue={u.warrantyBy ?? ""} />
                    </div>
                    <div className="field">
                      <label htmlFor="eu-brand" className="label">
                        Brand
                      </label>
                      <input id="eu-brand" name="brand" list="eu-brands" required className="input" defaultValue={u.brand} />
                      <datalist id="eu-brands">
                        {VACUUM_KIND.brands.map((b) => (
                          <option key={b} value={b} />
                        ))}
                      </datalist>
                    </div>
                    <div className="field">
                      <label htmlFor="eu-model" className="label">
                        Model
                      </label>
                      <input id="eu-model" name="model" required className="input" defaultValue={u.model} />
                    </div>
                    <div className="field">
                      <label htmlFor="eu-serial" className="label">
                        Serial
                      </label>
                      <input id="eu-serial" name="serial" className="input mono" defaultValue={u.serial ?? ""} />
                    </div>
                    <div className="field">
                      <label htmlFor="eu-type" className="label">
                        Type
                      </label>
                      <select id="eu-type" name="machineType" className="select" defaultValue={u.machineType ?? ""}>
                        <option value="">-</option>
                        {VACUUM_KIND.types.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                    <IntakeFields defs={VACUUM_KIND.intakeFields} on="machine" values={u.details} />
                  </div>
                  <div className="field">
                    <label htmlFor="eu-note" className="label">
                      Note
                    </label>
                    <input id="eu-note" name="note" className="input" defaultValue={u.note ?? ""} />
                  </div>
                  <Submit className="btn">Save</Submit>
                </ActionForm>
              </Section>
              {u.status === "IN_STOCK" && (
                <Section title="Take off sale">
                  <ActionForm action={setUnitOffSale.bind(null, u.id, true)} success="Off sale" className="flex flex-wrap items-end gap-2">
                    <div className="field flex-1">
                      <label htmlFor="off-reason" className="label">
                        Why (optional)
                      </label>
                      <input id="off-reason" name="reason" className="input" placeholder="kept as a loaner, parts machine, returned to the supplier..." />
                    </div>
                    <Submit className="btn">Take off sale</Submit>
                  </ActionForm>
                </Section>
              )}
              {u.status === "REMOVED" && (
                <Section title="Off sale">
                  <ActionForm action={setUnitOffSale.bind(null, u.id, false)} success="Back on sale">
                    <Submit className="btn">Put back on sale</Submit>
                  </ActionForm>
                </Section>
              )}
            </>
          )}
          {u.status === "IN_STOCK" && write && (
            <p className="card card-pad text-sm">
              Sell it at the{" "}
              <Link href="/register" className="link">
                register
              </Link>
              : &quot;Vacuum for sale&quot;, or scan its serial.
            </p>
          )}
        </div>
      </div>
    </VacFrame>
  );
}
