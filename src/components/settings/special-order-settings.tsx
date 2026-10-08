// Settings → Selling → Special orders (shop-features-round-2-design.md 1.2): the deposit asked by default (none, a set
// amount or a percent), what cancelling does with it, and the days before "not picked up" shows on the dashboard.
import { specialOrderSettings } from "@/lib/special-orders";
import { saveSpecialOrderSettings } from "@/actions/special-orders";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function SpecialOrderSettings({ shopId, admin }: { shopId: string; admin: boolean }) {
  const s = await specialOrderSettings(shopId);
  const how = s.depositCents > 0 ? "amount" : s.depositPct > 0 ? "pct" : "none";
  return (
    <Section title="Special orders" id="special-orders">
      <p className="muted mb-3 text-sm">What the register fills in when a customer orders something you don&apos;t have. You can change the deposit for each order.</p>
      <ActionForm action={saveSpecialOrderSettings} success="Saved" className="space-y-3 text-base">
        <fieldset disabled={!admin} className="space-y-3">
          <fieldset className="space-y-1">
            <legend className="label">Deposit</legend>
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="depositHow" value="none" defaultChecked={how === "none"} className="h-5 w-5" /> No deposit
            </label>
            <label className="flex min-h-11 flex-wrap items-center gap-2">
              <input type="radio" name="depositHow" value="amount" defaultChecked={how === "amount"} className="h-5 w-5" /> A set amount
              <input name="depositAmount" aria-label="Deposit amount" className="input num w-28" inputMode="decimal" defaultValue={s.depositCents ? (s.depositCents / 100).toFixed(2) : "10.00"} />
            </label>
            <label className="flex min-h-11 flex-wrap items-center gap-2">
              <input type="radio" name="depositHow" value="pct" defaultChecked={how === "pct"} className="h-5 w-5" /> A percent of the price
              <input name="depositPct" aria-label="Deposit percent" className="input num w-20" inputMode="numeric" defaultValue={s.depositPct || 25} />%
            </label>
          </fieldset>
          <div className="grid-form">
            <div className="field">
              <label htmlFor="so-rule" className="label">
                If she cancels, the deposit
              </label>
              <select id="so-rule" name="rule" className="select" defaultValue={s.rule}>
                <option value="credit">Comes back as store credit</option>
                <option value="refund">Is refunded</option>
                <option value="keep">Is kept (not refundable)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="so-days" className="label">
                Show it as not picked up after (days)
              </label>
              <input id="so-days" name="days" className="input num" inputMode="numeric" defaultValue={s.days} />
            </div>
          </div>
          <p className="muted text-sm">An item can keep its deposit whatever this says (a kit pre-registration): tick it on the item&apos;s page. The slip prints the rule.</p>
          {admin && <Submit>Save special order settings</Submit>}
        </fieldset>
      </ActionForm>
    </Section>
  );
}
