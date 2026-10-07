"use client";

// "Join this company into another of yours" (round-2 7.6): the owner makes a one-time join code here and types it into
// the other company. The code is shown once, on the page (not in a passing toast), so she can copy it down.
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { runAction } from "@/components/action-form";
import type { ActionResult } from "@/lib/action";

export function JoinCodeButton({ action }: { action: () => Promise<ActionResult> }) {
  const [code, setCode] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await runAction(action);
            if (r?.error) toast.error(r.error);
            else if (r?.shown) setCode(r.shown);
          })
        }
      >
        {code ? "Make a new join code" : "Make a join code"}
      </button>
      {code && (
        <p className="text-base" data-testid="join-code">
          Your join code: <strong className="font-mono text-lg tracking-wider">{code}</strong>. Sign in to the other company, open Settings, Stores, and type it there within 30
          minutes. It works once.
        </p>
      )}
    </div>
  );
}
