"use client";
// "Make a key" for the phone-answering service (shop-features-round-2-design.md 5.6): the key shows once, to copy into
// the service's settings; making a new one stops the old.
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { makeStatusKey } from "@/actions/customer-answers";
import { runAction } from "@/components/action-form";

export function StatusKeyButton({ hasKey }: { hasKey: boolean }) {
  const [pending, start] = useTransition();
  const [key, setKey] = useState<string | null>(null);
  return (
    <div className="space-y-2 text-sm">
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await runAction(() => makeStatusKey());
            if (r?.error) toast.error(r.error);
            else if (r?.shown) setKey(r.shown);
          })
        }
      >
        {hasKey || key ? "Make a new key" : "Make a key"}
      </button>
      {key && (
        <div className="space-y-1" data-status-key>
          <label htmlFor="status-key" className="label">
            Your key (copy it now: it won&apos;t be shown again)
          </label>
          <div className="flex flex-wrap gap-2">
            <input id="status-key" readOnly value={key} className="input mono min-w-64 flex-1" onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(key);
                  toast.success("Copied.");
                } catch {
                  toast.error("Couldn't copy here: select the key and copy it.");
                }
              }}
            >
              Copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
