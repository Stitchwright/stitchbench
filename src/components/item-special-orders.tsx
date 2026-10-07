// An item's special orders and "Coming soon" (shop-features-round-2-design.md 1.2) on its page: the day it's expected
// (the register and the online shop then take pre-orders), whether a deposit for it is kept on a cancel, and the open
// orders for it, with "Ask for the balances" for pre-orders (a pay link each).
import Link from "next/link";
import { fmtYmdLong } from "@/lib/units/units";
import { specialOrdersFor } from "@/lib/special-orders";
import { askForPreorderBalances, saveComingSoon } from "@/actions/special-orders";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function ItemSpecialOrders({ shopId, part, admin }: { shopId: string; part: { id: string; comingSoonOn: string | null; depositKept: boolean }; admin: boolean }) {
  const orders = (await specialOrdersFor(shopId, { partId: part.id })).filter((o) => ["WAITING", "ORDERED", "HERE"].includes(o.status));
  const pre = orders.filter((o) => o.kind === "PREORDER");
  return (
    <Section title="Special orders and coming soon">
      <div className="space-y-3 text-base">
        {orders.length > 0 ? (
          <p>
            <Link href={`/special-orders`} className="link">
              {orders.length} {orders.length === 1 ? "customer is" : "customers are"} waiting for this
            </Link>
            : {orders.map((o) => `${o.customer?.name ?? ""} (${o.statusWords.toLowerCase()})`).join(", ")}.
          </p>
        ) : (
          <p className="muted text-sm">No special orders for this item.</p>
        )}
        {part.comingSoonOn && <p><span className="pill tone-wait">Coming soon {fmtYmdLong(part.comingSoonOn)}</span> The register takes pre-orders for it.</p>}
        {admin && pre.length > 0 && (
          <ActionButton action={askForPreorderBalances.bind(null, part.id)} className="btn min-h-11" confirm={`Tap again to send ${pre.length} pay ${pre.length === 1 ? "link" : "links"}`}>
            Ask for the balances
          </ActionButton>
        )}
        {admin && (
          <details>
            <summary className="link cursor-pointer text-base">Coming soon and deposits</summary>
            <ActionForm action={saveComingSoon.bind(null, part.id)} success="Saved" className="mt-3 space-y-3">
              <div className="field max-w-xs">
                <label htmlFor="cs-on" className="label">
                  Coming soon: expected on
                </label>
                <input id="cs-on" name="comingSoonOn" type="date" className="input text-base" defaultValue={part.comingSoonOn ?? ""} />
              </div>
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" name="depositKept" defaultChecked={part.depositKept} className="h-5 w-5" /> A deposit for this item is kept if she cancels (not refundable)
              </label>
              <Submit>Save</Submit>
            </ActionForm>
          </details>
        )}
      </div>
    </Section>
  );
}
