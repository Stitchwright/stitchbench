// A machine's service plans on its page (tax-machine-sales-layaway-design.md section 3): each with its visits used and
// last day; an owner or admin can end one early (refunded by hand, or sold by mistake).
import type { CurrentUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { machinePlansFor } from "@/lib/units/plans";
import { endPlan } from "@/actions/units";
import { ActionButton } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function PlanList({ machineId, user }: { machineId: string; user: CurrentUser }) {
  const plans = await machinePlansFor(user.shopId, machineId, await shopTimeZone(user.shopId));
  if (!plans.length) return null;
  return (
    <Section title="Service plans">
      <ul className="divide-y divide-line text-sm">
        {plans.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              {p.text}
              {p.voided ? <span className="pill tone-neutral ml-2">Ended</span> : !p.current && <span className="pill tone-neutral ml-2">Not in force</span>}
            </span>
            {!p.voided && user.role !== "TECH" && (
              <ActionButton action={endPlan.bind(null, p.id)} className="btn btn-sm" confirm={`End ${p.name} now? Work it already covered stays covered. Refund any money as a misc line at the register.`}>
                End plan
              </ActionButton>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
