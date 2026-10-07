// "It's back" for a loaner or demo (shop-features-round-2-design.md 1.7): the condition coming back, and the deposit
// given back (cash, card, check or store credit), or part of it kept for damage (owners and admins).
import { money } from "@/lib/format";
import { loanBack } from "@/actions/loans";
import { ActionForm, Submit } from "@/components/action-form";

export function LoanBackForm({ loanId, heldCents, admin }: { loanId: string; heldCents: number; admin: boolean }) {
  return (
    <ActionForm action={loanBack.bind(null, loanId)} className="space-y-3 text-base">
      <div className="field">
        <label htmlFor={`back-cond-${loanId}`} className="label">
          Condition coming back
        </label>
        <input id={`back-cond-${loanId}`} name="conditionBack" className="input text-base" defaultValue="Good" />
      </div>
      {heldCents > 0 && (
        <>
          <fieldset className="flex flex-wrap items-center gap-3">
            <legend className="label">Give the {money(heldCents)} deposit back as</legend>
            {(["CASH", "CARD", "CHECK", "CREDIT"] as const).map((m, i) => (
              <label key={m} className="flex min-h-11 items-center gap-2">
                <input type="radio" name="method" value={m} defaultChecked={i === 0} className="h-5 w-5" /> {m === "CREDIT" ? "Store credit" : m[0] + m.slice(1).toLowerCase()}
              </label>
            ))}
          </fieldset>
          {admin && (
            <details>
              <summary className="link cursor-pointer text-base">Damaged or lost? Keep some of the deposit</summary>
              <div className="field mt-2 max-w-xs">
                <label htmlFor={`back-keep-${loanId}`} className="label">
                  Keep (Loaner charges)
                </label>
                <input id={`back-keep-${loanId}`} name="keep" className="input num text-base" inputMode="decimal" placeholder="0.00" />
              </div>
            </details>
          )}
        </>
      )}
      <Submit className="btn btn-primary min-h-11">It&apos;s back</Submit>
    </ActionForm>
  );
}
