// The customer's estimate page (scheduling-messaging-design.md 10.4). Outside (app): no sign-in, no nav. Opening it
// changes nothing; approving or declining is a POST from the confirm step, so a link scanner can't answer for them.
import type { Metadata } from "next";
import { headers } from "next/headers";
import { allowPublic } from "@/lib/rate-limit";
import { estimateByToken } from "@/lib/estimate-links";
import { fmtDateTime, money } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your estimate", robots: { index: false, follow: false }, referrer: "no-referrer" };

const when = (d: Date, tz: string) => fmtDateTime(d, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(", ", " at ").replace(/\s?(AM|PM)$/, (_, x: string) => ` ${x.toLowerCase()}`);

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 px-5 py-10 text-base">{children}</main>;
}

export default async function EstimatePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ step?: string }> }) {
  const { token } = await params;
  const { step } = await searchParams;
  const h = await headers();
  if (!allowPublic(h, "e", 60, 60_000)) {
    return (
      <Shell>
        <p className="card card-pad">Too many tries. Please wait a minute and open the link again.</p>
      </Shell>
    );
  }
  const found = await estimateByToken(token);
  if (!found) {
    return (
      <Shell>
        <p className="card card-pad">This link isn&apos;t valid. Please call the shop.</p>
      </Shell>
    );
  }
  const v = found.view;
  const phone = v.shopPhone ? (
    <a href={`tel:${v.shopPhone}`} className="link">
      {v.shopPhone}
    </a>
  ) : null;
  const total = money(v.totalCents);
  const answeredText =
    v.answer === "APPROVED" && v.answeredAt
      ? `You approved this on ${when(v.answeredAt, v.tz)}. Thank you! We'll get to work.`
      : v.answer === "DECLINED"
        ? "You declined. We'll call you about picking it up."
        : null;

  return (
    <Shell>
      <header>
        <div className="text-2xl font-bold">{v.shopName}</div>
        {phone && <div className="muted">{phone}</div>}
      </header>
      {v.state !== "expired" && v.state !== "revoked" && (
      <section className="card card-pad space-y-3">
        <h1 className="h2">
          {v.proof ? "Your order" : "Estimate for your"} {v.machine}
          {v.ref && ` (${v.ref})`}
        </h1>
        <p>Hi {v.firstName},</p>
        {v.proof && (
          <div className="space-y-2">
            <p className="font-semibold">What we will make</p>
            <ul className="list-disc pl-5">
              {v.proof.items.map((it, i) => (
                <li key={i}>
                  <strong>{it.where}:</strong> {it.what}
                </li>
              ))}
            </ul>
            {v.proof.hasMockup && (
              // eslint-disable-next-line @next/next/no-img-element -- the picture is served by our own route for this link
              <img src={`/api/e/${encodeURIComponent(token)}/mockup`} alt="A picture of the design on the garment" className="max-w-full rounded border border-line" />
            )}
          </div>
        )}
        <table className="table">
          <tbody>
            {v.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.description}</td>
                <td className="num text-right">{money(l.amountCents)}</td>
              </tr>
            ))}
            <tr>
              <td className="font-semibold">Total</td>
              <td className="num text-right font-semibold">{total}</td>
            </tr>
          </tbody>
        </table>
        {v.note && <p className="whitespace-pre-wrap">{v.note}</p>}
      </section>
      )}

      {v.state === "answered" && answeredText && (
        <p className="card card-pad" role="status">
          {answeredText}
        </p>
      )}
      {(v.state === "expired" || v.state === "revoked") && (
        <p className="card card-pad" role="status">
          This link has expired. Please call {v.shopName}
          {phone && <> at {phone}</>}.
        </p>
      )}
      {v.state === "open" && step !== "approve" && step !== "decline" && (
        <>
          <div className="flex flex-wrap gap-3">
            <a href={`?step=approve`} className="btn btn-primary">
              Approve {total}
            </a>
            <a href={`?step=decline`} className="btn">
              Decline
            </a>
          </div>
          <p className="muted text-sm">
            This link works until {when(v.expiresAt, v.tz)}.{phone && <> Questions? Call {phone}.</>}
          </p>
        </>
      )}
      {v.state === "open" && (step === "approve" || step === "decline") && (
        <form method="post" action={`/api/e/${encodeURIComponent(token)}`} className="card card-pad space-y-3">
          <h2 className="h2">{step === "approve" ? `Approve ${total} for ${v.proof ? "" : "your "}${v.machine}?` : `Decline the work on ${v.proof ? "" : "your "}${v.machine}?`}</h2>
          <input type="hidden" name="answer" value={step === "approve" ? "APPROVED" : "DECLINED"} />
          <input type="hidden" name="confirm" value="1" />
          <div className="field">
            <label htmlFor="note" className="label">
              Anything to tell us?
            </label>
            <textarea id="note" name="note" maxLength={500} rows={3} className="input" />
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className={step === "approve" ? "btn btn-primary" : "btn btn-danger"}>
              {step === "approve" ? "Yes, approve" : "Yes, decline"}
            </button>
            <a href="?" className="btn">
              Back
            </a>
          </div>
        </form>
      )}
    </Shell>
  );
}
