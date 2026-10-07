// One purchase order for several stores (shop-features-round-2-design.md 7.3), on the order's page, only with more than
// one store: how many of each line are for each other store, and once it has come in, "Send <store>'s share", which
// fills in a transfer from this store. Each store can also receive its own part when the supplier ships to both.
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { activeStores, currentStore } from "@/lib/stores";
import type { OrderView } from "@/lib/fabric-orders";
import { amountText } from "@/lib/fabric-orders-math";
import { saveSplit, sendShare } from "@/actions/transfers";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";

export async function OrderStores({ user, order }: { user: CurrentUser; order: OrderView }) {
  const stores = await activeStores(user.shopId);
  if (stores.length <= 1 || order.status === "CANCELLED") return null;
  const here = (await currentStore(user))!;
  const others = stores.filter((s) => s.id !== here.id);
  const unitWord = (l: OrderView["lines"][number]) => (l.unit === "EACH" ? "" : l.unit === "BOLT" ? " bolts" : " yd");
  const shares = others.map((s) => ({ s, lines: order.lines.filter((l) => (l.split?.[s.id] ?? 0) > 0) }));
  const sent = new Set((await db.stockTransfer.findMany({ where: { shopId: user.shopId, poId: order.id, status: { in: ["SENT", "ARRIVED"] } }, select: { toId: true } })).map((t) => t.toId));
  const came = order.status === "RECEIVED" || order.status === "PARTLY_RECEIVED";
  return (
    <div className="card card-pad space-y-3" data-testid="order-stores">
      <h2 className="text-base font-semibold">Which store gets what</h2>
      <p className="muted text-sm">
        The box comes to the store that receives it ({here.name} on this computer). Type how many of each line are for another store; the rest stays here. Once it has come, send each store its share.
      </p>
      <ActionForm action={saveSplit.bind(null, order.id)} success="Saved" className="space-y-2">
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="text-right">Ordered</th>
                {others.map((s) => (
                  <th key={s.id} className="text-right">
                    For {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <span className="mono">{l.itemNumber}</span> <span className="muted text-sm">{l.description}</span>
                  </td>
                  <td className="num text-right">{amountText(l)}</td>
                  {others.map((s) => (
                    <td key={s.id} className="text-right">
                      <input name={`split.${l.id}.${s.id}`} className="input num w-20" inputMode="decimal" defaultValue={l.split?.[s.id] ?? ""} aria-label={`${l.itemNumber} for ${s.name}`} />
                      <span className="muted text-xs">{unitWord(l)}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Submit className="btn btn-sm">Save the split</Submit>
      </ActionForm>
      {came && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {shares
            .filter((x) => x.lines.length)
            .map((x) =>
              sent.has(x.s.id) ? (
                <span key={x.s.id} className="pill tone-ready">
                  {x.s.name}&apos;s share sent
                </span>
              ) : (
                <ActionButton key={x.s.id} action={sendShare.bind(null, order.id, x.s.id)} className="btn btn-primary">
                  Send {x.s.name}&apos;s share
                </ActionButton>
              ),
            )}
        </div>
      )}
    </div>
  );
}
