// One machine for sale (modules-design.md 10.c; every shop since tax-machine-sales-layaway-design.md section 3):
// details, what comes with it, the maker's terms as the shop typed them, its history, links to the receipt and the
// machine; admins edit it and take it off sale or put it back; anyone records the maker's warranty registration once
// it is sold. Writes on a vacuum or appliance need its module (the actions refuse otherwise).
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { UNIT_CONDITION_LABEL, UNIT_STATUS_LABEL, UNIT_STATUS_TONE } from "@/lib/constants";
import { canWorkOn } from "@/lib/equipment/gate";
import { kindOf } from "@/lib/equipment/shop";
import { listPlans } from "@/lib/units/plans";
import { bundleItems, fmtYmdLong, makerTermsFor, MAX_CLASS_CREDITS, termsOf, termsText, UNIT_CONDITIONS, unitDetail, warrantyThrough } from "@/lib/units/units";
import { ymdOf } from "@/lib/zoned";
import { recordRegistration, setUnitOffSale, updateUnit } from "@/actions/units";
import { ActionForm, Submit } from "@/components/action-form";
import { IntakeFields } from "@/components/equipment/intake-fields";
import { UnitLifetime } from "@/components/units/unit-lifetime";
import { UnitUse } from "@/components/units/unit-use";
import { Empty, KV, PageHeader, Section } from "@/components/ui";

export default async function UnitPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const u = await unitDetail(user.shopId, id);
  if (!u) notFound();
  const [tz, kind, plans, terms, workable] = await Promise.all([
    shopTimeZone(user.shopId),
    kindOf(user.shopId, { equipment: u.equipment, kind: u.kind }),
    listPlans(user.shopId),
    makerTermsFor(user.shopId, [u.brand]),
    canWorkOn(user.shopId, u.equipment),
  ]);
  const admin = user.role !== "TECH";
  const title = `${u.brand} ${u.model}`;
  const through = u.warrantyUntil ? fmtYmdLong(warrantyThrough(u.warrantyUntil, tz)) : null;
  const maker = termsOf(terms, u.brand);
  const plan = plans.find((p) => p.id === u.includedPlanId) ?? null;
  const bundle = bundleItems(u.bundle);
  const answers = kind.intakeFields.filter((f) => f.on === "machine");
  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        back={{ href: "/units", label: "Machines for sale" }}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <span className={`pill tone-${UNIT_STATUS_TONE[u.status] ?? "neutral"}`}>{UNIT_STATUS_LABEL[u.status] ?? u.status}</span>
            <span>{UNIT_CONDITION_LABEL[u.condition] ?? u.condition}</span>
            <span>{kind.label}</span>
            {u.serial && <span className="mono">S/N {u.serial}</span>}
          </span>
        }
      />
      {!workable && <p className="card card-pad text-sm">{kind.label}s can&apos;t be sold or changed while their module is off. Returns and warranty registration still work.</p>}
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          <Section title="Details">
            <div className="grid gap-4 sm:grid-cols-3">
              <KV k="Price" v={u.priceCents != null ? money(u.priceCents) : null} />
              {admin && <KV k="Cost" v={u.costCents != null ? money(u.costCents) : null} />}
              <KV k="Type" v={u.machineType} />
              {answers.map((f) => (
                <KV key={f.key} k={f.label} v={u.details[f.key] != null && u.details[f.key] !== "" ? String(u.details[f.key]) : null} />
              ))}
              <KV k="Warranty" v={u.warrantyMonths != null ? `${u.warrantyMonths} months${u.warrantyBy ? ` from ${u.warrantyBy}` : ""}` : u.warrantyBy} />
              {maker && termsText(maker) && <KV k={`${maker.brand}'s terms (as you typed them)`} v={termsText(maker)} />}
              <KV k="Comes with" v={bundle.length ? bundle.join(", ") : null} />
              <KV k="Owner's classes" v={u.classCredits > 0 ? `${u.classCredits} included` : null} />
              <KV k="Service plan" v={plan ? `${plan.name} included` : null} />
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

          {u.status === "SOLD" && (
            <Section title="Warranty registration">
              <p className="muted mb-2 text-sm">
                Register it on the maker&apos;s site
                {maker?.registerUrl && (
                  <>
                    {" "}
                    (
                    <a href={maker.registerUrl} className="link" target="_blank" rel="noreferrer">
                      {maker.brand}&apos;s registration page
                    </a>
                    )
                  </>
                )}
                , then note it here so the &quot;Warranty to register&quot; list clears.
              </p>
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

          <UnitUse shopId={user.shopId} unitId={u.id} admin={admin} />
          <UnitLifetime shopId={user.shopId} unitId={u.id} admin={admin} />

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
          {admin && workable && (
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
                        {kind.brands.map((b) => (
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
                        {u.machineType && !kind.types.includes(u.machineType) && <option>{u.machineType}</option>}
                        {kind.types.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                    <IntakeFields defs={kind.intakeFields} on="machine" values={u.details} />
                  </div>
                  <div className="field">
                    <label htmlFor="eu-bundle" className="label">
                      What comes with it (one item a line)
                    </label>
                    <textarea id="eu-bundle" name="bundle" rows={3} className="textarea text-sm" defaultValue={u.bundle ?? ""} />
                  </div>
                  {u.status !== "SOLD" && (
                    <div className="grid-form">
                      <div className="field">
                        <label htmlFor="eu-classes" className="label">
                          Owner&apos;s classes included
                        </label>
                        <input id="eu-classes" name="classCredits" className="input num" inputMode="numeric" defaultValue={u.classCredits} aria-describedby="eu-classes-hint" />
                        <p id="eu-classes-hint" className="muted text-xs">
                          0 to {MAX_CLASS_CREDITS}.
                        </p>
                      </div>
                      <div className="field">
                        <label htmlFor="eu-plan" className="label">
                          Service plan included
                        </label>
                        <select id="eu-plan" name="includedPlanId" className="select" defaultValue={u.includedPlanId ?? ""}>
                          <option value="">None</option>
                          {plans
                            .filter((p) => p.active || p.id === u.includedPlanId)
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      </div>
                    </div>
                  )}
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
          {u.status === "IN_STOCK" && workable && (
            <p className="card card-pad text-sm">
              Sell it at the{" "}
              <Link href="/register" className="link">
                register
              </Link>
              : &quot;Machine for sale&quot;, or scan its serial.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
