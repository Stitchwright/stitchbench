// Settings → Care tips (shop-features-round-2-design.md 5.5): the shop's own tips per kind of machine, which the pickup
// sheet picks from. Starter tips with one tap; owners and admins change them; everyone can read them.
import { requireUser } from "@/lib/session";
import { careTipsFor } from "@/lib/care-tips";
import { startersFor } from "@/lib/care-tips-starters";
import { shopKinds } from "@/lib/equipment/shop";
import { withArticle } from "@/lib/equipment/types";
import { addCareTip, addStarterTips } from "@/actions/care-tips";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CareTipRemove } from "@/components/care-tip-remove";
import { PageHeader, Section } from "@/components/ui";

export default async function CareTipsPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [{ usable }, tips] = await Promise.all([shopKinds(user.shopId), careTipsFor(user.shopId)]);
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Care tips" sub="The pickup sheet prints the tips you tick from these. Write them once, in your own words." back={{ href: "/settings", label: "Settings" }} />
      {usable.map((k) => {
        const mine = tips.filter((t) => t.kind === k.key);
        const starters = startersFor(k.key);
        return (
          <Section key={k.key} title={`For ${withArticle(k.noun)}`}>
            <div className="space-y-3">
              {mine.length === 0 ? (
                <p className="text-sm">
                  No tips yet for {withArticle(k.noun)}.{admin && starters.length > 0 ? ` Start with ${starters.length} common ones and change them as you like.` : ""}
                </p>
              ) : (
                <ul className="divide-y divide-line text-sm" aria-label={`Care tips for ${withArticle(k.noun)}`}>
                  {mine.map((t) => (
                    <li key={t.id} className="flex items-start justify-between gap-3 py-2">
                      <span>{t.text}</span>
                      {admin && <CareTipRemove id={t.id} />}
                    </li>
                  ))}
                </ul>
              )}
              {admin && mine.length === 0 && starters.length > 0 && (
                <ActionButton action={addStarterTips.bind(null, k.key)} className="btn btn-primary">
                  Add the starter tips
                </ActionButton>
              )}
              {admin && (
                <ActionForm action={addCareTip.bind(null, k.key)} reset className="flex flex-wrap items-end gap-2">
                  <div className="field min-w-64 flex-1">
                    <label htmlFor={`tip-${k.key}`} className="label">
                      A tip of your own for {withArticle(k.noun)}
                    </label>
                    <input id={`tip-${k.key}`} name="text" className="input" maxLength={300} placeholder="Change the needle every 8 hours of sewing." />
                  </div>
                  <Submit>Add the tip</Submit>
                </ActionForm>
              )}
            </div>
          </Section>
        );
      })}
      {!admin && <p className="muted text-sm">Only an owner or admin can change the care tips.</p>}
    </div>
  );
}
