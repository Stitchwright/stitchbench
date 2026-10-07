// Machines for sale (modules-design.md 10.c; every shop since tax-machine-sales-layaway-design.md section 3): the four
// tabs, the search, the table, and for admins the "Add machines for sale" form (one unit per serial) for any kind the
// shop can take new work for (a vacuum while Vac Shop is on). Read-only while the program's key has lapsed (the write
// actions refuse).
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { UNIT_CONDITION_LABEL, UNIT_STATUS_LABEL, UNIT_STATUS_TONE } from "@/lib/constants";
import { shopKinds } from "@/lib/equipment/shop";
import { listPlans } from "@/lib/units/plans";
import { DEFAULT_WARRANTY_MONTHS, fmtYmdLong, isUnitTab, listUnits, MAX_CLASS_CREDITS, requiredAnswers, UNIT_CONDITIONS, UNIT_TABS, warrantyThrough } from "@/lib/units/units";
import { receiveUnits } from "@/actions/units";
import { ActionForm, Submit } from "@/components/action-form";
import { IntakeFields } from "@/components/equipment/intake-fields";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function Units({ searchParams }: { searchParams: Promise<{ tab?: string | string[]; q?: string | string[]; kind?: string | string[] }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const one = (v: unknown) => (typeof v === "string" ? v : "");
  const tab = isUnitTab(one(sp.tab)) ? one(sp.tab) : "stock";
  const q = one(sp.q).trim();
  const shopId = user.shopId;
  const [units, tz, kinds, plans, shop] = await Promise.all([
    listUnits(shopId, tab, q || null),
    shopTimeZone(shopId),
    shopKinds(shopId),
    listPlans(shopId, true),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { sellsRetail: true } }),
  ]);
  const admin = user.role !== "TECH";
  const kindLabel = new Map(kinds.all.map((k) => [k.key, k.label]));
  // The "Add" form's kind: picked by a link (each kind has its own types and questions), sewing machines first.
  const kind = kinds.usable.find((k) => k.key === one(sp.kind)) ?? kinds.usable[0];
  const sold = tab === "sold" || tab === "register";
  const here = (more: string) => `/units?tab=${tab}${q ? `&q=${encodeURIComponent(q)}` : ""}${more}`;
  return (
    <div className="space-y-4">
      <PageHeader title="Machines for sale" sub="New, used and trade-in machines with serials and warranties, sold at the register." />
      {!shop.sellsRetail && (
        <p className="card card-pad text-sm">
          Selling machines and trade-ins happens at the Register.{" "}
          {admin ? (
            <Link href="/settings#company" className="link">
              Turn on &quot;Sells over the counter&quot; in Settings
            </Link>
          ) : (
            "Ask the shop owner to turn on the register."
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2" role="navigation" aria-label="Units">
        {UNIT_TABS.map((t) => (
          <Link key={t.key} href={`/units?tab=${t.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className={`btn btn-sm ${tab === t.key ? "btn-primary" : ""}`}>
            {t.label}
          </Link>
        ))}
        <form className="ml-auto flex gap-2">
          <input type="hidden" name="tab" value={tab} />
          <label htmlFor="vu-search" className="sr-only">
            Search by serial, brand or model
          </label>
          <input id="vu-search" name="q" defaultValue={q} className="input w-56" placeholder="Serial, brand or model" />
          <button className="btn btn-sm">Search</button>
        </form>
      </div>
      {units.length === 0 ? (
        <Empty>{q ? "No machine matches." : tab === "stock" ? "Nothing in stock." : tab === "sold" ? "Nothing sold yet." : tab === "off" ? "Nothing is off sale." : "Every new machine sold is registered."}</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Machine</th>
                <th>Serial</th>
                <th>Condition</th>
                <th className="text-right">Price</th>
                {admin && <th className="text-right">Cost</th>}
                <th>Status</th>
                {sold && <th>Sold</th>}
                {sold && <th>Warranty through</th>}
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link href={`/units/${u.id}`} className="link font-semibold">
                      {u.brand} {u.model}
                    </Link>
                    <span className="muted text-xs"> · {[kindLabel.get(u.kind) ?? u.kind, u.machineType].filter(Boolean).join(", ")}</span>
                  </td>
                  <td className="mono">{u.serial ?? ""}</td>
                  <td>{UNIT_CONDITION_LABEL[u.condition] ?? u.condition}</td>
                  <td className="num text-right">{u.priceCents != null ? money(u.priceCents) : <span className="muted">none</span>}</td>
                  {admin && <td className="num text-right">{u.costCents != null ? money(u.costCents) : ""}</td>}
                  <td>
                    <span className={`pill tone-${UNIT_STATUS_TONE[u.status] ?? "neutral"}`}>{UNIT_STATUS_LABEL[u.status] ?? u.status}</span>
                  </td>
                  {sold && (
                    <td className="whitespace-nowrap">
                      {u.soldAt ? fmtDate(u.soldAt, tz) : ""}
                      {u.buyer && (
                        <>
                          {" "}
                          <Link href={`/customers/${u.buyer.id}`} className="link">
                            {u.buyer.name}
                          </Link>
                        </>
                      )}
                    </td>
                  )}
                  {sold && (
                    <td className="whitespace-nowrap">
                      {u.warrantyUntil ? fmtYmdLong(warrantyThrough(u.warrantyUntil, tz)) : ""}
                      {tab === "register" && <span className="pill tone-wait ml-2">to register</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {admin && kind && (
        <Section title="Add machines for sale" id="add">
          {kinds.usable.length > 1 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm" role="navigation" aria-label="What kind">
              <span className="muted">What kind:</span>
              {kinds.usable.map((k) => (
                <Link key={k.key} href={here(`&kind=${encodeURIComponent(k.key)}#add`)} className={`btn btn-sm ${k.key === kind.key ? "btn-primary" : ""}`} aria-current={k.key === kind.key ? "true" : undefined}>
                  {k.label}
                </Link>
              ))}
            </div>
          )}
          <ActionForm key={kind.key} action={receiveUnits} className="space-y-3">
            <input type="hidden" name="kind" value={kind.key} />
            <div className="grid-form">
              <div className="field">
                <label htmlFor="ru-brand" className="label">
                  Brand
                </label>
                <input id="ru-brand" name="brand" list="ru-brands" required className="input" />
                <datalist id="ru-brands">
                  {kind.brands.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label htmlFor="ru-model" className="label">
                  Model
                </label>
                <input id="ru-model" name="model" required className="input" placeholder={kind.modelHint} />
              </div>
              {kind.types.length > 0 && (
                <div className="field">
                  <label htmlFor="ru-type" className="label">
                    Type
                  </label>
                  <select id="ru-type" name="machineType" className="select" defaultValue="">
                    <option value="">-</option>
                    {kind.types.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor="ru-cond" className="label">
                  Condition
                </label>
                <select id="ru-cond" name="condition" className="select" defaultValue="NEW">
                  {UNIT_CONDITIONS.map((c) => (
                    <option key={c} value={c}>
                      {UNIT_CONDITION_LABEL[c]}
                    </option>
                  ))}
                </select>
              </div>
              <IntakeFields defs={kind.intakeFields} on="machine" required={requiredAnswers(kind)} />
            </div>
            <div className="field">
              <label htmlFor="ru-serials" className="label">
                Serial numbers, one per line (one {kind.noun} each)
              </label>
              <textarea id="ru-serials" name="serials" rows={3} className="textarea mono text-sm" aria-describedby="ru-serials-hint" />
              <p id="ru-serials-hint" className="muted text-xs">
                It&apos;s on the label; the warranty needs it. A used {kind.noun} may go in without one.
              </p>
            </div>
            <div className="grid-form">
              <div className="field">
                <label htmlFor="ru-cost" className="label">
                  Cost ($)
                </label>
                <input id="ru-cost" name="costCents" className="input num" inputMode="decimal" placeholder="0.00" />
              </div>
              <div className="field">
                <label htmlFor="ru-price" className="label">
                  Price ($)
                </label>
                <input id="ru-price" name="priceCents" className="input num" inputMode="decimal" placeholder="0.00" />
              </div>
            </div>
            <details className="rounded border border-line p-3">
              <summary className="link cursor-pointer text-sm">More options: warranty, what comes with it, owner&apos;s classes</summary>
              <div className="mt-3 space-y-3">
                <div className="grid-form">
                  <div className="field">
                    <label htmlFor="ru-months" className="label">
                      Warranty months
                    </label>
                    <input id="ru-months" name="warrantyMonths" className="input num" inputMode="numeric" placeholder={String(DEFAULT_WARRANTY_MONTHS.NEW)} aria-describedby="ru-months-hint" />
                    <p id="ru-months-hint" className="muted text-xs">
                      Leave blank for the usual: new and open box 12, refurbished 6, used 3.
                    </p>
                  </div>
                  <div className="field">
                    <label htmlFor="ru-by" className="label">
                      Warranty from
                    </label>
                    <input id="ru-by" name="warrantyBy" className="input" placeholder="the maker (new) or the shop (used)" />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="ru-bundle" className="label">
                    What comes with it (one item a line, printed on the receipt)
                  </label>
                  <textarea id="ru-bundle" name="bundle" rows={2} className="textarea text-sm" placeholder={"Extension table\nEmbroidery software\n$100 off a cabinet"} />
                </div>
                <div className="grid-form">
                  <div className="field">
                    <label htmlFor="ru-classes" className="label">
                      Owner&apos;s classes included
                    </label>
                    <input id="ru-classes" name="classCredits" className="input num" inputMode="numeric" defaultValue="0" aria-describedby="ru-classes-hint" />
                    <p id="ru-classes-hint" className="muted text-xs">
                      Guide classes the buyer books with you, free (up to {MAX_CLASS_CREDITS}).
                    </p>
                  </div>
                  {plans.length > 0 && (
                    <div className="field">
                      <label htmlFor="ru-plan" className="label">
                        Service plan included
                      </label>
                      <select id="ru-plan" name="includedPlanId" className="select" defaultValue="">
                        <option value="">None</option>
                        {plans.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="field">
                    <label htmlFor="ru-note" className="label">
                      Note
                    </label>
                    <input id="ru-note" name="note" className="input" />
                  </div>
                </div>
              </div>
            </details>
            <Submit>Add to stock</Submit>
          </ActionForm>
        </Section>
      )}
    </div>
  );
}
