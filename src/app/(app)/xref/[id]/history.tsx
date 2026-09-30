"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { ActionButton } from "@/components/action-form";
import { crossRefHistory, revertCrossRef, type XRevision } from "@/actions/xref";

const ACTION: Record<string, string> = { added: "Added", edited: "Changed", merged: "Merged", reverted: "Rolled back", removed: "Removed", restored: "Restored", sources: "Where-to-buy links updated" };

/**
 * The versions of a cross-reference entry on the hub, newest first, with a button to go back to any of them. The hub
 * sends them a page at a time (50, each holding the whole entry): "Load older" asks for the next page, so an entry
 * with hundreds of versions still opens.
 */
export function XrefHistory({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [revs, setRevs] = useState<XRevision[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load(before: string | null) {
    if (loading) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await crossRefHistory(id, before);
      if ("error" in r) {
        setErr(r.error);
        return;
      }
      // Older pages go after what's shown; a version shown already (added between two loads) isn't shown twice.
      setRevs((have) => {
        const seen = new Set((before ? (have ?? []) : []).map((x) => x.id));
        return [...(before ? (have ?? []) : []), ...r.revisions.filter((x) => !seen.has(x.id))];
      });
      setMore(r.more);
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    setOpen((o) => !o);
    if (!revs) await load(null);
  }

  return (
    <div>
      <button type="button" className="btn btn-sm" onClick={toggle} aria-expanded={open}>
        <History size={12} aria-hidden /> History
      </button>
      {open && (
        <div className="mt-2 rounded border border-line p-2 text-xs">
          {err && !revs ? (
            <p className="text-[var(--bad)]">{err}</p>
          ) : !revs ? (
            <p className="muted">Loading from the hub...</p>
          ) : (
            <>
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
              {revs.length === 0 && <p className="muted">No versions yet.</p>}
              {err && <p className="mt-2 text-[var(--bad)]">{err}</p>}
              {more && (
                <div className="mt-2">
                  <button type="button" className="btn btn-sm" onClick={() => load(revs[revs.length - 1]?.id ?? null)} disabled={loading}>
                    {loading ? "Loading..." : "Load older"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
