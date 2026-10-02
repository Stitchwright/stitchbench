// The customer's order page (online-and-parts-design.md section 3), by the token in the link: what was ordered, what
// it came to, paid or not, ready, shipped with tracking, cancelled with the refund. Stripe's return lands here with
// ?paid=1: a still-pending order is confirmed with Stripe before the page is drawn.
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { money } from "@/lib/format";
import { allowPublic } from "@/lib/rate-limit";
import { qtyText } from "@/lib/register-math";
import { confirmFromReturn, orderByToken } from "@/lib/shop/online-shop";
import { fmtWhen } from "@/lib/zoned";
import { ShopShell } from "@/components/shop/shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your order", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function OrderPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const sp = await searchParams;
  if (!allowPublic(await headers(), "shop-order", 120, 60_000)) return <main className="p-6">Too many requests. Please wait a minute.</main>;
  if (sp.paid) await confirmFromReturn(token);
  const o = await orderByToken(token);
  if (!o) return <main className="mx-auto max-w-xl p-6 text-base">There&apos;s no order at this address.</main>;
  const shop = { name: o.shop.name, phone: o.shop.phone, slug: o.shop.slug ?? "" };
  const headline =
    o.status === "PENDING"
      ? "We're confirming your payment…"
      : o.status === "PAID"
        ? "Thanks! We have your order."
        : o.status === "READY"
          ? "Your order is ready to pick up."
          : o.status === "DONE"
            ? o.fulfil === "ship"
              ? "Your order has shipped."
              : "Picked up. Thank you!"
            : "This order was cancelled.";
  return (
    <ShopShell shop={shop}>
      {o.status === "PENDING" && <meta httpEquiv="refresh" content="5" />}
      <h1 className="h1">{headline}</h1>
      <p className="muted text-sm">
        Order #{o.number} · {fmtWhen(o.createdAt, o.shop.timeZone)}
      </p>
      {o.status === "PENDING" && <p className="card card-pad text-sm">If you paid, this page updates in a moment. If you didn&apos;t, nothing was charged.</p>}
      {o.status === "PAID" && (
        <p className="card card-pad text-sm">
          {o.fulfil === "ship" ? "We'll let you know when it ships." : `We'll let you know when it's ready to pick up${o.shop.address ? ` at ${o.shop.address}` : ""}.`}
        </p>
      )}
      {o.status === "READY" && (
        <p className="card card-pad text-sm">
          {o.shop.pickupNote || "Come to the counter with your order number."}
          {o.shop.address ? ` ${o.shop.address}.` : ""}
        </p>
      )}
      {o.status === "DONE" && o.tracking && (
        <p className="card card-pad text-sm">
          Tracking: <span className="mono">{o.tracking}</span>
        </p>
      )}
      {o.status === "CANCELLED" && o.refundedCents > 0 && <p className="card card-pad text-sm">{money(o.refundedCents)} goes back to your card in a few days.</p>}
      <ul className="divide-y divide-line rounded border border-line text-sm">
        {o.items.map((it, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3 p-3">
            <span>
              {it.description}
              {it.partNumber ? <span className="muted mono"> {it.partNumber}</span> : null} × {qtyText(it.qty, it.unit)}
              {it.short ? <span className="text-danger"> ({qtyText(it.short, it.unit)} out of stock, refunded)</span> : null}
            </span>
            <span className="num">{money(Math.round(it.qty * it.unitPriceCents))}</span>
          </li>
        ))}
      </ul>
      <div className="card card-pad space-y-1 text-sm">
        <div className="flex justify-between">
          <span>Items</span>
          <span className="num">{money(o.subtotalCents)}</span>
        </div>
        {o.fulfil === "ship" && (
          <div className="flex justify-between">
            <span>Shipping</span>
            <span className="num">{money(o.shipCents)}</span>
          </div>
        )}
        {o.taxCents > 0 && (
          <div className="flex justify-between">
            <span>Sales tax</span>
            <span className="num">{money(o.taxCents)}</span>
          </div>
        )}
        <div className="flex justify-between text-base font-semibold">
          <span>Total</span>
          <span className="num">{money(o.totalCents)}</span>
        </div>
        {o.refundedCents > 0 && o.status !== "CANCELLED" && (
          <div className="flex justify-between">
            <span>Refunded</span>
            <span className="num">-{money(o.refundedCents)}</span>
          </div>
        )}
        {o.fulfil === "ship" && o.address && <p className="muted whitespace-pre-wrap pt-2 text-xs">Ships to: {o.address}</p>}
      </div>
      <p className="muted text-sm">
        Questions? {o.shop.phone ? `Call ${o.shop.name} at ${o.shop.phone}.` : `Call ${o.shop.name}.`}{" "}
        {o.shop.slug && (
          <Link href={`/shop/${o.shop.slug}`} className="link">
            Back to the shop
          </Link>
        )}
      </p>
    </ShopShell>
  );
}
