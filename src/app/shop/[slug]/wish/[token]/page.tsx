// A shared wish list (shop-features-round-2-design.md 9.9): what she would still like from this shop, for family to buy
// at the counter (or online, where the item is listed). Nothing about who bought what, and no prices (the items' own
// pages show them).
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { allowPublic } from "@/lib/rate-limit";
import { publicRegistry } from "@/lib/gift-registry";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Wish list", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function WishListPage({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  if (!allowPublic(await headers(), "wish-list", 120, 60_000)) return <main className="p-6">Too many requests. Please wait a minute.</main>;
  const r = await publicRegistry(slug, token);
  if (!r) return <main className="mx-auto max-w-xl p-6 text-base">This list isn&apos;t shared any more. Ask her for a new link.</main>;
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4 text-base">
      <header>
        <h1 className="h1">{r.title}</h1>
        <p className="muted">
          {r.firstName}&apos;s wishes at {r.shop.name}
          {r.eventDate ? `, for ${r.eventDate}` : ""}.
        </p>
      </header>
      {r.lines.length ? (
        <ul className="divide-y divide-line rounded border border-line">
          {r.lines.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span>
                {l.partId ? (
                  <Link href={`/shop/${slug}/i/${l.partId}`} className="link">
                    {l.description}
                  </Link>
                ) : (
                  l.description
                )}
                {l.note ? <span className="muted text-sm"> · {l.note}</span> : null}
              </span>
              <span className="muted text-sm">{l.left > 1 ? `${l.left} wanted` : "1 wanted"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="card card-pad">Everything on this list has been bought. Thank you!</p>
      )}
      <p className="text-sm">
        Buying at the shop? Say it is from {r.firstName}&apos;s list so it is ticked off.
        {r.shop.phone ? ` ${r.shop.name}: ${r.shop.phone}` : ""}
        {r.shop.address ? `, ${r.shop.address}` : ""}
      </p>
    </main>
  );
}
