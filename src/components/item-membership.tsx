// "Sells a membership" on an item's page (shop-features-round-2-design.md 1.5): selling this item puts the buyer in a
// price group for some months ("Club card, $25, 12 months"). Owners and admins.
import { db } from "@/lib/db";
import { saveMembershipItem } from "@/actions/price-groups";
import { ActionForm, Submit } from "@/components/action-form";

export async function ItemMembership({ shopId, part }: { shopId: string; part: { id: string; membershipGroupId: string | null; membershipMonths: number | null } }) {
  const groups = await db.priceGroup.findMany({ where: { shopId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  if (!groups.length && !part.membershipGroupId) return null;
  return (
    <details className="card card-pad">
      <summary className="link cursor-pointer text-base">Sells a membership{part.membershipGroupId ? `: ${groups.find((g) => g.id === part.membershipGroupId)?.name ?? ""}` : ""}</summary>
      <ActionForm action={saveMembershipItem.bind(null, part.id)} success="Saved" className="mt-3 flex flex-wrap items-end gap-3 text-base">
        <div className="field">
          <label htmlFor="mem-group" className="label">
            Puts the buyer in
          </label>
          <select id="mem-group" name="groupId" className="select" defaultValue={part.membershipGroupId ?? ""}>
            <option value="">No group (an ordinary item)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="mem-months" className="label">
            For (months)
          </label>
          <input id="mem-months" name="months" className="input num w-20" inputMode="numeric" defaultValue={part.membershipMonths ?? 12} />
        </div>
        <Submit className="btn min-h-11">Save</Submit>
      </ActionForm>
    </details>
  );
}
