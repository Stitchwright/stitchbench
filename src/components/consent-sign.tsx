"use client";

// The counter tablet's consent form (scheduling-messaging-design.md 8.3, /consent/[customerId]): tick, type a name,
// Sign. After signing the customer sees only a thank-you; "Done" takes staff back to the customer's page.
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { recordTextConsent } from "@/actions/consent";
import { runAction } from "@/components/action-form";

export function ConsentSign({ customerId }: { customerId: string }) {
  const [signed, setSigned] = useState(false);
  const [pending, start] = useTransition();

  if (signed) {
    return (
      <div className="space-y-6 text-center">
        <p className="text-3xl font-semibold">Thank you. Please hand the tablet back.</p>
        <p className="muted text-lg">A text confirming the sign-up is on its way.</p>
        <p className="pt-8">
          <Link href={`/customers/${customerId}`} className="btn btn-sm">
            Done (staff)
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        const fd = new FormData(e.currentTarget);
        fd.set("source", "tablet");
        start(async () => {
          const r = await runAction(() => recordTextConsent(customerId, fd));
          if (r?.error) toast.error(r.error);
          else setSigned(true);
        });
      }}
    >
      <label className="flex items-start gap-3 text-xl">
        <input type="checkbox" name="agree" className="check mt-1 h-7 w-7" required /> <span>I agree</span>
      </label>
      <div className="field">
        <label htmlFor="signedName" className="text-lg font-semibold">
          Type your name to sign
        </label>
        <input id="signedName" name="signedName" className="input text-2xl" autoComplete="off" minLength={2} maxLength={80} required />
      </div>
      <button type="submit" className="btn btn-primary w-full py-4 text-xl" disabled={pending}>
        {pending ? "Saving..." : "Sign"}
      </button>
    </form>
  );
}
