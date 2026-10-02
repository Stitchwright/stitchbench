// Signing up for a class online (online-and-parts-design.md section 2): the class, its meetings and seats, then the
// customer's details. Full with a waiting list: the sign-up goes on the list.
import type { Metadata } from "next";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { publicClasses, publicShop } from "@/lib/online-booking";
import { allowPublic } from "@/lib/rate-limit";
import { fmtWhen } from "@/lib/zoned";
import { BookShell, CustomerFields, Problem } from "@/components/book/shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign up for a class", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function BookClass({ params, searchParams }: { params: Promise<{ slug: string; classId: string }>; searchParams: Promise<{ err?: string }> }) {
  const { slug, classId } = await params;
  const sp = await searchParams;
  if (!allowPublic(await headers(), "book-page", 120, 60_000)) return <main className="p-6">Too many requests. Please wait a minute.</main>;
  const shop = await publicShop(slug);
  if (!shop || !shop.open) return <main className="mx-auto max-w-xl p-6 text-base">Online booking isn&apos;t available right now.</main>;
  const c = (await publicClasses(shop.id)).find((x) => x.id === classId);
  if (!c) {
    return (
      <BookShell shop={shop} slug={shop.slug}>
        <p className="card card-pad">That class isn&apos;t open for sign-ups online. {shop.phone ? `Call us at ${shop.phone}.` : ""}</p>
      </BookShell>
    );
  }
  const meetings = await db.classMeeting.findMany({ where: { shopId: shop.id, classId: c.id, cancelled: false }, orderBy: { startsAt: "asc" }, select: { startsAt: true } });
  const page = `/book/${shop.slug}/c/${c.id}`;
  return (
    <BookShell shop={shop} slug={shop.slug}>
      <section className="space-y-1">
        <h1 className="h2">{c.title}</h1>
        <p className="muted text-sm">
          {c.teacher ? `With ${c.teacher} · ` : ""}
          {c.feeCents ? `${money(c.feeCents)}, paid at the counter` : "Free"}
          {c.location ? ` · ${c.location}` : ""}
        </p>
        {c.description && <p className="whitespace-pre-wrap text-sm">{c.description}</p>}
        {meetings.length > 0 && (
          <ul className="text-sm">
            {meetings.slice(0, 12).map((m) => (
              <li key={m.startsAt.toISOString()}>{fmtWhen(m.startsAt, shop.timeZone)}</li>
            ))}
            {meetings.length > 12 && <li className="muted">and {meetings.length - 12} more</li>}
          </ul>
        )}
        <p className={`pill ${c.seatsLeft > 0 ? "tone-ready" : "tone-wait"} inline-block`}>{c.seatsLeft > 0 ? `${c.seatsLeft} seat${c.seatsLeft === 1 ? "" : "s"} left` : "Full: you can join the waiting list"}</p>
      </section>
      <Problem text={sp.err} />
      <form method="post" action={`/api/book/${shop.slug}`} className="card card-pad space-y-3">
        <input type="hidden" name="kind" value="class" />
        <input type="hidden" name="classId" value={c.id} />
        <input type="hidden" name="back" value={page} />
        <CustomerFields withAttendee noteLabel="Anything we should know? (optional)" />
        <button className="btn btn-primary">{c.seatsLeft > 0 ? "Sign up" : "Join the waiting list"}</button>
        <p className="muted text-xs">We&apos;ll confirm the way you chose, and you can cancel from the link in the confirmation.</p>
      </form>
    </BookShell>
  );
}
