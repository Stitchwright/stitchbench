// A customer's price group or membership on her page (shop-features-round-2-design.md 1.5): the group, until when, and
// (owners and admins) join, change or leave it.
import { db } from "@/lib/db";
import { fmtYmdLong } from "@/lib/units/units";
import { customerGroupFor } from "@/lib/price-groups";
import { setCustomerGroup } from "@/actions/price-groups";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function CustomerPriceGroup({ shopId, customerId, admin }: { shopId: string; customerId: string; admin: boolean }) {
  const [g, groups] = await Promise.all([customerGroupFor(shopId, customerId), db.priceGroup.findMany({ where: { shopId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })]);
  if (!g && !groups.length) return null;
  return (
    <Section title="Price group">
      <p className="text-base">
        {g ? (
          <>
            <span className={`pill mr-1 ${g.inForce ? "tone-ready" : "tone-neutral"}`}>{g.name}</span>
            {g.useWholesale ? "the wholesale price" : `${g.pctOff}% off`}
            {g.until ? `, ${g.inForce ? "until" : "ended"} ${fmtYmdLong(g.until)}` : ""}
          </>
        ) : (
          "No price group."
        )}
      </p>
      {admin && (
        <details className="mt-2">
          <summary className="link cursor-pointer text-base">{g ? "Change or end it" : "Put her in a group"}</summary>
          <ActionForm action={setCustomerGroup.bind(null, customerId)} success="Saved" className="mt-2 flex flex-wrap items-end gap-3 text-base">
            <div className="field">
              <label htmlFor="cg-group" className="label">
                Group
              </label>
              <select id="cg-group" name="groupId" className="select" defaultValue={g?.id ?? ""}>
                <option value="">None</option>
                {groups.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cg-until" className="label">
                Ends (for a paid membership)
              </label>
              <input id="cg-until" name="until" type="date" className="input" defaultValue={g?.until ?? ""} />
            </div>
            <Submit className="btn min-h-11">Save</Submit>
          </ActionForm>
        </details>
      )}
    </Section>
  );
}
