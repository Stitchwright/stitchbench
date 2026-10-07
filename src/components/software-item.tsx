// "Software licence" on a software item's page (shop-features-round-2-design.md 2.5): once or a subscription, the
// no-returns words the receipt prints, and the codes on hand (bought ahead: the register uses the next one by itself).
import { db } from "@/lib/db";
import { codesOnHand, NO_RETURN_DEFAULT } from "@/lib/software";
import { loadCodes, saveSoftwareItem } from "@/actions/software";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function SoftwareItem({ shopId, partId }: { shopId: string; partId: string }) {
  const [p, onHand] = await Promise.all([db.part.findFirst({ where: { id: partId, shopId }, select: { licenseKind: true, licenseMonths: true, noReturnText: true } }), codesOnHand(shopId, partId)]);
  if (!p) return null;
  return (
    <Section title="Software licence">
      <ActionForm action={saveSoftwareItem.bind(null, partId)} success="Saved" className="space-y-3">
        <fieldset className="space-y-1">
          <legend className="label">How long it lasts</legend>
          <label className="flex min-h-11 items-center gap-2 text-base">
            <input type="radio" name="licenseKind" value="ONCE" defaultChecked={p.licenseKind !== "SUBSCRIPTION"} className="check" /> For good (bought once)
          </label>
          <label className="flex min-h-11 items-center gap-2 text-base">
            <input type="radio" name="licenseKind" value="SUBSCRIPTION" defaultChecked={p.licenseKind === "SUBSCRIPTION"} className="check" /> A subscription of
            <input name="licenseMonths" defaultValue={p.licenseMonths ?? 12} inputMode="numeric" className="input num w-20" aria-label="Months" /> months
          </label>
        </fieldset>
        <div className="field">
          <label className="label" htmlFor="no-return">
            No-returns words on the receipt
          </label>
          <input id="no-return" name="noReturnText" defaultValue={p.noReturnText ?? ""} placeholder={NO_RETURN_DEFAULT} className="input" maxLength={300} />
        </div>
        <Submit>Save</Submit>
      </ActionForm>
      <div className="mt-4 space-y-2 border-t border-line pt-3">
        <p className="text-base">
          <span className="font-semibold">{onHand}</span> {onHand === 1 ? "code" : "codes"} on hand. {onHand ? "The register uses the next one when no code is typed." : "Codes bought ahead can be loaded here."}
        </p>
        <ActionForm action={loadCodes.bind(null, partId)} reset className="space-y-2">
          <div className="field">
            <label className="label" htmlFor="load-codes">
              Add codes bought ahead (scan or type, one a line)
            </label>
            <textarea id="load-codes" name="codes" rows={3} className="input mono" autoComplete="off" required />
          </div>
          <Submit className="btn">Add these codes</Submit>
        </ActionForm>
      </div>
    </Section>
  );
}
