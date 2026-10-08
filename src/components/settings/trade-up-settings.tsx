// Settings → Selling → Trade-up credit and the trade-in rule (shop-features-round-2-design.md 1.9): a repair's charges off
// a new machine bought within some days (off by default), and the trade-in step's starting number.
import { tradeUpSettings } from "@/lib/trade-up";
import { saveTradeUpSettings } from "@/actions/trade-up";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function TradeUpSettings({ shopId, admin }: { shopId: string; admin: boolean }) {
  const s = await tradeUpSettings(shopId);
  return (
    <Section title="Trade-up credit and trade-ins" id="trade-up">
      <ActionForm action={saveTradeUpSettings} success="Saved" className="space-y-3 text-base">
        <fieldset disabled={!admin} className="space-y-3">
          <label className="flex min-h-11 flex-wrap items-center gap-2">
            <input type="checkbox" name="on" defaultChecked={s.days > 0} className="h-5 w-5" /> If she buys a new machine within
            <input name="days" aria-label="Trade-up days" className="input num w-20" inputMode="numeric" defaultValue={s.days || 30} />{" "}days of a repair, take the repair&apos;s cost off
          </label>
          <p className="muted text-sm">The invoice says so (&quot;If you&apos;d rather buy a new machine by 12 Nov, we&apos;ll take $89 off&quot;); the register shows the credit when she buys a machine.</p>
          <label className="flex min-h-11 flex-wrap items-center gap-2">
            A trade-in starts at what you expect to sell it for, less
            <input name="lessPct" aria-label="Trade-in percent less" className="input num w-20" inputMode="numeric" defaultValue={s.lessPct} />%
          </label>
          {admin && <Submit>Save</Submit>}
        </fieldset>
      </ActionForm>
    </Section>
  );
}
