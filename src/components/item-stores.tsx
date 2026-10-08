// An item's stock at every store (shop-features-round-2-design.md 7.2 and 7.7), on its page, only with more than one
// store: "In this store: 2 · At Florida store: 5", each store's bin and reorder point, what's on the way, and two plain
// choices: Send some to another store, or Ask another store to send some.
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { activeStores, currentStore } from "@/lib/stores";
import { otherStoreLevels, qtyAt } from "@/lib/stock";
import { onTheWay } from "@/lib/transfers";
import { qtyText } from "@/lib/register-math";
import { saveStoreLevel } from "@/actions/store-levels";
import { askItem, sendItem } from "@/actions/transfers";
import { ActionForm, Submit } from "@/components/action-form";

export async function ItemStores({ user, part }: { user: CurrentUser; part: { id: string; qtyOnHand: number; reorderAt: number; location: string | null; unit: string | null; kind: string; consignLinkId: string | null } }) {
  const stores = await activeStores(user.shopId);
  if (stores.length <= 1 || part.consignLinkId || part.kind === "MACHINE") return null;
  const here = (await currentStore(user))!;
  const levels = (await otherStoreLevels(user.shopId, [part.id])).get(part.id);
  const rows = await db.stockLevel.findMany({ where: { shopId: user.shopId, partId: part.id }, select: { locationId: true, reorderAt: true, bin: true } });
  const own = new Map(rows.map((r) => [r.locationId, r]));
  const coming = await onTheWay(user.shopId, part.id);
  const admin = user.role !== "TECH";
  const per = stores.map((s) => ({
    s,
    qty: qtyAt(part.qtyOnHand, levels, s),
    reorderAt: s.main ? part.reorderAt : (own.get(s.id)?.reorderAt ?? 0),
    bin: s.main ? part.location : (own.get(s.id)?.bin ?? null),
  }));
  const mine = per.find((x) => x.s.id === here.id)!;
  const others = per.filter((x) => x.s.id !== here.id);
  const amount = (n: number) => `${qtyText(n, part.unit)}${part.unit === "yd" ? " yd" : ""}`;
  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4" data-testid="item-stores">
      <p className="text-base">
        <strong>In this store: {amount(mine.qty)}</strong>
        {others.map((o) => (
          <span key={o.s.id} className="muted text-sm">
            {" "}
            · At {o.s.name}: {amount(o.qty)}
          </span>
        ))}
      </p>
      {coming.length > 0 && (
        <ul className="muted text-sm">
          {coming.map((c, i) => (
            <li key={i}>
              {c.status === "ASKED" ? `Asked of ${c.from} for ${c.to}` : `On the way from ${c.from} to ${c.to}`}: {amount(c.qty)} (transfer {c.number})
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <ActionForm action={sendItem.bind(null, part.id)} reset className="space-y-2 rounded border border-line p-3">
          <div className="label">Send to another store</div>
          <div className="flex flex-wrap gap-2">
            <input name="qty" aria-label="How many to send" inputMode="decimal" className="input num w-20" placeholder="qty" required />
            <select name="toId" aria-label="Send to" className="select w-48" defaultValue={others[0]?.s.id}>
              {others.map((o) => (
                <option key={o.s.id} value={o.s.id}>
                  {o.s.name}
                </option>
              ))}
            </select>
          </div>
          <Submit className="btn btn-sm">Send</Submit>
        </ActionForm>
        <ActionForm action={askItem.bind(null, part.id)} reset className="space-y-2 rounded border border-line p-3">
          <div className="label">Ask another store to send some</div>
          <div className="flex flex-wrap gap-2">
            <input name="qty" aria-label="How many to ask for" inputMode="decimal" className="input num w-20" placeholder="qty" required />
            <select name="fromId" aria-label="Ask" className="select w-48" defaultValue={[...others].sort((a, b) => b.qty - a.qty)[0]?.s.id}>
              {others.map((o) => (
                <option key={o.s.id} value={o.s.id}>
                  {o.s.name} (has {amount(o.qty)})
                </option>
              ))}
            </select>
          </div>
          <input name="note" aria-label="Note for them" className="input" placeholder="For Jane by Friday (optional)" />
          <Submit className="btn btn-sm">Ask them</Submit>
        </ActionForm>
      </div>
      {admin && (
        <details>
          <summary className="link cursor-pointer text-sm">Bin and reorder point at each store</summary>
          <ul className="mt-2 divide-y divide-line text-sm">
            {per.map((x) => (
              <li key={x.s.id} className="py-2">
                <ActionForm action={saveStoreLevel.bind(null, part.id, x.s.id)} success={`${x.s.name} saved`} className="flex flex-wrap items-end gap-2">
                  <span className="min-w-32 font-semibold">{x.s.name}</span>
                  <label className="text-sm">
                    Bin <input name="bin" className="input w-24" defaultValue={x.bin ?? ""} />
                  </label>
                  <label className="text-sm">
                    Reorder at <input name="reorderAt" className="input num w-20" inputMode="decimal" defaultValue={x.reorderAt || ""} />
                  </label>
                  <Submit className="btn btn-sm">Save</Submit>
                </ActionForm>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
