"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { ActionButton } from "@/components/action-form";
import { manualLinkHistory, revertManualLink } from "@/actions/hub";
import type { LinkRevision } from "@/lib/hub";

const ACTION: Record<string, string> = { added: "Added", edited: "Changed", reverted: "Rolled back", removed: "Removed", restored: "Restored" };

/** Every version of a manual link on the hub, with a button to go back to any of them. */
export function LinkHistory({ linkId }: { linkId: string }) {
  const [open, setOpen] = useState(false);
  const [revs, setRevs] = useState<LinkRevision[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function toggle() {
    setOpen((o) => !o);
    if (revs) return;
    const r = await manualLinkHistory(linkId);
    if ("error" in r) setErr(r.error);
    else setRevs(r.revisions);
  }

  return (
    <div>
      <button type="button" className="btn btn-sm" onClick={toggle} aria-expanded={open}>
        <History size={12} aria-hidden /> History
      </button>
      {open && (
        <div className="mt-2 rounded border border-line p-2 text-xs">
          {err ? (
            <p className="text-[var(--bad)]">{err}</p>
          ) : !revs ? (
            <p className="muted">Loading from the hub...</p>
          ) : (
            <ol className="space-y-2">
              {revs.map((r, i) => (
                <li key={r.id} className="border-b border-line pb-2 last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <strong>{ACTION[r.action] ?? r.action}</strong> {new Date(r.createdAt).toLocaleString()} by {r.byName || "someone"}
                      {r.byShop ? ` (${r.byShop})` : ""}
                    </span>
                    {i > 0 && r.action !== "removed" && (
                      <ActionButton action={revertManualLink.bind(null, linkId, r.id)} className="btn btn-sm" confirm="Go back to this version?" success="Rolled back">
                        Roll back to this
                      </ActionButton>
                    )}
                  </div>
                  <div className="mt-1 break-all">
                    {r.title} · <span className="mono">{r.url}</span>
                  </div>
                  {r.note && <div className="muted">&ldquo;{r.note}&rdquo;</div>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
