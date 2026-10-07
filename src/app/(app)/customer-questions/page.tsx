// Customer questions (shop-features-round-2-design.md 5.6): what customers left on the booking page for a person, with
// how to reach them. Mark one answered when it's dealt with (Undo puts it back). Everyone in the company sees it.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { questionsFor } from "@/lib/customer-answers";
import { QuestionDone } from "@/components/question-done";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function CustomerQuestionsPage() {
  const user = await requireUser();
  const [{ open, done }, tz] = await Promise.all([questionsFor(user.shopId), shopTimeZone(user.shopId)]);
  const when = (d: Date) => fmtDateTime(d, tz, { month: "short", day: "numeric" });
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Customer questions" sub="Left on your booking page for a person to answer." />
      <Section title={`Waiting (${open.length})`}>
        {open.length === 0 ? (
          <Empty>
            No questions waiting. When a customer asks something the booking page can&apos;t answer, it shows here with how to reach her.{" "}
            {user.role !== "TECH" && (
              <Link href="/settings/customer-questions" className="link">
                Settings → Customer questions
              </Link>
            )}
          </Empty>
        ) : (
          <ul className="divide-y divide-line" aria-label="Questions waiting">
            {open.map((q) => (
              <li key={q.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="whitespace-pre-wrap text-base">{q.text}</p>
                  <p className="muted text-sm">
                    {[q.name, q.contact].filter(Boolean).join(" · ")} · {when(q.at)}
                  </p>
                </div>
                <QuestionDone id={q.id} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      {done.length > 0 && (
        <details className="card card-pad text-sm">
          <summary className="cursor-pointer">Answered lately ({done.length})</summary>
          <ul className="mt-2 divide-y divide-line">
            {done.map((q) => (
              <li key={q.id} className="py-2">
                {q.text} <span className="muted">· {[q.name, q.contact].filter(Boolean).join(" · ")} · answered {q.handledAt ? when(q.handledAt) : ""}{q.handledBy ? ` by ${q.handledBy}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
