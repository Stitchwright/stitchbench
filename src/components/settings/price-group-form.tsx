// One price group's form (shop-features-round-2-design.md 1.5): its name, what it gives (a percent off, or the item's
// wholesale price), which kinds of items (all by default), and whether it also applies to items already on sale.
import { savePriceGroup } from "@/actions/price-groups";
import { RULE_KINDS } from "@/lib/price-rules";
import type { GroupView } from "@/lib/price-groups";
import { ActionForm, Submit } from "@/components/action-form";

export function PriceGroupForm({ g }: { g: GroupView | null }) {
  const p = g?.id ?? "new";
  const all = !g || !g.kinds.length;
  return (
    <ActionForm action={savePriceGroup.bind(null, g?.id ?? null)} success="Saved" reset={!g} className="space-y-3 text-base">
      <div className="grid-form">
        <div className="field">
          <label htmlFor={`pg-name-${p}`} className="label">
            Name
          </label>
          <input id={`pg-name-${p}`} name="name" className="input text-base" placeholder="Guild" defaultValue={g?.name ?? ""} required maxLength={60} />
        </div>
        <fieldset className="field">
          <legend className="label">What it gives</legend>
          <label className="flex min-h-11 flex-wrap items-center gap-2">
            <input type="radio" name="gives" value="pct" defaultChecked={!g?.useWholesale} className="h-5 w-5" />
            <input name="pctOff" aria-label="Percent off" className="input num w-20" inputMode="numeric" defaultValue={g && !g.useWholesale ? g.pctOff : 10} />% off
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name="gives" value="wholesale" defaultChecked={!!g?.useWholesale} className="h-5 w-5" />{" "}The item&apos;s wholesale price
          </label>
        </fieldset>
      </div>
      <details>
        <summary className="link cursor-pointer text-base">More choices: which items, items on sale{g ? ", switch it off" : ""}</summary>
        <div className="mt-3 space-y-3">
          <fieldset>
            <legend className="label">On these kinds of items</legend>
            <div className="flex flex-wrap gap-x-4">
              {RULE_KINDS.map((k) => (
                <label key={k.key} className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" name="kinds" value={k.key} defaultChecked={all || g!.kinds.includes(k.key)} className="h-5 w-5" /> {k.label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" name="onSaleItems" defaultChecked={!!g?.onSaleItems} className="h-5 w-5" /> Also on items already on sale (the bigger discount wins, never both)
          </label>
          {g && (
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="active" defaultChecked={g.active} className="h-5 w-5" /> In use (untick to stop it; members keep their place)
            </label>
          )}
        </div>
      </details>
      <Submit className="btn btn-primary min-h-11">{g ? "Save" : "Add the group"}</Submit>
    </ActionForm>
  );
}
