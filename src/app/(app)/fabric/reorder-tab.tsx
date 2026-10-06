// The Reorder tab (fabric-smarts-design.md section 2, item 4): fabrics worth reordering while in print, the suggested
// amount in half bolts with the numbers behind it, tick rows onto a draft order per supplier, suppliers' figures, and the
// company's orders.
import Link from "next/link";
import { money } from "@/lib/format";
import { reorderFor, ordersListFor, suppliersFor, type ReorderRow } from "@/lib/fabric-orders";
import { PO_STATUS_LABEL } from "@/lib/fabric-orders-math";
import { qtyText } from "@/lib/register-math";
import { fmtDate } from "@/lib/format";
import { Empty } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { addReorderToDrafts } from "@/actions/fabric-orders";
import { NewOrderForm, SupplierForm } from "@/components/fabric-orders-forms";
import { Swatch } from "@/components/fabric-swatch";
import { db } from "@/lib/db";

const fix1 = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1));
const TONE = { DRAFT: "tone-neutral", SENT: "tone-work", PARTLY_RECEIVED: "tone-wait", RECEIVED: "tone-ready", CANCELLED: "tone-bad" } as const;

function Why({ r, review }: { r: ReorderRow; review: number }) {
  const m = r.math;
  return (
    <div className="muted text-xs">
      Sells {fix1(r.item.perWeek)} yd a week; to last {fix1(r.lead.days / 7)} weeks of lead time ({r.lead.days} days, {r.lead.from === "learned" ? "learned" : r.lead.from === "supplier" ? "supplier's figure" : "shop default"}) plus {review}{" "}
      {review === 1 ? "week" : "weeks"} between orders needs {fix1(m.target - m.safety)} yd, plus {fix1(m.safety)} yd safety ({r.staple ? "staple" : "collection"}, {r.z}). Have {qtyText(r.item.qty, "yd")}
      {r.onOrder > 0 ? `, ${qtyText(r.onOrder, "yd")} on order` : ""}.
    </div>
  );
}

export async function ReorderTab({ shopId }: { shopId: string }) {
  const [view, suppliers, orders, shop] = await Promise.all([
    reorderFor(shopId),
    suppliersFor(shopId),
    ordersListFor(shopId),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true, fabLeadDays: true } }),
  ]);
  const open = orders.filter((o) => o.status === "DRAFT" || o.status === "SENT" || o.status === "PARTLY_RECEIVED");
  return (
    <div className="space-y-4">
      <p className="muted text-sm">
        Fabrics still in print (not marked closed out) that will run out before the next order arrives. The suggestion is what they sell over the supplier&apos;s lead time plus {view.reviewWeeks}{" "}
        {view.reviewWeeks === 1 ? "week" : "weeks"}, plus a safety margin, less what you have and what is on a sent order, rounded to half bolts. Ticking rows adds them to a draft order per supplier; nothing is ordered
        until you send it.
      </p>
      <div className="card">
        {view.rows.length === 0 ? (
          <div className="card-pad">
            <Empty>Nothing needs ordering right now. Fabrics that are selling, in print, and short against their lead time show up here.</Empty>
          </div>
        ) : (
          <ActionForm action={addReorderToDrafts} success="Added to draft orders">
            <ul className="divide-y divide-line" aria-label="Reorder">
              {view.rows.map((r) => {
                const i = r.item;
                const half = i.boltYards / 2;
                return (
                  <li key={i.id} className="card-pad flex flex-wrap items-start gap-3">
                    <Swatch photoId={i.photoId} alt={i.description} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div>
                        <Link href={`/parts/${i.id}`} className="link mono">
                          {i.partNumber}
                        </Link>{" "}
                        {i.description}
                        <div className="muted text-xs">{[i.brand, i.collection, r.supplier ?? "no supplier", i.priceCents != null ? `${money(i.priceCents)}/yd` : null].filter(Boolean).join(" · ")}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        {r.urgent && <span className="pill tone-bad">Reorder now: {r.soldPct}% sold in {view.urgentDays} days</span>}
                        {i.inPrint === "UNKNOWN" && <span className="pill tone-neutral">in print? check the supplier</span>}
                        <span>
                          <span className="num font-semibold">{i.weeks == null ? "-" : fix1(i.weeks)}</span> weeks of supply
                        </span>
                        {i.reorderAt > 0 && <span className="muted">your reorder point: {qtyText(i.reorderAt, "yd")}</span>}
                        {r.inDraft > 0 && <span className="pill tone-wait">{qtyText(r.inDraft, "yd")} on a draft order</span>}
                      </div>
                      <Why r={r} review={view.reviewWeeks} />
                    </div>
                    <div className="flex flex-col gap-1 text-sm sm:items-end">
                      <label className="flex items-center gap-2">
                        <input type="checkbox" name={`pick.${i.id}`} className="check" disabled={!r.supplier} aria-label={`Order ${i.partNumber}`} />
                        <span>Order</span>
                        <input name={`bolts.${i.id}`} defaultValue={r.math.halves / 2} inputMode="decimal" className="input num w-16" aria-label={`Bolts of ${i.partNumber}`} />
                        <span>bolts</span>
                      </label>
                      <span className="muted text-xs">
                        {qtyText(r.math.yards, "yd")} ({qtyText(half, "yd")} is half a bolt)
                      </span>
                      {!r.supplier && <span className="muted text-xs">Give it a supplier to order it.</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="card-pad">
              <Submit>Add ticked fabric to draft orders</Submit>
            </div>
          </ActionForm>
        )}
      </div>

      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Orders</h2>
        {orders.length === 0 ? (
          <Empty>No orders yet.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Supplier</th>
                  <th>Status</th>
                  <th className="text-right">Lines</th>
                  <th className="text-right">At cost</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/fabric/orders/${o.id}`} className="link">
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
        {open.length > 0 && <p className="muted text-xs">{open.length} open. Sent orders count as on order in the suggestions above and keep a fabric off Bolt ends.</p>}
        <NewOrderForm suppliers={suppliers.map((s) => s.name)} />
      </div>

      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Suppliers</h2>
        <p className="muted text-xs">
          The names come from your fabric items. A supplier&apos;s lead time is learned from its received orders (days from sent to first delivery); until then the figure you give here, or {shop.fabLeadDays} days,
          is used. The minimum order only warns on an order.
        </p>
        {suppliers.length === 0 ? (
          <Empty>No suppliers yet. Give a fabric a supplier (open the item), or start an order by hand above.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {suppliers.map((s) => (
              <li key={s.name} className="space-y-2 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-medium">{s.name}</span>
                  <span className="muted text-xs">
                    {s.fabrics} {s.fabrics === 1 ? "fabric" : "fabrics"} · lead time in use {s.lead.days} days ({s.lead.from === "learned" ? `learned from ${s.learnedOrders} ${s.learnedOrders === 1 ? "order" : "orders"}` : s.lead.from === "supplier" ? "your figure" : "shop default"})
                    {s.openOrders ? ` · ${s.openOrders} open` : ""}
                  </span>
                </div>
                <SupplierForm name={s.name} leadDays={s.leadDays} minOrder={s.minOrderCents ? (s.minOrderCents / 100).toFixed(2) : ""} orderEmail={s.orderEmail} placeholderLead={shop.fabLeadDays} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
