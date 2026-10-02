// The customer's own booking, from the link in the confirmation (online-and-parts-design.md section 2): what and
// when, cancel (with a confirm step), and for an appointment a move to another offered time.
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { money } from "@/lib/format";
import { freeTimesForMove, manageByToken } from "@/lib/online-booking";
import { allowPublic } from "@/lib/rate-limit";
import { BookShell, Problem, TimePicker } from "@/components/book/shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };

const STATUS: Record<string, string> = { BOOKED: "Booked", DONE: "Done", NO_SHOW: "Missed", CANCELLED: "Cancelled", ENROLLED: "Signed up", WAITLIST: "On the waiting list" };

export default async function ManageBooking({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ new?: string; done?: string; err?: string; step?: string; move?: string; from?: string; at?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  if (!allowPublic(await headers(), "book-m-page", 60, 60_000)) return <main className="p-6">Too many requests. Please wait a minute.</main>;
  const f = await manageByToken(token);
  if (!f) return <main className="mx-auto max-w-xl p-6 text-base">This link has expired or isn&apos;t one of ours. Please call the shop.</main>;
  const v = f.view;
  const page = `/book/m/${token}`;
  const moving = sp.move === "1" && v.canMove;
  const days = moving ? await freeTimesForMove(f, typeof sp.from === "string" ? sp.from : null) : [];
  // The time picked for a move, only when it is one of the offered times.
  const pickedAt = typeof sp.at === "string" && days.some((d) => d.starts.some((s) => s.toISOString() === sp.at)) ? sp.at : null;
  return (
    <BookShell shop={v.shop} slug={v.shop.slug}>
      {sp.new === "1" && (
        <p className="card card-pad tone-ready" role="status">
          {v.status === "WAITLIST" ? "You're on the waiting list. We'll let you know if a seat opens up." : "You're booked. Thank you!"} Keep this page&apos;s address to change or cancel it.
        </p>
      )}
      {sp.done === "cancelled" && (
        <p className="card card-pad" role="status">
          Cancelled. Sorry we won&apos;t see you this time{v.shop.slug ? "; you can " : "."}
          {v.shop.slug && (
            <Link href={`/book/${v.shop.slug}`} className="link">
              book another time
            </Link>
          )}
          .
        </p>
      )}
      {sp.done === "moved" && (
        <p className="card card-pad tone-ready" role="status">
          Moved. See you then.
        </p>
      )}
      <Problem text={sp.err} />
      <section className="card card-pad space-y-1">
        <div className="muted text-sm">Hi {v.firstName}, here&apos;s your booking.</div>
        <div className="text-lg font-semibold">{v.what}</div>
        {v.when && <div>{v.when}</div>}
        {v.where && <div className="muted text-sm">{v.where}</div>}
        {v.feeCents > 0 && <div className="muted text-sm">{money(v.feeCents)}, paid at the counter</div>}
        <div>
          <span className="pill tone-neutral">{STATUS[v.status] ?? v.status}</span>
        </div>
        {v.shop.address && <div className="muted text-sm">{v.shop.address}</div>}
      </section>
      {(v.canCancel || v.canMove) && !moving && sp.step !== "cancel" && (
        <div className="flex flex-wrap gap-2">
          {v.canMove && (
            <Link href={`${page}?move=1`} className="btn">
              Pick another time
            </Link>
          )}
          {v.canCancel && (
            <Link href={`${page}?step=cancel`} className="btn">
              Cancel it
            </Link>
          )}
        </div>
      )}
      {sp.step === "cancel" && v.canCancel && (
        <form method="post" action={`/api/book/m/${token}`} className="card card-pad space-y-2">
          <input type="hidden" name="action" value="cancel" />
          <input type="hidden" name="confirm" value="1" />
          <p>Cancel {v.what}{v.when ? ` on ${v.when}` : ""}?</p>
          <div className="flex gap-2">
            <button className="btn btn-danger">Yes, cancel it</button>
            <Link href={page} className="btn">
              Keep it
            </Link>
          </div>
        </form>
      )}
      {moving && (
        <section className="card card-pad space-y-3">
          <h2 className="label">Pick another time</h2>
          <TimePicker days={days} tz={v.shop.timeZone} href={(iso) => `${page}?move=1&at=${encodeURIComponent(iso)}#move`} at={pickedAt} />
          {pickedAt && (
            <form method="post" action={`/api/book/m/${token}`} id="move" className="flex items-center gap-2">
              <input type="hidden" name="action" value="move" />
              <input type="hidden" name="at" value={pickedAt} />
              <button className="btn btn-primary">Move it to this time</button>
            </form>
          )}
          <Link href={page} className="link text-sm">
            Keep the time I have
          </Link>
        </section>
      )}
      {!v.canCancel && !v.canMove && v.status !== "CANCELLED" && (
        <p className="muted text-sm">To change this now, please call {v.shop.phone ? v.shop.phone : "the shop"}.</p>
      )}
    </BookShell>
  );
}
