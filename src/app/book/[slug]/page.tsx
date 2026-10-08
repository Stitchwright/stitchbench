// The shop's public booking page (online-and-parts-design.md section 2): what can be booked and which classes have
// seats. Outside (app): no sign-in, no nav, nothing of the shop but its name, phone and offers.
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { money } from "@/lib/format";
import { publicClasses, publicShop, publicTypes } from "@/lib/online-booking";
import { allowPublic } from "@/lib/rate-limit";
import { fmtWhen } from "@/lib/zoned";
import { BookShell } from "@/components/book/shell";
import { CustomerAnswers } from "@/components/book/customer-answers";
import { assistantAvailable } from "@/lib/assistant/client";
import { answersShop, typedToday } from "@/lib/customer-answers";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Book online", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function BookHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!allowPublic(await headers(), "book-page", 120, 60_000)) return <main className="p-6">Too many requests. Please wait a minute.</main>;
  const shop = await publicShop(slug);
  if (!shop) return <main className="mx-auto max-w-xl p-6 text-base">There&apos;s no booking page at this address.</main>;
  // Customer answers (shop-features-round-2-design.md 5.6): when the shop turned them on; typed questions while the
  // Assistant can take them and today's cap isn't reached.
  const answers = await answersShop(slug);
  const typed = !!answers?.on && (await assistantAvailable(answers.id, { group: "customers" })).ok && (await typedToday(answers)) < answers.cap;
  if (!shop.open) {
    return (
      <BookShell shop={shop}>
        <p className="card card-pad">Online booking isn&apos;t available right now. {shop.phone ? `Call us at ${shop.phone}.` : "Please call the shop."}</p>
        {answers?.on && <CustomerAnswers slug={shop.slug} typed={typed} bookAnchor={null} />}
      </BookShell>
    );
  }
  const [types, classes] = await Promise.all([publicTypes(shop.id), publicClasses(shop.id)]);
  return (
    <BookShell shop={shop} slug={shop.slug}>
      {shop.welcome && <p className="whitespace-pre-wrap">{shop.welcome}</p>}
      {answers?.on && <CustomerAnswers slug={shop.slug} typed={typed} bookAnchor={types.length ? "#book-a-time" : null} />}
      {types.length > 0 && (
        <section className="space-y-2" id="book-a-time">
          <h1 className="h2">Book a time</h1>
          <ul className="space-y-2">
            {types.map((t) => (
              <li key={t.id}>
                <Link href={`/book/${shop.slug}/a/${t.id}`} className="card card-pad block hover:bg-surface-2">
                  <div className="font-semibold">{t.name}</div>
                  <div className="muted text-sm">
                    {t.minutes} minutes{t.feeCents ? ` · ${money(t.feeCents)}, paid at the counter` : ""}
                    {t.location ? ` · ${t.location}` : ""}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {classes.length > 0 && (
        <section className="space-y-2">
          <h2 className="h2">Classes</h2>
          <ul className="space-y-2">
            {classes.map((c) => (
              <li key={c.id}>
                <Link href={`/book/${shop.slug}/c/${c.id}`} className="card card-pad block hover:bg-surface-2">
                  <div className="font-semibold">{c.title}</div>
                  <div className="muted text-sm">
                    {c.firstAt ? `Starts ${fmtWhen(c.firstAt, shop.timeZone)}` : "Date to be announced"}
                    {c.meetings > 1 ? ` · ${c.meetings} meetings` : ""}
                    {c.feeCents ? ` · ${money(c.feeCents)}` : " · Free"} · {c.seatsLeft > 0 ? `${c.seatsLeft} seat${c.seatsLeft === 1 ? "" : "s"} left` : "Full: waiting list"}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!types.length && !classes.length && <p className="card card-pad">Nothing can be booked online just now. {shop.phone ? `Call us at ${shop.phone}.` : ""}</p>}
    </BookShell>
  );
}
