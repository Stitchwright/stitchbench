// A machine for sale's lifetime discount on its supplies (shop-features-round-2-design.md 1.5): ticked with the
// percent (the shop's default filled in); the buyer then gets it on bags, belts and filters bought for this machine.
import { db } from "@/lib/db";
import { saveUnitLifetime } from "@/actions/price-groups";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function UnitLifetime({ shopId, unitId, admin }: { shopId: string; unitId: string; admin: boolean }) {
  const [u, shop] = await Promise.all([
    db.stockUnit.findFirst({ where: { id: unitId, shopId }, select: { lifetimePctOff: true } }),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { lifetimePctDefault: true } }),
  ]);
  if (!u) return null;
  return (
    <Section title="Lifetime discount on its supplies">
      <ActionForm action={saveUnitLifetime.bind(null, unitId)} success="Saved" className="space-y-3 text-base">
        <fieldset disabled={!admin} className="flex flex-wrap items-center gap-3">
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" name="on" defaultChecked={u.lifetimePctOff != null} className="h-5 w-5" /> The buyer gets
          </label>
          <input name="pct" aria-label="Lifetime percent off" className="input num w-20" inputMode="numeric" defaultValue={u.lifetimePctOff ?? shop.lifetimePctDefault} />
          <span>% off its bags, belts and filters for life</span>
          {admin && <Submit className="btn min-h-11">Save</Submit>}
        </fieldset>
      </ActionForm>
    </Section>
  );
}
