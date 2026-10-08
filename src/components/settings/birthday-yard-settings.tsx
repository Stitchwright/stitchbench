// Settings → Prices and members: the birthday offer and the per-yard breaks (shop-features-round-2-design.md 1.6).
import { birthdayOfferOf, yardBreaksFor } from "@/lib/birthdays";
import { RULE_KINDS } from "@/lib/price-rules";
import { addYardBreak, removeYardBreak, saveBirthdayOffer } from "@/actions/birthdays";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function BirthdayYardSettings({ shopId, admin }: { shopId: string; admin: boolean }) {
  const [offer, breaks] = await Promise.all([birthdayOfferOf(shopId), yardBreaksFor(shopId)]);
  const kindLabel = (k: string) => RULE_KINDS.find((x) => x.key === k)?.label.toLowerCase() ?? k;
  return (
    <>
      <Section title="Birthday offer">
        <p className="muted mb-3 text-sm">During her birthday month, once a year. The register shows it when she&apos;s chosen; one tap uses it. Add her birthday on her page (only if she&apos;d like to tell you).</p>
        <ActionForm action={saveBirthdayOffer} success="Saved" className="space-y-2 text-base">
          <fieldset disabled={!admin} className="space-y-1">
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="kind" value="none" defaultChecked={!offer} className="h-5 w-5" /> No birthday offer
            </label>
            <label className="flex min-h-11 flex-wrap items-center gap-2">
              <input type="radio" name="kind" value="pct" defaultChecked={offer?.kind === "pct"} className="h-5 w-5" />
              <input name="pct" aria-label="Birthday percent off" className="input num w-20" inputMode="numeric" defaultValue={offer?.kind === "pct" ? offer.value : 15} />% off one sale
            </label>
            <label className="flex min-h-11 flex-wrap items-center gap-2">
              <input type="radio" name="kind" value="credit" defaultChecked={offer?.kind === "credit"} className="h-5 w-5" /> A store credit of $
              <input name="credit" aria-label="Birthday credit amount" className="input num w-24" inputMode="decimal" defaultValue={offer?.kind === "credit" ? (offer.value / 100).toFixed(2) : "10.00"} />
            </label>
            {admin && <Submit>Save the birthday offer</Submit>}
          </fieldset>
        </ActionForm>
      </Section>

      <Section title="Per-yard price breaks">
        <p className="muted mb-3 text-sm">A lower price when she buys more of one fabric. The register applies it when the yards reach the step (&quot;10+ yd price&quot;). An item can have its own break on its page.</p>
        {breaks.length === 0 ? (
          <p className="text-base">No yard breaks.</p>
        ) : (
          <ul className="divide-y divide-line text-base">
            {breaks.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {b.minYards} yards or more of one item: {b.pctOff}% off{b.kinds.length ? ` (${b.kinds.map(kindLabel).join(", ")})` : ""}
                </span>
                {admin && (
                  <ActionButton action={removeYardBreak.bind(null, b.id)} className="btn btn-sm min-h-11" success="Removed">
                    Remove
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <details className="mt-3">
            <summary className="link cursor-pointer text-base">Add a yard break</summary>
            <ActionForm action={addYardBreak} success="Added" reset className="mt-2 space-y-3 text-base">
              <div className="flex flex-wrap items-end gap-3">
                <div className="field">
                  <label htmlFor="yb-min" className="label">
                    From how many yards
                  </label>
                  <input id="yb-min" name="minYards" className="input num w-24" inputMode="decimal" defaultValue="10" />
                </div>
                <div className="field">
                  <label htmlFor="yb-pct" className="label">
                    Percent off
                  </label>
                  <input id="yb-pct" name="pctOff" className="input num w-20" inputMode="numeric" defaultValue="10" />
                </div>
              </div>
              <details>
                <summary className="link cursor-pointer text-sm">Only some kinds (all items sold by the yard if none)</summary>
                <div className="flex flex-wrap gap-x-4">
                  {RULE_KINDS.map((k) => (
                    <label key={k.key} className="flex min-h-11 items-center gap-2">
                      <input type="checkbox" name="kinds" value={k.key} className="h-5 w-5" /> {k.label}
                    </label>
                  ))}
                </div>
              </details>
              <Submit className="btn btn-primary min-h-11">Add the break</Submit>
            </ActionForm>
          </details>
        )}
      </Section>
    </>
  );
}
