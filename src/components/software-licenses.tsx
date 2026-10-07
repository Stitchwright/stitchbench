// Software licences in a list (shop-features-round-2-design.md 2.5): the item, who and which machine it is for, the code
// masked ("…7F3K", shown in full with one tap), when it renews, and the steps: fill in a code that came later, mark it
// activated, end a subscription that isn't being renewed. Used on Parts → Software, a customer's page and a machine's.
import Link from "next/link";
import { fillCode, endLicense, setActivated } from "@/actions/software";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { RevealCode } from "@/components/reveal-code";
import type { LicenseRow } from "@/lib/software";

const STATUS: Record<string, string> = { ACTIVE: "Active", RENEWED: "Renewed", RETURNED: "Returned", ENDED: "Ended" };

export function LicenseList({ rows, admin, showCustomer = true, empty }: { rows: LicenseRow[]; admin: boolean; showCustomer?: boolean; empty: string }) {
  if (!rows.length) return <p className="muted text-sm">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((l) => (
        <li key={l.id} className="space-y-1 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base font-semibold">{l.description}</span>
            <span className="text-sm">
              {l.lapsed ? <span className="pill tone-bad">Renewal date passed</span> : <span className="pill tone-neutral">{STATUS[l.status] ?? l.status}</span>}
              {l.kind === "SUBSCRIPTION" && l.renewsText ? ` renews ${l.renewsText}` : l.kind === "ONCE" ? " for good" : ""}
            </span>
          </div>
          <div className="text-sm">
            {showCustomer && l.customerId && (
              <>
                <Link href={`/customers/${l.customerId}`} className="link">
                  {l.customerName}
                </Link>
                {" · "}
              </>
            )}
            {l.machineLabel ? `for the ${l.machineLabel} · ` : ""}
            sold {l.startsText}
            {l.saleId && (
              <>
                {" · "}
                <Link href={`/register/sales/${l.saleId}`} className="link">
                  receipt
                </Link>
              </>
            )}
            {" · "}
            {l.activatedText ? `activated ${l.activatedText}` : "not activated yet"}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {l.code ? (
              <RevealCode code={l.code} />
            ) : l.status === "ACTIVE" ? (
              <ActionForm action={fillCode.bind(null, l.id)} reset className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1">
                  <span className="muted">The code, now it has come</span>
                  <input name="code" className="input mono" autoComplete="off" required maxLength={80} />
                </label>
                <Submit className="btn">Save the code</Submit>
              </ActionForm>
            ) : null}
            {l.status === "ACTIVE" && !l.activatedText && (
              <ActionButton action={setActivated.bind(null, l.id, true)} className="btn btn-sm">
                Mark activated
              </ActionButton>
            )}
            {l.status === "ACTIVE" && l.activatedText && admin && (
              <ActionButton action={setActivated.bind(null, l.id, false)} className="btn btn-sm">
                Not activated after all
              </ActionButton>
            )}
            {l.status === "ACTIVE" && l.kind === "SUBSCRIPTION" && admin && (
              <ActionButton action={endLicense.bind(null, l.id)} className="btn btn-sm" confirm="Tap again: no more renewal reminders for it">
                Not renewing
              </ActionButton>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
