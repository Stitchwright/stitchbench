// The public shop pages' frame (online-and-parts-design.md section 3): the shop's name, phone and a cart link, no nav;
// plain so it frames well inside the shop's own website. Server components only: every page is links and forms.
import Link from "next/link";
import { money } from "@/lib/format";
import { encodeCart, type Cart } from "@/lib/shop/online-shop";

export function ShopShell({ shop, cart, children }: { shop: { name: string; phone: string | null; slug: string }; cart?: Cart; children: React.ReactNode }) {
  const n = cart ? [...cart.values()].reduce((a, q) => a + q, 0) : 0;
  const c = cart?.size ? `?c=${encodeURIComponent(encodeCart(cart))}` : "";
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-5 px-5 py-8 text-base">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-3">
        <Link href={`/shop/${shop.slug}${c}`} className="text-lg font-semibold">
          {shop.name}
        </Link>
        <span className="flex items-baseline gap-4">
          {shop.phone && (
            <a href={`tel:${shop.phone}`} className="link">
              {shop.phone}
            </a>
          )}
          <Link href={`/shop/${shop.slug}/cart${c}`} className="btn btn-sm">
            Cart{n > 0 ? ` (${Number.isInteger(n) ? n : n.toFixed(3).replace(/0+$/, "")})` : ""}
          </Link>
        </span>
      </header>
      {children}
    </main>
  );
}

/** seeInCart: the cents are the maker's minimum advertised price; the real price shows in the cart (9.3). */
export function Price({ cents, unit, seeInCart = false }: { cents: number; unit: string | null; seeInCart?: boolean }) {
  return (
    <span className="num font-semibold">
      {money(cents)}
      {unit === "yd" ? <span className="muted text-sm"> / yd</span> : null}
      {seeInCart ? <span className="muted block text-sm font-normal">Add to cart to see our price</span> : null}
    </span>
  );
}

export function Thumb({ photoId, alt, big = false }: { photoId: string | null; alt: string; big?: boolean }) {
  const cls = big ? "h-64 w-full rounded border border-line object-contain" : "h-28 w-full rounded border border-line object-cover";
  // eslint-disable-next-line @next/next/no-img-element
  if (photoId) return <img src={`/api/shop/photo/${photoId}`} alt={alt} className={cls} loading="lazy" />;
  return <div className={`${cls} muted flex items-center justify-center bg-surface-2 text-xs`}>No photo</div>;
}
