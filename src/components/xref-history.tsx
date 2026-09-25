"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { ActionButton } from "@/components/action-form";
import { crossRefHistory, revertCrossRef, type XRevision } from "@/actions/xref";

const ACTION: Record<string, string> = { added: "Added", edited: "Changed", merged: "Merged", reverted: "Rolled back", removed: "Removed", restored: "Restored" };

/** Every version of a cross-reference entry on the hub, with a button to go back to any of them. */
export function XrefHistory({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [revs, setRevs] = useState<XRevision[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function toggle() {
    setOpen((o) => !o);
    if (revs) return;
    const r = await crossRefHistory(id);
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
                      <ActionButton action={revertCrossRef.bind(null, id, r.id)} className="btn btn-sm" confirm="Go back to this version?" success="Rolled back">
                        Roll back to this
                      </ActionButton>
                    )}
                  </div>
                  <div className="mt-1">
                    {r.snapshot.name} · {r.snapshot.numbers.map((n) => `${n.brand} ${n.number}`).join(", ")} · fits {r.snapshot.fits.length} models
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
