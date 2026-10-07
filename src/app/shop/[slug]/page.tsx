// The shop's public catalog (online-and-parts-design.md section 3): search, the kinds, the listed items with a photo,
// price and in stock / out of stock (never the count). Outside (app): no sign-in, no nav.
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { allowPublic } from "@/lib/rate-limit";
import { catalog, catalogFitModels, catalogKinds, decodeCartParam, encodeCart, publicStore } from "@/lib/shop/online-shop";
import { Price, ShopShell, Thumb } from "@/components/shop/shell";
import { listLenders } from "@/lib/financing";

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
  // "Fits your machine" (shop-features-round-2-design.md 2.4): a model key from the picker.
  const m = typeof sp.m === "string" ? sp.m.slice(0, 80) : "";
  const [items, kinds, lenders, fitModels] = await Promise.all([catalog(store.id, { q, kind: k || null, fits: m || null }), catalogKinds(store.id), listLenders(store.id, true), catalogFitModels(store.id)]);
  // Financing the shop offers (tax-machine-sales-layaway-design.md section 5): each lender's own "apply now" page.
  const apply = lenders.filter((l) => l.applyUrl);
  return (
    <ShopShell shop={store} cart={cart}>
      {store.welcome && !q && !k && !m && <p className="whitespace-pre-wrap">{store.welcome}</p>}
      {apply.length > 0 && !q && !k && (
        <p className="text-sm">
          Financing available:{" "}
          {apply.map((l, i) => (
            <span key={l.id}>
              {i > 0 && ", "}
              <a href={l.applyUrl!} className="link" target="_blank" rel="noreferrer">
                apply with {l.name}
              </a>
            </span>
          ))}
          .
        </p>
      )}
      <form method="get" className="flex gap-2" role="search">
        {cart.size > 0 && <input type="hidden" name="c" value={encodeCart(cart)} />}
        {k && <input type="hidden" name="k" value={k} />}
        {m && <input type="hidden" name="m" value={m} />}
        <input name="q" defaultValue={q} aria-label="Search the shop" placeholder="Part number, brand, model or words" className="input flex-1" maxLength={80} />
        <button className="btn">Search</button>
      </form>
      {fitModels.length > 0 && (
        <form method="get" className="flex flex-wrap items-end gap-2">
          {cart.size > 0 && <input type="hidden" name="c" value={encodeCart(cart)} />}
          {k && <input type="hidden" name="k" value={k} />}
          <div className="field">
            <label htmlFor="fits-m" className="label">
              Fits your machine
            </label>
            <select id="fits-m" name="m" defaultValue={m} className="select">
              <option value="">Any machine</option>
              {fitModels.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <button className="btn">Show what fits</button>
        </form>
      )}
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
