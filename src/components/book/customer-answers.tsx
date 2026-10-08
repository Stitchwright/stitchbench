"use client";
// "Questions?" on the shop's public page (shop-features-round-2-design.md 5.6): four buttons that answer from the
// shop's records (no Assistant, no cost), a typed question when the shop has the Assistant (sorted into one of the four,
// or passed to a person), and "Leave your question". Answers are the program's fixed sentences.
import { useState } from "react";

type Mode = null | "status" | "leave";

async function ask(slug: string, body: Record<string, unknown>): Promise<{ answer?: string; error?: string; topic?: string | null; ticket?: number | null }> {
  try {
    const r = await fetch(`/api/book/${encodeURIComponent(slug)}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as { answer?: string; error?: string };
  } catch {
    return { error: "We couldn't reach the shop just now. Please try again, or call us." };
  }
}

export function CustomerAnswers({ slug, typed, bookAnchor }: { slug: string; typed: boolean; bookAnchor: string | null }) {
  const [answer, setAnswer] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState("");
  const [last4, setLast4] = useState("");
  const [question, setQuestion] = useState("");
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [website, setWebsite] = useState("");

  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    const r = await ask(slug, { ...body, website });
    setBusy(false);
    setAnswer(r.error ?? r.answer ?? null);
    return r;
  };

  return (
    <section className="card card-pad space-y-3" aria-labelledby="qa-title">
      <h2 id="qa-title" className="h2">
        Questions?
      </h2>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={() => (setMode("status"), setAnswer(null))}>
          Is my machine ready?
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => (setMode(null), run({ kind: "hours" }))}>
          Hours
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => (setMode(null), run({ kind: "classes" }))}>
          Classes with seats
        </button>
        {bookAnchor ? (
          <a href={bookAnchor} className="btn">
            Book a drop-off
          </a>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={() => (setMode(null), run({ kind: "dropoff" }))}>
            Book a drop-off
          </button>
        )}
      </div>
      {mode === "status" && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run({ kind: "status", ticket, last4 });
          }}
        >
          <div className="field">
            <label htmlFor="qa-ticket" className="label">
              Ticket number
            </label>
            <input id="qa-ticket" className="input num w-32" inputMode="numeric" value={ticket} onChange={(e) => setTicket(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="qa-last4" className="label">
              Last 4 digits of your phone
            </label>
            <input id="qa-last4" className="input num w-32" inputMode="numeric" maxLength={20} value={last4} onChange={(e) => setLast4(e.target.value)} required />
          </div>
          <button className="btn btn-primary" disabled={busy}>
            Check
          </button>
        </form>
      )}
      {typed && mode !== "leave" && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run({ kind: "typed", text: question });
            if (r.topic === "status") {
              setMode("status");
              if (r.ticket) setTicket(String(r.ticket));
            } else if (r.topic === "person" || r.topic === null) setMode("leave");
          }}
        >
          <div className="field min-w-56 flex-1">
            <label htmlFor="qa-question" className="label">
              Or type your question
            </label>
            <input id="qa-question" className="input" maxLength={500} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Is ticket 1234 ready?" />
          </div>
          <button className="btn" disabled={busy || question.trim().length < 3}>
            Ask
          </button>
        </form>
      )}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden value={website} onChange={(e) => setWebsite(e.target.value)} />
      {answer && (
        <p className="text-base font-semibold" role="status" aria-live="polite" data-qa-answer>
          {answer}
        </p>
      )}
      {mode === "leave" ? (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run({ kind: "leave", name, contact, text: question });
            if (!r.error) {
              setMode(null);
              setQuestion("");
            }
          }}
        >
          <div className="field">
            <label htmlFor="qa-leave-q" className="label">
              Your question
            </label>
            <textarea id="qa-leave-q" className="input" rows={3} maxLength={1000} value={question} onChange={(e) => setQuestion(e.target.value)} required />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="field">
              <label htmlFor="qa-name" className="label">
                Your name
              </label>
              <input id="qa-name" className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="qa-contact" className="label">
                Phone or email
              </label>
              <input id="qa-contact" className="input" maxLength={120} value={contact} onChange={(e) => setContact(e.target.value)} required />
            </div>
          </div>
          <button className="btn btn-primary" disabled={busy}>
            Send it to the shop
          </button>
        </form>
      ) : (
        <button type="button" className="link text-sm" onClick={() => (setMode("leave"), setAnswer(null))}>
          Leave a question for the shop
        </button>
      )}
      <p className="muted text-xs">Answers come from the shop&apos;s own records. For prices or what&apos;s wrong with a machine, leave a question or call us.</p>
    </section>
  );
}
