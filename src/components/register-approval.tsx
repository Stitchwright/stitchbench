"use client";

// A refund or discount over the store's limit (shop-features-round-2-design.md 7.5) stops the register here with two
// ways on: a manager types her code, or "Ask the owner" (she gets an email with a link; this panel waits and moves on by
// itself when she answers). The approval's id goes with the sale, which uses it once.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { approvalStatus, approveWithCode, askOwner } from "@/actions/stores";
import { runAction } from "@/components/action-form";
import { money } from "@/lib/format";

export type ApprovalNeed = { kind: "REFUND" | "DISCOUNT"; amountCents: number; pct: number | null };
export type ApprovalDraft = { lines: { description: string; qty: number; unitPriceCents: number; discountCents?: number }[]; customer: string | null; totalCents: number };

export const needWords = (n: ApprovalNeed) => (n.kind === "REFUND" ? `a refund of ${money(n.amountCents)}` : `a ${n.pct ?? 0}% discount (${money(n.amountCents)})`);

/** The limit a cart goes over (pure, the same rule the server holds the sale to), or null. */
export function overLimit(limits: { refundCents: number | null; discountPct: number | null } | null, s: { refundCents: number; discountCents: number; grossCents: number }): ApprovalNeed | null {
  if (!limits) return null;
  if (limits.refundCents != null && s.refundCents > limits.refundCents) return { kind: "REFUND", amountCents: s.refundCents, pct: null };
  if (limits.discountPct != null && s.discountCents > 0 && s.grossCents > 0) {
    const pct = Math.round((s.discountCents / s.grossCents) * 1000) / 10;
    if (pct > limits.discountPct) return { kind: "DISCOUNT", amountCents: s.discountCents, pct };
  }
  return null;
}

export function RegisterApproval({ need, draft, onApproved, onCancel }: { need: ApprovalNeed; draft: ApprovalDraft; onApproved: (approvalId: string) => void; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<{ id: string; told: number } | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const done = useRef(false);

  // Waiting on the owner: ask every 4 seconds until she answers or it runs out.
  useEffect(() => {
    if (!asked) return;
    const timer = setInterval(async () => {
      const r = await runAction(() => approvalStatus(asked.id));
      if (r.error || !r.note) return;
      const [status, by, note] = r.note.split("|");
      if (status === "APPROVED" && !done.current) {
        done.current = true;
        clearInterval(timer);
        toast.success(`Approved${by ? ` by ${by}` : ""}.`);
        onApproved(asked.id);
      } else if (status === "REFUSED" || status === "EXPIRED") {
        clearInterval(timer);
        setAnswer(status === "REFUSED" ? `Not this time${by ? ` (${by})` : ""}${note ? `: ${note}` : "."}` : "No answer in time. Ask again, or a manager types her code.");
        setAsked(null);
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [asked, onApproved]);

  async function withCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await runAction(() => approveWithCode(need, code, reason, draft));
    setBusy(false);
    if (r.error) return void toast.error(r.error);
    if (r.note) onApproved(r.note);
  }

  async function ask() {
    setBusy(true);
    setAnswer(null);
    const r = await runAction(() => askOwner(need, reason, draft));
    setBusy(false);
    if (r.error || !r.note) return void toast.error(r.error ?? "Couldn't ask. Try again.");
    const [id, told] = r.note.split("|");
    setAsked({ id, told: Number(told) || 0 });
  }

  return (
    <div className="card card-pad space-y-3 text-base" role="region" aria-label="Approval needed" data-testid="approval-panel">
      <h2 className="h2">This needs an OK</h2>
      <p>
        This sale is {needWords(need)}, over this store&apos;s limit. A manager can type her code here, or ask the owner.
      </p>
      <div className="field">
        <label htmlFor="appr-reason" className="label">
          Why (the owner sees this)
        </label>
        <input id="appr-reason" className="input text-base" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damaged in the box; she's a regular" />
      </div>
      {asked ? (
        <p className="pill tone-wait inline-block whitespace-normal" role="status">
          Waiting for the owner{asked.told ? " (she has the email)" : " (email isn't set up: she can answer from Today on her phone)"}. This moves on by itself when she answers.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={withCode} className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label htmlFor="appr-code" className="label">
                Manager&apos;s code
              </label>
              <input id="appr-code" className="input num w-32 text-base" inputMode="numeric" autoComplete="off" type="password" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary min-h-11" disabled={busy || !code}>
              Approve with the code
            </button>
          </form>
          <button type="button" className="btn min-h-11" onClick={ask} disabled={busy}>
            Ask the owner
          </button>
        </div>
      )}
      {answer && <p className="text-base" role="status">{answer}</p>}
      <button type="button" className="link text-sm" onClick={onCancel}>
        Change the sale instead
      </button>
    </div>
  );
}
