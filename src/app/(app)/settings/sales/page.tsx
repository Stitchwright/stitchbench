// Settings → Selling machines (tax-machine-sales-layaway-design.md section 3): the shop's own service plans (sold at the
// register or included with a machine for sale) and each maker's warranty as the shop wants it shown. Owners and
// admins change them; everyone can read them.
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { listPlans, planTerms } from "@/lib/units/plans";
import { listMakerTerms, termsText } from "@/lib/units/units";
import { deleteMakerTerms, saveMakerTerms, savePlan } from "@/actions/units";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Empty, PageHeader, Section } from "@/components/ui";

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

export default async function SalesSettingsPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [plans, makers] = await Promise.all([listPlans(user.shopId), listMakerTerms(user.shopId)]);
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Plans and warranties" sub="What you sell with a machine, and the warranty each maker gives, in your own words." back={{ href: "/settings", label: "Settings" }} />

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
