// Vacuums for sale (modules-design.md 10.c): the four tabs, the search, the table, and for admins the "Add vacuums
// for sale" form (one unit per serial). Lapsed: read-only through the page gate.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { UNIT_CONDITION_LABEL, UNIT_STATUS_LABEL, UNIT_STATUS_TONE } from "@/lib/constants";
import { VACUUM_KIND } from "@/lib/equipment/vacuum";
import { DEFAULT_WARRANTY_MONTHS, fmtYmdLong, isUnitTab, listUnits, UNIT_CONDITIONS, UNIT_TABS, warrantyThrough } from "@/lib/vac/units";
import { receiveUnits } from "@/actions/vac-units";
import { ActionForm, Submit } from "@/components/action-form";
import { IntakeFields } from "@/components/equipment/intake-fields";
import { Empty, Section } from "@/components/ui";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";

export default async function VacUnits({ searchParams }: { searchParams: Promise<{ tab?: string | string[]; q?: string | string[] }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const one = (v: unknown) => (typeof v === "string" ? v : "");
  const tab = isUnitTab(one(sp.tab)) ? one(sp.tab) : "stock";
  const q = one(sp.q).trim();
  const shopId = user.shopId;
  const [units, tz] = await Promise.all([listUnits(shopId, tab, q || null), shopTimeZone(shopId)]);
  const s = await vacPageState(user, units.length > 0);
  const sold = tab === "sold" || tab === "register";
  return (
    <VacFrame title="Vacuums for sale" tab="units" what="Your vacuums for sale" needsRegister {...s}>
      <div className="flex flex-wrap items-center gap-2" role="navigation" aria-label="Units">
        {UNIT_TABS.map((t) => (
          <Link key={t.key} href={`/vac/units?tab=${t.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className={`btn btn-sm ${tab === t.key ? "btn-primary" : ""}`}>
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
        <Empty>{q ? "No vacuum matches." : tab === "stock" ? "Nothing in stock." : tab === "sold" ? "Nothing sold yet." : tab === "off" ? "Nothing is off sale." : "Every new vacuum sold is registered."}</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Vacuum</th>
                <th>Serial</th>
                <th>Condition</th>
                <th className="text-right">Price</th>
                {s.admin && <th className="text-right">Cost</th>}
                <th>Status</th>
                {sold && <th>Sold</th>}
                {sold && <th>Warranty through</th>}
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link href={`/vac/units/${u.id}`} className="link font-semibold">
                      {u.brand} {u.model}
                    </Link>
                    {u.machineType && <span className="muted text-xs"> · {u.machineType}</span>}
                  </td>
                  <td className="mono">{u.serial ?? ""}</td>
                  <td>{UNIT_CONDITION_LABEL[u.condition] ?? u.condition}</td>
                  <td className="num text-right">{u.priceCents != null ? money(u.priceCents) : <span className="muted">none</span>}</td>
                  {s.admin && <td className="num text-right">{u.costCents != null ? money(u.costCents) : ""}</td>}
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
      {s.admin && s.gate === "write" && (
        <Section title="Add vacuums for sale" id="add">
          <ActionForm action={receiveUnits} className="space-y-3">
            <div className="grid-form">
              <div className="field">
                <label htmlFor="ru-brand" className="label">
                  Brand
                </label>
                <input id="ru-brand" name="brand" list="ru-brands" required className="input" />
                <datalist id="ru-brands">
                  {VACUUM_KIND.brands.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label htmlFor="ru-model" className="label">
                  Model
                </label>
                <input id="ru-model" name="model" required className="input" placeholder={VACUUM_KIND.modelHint} />
              </div>
              <div className="field">
                <label htmlFor="ru-type" className="label">
                  Type
                </label>
                <select id="ru-type" name="machineType" className="select" defaultValue="">
                  <option value="">-</option>
                  {VACUUM_KIND.types.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </div>
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
              <IntakeFields defs={VACUUM_KIND.intakeFields} on="machine" required={["bagged"]} />
            </div>
            <div className="field">
              <label htmlFor="ru-serials" className="label">
                Serial numbers, one per line (one vacuum each)
              </label>
              <textarea id="ru-serials" name="serials" rows={3} className="textarea mono text-sm" aria-describedby="ru-serials-hint" />
              <p id="ru-serials-hint" className="muted text-xs">
                It&apos;s on the label; the warranty needs it. A used vacuum may go in without one.
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
              <div className="field">
                <label htmlFor="ru-months" className="label">
                  Warranty months
                </label>
                <input id="ru-months" name="warrantyMonths" className="input num" inputMode="numeric" defaultValue={DEFAULT_WARRANTY_MONTHS.NEW} aria-describedby="ru-months-hint" />
                <p id="ru-months-hint" className="muted text-xs">
                  New and open box 12, refurbished 6, used 3, unless you say otherwise.
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
              <label htmlFor="ru-note" className="label">
                Note
              </label>
              <input id="ru-note" name="note" className="input" />
            </div>
            <Submit>Add to stock</Submit>
          </ActionForm>
        </Section>
      )}
    </VacFrame>
  );
}
