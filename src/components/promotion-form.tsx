// The promotion form on Settings → Selling (tax-machine-sales-layaway-design.md section 2): a name, the days, what it
// does (percent off, amount off each, or the price including the tax when the owner has allowed it) and what it
// covers (kinds, brands, item numbers; any of them).
import { HOLIDAY_KINDS } from "@/lib/tax-holiday-math";
import { EFFECT_LABEL, PROMO_EFFECTS } from "@/lib/promo-math";
import type { PromoRow } from "@/lib/promotions";
import { savePromotion } from "@/actions/promotions";
import { ActionForm, Submit } from "@/components/action-form";

export function PromotionForm({ p, taxIncludedOn, today, prefix }: { p?: PromoRow; taxIncludedOn: boolean; today: string; prefix: string }) {
  const effects = PROMO_EFFECTS.filter((e) => e !== "TAX_INCLUDED" || taxIncludedOn || p?.effect === e);
  const value = !p ? "" : p.effect === "PERCENT" ? String(p.value) : p.effect === "AMOUNT" ? (p.value / 100).toFixed(2) : "";
  return (
    <ActionForm action={savePromotion.bind(null, p?.id ?? null)} success={p ? "Saved" : "Sale added. The register applies it on those days."} reset={!p} className="space-y-3">
      <div className="grid-form">
        <div className="field">
          <label htmlFor={`${prefix}-name`} className="label">
            Name (printed on the receipt)
          </label>
          <input id={`${prefix}-name`} name="name" required className="input" defaultValue={p?.name ?? ""} placeholder="Fall machine sale" />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-first`} className="label">
            First day
          </label>
          <input id={`${prefix}-first`} name="firstDay" type="date" required className="input" defaultValue={p?.firstDay ?? today} />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-last`} className="label">
            Last day
          </label>
          <input id={`${prefix}-last`} name="lastDay" type="date" required className="input" defaultValue={p?.lastDay ?? today} />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-effect`} className="label">
            What it does
          </label>
          <select id={`${prefix}-effect`} name="effect" className="select" defaultValue={p?.effect ?? "PERCENT"}>
            {effects.map((e) => (
              <option key={e} value={e}>
                {EFFECT_LABEL[e]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-value`} className="label">
            How much (percent, or dollars off each)
          </label>
          <input id={`${prefix}-value`} name="value" className="input num" inputMode="decimal" defaultValue={value} placeholder="20" aria-describedby={`${prefix}-value-hint`} />
          <p id={`${prefix}-value-hint`} className="muted text-xs">
            Not needed when the price includes the tax.
          </p>
        </div>
      </div>
      <fieldset>
        <legend className="label">What it covers (tick kinds, or type brands or item numbers below)</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {HOLIDAY_KINDS.map((k) => (
            <label key={k.key} className="flex items-center gap-2">
              <input type="checkbox" name="kinds" value={k.key} defaultChecked={p?.scope.kinds.includes(k.key) ?? false} /> {k.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid-form">
        <div className="field">
          <label htmlFor={`${prefix}-brands`} className="label">
            Brands (commas between)
          </label>
          <input id={`${prefix}-brands`} name="brands" className="input" defaultValue={p?.scope.brands.join(", ") ?? ""} placeholder="Brother, Janome" />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-items`} className="label">
            Item numbers (commas between)
          </label>
          <input id={`${prefix}-items`} name="items" className="input mono" defaultValue={p?.partNumbers.join(", ") ?? ""} />
        </div>
      </div>
      {p && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={p.active} /> On (untick to switch it off)
        </label>
      )}
      <Submit className={p ? "btn btn-sm" : undefined}>{p ? "Save" : "Add sale"}</Submit>
    </ActionForm>
  );
}
