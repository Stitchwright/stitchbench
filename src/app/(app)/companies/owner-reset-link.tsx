"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { makeOwnerResetLink } from "@/actions/password-reset";
import { runAction } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";

/** "Reset link" for a company's owner: one hour, one use, shown here once for the administrator to pass on. */
export function OwnerResetLink({ shopId }: { shopId: string }) {
  const [pending, start] = useTransition();
  const [link, setLink] = useState<string | null>(null);
  if (link) {
    return (
      <span className="mt-1 flex flex-wrap items-center gap-1" data-testid="owner-reset-link">
        <input readOnly value={link} className="input mono text-xs" aria-label="Reset link" onFocus={(e) => e.currentTarget.select()} />
        <CopyButton text={link} />
        <span className="muted text-xs">Works once, for an hour. Give it to the owner only.</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-sm ml-1"
      disabled={pending}
      title="A link for the owner to choose a new password (one hour, one use)"
      onClick={() =>
        start(async () => {
          const r = await runAction(() => makeOwnerResetLink(shopId));
          if (r.error) toast.error(r.error);
          else if (r.shown) setLink(r.shown);
        })
      }
    >
      Reset link
    </button>
  );
}
