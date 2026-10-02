// The public booking pages' frame and shared pieces (online-and-parts-design.md section 2): a narrow page with the
// shop's name and phone, no nav; the customer fields; the day-by-day time picker. Server components, no client code:
// the pages are plain forms that post to /api/book.
import Link from "next/link";
import { fmtDay, fmtTime } from "@/lib/zoned";
import type { FreeDay } from "@/lib/online-booking";

export function BookShell({ shop, slug, children }: { shop: { name: string; phone: string | null }; slug?: string | null; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 px-5 py-8 text-base">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-3">
        {slug ? (
          <Link href={`/book/${slug}`} className="text-lg font-semibold">
            {shop.name}
          </Link>
        ) : (
          <span className="text-lg font-semibold">{shop.name}</span>
        )}
        {shop.phone && (
          <a href={`tel:${shop.phone}`} className="link">
            {shop.phone}
          </a>
        )}
      </header>
      {children}
    </main>
  );
}

export function Problem({ text }: { text?: string | string[] }) {
  if (!text || typeof text !== "string") return null;
  return (
    <p className="card card-pad tone-bad text-sm" role="alert">
      {text}
    </p>
  );
}

/** Name, mobile, email, how to confirm, a note, and the two bot checks (a field people never see, and when the form opened). */
export function CustomerFields({ noteLabel = "Anything we should know? (optional)", withAttendee = false }: { noteLabel?: string; withAttendee?: boolean }) {
  return (
    <>
      <div className="field">
        <label htmlFor="bk-name" className="label">
          Your name
        </label>
        <input id="bk-name" name="name" required maxLength={120} autoComplete="name" className="input" />
      </div>
      {withAttendee && (
        <div className="field">
          <label htmlFor="bk-attendee" className="label">
            Who is taking the class, if not you (optional)
          </label>
          <input id="bk-attendee" name="attendee" maxLength={80} className="input" placeholder="A child, a friend" />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="field">
          <label htmlFor="bk-phone" className="label">
            Mobile number
          </label>
          <input id="bk-phone" name="phone" type="tel" autoComplete="tel" maxLength={40} className="input" />
        </div>
        <div className="field">
          <label htmlFor="bk-email" className="label">
            Email
          </label>
          <input id="bk-email" name="email" type="email" autoComplete="email" maxLength={120} className="input" />
        </div>
      </div>
      <fieldset className="field">
        <legend className="label">How should we confirm it?</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="notify" value="email" className="check" defaultChecked /> Email
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="notify" value="sms" className="check" /> Text
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="notify" value="none" className="check" /> No need
          </label>
        </div>
        <p className="muted text-xs">Texts are about this booking only (a confirmation and a reminder). Message and data rates may apply; reply STOP to stop them.</p>
      </fieldset>
      <div className="field">
        <label htmlFor="bk-note" className="label">
          {noteLabel}
        </label>
        <textarea id="bk-note" name="note" rows={2} maxLength={500} className="textarea" />
      </div>
      {/* People never see this field; a program that fills every box does. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="bk-website">Website</label>
        <input id="bk-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <input type="hidden" name="t0" value={String(new Date().getTime())} />
    </>
  );
}

/** The free times, a day at a time, each a link that selects it (`?at=`), with the chosen one marked. */
export function TimePicker({ days, tz, href, at }: { days: FreeDay[]; tz: string; href: (startIso: string) => string; at?: string | null }) {
  const shown = days.filter((d) => d.starts.length);
  if (!shown.length) return <p className="muted text-sm">No times are open in the next two weeks. Try the next two, or call us.</p>;
  return (
    <div className="space-y-3">
      {shown.map((d) => (
        <div key={d.ymd}>
          <div className="label">{fmtDay(d.starts[0], tz)}</div>
          <div className="flex flex-wrap gap-2">
            {d.starts.map((s) => {
              const iso = s.toISOString();
              return (
                <Link key={iso} href={href(iso)} className={`btn btn-sm ${at === iso ? "btn-primary" : ""}`} scroll={false}>
                  {fmtTime(s, tz)}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
