// Orders to suppliers for every item (shop-features-round-2-design.md 1.1, package po-any-item): what is at or below its
// own reorder point with a suggestion, ticked onto a draft order per supplier, and the company's orders. Fabric by the
// yard has its own suggestions (the Fabric page's Reorder tab); its orders are listed here too.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { fmtDate, money } from "@/lib/format";
import { ordersListFor, reorderEachFor, suppliersFor } from "@/lib/fabric-orders";
import { PO_STATUS_LABEL } from "@/lib/fabric-orders-math";
import { KIND_LABEL } from "@/lib/parts";
import { Empty, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { addItemsToOrders, addSupplier } from "@/actions/fabric-orders";
import { NewOrderForm } from "@/components/fabric-orders-forms";
import { CatalogImport } from "@/components/connector-forms";
import { connectorFor } from "@/lib/connectors/registry";
import { waitingToOrder } from "@/lib/special-orders";
import { orderSpecialOrders } from "@/actions/special-orders";
import { hereForPage, reorderByStore } from "@/lib/store-orders";
import { activeStores } from "@/lib/stores";

const TONE = { DRAFT: "tone-neutral", SENT: "tone-work", PARTLY_RECEIVED: "tone-wait", RECEIVED: "tone-ready", CANCELLED: "tone-bad" } as const;

export default async function SupplierOrdersPage({ searchParams }: { searchParams: Promise<{ stores?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  // More than one store (7.3): "This store" or "All stores" (a combined order keeps each store's share).
  const here = await hereForPage(user);
  const mode = here && sp.stores === "all" ? "all" : "here";
  const storeRows = here ? await reorderByStore(user.shopId, here, mode) : null;
  const storeNames = new Map((await activeStores(user.shopId)).map((s) => [s.id, s.name]));
  const [rows, orders, suppliers, shop] = await Promise.all([
    reorderEachFor(user.shopId),
    ordersListFor(user.shopId),
    suppliersFor(user.shopId),
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true, sellsRetail: true, doesRepair: true } }),
  ]);
  const open = orders.filter((o) => o.status === "DRAFT" || o.status === "SENT" || o.status === "PARTLY_RECEIVED");
  // Special orders not ordered yet (shop-features-round-2-design.md 1.2): "3 special orders waiting", Add them.
  const specials = shop.sellsRetail ? await waitingToOrder(user.shopId) : [];
  const orderable = rows.filter((r) => r.supplier).length;
  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        back={{ href: "/parts", label: shop.doesRepair ? "Parts" : "Inventory" }}
        title="Orders to suppliers"
        sub={open.length ? `${open.length} open ${open.length === 1 ? "order" : "orders"}. Tick what's running low to add it to a draft order; nothing is ordered until you send it.` : "Tick what's running low to add it to a draft order; nothing is ordered until you send it."}
        actions={
          <Link href="/parts/coming-in" className="btn min-h-11">
            Coming in
          </Link>
        }
      />

      {specials.length > 0 && (
        <ActionForm action={orderSpecialOrders} className="card card-pad flex flex-wrap items-center justify-between gap-3 text-base">
          {specials.map((s) => (
            <input key={s.id} type="hidden" name="id" value={s.id} />
          ))}
          <span>
            <Link href="/special-orders" className="link">
              {specials.length} special {specials.length === 1 ? "order" : "orders"} waiting
            </Link>{" "}
            to be ordered for customers.
          </span>
          <Submit className="btn btn-primary min-h-11">Add {specials.length === 1 ? "it" : "them"}</Submit>
        </ActionForm>
      )}

      <section className="card" aria-labelledby="low-h">
        <div className="card-pad space-y-1 border-b border-line">
          <h2 id="low-h" className="h2">
            Running low
          </h2>
          <p className="muted text-sm">
            Items at or below the reorder point you set on each one (what&apos;s on a sent order counts). The amount brings it back up to twice that point; change it before you add it.
            {shop.sellsRetail ? (
              <>
                {" "}
                Fabric by the yard is suggested on the{" "}
                <Link href="/fabric?tab=reorder" className="link">
                  Fabric page&apos;s Reorder tab
                </Link>
                .
              </>
            ) : null}
          </p>
          {here && (
            <div className="flex flex-wrap gap-2 pt-2" role="group" aria-label="Which stores">
              <Link href="/parts/orders" className={`btn btn-sm ${mode === "here" ? "btn-primary" : ""}`} aria-current={mode === "here" ? "page" : undefined}>
                {here.name}
              </Link>
              <Link href="/parts/orders?stores=all" className={`btn btn-sm ${mode === "all" ? "btn-primary" : ""}`} aria-current={mode === "all" ? "page" : undefined}>
                All stores
              </Link>
            </div>
          )}
        </div>
        {storeRows ? (
          storeRows.length === 0 ? (
            <div className="card-pad">
              <Empty>Nothing is running low {mode === "all" ? "at any store" : `at ${here!.name}`}. Each store&apos;s reorder point is on the item&apos;s page, under Bin and reorder point at each store.</Empty>
            </div>
          ) : (
            <ActionForm action={addItemsToOrders} success="Added to draft orders">
              <ul className="divide-y divide-line" aria-label="Running low">
                {storeRows.map((r) => (
                  <li key={r.id} className="card-pad flex flex-wrap items-center gap-3">
                    <div className="min-w-[12rem] flex-1">
                      <Link href={`/parts/${r.id}`} className="link mono">
                        {r.partNumber}
                      </Link>{" "}
                      {r.description}
                      <div className="muted text-sm">{r.supplier ?? "no supplier yet"}</div>
                      <div className="text-sm">
                        {r.qty} on hand{mode === "all" ? " at all stores" : ""}, reorder at {r.reorderAt}
                        {Object.keys(r.split).length > 0 && <span className="muted"> · {Object.entries(r.split).map(([id, q]) => `${q} for ${storeNames.get(id) ?? "another store"}`).join(", ")}</span>}
                      </div>
                    </div>
                    {r.supplier ? (
                      <label className="flex min-h-11 items-center gap-2 text-base">
                        <input type="checkbox" name={`pick.${r.id}`} className="check" aria-label={`Order ${r.partNumber}`} />
                        <span>Order</span>
                        <input name={`qty.${r.id}`} defaultValue={r.suggest} inputMode="numeric" className="input num w-20" aria-label={`How many of ${r.partNumber}`} />
                        {Object.keys(r.split).length > 0 && <input type="hidden" name={`split.${r.id}`} value={JSON.stringify(r.split)} />}
                      </label>
                    ) : (
                      <Link href={`/parts/${r.id}`} className="link text-sm">
                        Give it a supplier to order it
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
              <div className="card-pad">
                <Submit>Add ticked items to draft orders</Submit>
              </div>
            </ActionForm>
          )
        ) : rows.length === 0 ? (
          <div className="card-pad">
            <Empty>Nothing is running low. An item shows up here when its stock reaches the &quot;Reorder when at or below&quot; number on its page.</Empty>
          </div>
        ) : (
          <ActionForm action={addItemsToOrders} success="Added to draft orders">
            <ul className="divide-y divide-line" aria-label="Running low">
              {rows.map((r) => (
                <li key={r.id} className="card-pad flex flex-wrap items-center gap-3">
                  <div className="min-w-[12rem] flex-1">
                    <Link href={`/parts/${r.id}`} className="link mono">
                      {r.partNumber}
                    </Link>{" "}
                    {r.description}
                    <div className="muted text-sm">
                      {[KIND_LABEL[r.kind] ?? r.kind, r.brand, r.supplier ?? "no supplier yet", r.location ? `bin ${r.location}` : null].filter(Boolean).join(" · ")}
                    </div>
                    <div className="text-sm">
                      {r.qtyOnHand} on hand, reorder at {r.reorderAt}
                      {r.onOrder > 0 ? `, ${r.onOrder} coming` : ""}
                      {r.inDraft > 0 && <span className="pill tone-wait ml-2">{r.inDraft} on a draft order</span>}
                    </div>
                  </div>
                  {r.supplier ? (
                    <label className="flex min-h-11 items-center gap-2 text-base">
                      <input type="checkbox" name={`pick.${r.id}`} className="check" aria-label={`Order ${r.partNumber}`} />
                      <span>Order</span>
                      <input name={`qty.${r.id}`} defaultValue={r.suggest} inputMode="numeric" className="input num w-20" aria-label={`How many of ${r.partNumber}`} />
                    </label>
                  ) : (
                    <Link href={`/parts/${r.id}`} className="link text-sm">
                      Give it a supplier to order it
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            {orderable > 0 && (
              <div className="card-pad">
                <Submit>Add ticked items to draft orders</Submit>
              </div>
            )}
          </ActionForm>
        )}
      </section>

      <section className="card card-pad space-y-3" aria-labelledby="orders-h">
        <h2 id="orders-h" className="h2">
          Orders
        </h2>
        {orders.length === 0 ? (
          <Empty>No orders yet. Tick items above, or start one by hand below.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Supplier</th>
                  <th>Where it stands</th>
                  <th className="text-right">Lines</th>
                  <th className="text-right">At cost</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/parts/orders/${o.id}`} className="link">
                        #{o.number}
                      </Link>
                    </td>
                    <td>{o.supplierName}</td>
                    <td>
                      <span className={`pill ${TONE[o.status]}`}>{PO_STATUS_LABEL[o.status]}</span>
                    </td>
                    <td className="num text-right">{o.lines}</td>
                    <td className="num text-right">{o.totalCents ? money(o.totalCents) : "-"}</td>
                    <td>{fmtDate(o.sentAt ?? o.createdAt, shop.timeZone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <details>
          <summary className="link cursor-pointer text-sm">Start an order by hand</summary>
          <div className="pt-3">
            <NewOrderForm suppliers={suppliers.map((s) => s.name)} />
          </div>
        </details>
      </section>

      {/* Distributor lists for any item (shop-features-round-2-design.md 2.3): thread, notions, supplies, fabric. */}
      {user.role !== "TECH" && (
        <section className="card card-pad space-y-3" aria-labelledby="lists-h">
          <h2 id="lists-h" className="h2">
            Suppliers&apos; lists
          </h2>
          <p className="muted text-sm">
            Bring in a supplier&apos;s spreadsheet of thread colors, notions, supplies or fabric: new items are added with no stock, and new costs and prices update the items you have. Nothing changes until you press Bring them in.
          </p>
          {suppliers.length === 0 ? (
            <Empty>No suppliers yet. Add one below, or give an item a supplier on its page.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {suppliers.map((s) => (
                <li key={s.name} className="py-2">
                  <details>
                    <summary className="cursor-pointer text-base">
                      {s.name}
                      <span className="muted text-sm">
                        {" "}
                        · {s.fabrics} {s.fabrics === 1 ? "item" : "items"}
                        {s.catalogAt ? ` · list brought in ${fmtDate(s.catalogAt, shop.timeZone)}` : ""}
                      </span>
                    </summary>
                    <div className="pt-3">
                      {s.id ? (
                        <CatalogImport supplierId={s.id} supplierName={s.name} placeholder={!!connectorFor(s.connector).placeholder} />
                      ) : (
                        <ActionForm action={addSupplier} success="Ready" className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="name" value={s.name} />
                          <Submit className="btn">Get {s.name} ready for its list</Submit>
                        </ActionForm>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={addSupplier} reset success="Added" className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label className="label" htmlFor="new-supplier">
                Another supplier&apos;s name
              </label>
              <input id="new-supplier" name="name" className="input" autoComplete="off" required />
            </div>
            <Submit className="btn">Add supplier</Submit>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
