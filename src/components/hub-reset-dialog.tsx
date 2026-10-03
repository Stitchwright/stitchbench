"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { allowHubReset, refuseHubReset } from "@/actions/hub-reset";
import { runAction } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";

type Grant = { id: string; shopName: string; email: string; expiresAt: string };

/**
 * The Windows window's answer to a reset asked for on the StitchHub account (src/components/hub-reset-prompt.tsx). Allow
 * shows the new password here, once; closing the box forgets it.
 */
export function HubResetDialog({ grants }: { grants: Grant[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string; password: string } | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const g = grants.find((x) => !hidden.has(x.id));
  if (!done && !g) return null;

  const answer = (allow: boolean) => {
    if (!g) return;
    setError(null);
    start(async () => {
      const r = await runAction(() => (allow ? allowHubReset(g.id) : refuseHubReset(g.id)));
      if (r.error) {
        setError(r.error);
        return;
      }
      setHidden((h) => new Set(h).add(g.id));
      if (allow && r.shown) setDone({ email: g.email, password: r.shown });
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true" aria-labelledby="hub-reset-title">
      <div className="card card-pad w-full max-w-md space-y-4 bg-surface">
        {done ? (
          <>
            <h2 id="hub-reset-title" className="text-lg font-semibold">
              New password for {done.email}
            </h2>
            <p className="mono rounded border border-line px-3 py-2 text-lg tracking-wide" data-testid="hub-reset-password">
              {done.password}
            </p>
            <p className="muted text-sm">It is shown only here, now. Sign in with it, then change it under Settings → My password if you like. Every device signed in as this login signs in again.</p>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={done.password} />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setDone(null);
                  router.refresh();
                }}
              >
                Close
              </button>
            </div>
          </>
        ) : g ? (
          <>
            <h2 id="hub-reset-title" className="text-lg font-semibold">
              StitchHub asks to reset {g.email}&apos;s password
            </h2>
            <p className="text-sm">
              The owner of <strong>{g.shopName}</strong> asked for this on their StitchHub account. Allow sets a new password and shows it here, once. If nobody here asked for it, choose Refuse:
              nothing changes.
            </p>
            {error && (
              <p className="pill tone-bad whitespace-normal" role="alert">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary" disabled={pending} onClick={() => answer(true)}>
                Allow
              </button>
              <button type="button" className="btn" disabled={pending} onClick={() => answer(false)}>
                Refuse
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
