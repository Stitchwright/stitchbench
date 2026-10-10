"use client";
// The round Help button on every signed-in page (help-feedback-design.md section 1), and the browser's error alerts
// (section 2: window errors and rejected promises, at most 5 a page load). Not on print views; the public pages don't use
// the (app) layout, so it never shows there.
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { reportBrowserError, sendHelp } from "@/actions/help";
import { markHelpRepliesRead } from "@/actions/ease";
import type { HelpReplyView } from "@/lib/help";

type Choice = "help" | "idea" | "rating";

const MAX_TEXT = 4000;
const MAX_PICTURE = 800 * 1024;
const MAX_SIDE = 1600;

let reported = 0;

function screenSize() {
  return typeof window === "undefined" ? "" : `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}`;
}

/** Sends an error the browser saw, at most 5 a page load; never throws. */
export function reportError(e: { message?: string; stack?: string; digest?: string; source?: string }) {
  if (reported >= 5) return;
  reported++;
  void reportBrowserError({
    message: String(e.message ?? "").slice(0, 1000),
    stack: String(e.stack ?? "").slice(0, 6000),
    digest: e.digest,
    source: e.source,
    path: window.location.pathname,
    userAgent: navigator.userAgent,
    screen: screenSize(),
  }).catch(() => {});
}

/** The page under the panel as a JPEG (the panel itself left out), longest side 1600px, 800 KB at most; null if it can't. */
async function takePicture(): Promise<Blob | null> {
  try {
    const { domToCanvas } = await import("modern-screenshot");
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const full = await domToCanvas(document.body, {
      scale,
      backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
      filter: (n) => !(n instanceof HTMLElement && n.dataset.helpRoot !== undefined),
      timeout: 15000,
    });
    // The part of the page on screen now.
    const out = document.createElement("canvas");
    out.width = Math.round(w * scale);
    out.height = Math.round(h * scale);
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(full, Math.round(window.scrollX * scale), Math.round(window.scrollY * scale), out.width, out.height, 0, 0, out.width, out.height);
    for (const q of [0.8, 0.65, 0.5, 0.4, 0.3]) {
      const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/jpeg", q));
      if (blob && blob.size <= MAX_PICTURE) return blob;
    }
    return null;
  } catch {
    return null;
  }
}

const KIND_WORDS: Record<string, string> = { help: "Something's wrong", idea: "Your idea", rating: "Your rating", error: "A problem we noticed" };

export function HelpButton({ program, email, connected, helpEmail, replies = [] }: { program: string; email: string; connected: boolean; helpEmail: string | null; replies?: HelpReplyView[] }) {
  const pathname = usePathname();
  const router = useRouter();
  // Answers not read yet when the panel was opened stay under "We answered you" while it is open.
  const [justRead, setJustRead] = useState<string[]>([]);
  const [readAll, setReadAll] = useState(false);
  const unread = replies.filter((r) => r.unread && !readAll);
  const fresh = replies.filter((r) => justRead.includes(r.id));
  const older = replies.filter((r) => !justRead.includes(r.id));
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState(email);
  const [stars, setStars] = useState(0);
  const [quoteOk, setQuoteOk] = useState(false);
  const [withPicture, setWithPicture] = useState(true);
  const [picture, setPicture] = useState<Blob | null>(null);
  const [pictureUrl, setPictureUrl] = useState<string | null>(null);
  const [taking, setTaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const firstRef = useRef<HTMLButtonElement>(null);

  // Errors the pages didn't catch.
  useEffect(() => {
    const onError = (ev: ErrorEvent) => {
      const msg = ev.message || String(ev.error ?? "");
      if (/ResizeObserver loop/.test(msg)) return;
      reportError({ message: msg, stack: ev.error instanceof Error ? ev.error.stack : `at ${ev.filename}:${ev.lineno}:${ev.colno}` });
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      const r = ev.reason;
      reportError({ message: r instanceof Error ? r.message : String(r), stack: r instanceof Error ? r.stack : undefined });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => () => {
    if (pictureUrl) URL.revokeObjectURL(pictureUrl);
  }, [pictureUrl]);

  if (/\/print(\/|$)/.test(pathname ?? "")) return null;

  function reset() {
    setChoice(null);
    setText("");
    setReplyTo(email);
    setStars(0);
    setQuoteOk(false);
    setWithPicture(true);
    setPicture(null);
    setPictureUrl(null);
    setError(null);
    setSent(false);
  }

  function openPanel() {
    reset();
    setOpen(true);
    // Opening the panel is reading the answers.
    const ids = replies.filter((r) => r.unread).map((r) => r.id);
    if (!ids.length || readAll) setJustRead([]);
    if (ids.length && !readAll) {
      setJustRead(ids);
      setReadAll(true);
      void markHelpRepliesRead()
        .then(() => router.refresh())
        .catch(() => {});
    }
    setTimeout(() => firstRef.current?.focus(), 0);
  }

  async function pick(c: Choice) {
    setChoice(c);
    setError(null);
    if (c !== "help") return;
    setTaking(true);
    const blob = await takePicture();
    setTaking(false);
    setPicture(blob);
    setPictureUrl(blob ? URL.createObjectURL(blob) : null);
    if (!blob) setWithPicture(false);
  }

  async function send() {
    if (!choice) return;
    setError(null);
    if (choice !== "rating" && !text.trim()) {
      setError(choice === "help" ? "Please tell us what happened." : "Please tell us your idea.");
      return;
    }
    if (choice === "rating" && !stars) {
      setError("Please pick 1 to 5 stars.");
      return;
    }
    const fd = new FormData();
    fd.set("kind", choice);
    fd.set("text", text);
    fd.set("path", window.location.pathname);
    fd.set("userAgent", navigator.userAgent);
    fd.set("screen", screenSize());
    if (choice !== "rating") fd.set("replyTo", replyTo);
    if (choice === "rating") {
      fd.set("stars", String(stars));
      fd.set("quoteOk", quoteOk ? "true" : "false");
    }
    if (choice === "help" && withPicture && picture) fd.set("picture", picture, "screen.jpg");
    setBusy(true);
    try {
      const r = await sendHelp(fd);
      if (r.error) setError(r.error);
      else setSent(true);
    } catch {
      setError("That didn't go through. Check the connection to the shop computer and try again.");
    } finally {
      setBusy(false);
    }
  }

  const choiceBtn = "btn w-full justify-start text-left text-lg";
  const team = `the ${program} team`;

  return (
    <div data-help-root="" className="no-print">
      {!open && (
        <button
          type="button"
          onClick={openPanel}
          className="fixed right-4 bottom-4 z-40 flex h-16 w-16 items-center justify-center rounded-full border-2 border-white text-lg font-bold shadow-lg"
          style={{ background: "var(--navy)", color: "var(--navy-ink)" }}
          aria-label="Ask for help"
          data-testid="help-button"
        >
          Help
          {unread.length > 0 && (
            <span
              className="absolute -top-1 -right-1 h-5 w-5 rounded-full border-2 border-white"
              style={{ background: "var(--bad)" }}
              data-testid="help-dot"
              role="img"
              aria-label="You have an answer"
            />
          )}
        </button>
      )}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="help-title"
          className="card fixed inset-x-2 bottom-2 z-50 max-h-[calc(100vh-1rem)] overflow-y-auto p-4 shadow-xl sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[26rem]"
          data-testid="help-panel"
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <h2 id="help-title" className="text-xl font-semibold">
              {sent ? "Sent" : choice === "help" ? "Something's wrong" : choice === "idea" ? "I have an idea" : choice === "rating" ? "Rate the program" : "How can we help?"}
            </h2>
            <button type="button" className="btn h-12 w-12 shrink-0 p-0 text-2xl leading-none" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>

          {sent ? (
            <div className="space-y-4">
              <p className="text-lg" data-testid="help-sent">
                Thank you. It&apos;s on its way to {team}.
              </p>
              <button type="button" className="btn btn-primary btn-lg w-full" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          ) : !choice ? (
            <div className="space-y-3">
              {fresh.length > 0 && (
                <div className="space-y-2 rounded-md border-2 p-3" style={{ borderColor: "var(--navy)" }} data-testid="help-answers">
                  <h3 className="text-lg font-semibold">We answered you</h3>
                  {fresh.map((r) => (
                    <div key={r.id} className="space-y-1">
                      <p className="muted text-sm">
                        {KIND_WORDS[r.kind] ?? "Your note"}: &ldquo;{r.text.slice(0, 80)}
                        {r.text.length > 80 ? "…" : ""}&rdquo;
                      </p>
                      <p className="text-base whitespace-pre-wrap">{r.reply}</p>
                    </div>
                  ))}
                </div>
              )}
              <button ref={firstRef} type="button" className={`${choiceBtn} btn-lg`} onClick={() => void pick("help")}>
                Something&apos;s wrong
              </button>
              <button type="button" className={`${choiceBtn} btn-lg`} onClick={() => void pick("idea")}>
                I have an idea
              </button>
              <button type="button" className={`${choiceBtn} btn-lg`} onClick={() => void pick("rating")}>
                Rate the program
              </button>
              {older.length > 0 && (
                <details className="rounded-md border border-line p-3" data-testid="help-history">
                  <summary className="min-h-12 cursor-pointer py-3 text-base font-semibold">Your notes and our answers</summary>
                  <div className="space-y-3 pt-1">
                    {older.map((r) => (
                      <div key={r.id} className="space-y-1">
                        <p className="muted text-sm">
                          {KIND_WORDS[r.kind] ?? "Your note"}: &ldquo;{r.text.slice(0, 80)}
                          {r.text.length > 80 ? "…" : ""}&rdquo;
                        </p>
                        <p className="text-base whitespace-pre-wrap">{r.reply}</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {!connected && (
                <p className="muted text-sm">
                  Not connected to StitchHub yet: this will be sent once it is.
                  {helpEmail && <> For anything urgent, email {helpEmail}.</>}
                </p>
              )}
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {choice !== "rating" && (
                <div className="field">
                  <label htmlFor="help-text" className="label text-base">
                    {choice === "help" ? "What happened?" : "What would make the program better for you?"}
                  </label>
                  <textarea id="help-text" className="textarea" rows={5} maxLength={MAX_TEXT} value={text} onChange={(e) => setText(e.target.value)} required autoFocus />
                </div>
              )}

              {choice === "help" && (
                <div className="space-y-2">
                  <label className="flex min-h-12 items-center gap-3 text-base">
                    <input type="checkbox" className="check h-6 w-6" checked={withPicture} disabled={!picture} onChange={(e) => setWithPicture(e.target.checked)} />
                    Include a picture of this screen
                  </label>
                  {taking && <p className="muted text-sm">Taking the picture…</p>}
                  {!taking && !picture && <p className="muted text-sm">The picture couldn&apos;t be taken on this page; your words still go.</p>}
                  {pictureUrl && withPicture && (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: preview */}
                      <img src={pictureUrl} alt="The picture that will be sent" className="max-h-32 rounded border border-line" />
                      <p className="muted text-sm">It may show customer details. Untick to leave it out.</p>
                    </>
                  )}
                </div>
              )}

              {choice === "rating" && (
                <>
                  <div>
                    <div className="label mb-1 text-base" id="help-stars">
                      How many stars?
                    </div>
                    <div className="flex gap-1" role="group" aria-labelledby="help-stars">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          className="h-14 w-14 rounded text-4xl leading-none"
                          style={{ color: n <= stars ? "#d4a017" : "var(--line)" }}
                          aria-label={`${n} star${n > 1 ? "s" : ""}`}
                          aria-pressed={n === stars}
                          onClick={() => setStars(n)}
                        >
                          ★
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="help-text" className="label text-base">
                      Anything you&apos;d like to tell us?
                    </label>
                    <textarea id="help-text" className="textarea" rows={4} maxLength={MAX_TEXT} value={text} onChange={(e) => setText(e.target.value)} />
                  </div>
                  <label className="flex min-h-12 items-center gap-3 text-base">
                    <input type="checkbox" className="check h-6 w-6" checked={quoteOk} onChange={(e) => setQuoteOk(e.target.checked)} />
                    You may quote me with my shop&apos;s name
                  </label>
                </>
              )}

              {choice !== "rating" && (
                <div className="field">
                  <label htmlFor="help-reply" className="label text-base">
                    Email me back at
                  </label>
                  <input id="help-reply" type="email" className="input" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} autoComplete="email" />
                </div>
              )}

              {!connected && (
                <p className="muted text-sm">
                  Not connected to StitchHub yet: this will be sent once it is.
                  {helpEmail && <> For anything urgent, email {helpEmail}.</>}
                </p>
              )}
              {error && (
                <p role="alert" className="text-base font-semibold" style={{ color: "var(--bad)" }}>
                  {error}
                </p>
              )}

              <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy || taking}>
                {busy ? "Sending…" : "Send"}
              </button>
              <button type="button" className="btn w-full" onClick={() => reset()}>
                Back to the choices
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
