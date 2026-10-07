// Settings → Selling (tax-machine-sales-layaway-design.md sections 1, 3, 4 and 5): sales tax holidays, the layaway
// defaults and the terms customers sign, the lenders the shop offers financing through, the shop's own service plans
// (sold at the register or included with a machine for sale), and each maker's warranty as the shop wants it shown.
// Owners and admins change them; everyone can read them.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
import { listHolidays } from "@/lib/tax-holidays";
import { HOLIDAY_KINDS, HOLIDAY_PRESETS, holidayDays, presetByKey } from "@/lib/tax-holiday-math";
import { deleteHoliday } from "@/actions/tax-holidays";
import { saveLender } from "@/actions/financing";
import { listLenders } from "@/lib/financing";
import { TaxHolidayForm } from "@/components/tax-holiday-form";
import { money } from "@/lib/format";
import { listPlans, planTerms } from "@/lib/units/plans";
import { listMakerTerms, termsText } from "@/lib/units/units";
import { deleteMakerTerms, saveMakerTerms, savePlan } from "@/actions/units";
import { saveLayawaySettings } from "@/actions/layaway";
import { layawaySettings } from "@/lib/layaway";
import { EVERY_LABEL, LAYAWAY_EVERY } from "@/lib/layaway-math";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Empty, PageHeader, Section } from "@/components/ui";

/** A lender's fields, empty for a new one. */
function LenderFields({ l, prefix }: { l?: Awaited<ReturnType<typeof listLenders>>[number]; prefix: string }) {
  return (
    <div className="grid-form">
      <div className="field">
        <label htmlFor={`${prefix}-name`} className="label">
          Lender
        </label>
        <input id={`${prefix}-name`} name="name" required className="input" defaultValue={l?.name ?? ""} placeholder="Synchrony" />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-url`} className="label">
          Their &quot;apply now&quot; page (optional)
        </label>
        <input id={`${prefix}-url`} name="applyUrl" className="input" defaultValue={l?.applyUrl ?? ""} placeholder="https://" />
      </div>
      {l && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={l.active} /> Offered at the register
        </label>
      )}
    </div>
  );
}

/** The plan's fields, empty for a new one. Module level, so the server actions don't close over anything in the page. */
function PlanFields({ p, prefix }: { p?: Awaited<ReturnType<typeof listPlans>>[number]; prefix: string }) {
  return (
    <>
      <div className="grid-form">
        <div className="field">
          <label htmlFor={`${prefix}-name`} className="label">
            Name
          </label>
          <input id={`${prefix}-name`} name="name" required className="input" defaultValue={p?.name ?? ""} placeholder="Free yearly cleaning, 3 years" />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-price`} className="label">
            Price ($)
          </label>
          <input id={`${prefix}-price`} name="priceCents" className="input num" inputMode="decimal" defaultValue={p ? (p.priceCents / 100).toFixed(2) : ""} placeholder="0.00" />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-visits`} className="label">
            Covered visits
          </label>
          <input id={`${prefix}-visits`} name="visits" className="input num" inputMode="numeric" defaultValue={p?.visits ?? (p ? "" : "3")} aria-describedby={`${prefix}-visits-hint`} />
          <p id={`${prefix}-visits-hint`} className="muted text-xs">
            Blank for no limit (an extended warranty).
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-months`} className="label">
            How many months
          </label>
          <input id={`${prefix}-months`} name="months" className="input num" inputMode="numeric" defaultValue={p?.months ?? 36} />
        </div>
      </div>
      <details>
        <summary className="link cursor-pointer text-sm">More options</summary>
        <div className="mt-2 space-y-2">
          <div className="field">
            <label htmlFor={`${prefix}-desc`} className="label">
              What it covers (shown at the counter)
            </label>
            <input id={`${prefix}-desc`} name="description" className="input" defaultValue={p?.description ?? ""} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="taxable" defaultChecked={p?.taxable ?? false} /> Charge sales tax on it (check your state&apos;s rule for service plans)
          </label>
          {p && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="active" defaultChecked={p.active} /> On sale (untick to stop selling it; machines that have it keep it)
            </label>
          )}
        </div>
      </details>
    </>
  );
}

export default async function SalesSettingsPage({ searchParams }: { searchParams: Promise<{ preset?: string }> }) {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const sp = await searchParams;
  const [plans, makers, lw, holidays, tz, lenders] = await Promise.all([
    listPlans(user.shopId),
    listMakerTerms(user.shopId),
    layawaySettings(user.shopId),
    listHolidays(user.shopId),
    shopTimeZone(user.shopId),
    listLenders(user.shopId),
  ]);
  const today = ymdOf(new Date(), tz);
  const year = Number(today.slice(0, 4));
  const preset = presetByKey(sp.preset);
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Selling" sub="Sales tax holidays, how layaways work at your shop, what you sell with a machine, and the warranty each maker gives, in your own words." back={{ href: "/settings", label: "Settings" }} />

      <Section title="Sales tax holidays" id="holidays">
        <p className="muted mb-3 text-sm">
          On the days you set, the register leaves the sales tax off the items a holiday covers (and the online shop does too). The cashier can still charge tax on one item. The tax report lists these sales apart.
        </p>
        {holidays.length === 0 ? (
          <Empty>None set up. If your state has a tax-free weekend, add it here.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {holidays.map((h) => (
              <li key={h.id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">
                    {h.name}
                    {!h.active && <span className="pill tone-neutral ml-2">Off</span>}
                    {h.active && h.firstDay <= today && today <= h.lastDay && <span className="pill tone-ready ml-2">On today</span>}
                  </span>
                  <span className="text-sm">
                    {holidayDays(h)}
                    {h.maxUnitCents != null ? ` · up to ${money(h.maxUnitCents)} each` : ""}
                  </span>
                </div>
                <p className="muted text-sm">Covers: {HOLIDAY_KINDS.filter((k) => h.kinds.includes(k.key)).map((k) => k.label.toLowerCase()).join(", ")}</p>
                {admin && (
                  <details className="mt-2">
                    <summary className="link cursor-pointer text-sm">Change</summary>
                    <div className="mt-2 space-y-2">
                      <TaxHolidayForm h={h} year={year} prefix={`th-${h.id}`} />
                      <ActionButton action={deleteHoliday.bind(null, h.id)} className="btn btn-sm" success="Removed">
                        Remove
                      </ActionButton>
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="mb-2 font-semibold">Add a tax holiday</h3>
            <p className="mb-2 flex flex-wrap gap-2 text-sm">
              Start from:
              {HOLIDAY_PRESETS.map((p) => (
                <Link key={p.key} href={`/settings/sales?preset=${p.key}#holidays`} className={`btn btn-sm ${preset?.key === p.key ? "btn-primary" : ""}`}>
                  {p.state}
                </Link>
              ))}
              <Link href="/settings/sales#holidays" className={`btn btn-sm ${!preset ? "btn-primary" : ""}`}>
                A blank form
              </Link>
            </p>
            <TaxHolidayForm key={preset?.key ?? "blank"} preset={preset} year={year} prefix="th-new" />
          </div>
        )}
      </Section>

      <Section title="Layaway">
        <p className="muted mb-3 text-sm">What the register fills in when a customer wants to pay over time. You can change any of it for one layaway at the register.</p>
        <ActionForm action={saveLayawaySettings} success="Saved" className="space-y-3">
          <fieldset disabled={!admin} className="space-y-3">
            <div className="grid-form">
              <div className="field">
                <label htmlFor="lw-pct" className="label">
                  Deposit (% of the price)
                </label>
                <input id="lw-pct" name="depositPct" className="input num" inputMode="numeric" defaultValue={lw.depositPct} />
              </div>
              <div className="field">
                <label htmlFor="lw-days" className="label">
                  Days to pay it off
                </label>
                <input id="lw-days" name="days" className="input num" inputMode="numeric" defaultValue={lw.days} />
              </div>
              <div className="field">
                <label htmlFor="lw-every" className="label">
                  They pay
                </label>
                <select id="lw-every" name="every" className="select" defaultValue={lw.every}>
                  {LAYAWAY_EVERY.map((e) => (
                    <option key={e} value={e}>
                      {EVERY_LABEL[e]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <details>
              <summary className="link cursor-pointer text-sm">More options: cancelling, and the terms they sign</summary>
              <div className="mt-3 space-y-3">
                <div className="grid-form">
                  <div className="field">
                    <label htmlFor="lw-fee" className="label">
                      Cancel fee ($)
                    </label>
                    <input id="lw-fee" name="feeCents" className="input num" inputMode="decimal" defaultValue={(lw.feeCents / 100).toFixed(2)} />
                  </div>
                  <div className="field">
                    <label htmlFor="lw-feepct" className="label">
                      Plus this % of what they paid
                    </label>
                    <input id="lw-feepct" name="feePct" className="input num" inputMode="numeric" defaultValue={lw.feePct} />
                  </div>
                  <div className="field">
                    <label htmlFor="lw-refund" className="label">
                      The rest goes back
                    </label>
                    <select id="lw-refund" name="refund" className="select" defaultValue={lw.refund}>
                      <option value="credit">As store credit</option>
                      <option value="money">As money</option>
                    </select>
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="lw-terms" className="label">
                    The terms they sign
                  </label>
                  <textarea id="lw-terms" name="terms" rows={6} className="textarea text-sm" defaultValue={lw.terms} aria-describedby="lw-terms-hint" />
                  <p id="lw-terms-hint" className="muted text-xs">
                    Several states have rules for layaway terms and refunds. Ask your lawyer or accountant before you use these words. Empty this box to go back to the program&apos;s wording.
                  </p>
                </div>
              </div>
            </details>
            {admin && <Submit>Save layaway settings</Submit>}
          </fieldset>
        </ActionForm>
      </Section>

      <Section title="Financing">
        <p className="muted mb-3 text-sm">
          Lenders you offer (Synchrony, Affirm...). At the register, &quot;Financing&quot; takes the payment with the lender&apos;s approval number; the lender owes you until you mark it paid (Reports → Financing). The &quot;apply now&quot; page shows on receipts for machines and on your online shop.
        </p>
        {lenders.length === 0 ? (
          <Empty>None yet. Add a lender to take financed payments.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {lenders.map((l) => (
              <li key={l.id} className="py-2">
                <span className="font-semibold">{l.name}</span>
                {!l.active && <span className="pill tone-neutral ml-2">Not offered</span>}
                {l.applyUrl && (
                  <a href={l.applyUrl} className="link ml-2 text-sm" target="_blank" rel="noreferrer">
                    apply page
                  </a>
                )}
                {admin && (
                  <details className="mt-1">
                    <summary className="link cursor-pointer text-sm">Change</summary>
                    <ActionForm action={saveLender.bind(null, l.id)} success="Saved" className="mt-2 space-y-2">
                      <LenderFields l={l} prefix={`ln-${l.id}`} />
                      <Submit className="btn btn-sm">Save</Submit>
                    </ActionForm>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <ActionForm action={saveLender.bind(null, null)} success="Lender added" reset className="mt-4 space-y-3 border-t border-line pt-4">
            <LenderFields prefix="ln-new" />
            <Submit>Add lender</Submit>
          </ActionForm>
        )}
      </Section>

      <Section title="Your service plans">
        <p className="muted mb-3 text-sm">
          Sell a plan at the register (Service plan), or include one with a machine for sale. A repair ticket for that machine then shows what&apos;s covered, and a line can be marked covered with one click.
        </p>
        {plans.length === 0 ? (
          <Empty>No plans yet. Add your first one below, for example &quot;Free yearly cleaning, 3 years&quot;.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {plans.map((p) => (
              <li key={p.id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">
                    {p.name}
                    {!p.active && <span className="pill tone-neutral ml-2">Not on sale</span>}
                  </span>
                  <span className="text-sm">
                    {money(p.priceCents)} · {planTerms(p)}
                    {p.taxable ? " · taxed" : ""}
                  </span>
                </div>
                {p.description && <p className="muted text-sm">{p.description}</p>}
                {admin && (
                  <details className="mt-2">
                    <summary className="link cursor-pointer text-sm">Change</summary>
                    <ActionForm action={savePlan.bind(null, p.id)} success="Saved" className="mt-2 space-y-3">
                      <PlanFields p={p} prefix={`p-${p.id}`} />
                      <Submit className="btn btn-sm">Save</Submit>
                    </ActionForm>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="mb-2 font-semibold">Add a plan</h3>
            <ActionForm action={savePlan.bind(null, null)} success="Plan added" reset className="space-y-3">
              <PlanFields prefix="np" />
              <Submit>Add plan</Submit>
            </ActionForm>
          </div>
        )}
      </Section>

      <Section title="Makers' warranties">
        <p className="muted mb-3 text-sm">
          Type each maker&apos;s warranty as you want customers to see it (for example parts 25 years, labor 2 years). It prints on the receipt and shows on repair tickets. Leave a box blank if the maker gives none.
        </p>
        {makers.length === 0 ? (
          <Empty>None yet. Add a brand below.</Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {makers.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-semibold">{m.brand}</span>
                  {termsText(m) && `: ${termsText(m)}`}
                  {m.registerUrl && (
                    <>
                      {" · "}
                      <a href={m.registerUrl} className="link" target="_blank" rel="noreferrer">
                        registration page
                      </a>
                    </>
                  )}
                  {m.note && <span className="muted"> · {m.note}</span>}
                </span>
                {admin && (
                  <ActionButton action={deleteMakerTerms.bind(null, m.id)} className="btn btn-sm" success="Removed">
                    Remove
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="mb-2 font-semibold">Add or change a brand</h3>
            <ActionForm action={saveMakerTerms} success="Saved" reset className="space-y-3">
              <div className="grid-form">
                <div className="field">
                  <label htmlFor="mw-brand" className="label">
                    Brand
                  </label>
                  <input id="mw-brand" name="brand" required className="input" placeholder="Brother" />
                </div>
                <div className="field">
                  <label htmlFor="mw-parts" className="label">
                    Parts (years)
                  </label>
                  <input id="mw-parts" name="partsYears" className="input num" inputMode="decimal" />
                </div>
                <div className="field">
                  <label htmlFor="mw-labor" className="label">
                    Labor (years)
                  </label>
                  <input id="mw-labor" name="laborYears" className="input num" inputMode="decimal" />
                </div>
                <div className="field">
                  <label htmlFor="mw-elec" className="label">
                    Electronics (years)
                  </label>
                  <input id="mw-elec" name="electronicsYears" className="input num" inputMode="decimal" />
                </div>
              </div>
              <details>
                <summary className="link cursor-pointer text-sm">More options</summary>
                <div className="mt-2 grid-form">
                  <div className="field">
                    <label htmlFor="mw-url" className="label">
                      The maker&apos;s registration page
                    </label>
                    <input id="mw-url" name="registerUrl" className="input" placeholder="https://" />
                  </div>
                  <div className="field">
                    <label htmlFor="mw-note" className="label">
                      Note
                    </label>
                    <input id="mw-note" name="note" className="input" />
                  </div>
                </div>
              </details>
              <Submit>Save brand</Submit>
            </ActionForm>
          </div>
        )}
      </Section>
    </div>
  );
}
