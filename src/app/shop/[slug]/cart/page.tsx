// The cart and checkout (online-and-parts-design.md section 3): the lines with their quantities (each a small form),
// the totals for pickup or shipping, then who is ordering and "Pay now", which goes to Stripe's page. The cart is in
// the address (?c=), so there is nothing to remember and the page works inside an iframe.
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { money } from "@/lib/format";
import { allowPublic } from "@/lib/rate-limit";
import { decodeCartParam, encodeCart, fulfilOf, priceCart, publicStore } from "@/lib/shop/online-shop";
import { CustomerFields, Problem } from "@/components/book/shell";
import { Price, ShopShell } from "@/components/shop/shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your cart", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function CartPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  if (!allowPublic(await headers(), "shop-page", 240, 60_000)) return <main className="p-6">Too many requests. Please wait a minute.</main>;
  const store = await publicStore(slug);
  if (!store) return <main className="mx-auto max-w-xl p-6 text-base">There&apos;s no shop at this address.</main>;
  const cart = decodeCartParam(sp);
  const c = encodeCart(cart);
  const fulfil = store.shipping && (!store.pickup || fulfilOf(sp.f) === "ship") ? "ship" : "pickup";
  const err = typeof sp.err === "string" ? sp.err : undefined;
  if (!store.open) {
    return (
      <ShopShell shop={store} cart={cart}>
        <p className="card card-pad">Online ordering isn&apos;t available right now. {store.phone ? `Call us at ${store.phone}.` : "Please call the shop."}</p>
      </ShopShell>
    );
  }
  const priced = await priceCart(store, cart, fulfil);
  const other = fulfil === "ship" ? "pickup" : "ship";
  const otherHref = `/shop/${store.slug}/cart?c=${encodeURIComponent(c)}${other === "ship" ? "&f=ship" : ""}`;
  return (
    <ShopShell shop={store} cart={cart}>
      <h1 className="h1">Your cart</h1>
      {sp.added && <p className="card card-pad text-sm">Added to your cart.</p>}
      {sp.back && <p className="card card-pad text-sm">The payment wasn&apos;t made. Your cart is still here.</p>}
      <Problem text={err} />
      {priced.problems.length > 0 && <Problem text={priced.problems} />}
      {priced.lines.length === 0 ? (
        <p className="card card-pad">
          Nothing in it yet.{" "}
          <Link href={`/shop/${store.slug}`} className="link">
            Back to the shop
          </Link>
        </p>
      ) : (
        <>
          <ul className="divide-y divide-line rounded border border-line">
            {priced.lines.map((l) => (
              <li key={l.partId} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/shop/${store.slug}/i/${l.partId}?c=${encodeURIComponent(c)}`} className="font-semibold">
                    {l.title}
                  </Link>
                  <div className="muted text-xs">
                    <span className="mono">{l.partNumber}</span> · <Price cents={l.unitPriceCents} unit={l.unit} />
                    {l.problem ? <span className="text-danger"> · {l.problem}</span> : null}
                  </div>
                </div>
                <form method="post" action={`/api/shop/${store.slug}`} className="flex items-center gap-2">
                  <input type="hidden" name="action" value="set" />
                  <input type="hidden" name="partId" value={l.partId} />
                  <input type="hidden" name="c" value={c} />
                  <input name="qty" type="number" aria-label={`Quantity of ${l.title}`} min={0} max={99} step={l.unit === "yd" ? 0.125 : 1} defaultValue={l.qty} className="input num w-20" />
                  <button className="btn btn-sm">Update</button>
                </form>
                <form method="post" action={`/api/shop/${store.slug}`}>
                  <input type="hidden" name="action" value="set" />
                  <input type="hidden" name="partId" value={l.partId} />
                  <input type="hidden" name="qty" value="0" />
                  <input type="hidden" name="c" value={c} />
                  <button className="btn btn-sm" aria-label={`Remove ${l.title}`}>
                    Remove
                  </button>
                </form>
                <div className="num w-20 text-right font-semibold">{money(l.lineCents)}</div>
              </li>
            ))}
          </ul>
          <div className="card card-pad space-y-1 text-sm">
            <div className="flex justify-between">
              <span>Items</span>
              <span className="num">{money(priced.subtotalCents)}</span>
            </div>
            {fulfil === "ship" && (
              <div className="flex justify-between">
                <span>Shipping{priced.shipCents === 0 ? " (free)" : ""}</span>
                <span className="num">{money(priced.shipCents)}</span>
              </div>
            )}
            {priced.taxCents > 0 && (
              <div className="flex justify-between">
                <span>Sales tax</span>
                <span className="num">{money(priced.taxCents)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-semibold">
              <span>Total</span>
              <span className="num">{money(priced.totalCents)}</span>
            </div>
            <p className="muted text-xs">
              {fulfil === "ship" ? "Shipped to you." : `Pick up at the shop${store.address ? `, ${store.address}` : ""}.`}
              {store.pickup && store.shipping ? (
                <>
                  {" "}
                  <Link href={otherHref} className="link">
                    {other === "ship"
                      ? `Ship it instead${store.shipCents ? ` (${money(store.shipCents)}${store.freeOverCents != null ? `, free over ${money(store.freeOverCents)}` : ""})` : ""}`
                      : "Pick it up instead"}
                  </Link>
                </>
              ) : null}
            </p>
          </div>
          <form method="post" action={`/api/shop/${store.slug}`} className="card card-pad space-y-4">
            <h2 className="h2">Who&apos;s ordering</h2>
            <input type="hidden" name="action" value="checkout" />
            <input type="hidden" name="c" value={c} />
            <input type="hidden" name="fulfil" value={fulfil} />
            <input type="hidden" name="t0" value={String(new Date().getTime())} />
            <div className="hidden" aria-hidden="true">
              <label>
                Website <input name="website" tabIndex={-1} autoComplete="off" />
              </label>
            </div>
            <CustomerFields noteLabel="Anything we should know? (optional)" />
            {fulfil === "ship" && (
              <div className="field">
                <label htmlFor="address" className="label">
                  Shipping address
                </label>
                <textarea id="address" name="address" required rows={3} maxLength={400} autoComplete="shipping street-address" className="input" placeholder="Name, street, city, state, ZIP" />
              </div>
            )}
            <p className="muted text-xs">You&apos;ll pay on the next page, which is run by Stripe. {store.name} never sees your card.</p>
            <button className="btn btn-primary" disabled={priced.problems.length > 0}>
              Pay now, {money(priced.totalCents)}
            </button>
          </form>
        </>
      )}
    </ShopShell>
  );
}
