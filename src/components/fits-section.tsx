// "Fits these machines" on an item's page (shop-features-round-2-design.md 2.4): the models the item fits, picked from
// the shop's own models or typed, and the fit groups it belongs to. The register, the customer's page, a machine sale
// and the online shop read them.
import Link from "next/link";
import { db } from "@/lib/db";
import { fitGroupsFor, shopModels } from "@/lib/fits";
import { addFitModel, removeFitModel, setFitGroups } from "@/actions/fits";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function FitsSection({ shopId, partId }: { shopId: string; partId: string }) {
  const [p, groups, models] = await Promise.all([
    db.part.findFirst({ where: { id: partId, shopId }, select: { fitsModels: true, fitGroupIds: true } }),
    fitGroupsFor(shopId),
    shopModels(shopId),
  ]);
  if (!p) return null;
  const brands = [...new Set(models.map((m) => m.brand))];
  return (
    <Section title="Fits these machines">
      {p.fitsModels.length === 0 && p.fitGroupIds.length === 0 ? (
        <p className="muted text-sm">Not set yet. Add the models it fits: the register then shows it for a customer&apos;s machine, and with a machine being sold.</p>
      ) : (
        <ul className="divide-y divide-line">
          {p.fitsModels.map((m) => (
            <li key={m} className="flex items-center justify-between gap-2 py-2">
              <span className="text-base">{m}</span>
              <ActionButton action={removeFitModel.bind(null, partId, m)} className="btn btn-sm">
                Take off
              </ActionButton>
            </li>
          ))}
          {groups
            .filter((g) => p.fitGroupIds.includes(g.id))
            .map((g) => (
              <li key={g.id} className="py-2 text-base">
                {g.name} <span className="muted text-sm">({g.models.length} {g.models.length === 1 ? "model" : "models"})</span>
              </li>
            ))}
        </ul>
      )}
      <ActionForm action={addFitModel.bind(null, partId)} reset className="mt-3 flex flex-wrap items-end gap-2">
        <div className="field">
          <label htmlFor="fit-brand" className="label">
            Brand
          </label>
          <input id="fit-brand" name="brand" list="fit-brands" className="input w-36" autoComplete="off" placeholder="Brother" />
          <datalist id="fit-brands">
            {brands.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </div>
        <div className="field min-w-36 flex-1">
          <label htmlFor="fit-model" className="label">
            Model
          </label>
          <input id="fit-model" name="model" list="fit-models" className="input" autoComplete="off" placeholder="PE800" required />
          <datalist id="fit-models">
            {models.map((m) => (
              <option key={`${m.brand}|${m.model}`} value={m.model}>
                {m.brand}
              </option>
            ))}
          </datalist>
        </div>
        <Submit className="btn">Add this machine</Submit>
      </ActionForm>
      {groups.length > 0 && (
        <details className="mt-3">
          <summary className="link cursor-pointer text-sm">Fit groups ({p.fitGroupIds.length} ticked)</summary>
          <ActionForm action={setFitGroups.bind(null, partId)} success="Saved" className="mt-2 space-y-2">
            {groups.map((g) => (
              <label key={g.id} className="flex min-h-11 items-center gap-2 text-base">
                <input type="checkbox" name="group" value={g.id} defaultChecked={p.fitGroupIds.includes(g.id)} className="check" /> {g.name}
              </label>
            ))}
            <Submit className="btn">Save groups</Submit>
          </ActionForm>
        </details>
      )}
      <p className="mt-2 text-sm">
        <Link href="/parts/fit-groups" className="link">
          {groups.length ? "Change the fit groups" : "Make a fit group"}
        </Link>{" "}
        <span className="muted">(a name for many models at once, like &quot;Brother 7 mm low shank&quot;)</span>
      </p>
    </Section>
  );
}
