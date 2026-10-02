// Booking one appointment type online (online-and-parts-design.md section 2): two weeks of free times, then the
// customer's details. The form posts to /api/book/{slug}; a problem comes back as ?err=.
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { publicFreeTimes, publicShop } from "@/lib/online-booking";
import { allowPublic } from "@/lib/rate-limit";
import { addDays, fmtWhen, parseYmd, ymdOf } from "@/lib/zoned";
import { BookShell, CustomerFields, Problem, TimePicker } from "@/components/book/shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Book a time", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function BookType({ params, searchParams }: { params: Promise<{ slug: string; typeId: string }>; searchParams: Promise<{ from?: string; at?: string; err?: string }> }) {
  const { slug, typeId } = await params;
  const sp = await searchParams;
  if (!allowPublic(await headers(), "book-page", 120, 60_000)) return <main className="p-6">Too many requests. Please wait a minute.</main>;
  const shop = await publicShop(slug);
  if (!shop || !shop.open) return <main className="mx-auto max-w-xl p-6 text-base">Online booking isn&apos;t available right now.</main>;
  const type = await db.appointmentType.findFirst({ where: { id: typeId, shopId: shop.id, active: true, online: true } });
  if (!type) {
    return (
      <BookShell shop={shop} slug={shop.slug}>
        <p className="card card-pad">That appointment isn&apos;t offered online. {shop.phone ? `Call us at ${shop.phone}.` : ""}</p>
      </BookShell>
    );
  }
  const now = new Date();
  const from = typeof sp.from === "string" ? parseYmd(sp.from) : null;
  const days = await publicFreeTimes(shop, type, from, now);
  const at = typeof sp.at === "string" && !Number.isNaN(new Date(sp.at).getTime()) ? new Date(sp.at).toISOString() : null;
  const page = `/book/${shop.slug}/a/${type.id}`;
  const first = days[0]?.ymd ?? ymdOf(now, shop.timeZone);
  return (
    <BookShell shop={shop} slug={shop.slug}>
      <section className="space-y-1">
        <h1 className="h2">{type.name}</h1>
        <p className="muted text-sm">
          {type.minutes} minutes{type.feeCents ? ` · ${money(type.feeCents)}, paid at the counter` : ""}
          {type.location ? ` · ${type.location}` : ""}
        </p>
      </section>
      <Problem text={sp.err} />
      <section className="space-y-3">
        <h2 className="label">Pick a time</h2>
        <TimePicker days={days} tz={shop.timeZone} at={at} href={(iso) => `${page}?from=${first}&at=${encodeURIComponent(iso)}#details`} />
        <div className="flex flex-wrap gap-3 text-sm">
          {from && from > ymdOf(now, shop.timeZone) && (
            <Link href={`${page}?from=${addDays(first, -14)}`} className="link">
              Earlier
            </Link>
          )}
          <Link href={`${page}?from=${addDays(first, 14)}`} className="link">
            Later dates
          </Link>
        </div>
      </section>
      {at && (
        <form method="post" action={`/api/book/${shop.slug}`} id="details" className="card card-pad space-y-3">
          <input type="hidden" name="kind" value="appointment" />
          <input type="hidden" name="typeId" value={type.id} />
          <input type="hidden" name="at" value={at} />
          <input type="hidden" name="back" value={`${page}?from=${first}`} />
          <p className="font-semibold">{fmtWhen(new Date(at), shop.timeZone)}</p>
          <CustomerFields />
          <button className="btn btn-primary">Book it</button>
          <p className="muted text-xs">We&apos;ll confirm the way you chose, and you can change or cancel from the link in the confirmation.</p>
        </form>
      )}
    </BookShell>
  );
}
