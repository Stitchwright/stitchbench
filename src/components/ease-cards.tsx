// The two cards at the top of the home page (ease-of-use-design.md 2 and 3): "What's new" once after an update, and
// "Getting started" for owners and admins until it's done or hidden.
import Link from "next/link";
import { dismissWhatsNew, hideGettingStarted } from "@/actions/ease";
import { ActionButton } from "@/components/action-form";
import { gettingStarted, whatsNewFor } from "@/lib/ease";

export async function WhatsNewCard({ userId }: { userId: string }) {
  const news = await whatsNewFor(userId);
  if (!news) return null;
  return (
    <section className="card card-pad space-y-3" data-testid="whats-new-card" aria-labelledby="whats-new-title">
      <h2 id="whats-new-title" className="text-xl font-semibold">
        What&apos;s new
      </h2>
      {news.entries.map((e) => (
        <div key={e.version}>
          {news.entries.length > 1 && <div className="muted mb-1 text-sm font-semibold">Version {e.version}</div>}
          <ul className="list-disc space-y-1 pl-5 text-base">
            {e.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      ))}
      <ActionButton action={dismissWhatsNew} className="btn btn-primary btn-lg">
        Got it
      </ActionButton>
    </section>
  );
}

export async function GettingStartedCard({ shopId, admin }: { shopId: string; admin: boolean }) {
  if (!admin) return null;
  const g = await gettingStarted(shopId);
  if (!g) return null;
  return (
    <section className="card card-pad space-y-3" data-testid="getting-started" aria-labelledby="getting-started-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="getting-started-title" className="text-xl font-semibold">
          Getting started
        </h2>
        <span className="muted text-sm">
          {g.done} of {g.steps.length} done
        </span>
      </div>
      <ul className="space-y-2">
        {g.steps.map((s) => (
          <li key={s.key}>
            <Link
              href={s.href}
              className={`flex min-h-12 items-center gap-3 rounded-md border border-line px-3 py-2 text-base hover:border-navy ${s.done ? "opacity-60" : "font-semibold"}`}
              data-testid={`start-${s.key}`}
              data-done={s.done ? "yes" : "no"}
            >
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-lg leading-none"
                style={s.done ? { background: "var(--navy)", color: "var(--navy-ink)", borderColor: "var(--navy)" } : { borderColor: "var(--line)" }}
              >
                {s.done ? "✓" : ""}
              </span>
              <span className={s.done ? "line-through" : ""}>{s.label}</span>
              <span className="sr-only">{s.done ? " (done)" : " (not done yet)"}</span>
            </Link>
          </li>
        ))}
      </ul>
      <ActionButton action={hideGettingStarted} className="btn btn-lg">
        Hide this list
      </ActionButton>
    </section>
  );
}
