// An item's own per-yard break (shop-features-round-2-design.md 1.6): "this wide-back: $18 a yard from 3 yards".
// Owners and admins; only for items sold by the yard.
import { money } from "@/lib/format";
import { saveItemBreak } from "@/actions/birthdays";
import { ActionForm, Submit } from "@/components/action-form";

export function ItemYardBreak({ part }: { part: { id: string; breakMinQty: number | null; breakPriceCents: number | null } }) {
  return (
    <details className="card card-pad">
      <summary className="link cursor-pointer text-base">
        Yard break{part.breakMinQty != null && part.breakPriceCents != null ? `: ${money(part.breakPriceCents)} a yard from ${part.breakMinQty} yards` : ""}
      </summary>
      <ActionForm action={saveItemBreak.bind(null, part.id)} success="Saved" className="mt-3 flex flex-wrap items-end gap-3 text-base">
        <div className="field">
          <label htmlFor="ib-min" className="label">
            From how many yards (blank: none)
          </label>
          <input id="ib-min" name="breakMinQty" className="input num w-24" inputMode="decimal" defaultValue={part.breakMinQty ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="ib-price" className="label">
            Price a yard
          </label>
          <input id="ib-price" name="breakPrice" className="input num w-28" inputMode="decimal" defaultValue={part.breakPriceCents != null ? (part.breakPriceCents / 100).toFixed(2) : ""} />
        </div>
        <Submit className="btn min-h-11">Save</Submit>
      </ActionForm>
    </details>
  );
}
