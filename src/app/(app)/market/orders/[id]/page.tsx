import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDateTime, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import type { HubOrder } from "@/lib/hub";
import { PageHeader, Section, KV } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { MarketNav, OrderStatus, CONDITION_LABEL, Stars } from "@/components/market-ui";
import { orderAction, orderStock } from "@/actions/market";
import { orderStockNote } from "@/lib/parts";

const ACTION_LABEL: Record<string, string> = {
  requested: "Ordered",
  accepted: "Accepted and invoiced",
  declined: "Declined",
  "buyer-paid": "Buyer sent payment",
  paid: "Seller marked it paid",
  shipped: "Shipped",
  received: "Received",
  cancelled: "Cancelled",
  message: "Message",
};

const d2 = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const { id } = await params;
  const row = await db.marketOrder.findUnique({ where: { id } });
  if (!row || row.shopId !== user.shopId) notFound();
  const o = row.data as unknown as HubOrder;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { payInstructions: true } });
  const seller = o.role === "seller";
  const buyer = o.role === "buyer";
  const act = (a: Parameters<typeof orderAction>[1]) => orderAction.bind(null, o.id, a);
  const beforeShipping = ["REQUESTED", "ACCEPTED", "PAID"].includes(o.status);
  // The buyer rates the seller once it has shipped; the seller rates the buyer once they've paid.
  const canRate = buyer ? ["SHIPPED", "RECEIVED"].includes(o.status) : ["PAID", "SHIPPED", "RECEIVED"].includes(o.status);
  const mine = o.ratings?.[o.role] ?? null;
  // A received purchase (or a shipped sale of a listing with a part number) that isn't in the parts stock: the box was
  // left unticked, or the stock change failed after the hub had the step.
  const stockOffer =
    (buyer ? o.status === "RECEIVED" : seller && Boolean(o.item.partNumber) && ["SHIPPED", "RECEIVED"].includes(o.status)) &&
    (await db.stockMove.count({ where: { shopId: user.shopId, note: orderStockNote(o) } })) === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: `/market/orders?role=${o.role}`, label: "Orders" }}
        title={
          <>
            Order <span className="mono">{o.number}</span>
          </>
        }
        sub={seller ? `Sale to ${o.buyerShop}` : `Purchase from ${o.sellerShop}`}
        actions={
          ["ACCEPTED", "PAID", "SHIPPED", "RECEIVED"].includes(o.status) ? (
            <Link href={`/market/orders/${o.id}/invoice`} className="btn">
              Invoice
            </Link>
          ) : null
        }
      />
      <MarketNav current="orders" />
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          <Section title="Order" actions={<OrderStatus status={o.status} />}>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <KV k="Item" v={o.item.title} />
              <KV k="Part number" v={o.item.partNumber ? <span className="mono">{o.item.partNumber}</span> : "-"} />
              <KV k="Condition" v={CONDITION_LABEL[o.item.condition] ?? o.item.condition} />
              <KV k="Quantity" v={String(o.qty)} />
              <KV k="Each" v={money(o.unitPriceCents)} />
              <KV k="Shipping" v={o.shippingCents != null ? money(o.shippingCents) : "to be quoted"} />
              <KV k="Total" v={<span className="num text-lg font-semibold">{money(o.totalCents)}</span>} />
            </div>
            {o.tracking && (
              <p className="mt-4 text-sm">
                {o.carrier} tracking:{" "}
                {o.trackingUrl ? (
                  <a href={o.trackingUrl} target="_blank" rel="noreferrer" className="link mono">
                    {o.tracking} <ExternalLink size={10} className="inline" aria-hidden />
                  </a>
                ) : (
                  <span className="mono">{o.tracking}</span>
                )}
              </p>
            )}
            {o.payInstructions && ["ACCEPTED", "PAID", "SHIPPED", "RECEIVED"].includes(o.status) && (
              <p className="mt-3 rounded border border-line p-3 text-sm">
                <strong>How to pay {o.sellerShop}:</strong> <span className="whitespace-pre-wrap">{o.payInstructions}</span>
                {o.buyerPaidNote && <span className="muted block">Buyer: &ldquo;{o.buyerPaidNote}&rdquo;</span>}
              </p>
            )}
          </Section>

          <Section title="What happened">
            <ol className="space-y-2 text-sm">
              {o.events.map((e, i) => (
                <li key={i} className="border-b border-line pb-2 last:border-0">
                  <span className="muted text-xs">{fmtDateTime(e.at, tz)}</span>{" "}
                  <strong>{e.by === "seller" ? o.sellerShop : o.buyerShop}</strong>: {ACTION_LABEL[e.action] ?? e.action}
                  {e.note && <span className="block whitespace-pre-wrap">{e.note}</span>}
                </li>
              ))}
            </ol>
            <ActionForm action={act("message")} reset success="Sent" className="mt-3 flex gap-2">
              <label htmlFor="msg" className="sr-only">
                Message
              </label>
              <input id="msg" name="text" className="input" placeholder={`Message to ${seller ? o.buyerShop : o.sellerShop}`} required />
              <Submit className="btn btn-sm">Send</Submit>
            </ActionForm>
          </Section>
        </div>

        <div className="space-y-6 xl:col-span-2">
          <Section title="Next step">
            <div className="space-y-4 text-sm">
              {seller && o.status === "REQUESTED" && (
                <>
                  <ActionForm action={act("accept")} success="Accepted: the buyer has your invoice" className="space-y-2">
                    <div className="label">Accept and send the invoice</div>
                    <label htmlFor="ac-ship" className="muted text-xs">
                      Shipping ($)
                    </label>
                    <input id="ac-ship" name="shipping" defaultValue={d2(o.shippingCents)} className="input num" required />
                    <label htmlFor="ac-pay" className="muted text-xs">
                      How they pay you
                    </label>
                    <textarea id="ac-pay" name="payInstructions" rows={2} defaultValue={shop.payInstructions ?? ""} className="textarea" required />
                    <Submit className="btn btn-primary btn-sm">Accept</Submit>
                  </ActionForm>
                  <ActionForm action={act("decline")} success="Declined" className="space-y-2 border-t border-line pt-3">
                    <label htmlFor="dc-reason" className="label">
                      Or decline
                    </label>
                    <input id="dc-reason" name="reason" className="input" placeholder="Reason (the buyer sees it)" />
                    <Submit className="btn btn-sm">Decline</Submit>
                  </ActionForm>
                </>
              )}
              {seller && o.status === "ACCEPTED" && (
                <ActionForm action={act("paid")} success="Marked paid" className="space-y-2">
                  <div className="label">When the money arrives</div>
                  <Submit className="btn btn-sm">Mark it paid</Submit>
                </ActionForm>
              )}
              {seller && (o.status === "ACCEPTED" || o.status === "PAID") && (
                <ActionForm action={act("ship")} success="Shipped: the buyer has the tracking" className="space-y-2 border-t border-line pt-3">
                  <div className="label">Shipped it?</div>
                  <label htmlFor="sh-carrier" className="sr-only">
                    Carrier
                  </label>
                  <select id="sh-carrier" name="carrier" className="select" defaultValue="USPS">
                    {["USPS", "UPS", "FedEx", "DHL", "Other"].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                  <label htmlFor="sh-track" className="sr-only">
                    Tracking number
                  </label>
                  <input id="sh-track" name="tracking" className="input mono" placeholder="Tracking number" required />
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="takeFromStock" defaultChecked className="check" /> Take {o.qty} out of my parts stock
                  </label>
                  <Submit className="btn btn-primary btn-sm">Mark shipped</Submit>
                </ActionForm>
              )}
              {buyer && o.status === "REQUESTED" && <p className="muted">Waiting for {o.sellerShop} to accept and send the invoice.</p>}
              {buyer && o.status === "ACCEPTED" && (
                <ActionForm action={act("buyer-paid")} success="The seller knows you've paid" className="space-y-2">
                  <div className="label">Paid the seller?</div>
                  <input name="note" aria-label="How you paid" className="input" placeholder="e.g. PayPal, sent 3:10 pm" />
                  <Submit className="btn btn-sm">I&apos;ve sent payment</Submit>
                </ActionForm>
              )}
              {buyer && o.status === "PAID" && <p className="muted">Paid. Waiting for {o.sellerShop} to ship.</p>}
              {buyer && o.status === "SHIPPED" && (
                <ActionForm action={act("received")} success="Received" className="space-y-2">
                  <div className="label">Arrived?</div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="addToStock" defaultChecked className="check" /> Add {o.qty} to my parts stock
                  </label>
                  <Submit className="btn btn-primary btn-sm">Mark received</Submit>
                </ActionForm>
              )}
              {["RECEIVED", "DECLINED", "CANCELLED"].includes(o.status) && (
                <p className="muted">
                  Done{o.cancelReason ? `: ${o.cancelReason}` : ""}.
                </p>
              )}
              {stockOffer && (
                <ActionForm action={orderStock.bind(null, o.id)} success={buyer ? "Added to your parts stock" : "Taken out of your parts stock"} className="space-y-2 border-t border-line pt-3">
                  <div className="label">Parts stock</div>
                  <p className="muted">{buyer ? `The ${o.qty} that arrived aren't in your parts stock yet.` : `The ${o.qty} you shipped are still counted in your parts stock.`}</p>
                  <Submit className="btn btn-sm">{buyer ? `Add ${o.qty} to my parts stock` : `Take ${o.qty} out of my parts stock`}</Submit>
                </ActionForm>
              )}
              {beforeShipping && (
                <ActionForm action={act("cancel")} success="Cancelled" className="space-y-2 border-t border-line pt-3">
                  <label htmlFor="cx-reason" className="label">
                    Cancel the order
                  </label>
                  <input id="cx-reason" name="reason" className="input" placeholder="Reason" />
                  <Submit className="btn btn-sm btn-danger">Cancel order</Submit>
                </ActionForm>
              )}
            </div>
          </Section>

          <Section title="Ratings">
            <div className="space-y-3 text-sm">
              {(["buyer", "seller"] as const).map((side) => {
                const r = o.ratings?.[side];
                const who = side === "buyer" ? `${o.buyerShop} rated ${o.sellerShop}` : `${o.sellerShop} rated ${o.buyerShop}`;
                return r ? (
                  <div key={side}>
                    <span className="muted text-xs">{who}</span>
                    <div>
                      <span className="text-[var(--wait)]" aria-label={`${r.stars} out of 5`}>
                        {"★".repeat(r.stars)}
                        <span className="text-line">{"★".repeat(5 - r.stars)}</span>
                      </span>
                      {r.comment && <span> &ldquo;{r.comment}&rdquo;</span>}
                    </div>
                  </div>
                ) : null;
              })}
              {canRate && (
                <ActionForm action={act("rate")} success="Thanks for rating" className="space-y-2 border-t border-line pt-3">
                  <label htmlFor="rt-stars" className="label">
                    {mine ? "Change your rating of" : "Rate"} {seller ? o.buyerShop : o.sellerShop}
                  </label>
                  <select id="rt-stars" name="stars" defaultValue={String(mine?.stars ?? 5)} className="select w-40">
                    {[5, 4, 3, 2, 1].map((n) => (
                      <option key={n} value={n}>
                        {"★".repeat(n)} {n}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="rt-comment" className="sr-only">
                    Comment
                  </label>
                  <input id="rt-comment" name="comment" defaultValue={mine?.comment ?? ""} className="input" placeholder={seller ? "e.g. paid fast, easy to deal with" : "e.g. well packed, as described"} />
                  <Submit className="btn btn-sm">{mine ? "Update rating" : "Send rating"}</Submit>
                </ActionForm>
              )}
              {!canRate && !o.ratings?.buyer && !o.ratings?.seller && (
                <p className="muted text-xs">
                  {seller ? "You can rate the buyer once they've paid." : "You can rate the seller once it has shipped."}
                </p>
              )}
            </div>
          </Section>

          <Section title={seller ? "Buyer" : "Seller"}>
            <div className="mb-2">
              <Stars avg={(seller ? o.buyerReputation : o.sellerReputation)?.avg} count={(seller ? o.buyerReputation : o.sellerReputation)?.count ?? 0} />
            </div>
            <div className="space-y-1 text-sm">
              {seller ? (
                <>
                  <div className="font-semibold">{o.buyerShop}</div>
                  {o.buyerContact?.name && <div>{o.buyerContact.name}</div>}
                  {o.buyerContact?.email && <div>{o.buyerContact.email}</div>}
                  {o.buyerContact?.phone && <div>{o.buyerContact.phone}</div>}
                  {o.shipTo && <div className="mt-2 whitespace-pre-wrap">Ship to:{"\n"}{o.shipTo}</div>}
                  {o.buyerNote && <div className="muted mt-2">&ldquo;{o.buyerNote}&rdquo;</div>}
                </>
              ) : (
                <>
                  <div className="font-semibold">{o.sellerShop}</div>
                  {o.sellerContact ? (
                    <>
                      {o.sellerContact.address && <div className="whitespace-pre-wrap">{o.sellerContact.address}</div>}
                      {o.sellerContact.email && <div>{o.sellerContact.email}</div>}
                      {o.sellerContact.phone && <div>{o.sellerContact.phone}</div>}
                    </>
                  ) : (
                    <div className="muted">Contact details come with the invoice.</div>
                  )}
                </>
              )}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
