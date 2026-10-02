// Online orders for staff (online-and-parts-design.md section 3): paid orders to pack, ready ones waiting at the
// counter, and the rest on request. Ready for pickup (the customer hears), picked up, shipped with a tracking number
// (the customer hears), cancel and refund (owners and admins). Each is written in the register's books as a sale with
// tender "Paid online"; the link opens it.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";
import { ORDER_STATUS_LABEL, ordersFor, type OrderItem, type OrderStatus } from "@/lib/shop/online-shop";
import { fmtWhen } from "@/lib/zoned";
import { orderCancel, orderDone, orderNote, orderReady } from "@/actions/online-shop";
import { ActionForm, Submit } from "@/components/action-form";
import { Empty, PageHeader } from "@/components/ui";

const TONE: Record<OrderStatus, string> = { PENDING: "tone-wait", PAID: "tone-warn", READY: "tone-ok", DONE: "", CANCELLED: "tone-bad" };

export default async function OnlineOrders({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const user = await requireUser();
  const { all } = await searchParams;
  const [shop, orders] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true, shopOn: true, sellsRetail: true } }),
    ordersFor(user.shopId, { all: !!all }),
  ]);
  const admin = user.role !== "TECH";
  return (
    <div className="space-y-6">
      <PageHeader
        title="Online orders"
        sub={all ? "Every order, newest first." : "Paid orders to pack, and ready ones waiting at the counter."}
        actions={
          <>
            <Link href={all ? "/register/online" : "/register/online?all=1"} className="btn">
              {all ? "To do only" : "Show all"}
            </Link>
            {admin && (
              <Link href="/settings/shop" className="btn">
                Settings
              </Link>
            )}
          </>
        }
      />
      {!shop.shopOn && (
        <p className="card card-pad text-sm">
          The online shop is off.{" "}
          {admin && (
            <Link href="/settings/shop" className="link">
              Switch it on under Settings, Online shop.
            </Link>
          )}
        </p>
      )}
      {orders.length === 0 ? (
        <Empty>{all ? "No online orders yet." : "Nothing to pack. Orders show here as soon as they're paid."}</Empty>
      ) : (
        <ul className="space-y-4">
          {orders.map((o) => {
            const items = o.items as unknown as OrderItem[];
            const status = o.status as OrderStatus;
            return (
              <li key={o.id} className="card card-pad space-y-3" data-order={o.number}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="text-lg font-semibold">#{o.number}</span> <span className={`pill ${TONE[status]}`}>{ORDER_STATUS_LABEL[status]}</span>{" "}
                    <span className="pill">{o.fulfil === "ship" ? "Ship" : "Pickup"}</span>
                  </div>
                  <div className="muted text-sm">
                    {fmtWhen(o.createdAt, shop.timeZone)}
                    {o.paidAt ? ` · paid ${fmtWhen(o.paidAt, shop.timeZone)}` : ""}
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="text-sm">
                    <div className="font-semibold">
                      {o.customer ? (
                        <Link href={`/customers/${o.customer.id}`} className="link">
                          {o.name}
                        </Link>
                      ) : (
                        o.name
                      )}
                    </div>
                    <div className="muted">
                      {o.phone ?? ""}
                      {o.phone && o.email ? " · " : ""}
                      {o.email ?? ""}
                    </div>
                    {o.fulfil === "ship" && o.address && <div className="whitespace-pre-wrap pt-1">{o.address}</div>}
                    {o.note && <div className="pt-1 italic">&ldquo;{o.note}&rdquo;</div>}
                  </div>
                  <ul className="text-sm">
                    {items.map((it, i) => (
                      <li key={i} className="flex justify-between gap-2">
                        <span>
                          {it.description} <span className="mono muted">{it.partNumber}</span> × {qtyText(it.qty, it.unit)}
                          {it.short ? <span className="text-danger"> ({qtyText(it.short, it.unit)} short, refunded)</span> : null}
                        </span>
                        <span className="num">{money(Math.round(it.qty * it.unitPriceCents))}</span>
                      </li>
                    ))}
                    <li className="flex justify-between gap-2 border-t border-line pt-1 font-semibold">
                      <span>
                        Total{o.fulfil === "ship" && o.shipCents ? ` (incl. ${money(o.shipCents)} shipping)` : ""}
                        {o.refundedCents ? ` · ${money(o.refundedCents)} refunded` : ""}
                      </span>
                      <span className="num">{money(o.totalCents)}</span>
                    </li>
                  </ul>
                </div>
                {o.staffNote && <p className="rounded border border-warn bg-warn/10 p-2 text-sm">{o.staffNote}</p>}
                {o.tracking && (
                  <p className="text-sm">
                    Tracking: <span className="mono">{o.tracking}</span>
                  </p>
                )}
                <div className="flex flex-wrap items-end gap-3">
                  {o.saleId && (
                    <Link href={`/register/sales/${o.saleId}`} className="btn btn-sm">
                      The sale
                    </Link>
                  )}
                  {status === "PAID" && o.fulfil === "pickup" && (
                    <ActionForm action={orderReady.bind(null, o.id)} success="Marked ready; the customer hears">
                      <Submit className="btn btn-sm btn-primary">Ready for pickup</Submit>
                    </ActionForm>
                  )}
                  {(status === "PAID" || status === "READY") && o.fulfil === "pickup" && (
                    <ActionForm action={orderDone.bind(null, o.id)} success="Picked up">
                      <Submit className="btn btn-sm">Picked up</Submit>
                    </ActionForm>
                  )}
                  {status === "PAID" && o.fulfil === "ship" && (
                    <ActionForm action={orderDone.bind(null, o.id)} success="Shipped; the customer hears" className="flex items-end gap-2">
                      <div className="field">
                        <label htmlFor={`trk-${o.id}`} className="label">
                          Tracking number
                        </label>
                        <input id={`trk-${o.id}`} name="tracking" className="input" maxLength={120} placeholder="optional" />
                      </div>
                      <Submit className="btn btn-sm btn-primary">Shipped</Submit>
                    </ActionForm>
                  )}
                  {admin && (status === "PAID" || status === "READY") && (
                    <details>
                      <summary className="btn btn-sm cursor-pointer">Cancel and refund</summary>
                      <ActionForm action={orderCancel.bind(null, o.id)} success="Cancelled and refunded" className="mt-2 flex items-end gap-2">
                        <div className="field">
                          <label htmlFor={`why-${o.id}`} className="label">
                            Why
                          </label>
                          <input id={`why-${o.id}`} name="reason" className="input" maxLength={200} required />
                        </div>
                        <Submit className="btn btn-sm btn-danger">Refund {money(o.totalCents - o.refundedCents)} and cancel</Submit>
                      </ActionForm>
                    </details>
                  )}
                  <details>
                    <summary className="btn btn-sm cursor-pointer">Note</summary>
                    <ActionForm action={orderNote.bind(null, o.id)} success="Saved" className="mt-2 flex items-end gap-2">
                      <input name="note" aria-label="Staff note" defaultValue={o.staffNote ?? ""} className="input" maxLength={500} />
                      <Submit className="btn btn-sm">Save</Submit>
                    </ActionForm>
                  </details>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
