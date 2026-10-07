// A house account's limit and terms (shop-features-round-2-design.md 9.4): opening one on a customer's page, or changing
// it. Server component.
import { saveHouseAccount } from "@/actions/house-accounts";
import { ActionForm, Submit } from "@/components/action-form";

export function AccountTerms({ customerId, limitCents, termsDays, status, opening = false }: { customerId: string; limitCents: number; termsDays: number; status: string; opening?: boolean }) {
  return (
    <ActionForm action={saveHouseAccount.bind(null, customerId)} className="flex flex-wrap items-end gap-2">
      <div className="field">
        <label className="label" htmlFor={`ha-limit-${customerId}`}>
          Limit ($, blank for none)
        </label>
        <input id={`ha-limit-${customerId}`} name="limit" inputMode="decimal" className="input num w-32" defaultValue={limitCents ? (limitCents / 100).toFixed(2) : ""} />
      </div>
      <div className="field">
        <label className="label" htmlFor={`ha-terms-${customerId}`}>
          Days to pay
        </label>
        <input id={`ha-terms-${customerId}`} name="terms" inputMode="numeric" className="input num w-24" defaultValue={String(termsDays)} />
      </div>
      {!opening && (
        <label className="flex min-h-11 items-center gap-2 text-base">
          <input type="checkbox" name="status" value="CLOSED" className="check" defaultChecked={status === "CLOSED"} /> Closed to new charges
        </label>
      )}
      <Submit className={opening ? "btn btn-primary" : "btn"}>{opening ? "Open a house account" : "Save"}</Submit>
    </ActionForm>
  );
}
