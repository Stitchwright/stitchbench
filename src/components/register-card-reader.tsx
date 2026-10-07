"use client";

// The register's Card reader (shop-features-round-2-design.md 4.8): sends the amount to the shop's Stripe reader, says
// "Tap, insert or swipe on the reader", asks how it went every second and a half, and hands an approved payment back as a
// Card payment (the register then finishes the sale). Cancel stops it on the reader; in test mode the simulated reader
// can be "tapped" (approved, or a declined card).
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { CreditCard } from "lucide-react";
import { cancelReaderPayment, readerPaymentStatus, simulateReaderTap, startReaderPayment } from "@/actions/card-reader";
import { money } from "@/lib/format";

export type ReaderSetup = { readers: { id: string; label: string }[]; testMode: boolean };
type Waiting = { paymentId: string; amountCents: number; message: string | null };

const key = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

export function RegisterCardReader({ setup, amountCents, disabled, onApproved }: { setup: ReaderSetup; amountCents: number; disabled: boolean; onApproved: (t: { amountCents: number; stripeIntent: string; last4: string | null }) => void }) {
  const [readerId, setReaderId] = useState(setup.readers[0]?.id ?? "");
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [busy, setBusy] = useState(false);
  const done = useRef(false);
  const approved = useEffectEvent(onApproved);

  useEffect(() => {
    if (!waiting) return;
    done.current = false;
    const t = setInterval(async () => {
      const r = await readerPaymentStatus(waiting.paymentId).catch(() => null);
      if (!r || done.current) return;
      if ("error" in r) return setWaiting((w) => (w ? { ...w, message: r.error } : w));
      if (r.status === "approved") {
        done.current = true;
        setWaiting(null);
        toast.success(`Card approved${r.last4 ? ` (ending ${r.last4})` : ""}: ${money(r.amountCents)}`);
        approved({ amountCents: r.amountCents, stripeIntent: r.intentId, last4: r.last4 ?? null });
      } else if (r.status === "declined") setWaiting((w) => (w ? { ...w, message: `${r.message ?? "Declined."} Try the card again, or another way to pay.` } : w));
      else if (r.status === "cancelled") {
        done.current = true;
        setWaiting(null);
      }
    }, 1500);
    return () => clearInterval(t);
  }, [waiting]);

  if (!setup.readers.length) return null;

  async function start() {
    if (amountCents < 50) return toast.error("A card payment on the reader is at least $0.50.");
    setBusy(true);
    try {
      const r = await startReaderPayment(readerId, amountCents, key());
      if ("error" in r) return toast.error(r.error);
      setWaiting({ paymentId: r.paymentId, amountCents, message: null });
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!waiting) return;
    const r = await cancelReaderPayment(waiting.paymentId);
    if ("error" in r && r.error) return toast.error(r.error);
    done.current = true;
    setWaiting(null);
  }

  async function tap(decline: boolean) {
    if (!waiting) return;
    const r = await simulateReaderTap(waiting.paymentId, decline);
    if ("error" in r && r.error) toast.error(r.error);
  }

  if (waiting) {
    return (
      <div className="w-full space-y-2 rounded border border-line p-3" role="status" aria-label="Card reader">
        <p className="text-lg font-semibold">Tap, insert or swipe on the reader: {money(waiting.amountCents)}</p>
        {waiting.message && <p className="text-base text-[var(--bad)]">{waiting.message}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={cancel}>
            Cancel on the reader
          </button>
          {setup.testMode && (
            <>
              <button type="button" className="btn" onClick={() => tap(false)}>
                Test: tap a card
              </button>
              <button type="button" className="btn" onClick={() => tap(true)}>
                Test: a declined card
              </button>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {setup.readers.length > 1 && (
        <select aria-label="Which reader" className="select" value={readerId} onChange={(e) => setReaderId(e.target.value)}>
          {setup.readers.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      )}
      <button type="button" className="btn btn-sm btn-primary" disabled={disabled || busy || amountCents < 50} onClick={start}>
        <CreditCard size={14} aria-hidden /> {busy ? "Sending..." : `Card reader ${money(amountCents)}`}
      </button>
    </span>
  );
}
