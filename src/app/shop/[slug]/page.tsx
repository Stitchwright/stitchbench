// The shop's public catalog (online-and-parts-design.md section 3): search, the kinds, the listed items with a photo,
// price and in stock / out of stock (never the count). Outside (app): no sign-in, no nav.
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { allowPublic } from "@/lib/rate-limit";
import { catalog, catalogKinds, decodeCartParam, encodeCart, publicStore } from "@/lib/shop/online-shop";
import { Price, ShopShell, Thumb } from "@/components/shop/shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shop online", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function ShopHome({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  if (!allowPublic(await headers(), "shop-page", 240, 60_000)) return <main className="p-6">Too many requests. Please wait a minute.</main>;
  const store = await publicStore(slug);
  if (!store) return <main className="mx-auto max-w-xl p-6 text-base">There&apos;s no shop at this address.</main>;
  const cart = decodeCartParam(sp);
  const c = cart.size ? `&c=${encodeURIComponent(encodeCart(cart))}` : "";
  if (!store.open) {
    return (
      <ShopShell shop={store} cart={cart}>
        <p className="card card-pad">Online ordering isn&apos;t available right now. {store.phone ? `Call us at ${store.phone}.` : "Please call the shop."}</p>
      </ShopShell>
    );
  }
  const q = typeof sp.q === "string" ? sp.q.slice(0, 80) : "";
  const k = typeof sp.k === "string" ? sp.k : "";
  const [items, kinds] = await Promise.all([catalog(store.id, { q, kind: k || null }), catalogKinds(store.id)]);
  return (
    <ShopShell shop={store} cart={cart}>
      {store.welcome && !q && !k && <p className="whitespace-pre-wrap">{store.welcome}</p>}
      <form method="get" className="flex gap-2" role="search">
        {cart.size > 0 && <input type="hidden" name="c" value={encodeCart(cart)} />}
        {k && <input type="hidden" name="k" value={k} />}
        <input name="q" defaultValue={q} aria-label="Search the shop" placeholder="Part number, brand, model or words" className="input flex-1" maxLength={80} />
        <button className="btn">Search</button>
      </form>
      {kinds.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Kinds">
          <Link href={`/shop/${store.slug}?${c.slice(1)}`} className={`pill ${k ? "" : "tone-ok"}`}>
            Everything
          </Link>
          {kinds.map((x) => (
            <Link key={x.kind} href={`/shop/${store.slug}?k=${x.kind}${c}`} className={`pill ${k === x.kind ? "tone-ok" : ""}`}>
              {x.label} ({x.n})
            </Link>
          ))}
        </nav>
      )}
      {items.length === 0 ? (
        <p className="card card-pad">
          {q ? `Nothing matches "${q}".` : "Nothing is listed yet."} {store.phone ? `Call us at ${store.phone}; we may have it on the shelf.` : ""}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          {items.map((it) => (
            <li key={it.id}>
              <Link href={`/shop/${store.slug}/i/${it.id}${c ? `?${c.slice(1)}` : ""}`} className="card card-pad block h-full space-y-2 hover:bg-surface-2">
                <Thumb photoId={it.photoId} alt={it.title} />
                <div className="font-semibold leading-snug">{it.title}</div>
                <div className="muted text-xs">
                  <span className="mono">{it.partNumber}</span>
                  {it.brand ? ` · ${it.brand}` : ""}
                  {it.tags.length ? ` · ${it.tags.join(", ")}` : ""}
                </div>
                <div className="flex items-baseline justify-between">
                  <Price cents={it.priceCents} unit={it.unit} />
                  <span className={`text-xs ${it.inStock ? "text-ok" : "muted"}`}>{it.inStock ? "In stock" : "Out of stock"}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ShopShell>
  );
}
