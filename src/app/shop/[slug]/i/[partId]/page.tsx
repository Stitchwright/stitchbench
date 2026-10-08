// One listed item (online-and-parts-design.md section 3): photos, the shop's words, what it fits, the price, and
// "Add to cart" (a form to /api/shop/{slug}); out of stock says so and offers the phone.
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { KIND_LABEL } from "@/lib/parts";
import { allowPublic } from "@/lib/rate-limit";
import { catalogItem, decodeCartParam, encodeCart, publicStore } from "@/lib/shop/online-shop";
import { Price, ShopShell, Thumb } from "@/components/shop/shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shop online", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function ItemPage({ params, searchParams }: { params: Promise<{ slug: string; partId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug, partId } = await params;
  const sp = await searchParams;
  if (!allowPublic(await headers(), "shop-page", 240, 60_000)) return <main className="p-6">Too many requests. Please wait a minute.</main>;
  const store = await publicStore(slug);
  if (!store) return <main className="mx-auto max-w-xl p-6 text-base">There&apos;s no shop at this address.</main>;
  const cart = decodeCartParam(sp);
  const c = cart.size ? `?c=${encodeURIComponent(encodeCart(cart))}` : "";
  const it = store.open ? await catalogItem(store.id, partId) : null;
  if (!it) {
    return (
      <ShopShell shop={store} cart={cart}>
        <p className="card card-pad">
          That item isn&apos;t for sale online{store.open ? " any more" : " right now"}. {store.phone ? `Call us at ${store.phone}.` : ""}
        </p>
        <Link href={`/shop/${store.slug}${c}`} className="link">
          Back to the shop
        </Link>
      </ShopShell>
    );
  }
  const byYard = it.unit === "yd";
  const err = typeof sp.err === "string" ? sp.err.slice(0, 300) : null;
  return (
    <ShopShell shop={store} cart={cart}>
      <Link href={`/shop/${store.slug}${c}`} className="link text-sm">
        &larr; Back to the shop
      </Link>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-2">
          <Thumb photoId={it.photoId} alt={it.title} big />
          {it.photoIds.length > 1 && (
            <ul className="grid grid-cols-4 gap-2">
              {it.photoIds.slice(1).map((id) => (
                <li key={id}>
                  <Thumb photoId={id} alt={it.title} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-3">
          <h1 className="h1 leading-tight">{it.title}</h1>
          <p className="muted text-sm">
            <span className="mono">{it.partNumber}</span>
            {it.brand ? ` · ${it.brand}` : ""} · {KIND_LABEL[it.kind] ?? it.kind}
            {it.tags.length ? ` · ${it.tags.join(", ")}` : ""}
          </p>
          {it.title !== it.description && <p className="text-sm">{it.description}</p>}
          {it.fits && (
            <p className="text-sm">
              <span className="font-semibold">Fits:</span> {it.fits}
            </p>
          )}
          {it.text && <p className="whitespace-pre-wrap">{it.text}</p>}
          <p className="text-xl">
            <Price cents={it.priceCents} unit={it.unit} seeInCart={it.seeInCart} />
          </p>
          {it.inStock ? (
            <form method="post" action={`/api/shop/${store.slug}`} className="flex items-end gap-2">
              <input type="hidden" name="action" value="add" />
              <input type="hidden" name="partId" value={it.id} />
              <input type="hidden" name="c" value={encodeCart(cart)} />
              <div className="field">
                <label htmlFor="qty" className="label">
                  {byYard ? "Yards" : "Quantity"}
                </label>
                <input id="qty" name="qty" type="number" min={byYard ? 0.125 : 1} max={99} step={byYard ? 0.125 : 1} defaultValue={1} className="input num w-24" required />
              </div>
              <button className="btn btn-primary">Add to cart</button>
            </form>
          ) : it.comingSoonOn ? (
            <form method="post" action={`/api/shop/${store.slug}`} className="card card-pad space-y-3 text-base">
              <input type="hidden" name="action" value="preorder" />
              <input type="hidden" name="partId" value={it.id} />
              <input type="hidden" name="t0" value={String(new Date().getTime())} />
              <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
              <p className="font-semibold">Coming soon: {new Date(`${it.comingSoonOn}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric" })}. Pre-order it now with a deposit.</p>
              {err && <p role="alert">{err}</p>}
              <div className="field">
                <label htmlFor="po-name" className="label">
                  Your name
                </label>
                <input id="po-name" name="name" className="input text-base" required autoComplete="name" />
              </div>
              <div className="field">
                <label htmlFor="po-phone" className="label">
                  Mobile number
                </label>
                <input id="po-phone" name="phone" type="tel" className="input text-base" autoComplete="tel" />
              </div>
              <div className="field">
                <label htmlFor="po-email" className="label">
                  Email
                </label>
                <input id="po-email" name="email" type="email" className="input text-base" autoComplete="email" />
              </div>
              <input type="hidden" name="notify" value="email" />
              <button className="btn btn-primary min-h-11 w-full">Pre-order and pay the deposit</button>
              <p className="muted text-sm">We&apos;ll let you know when it&apos;s here; the rest is paid when you pick it up.</p>
            </form>
          ) : (
            <p className="card card-pad text-sm">Out of stock right now. {store.phone ? `Call us at ${store.phone} and we'll order it for you.` : ""}</p>
          )}
          <p className="muted text-xs">{store.pickup && store.shipping ? "Pick up at the shop or have it shipped." : store.shipping ? "Shipped to you." : "Pick up at the shop."}</p>
        </div>
      </div>
    </ShopShell>
  );
}
