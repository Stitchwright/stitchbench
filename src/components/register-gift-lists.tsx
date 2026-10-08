"use client";

// The register's "Gift lists" (shop-features-round-2-design.md 9.9): find a customer's wish list by her name, see what is
// still wanted, and add one to the sale: the line names the list item, so it is ticked off when the sale is done.
import { useState } from "react";
import { toast } from "sonner";
import { Gift } from "lucide-react";
import { findGiftLists } from "@/actions/gift-registry";
import { money } from "@/lib/format";

type Lists = Awaited<ReturnType<typeof findGiftLists>>;
export type GiftListPick = { registryItemId: string; partId: string; description: string; partNumber: string | null; priceCents: number | null; inStock: number; listName: string };

export function RegisterGiftLists({ returnMode, onAdd }: { returnMode: boolean; onAdd: (pick: GiftListPick) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [lists, setLists] = useState<Lists | null>(null);
  if (returnMode) return null;

  async function look() {
    if (q.trim().length < 2) return;
    setBusy(true);
    try {
      setLists(await findGiftLists(q.trim()));
    } catch {
      toast.error("Couldn't look the lists up. Check the connection, then try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={`btn btn-sm ${open ? "btn-primary" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Gift size={14} aria-hidden /> Gift lists
      </button>
      {open && (
        <div className="card card-pad w-full space-y-3" aria-label="Gift lists">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              look();
            }}
          >
            <div className="field min-w-64 flex-1">
              <label htmlFor="gift-list-q" className="label">
                Whose list? Her name
              </label>
              <input id="gift-list-q" value={q} onChange={(e) => setQ(e.target.value)} className="input text-lg" autoComplete="off" />
            </div>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Looking..." : "Find"}
            </button>
          </form>
          {lists && lists.length === 0 && <p className="text-base">No list under &quot;{q}&quot;. Try her first or last name.</p>}
          {lists?.map((l) => (
            <div key={l.id} className="space-y-1">
              <h3 className="text-base font-semibold">
                {l.title} <span className="muted text-sm font-normal">({l.name})</span>
              </h3>
              {l.lines.length === 0 ? (
                <p className="muted text-sm">Everything on it has been bought.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {l.lines.map((it) => (
                    <li key={it.id} className="flex flex-wrap items-center justify-between gap-2 py-1 text-base">
                      <span>
                        {it.description}
                        {it.note ? <span className="muted text-sm"> · {it.note}</span> : null} <span className="muted text-sm">({it.left} wanted)</span>
                      </span>
                      {it.partId ? (
                        <span className="flex items-center gap-2">
                          <span className="num">{money(it.priceCents)}</span>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={it.inStock < 1}
                            onClick={() => onAdd({ registryItemId: it.id, partId: it.partId!, description: it.description, partNumber: it.partNumber, priceCents: it.priceCents, inStock: it.inStock, listName: l.title })}
                          >
                            {it.inStock < 1 ? "None on the shelf" : "Add"}
                          </button>
                        </span>
                      ) : (
                        <span className="muted text-sm">not an item in stock</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
