"use client";
// "Add to her want list" (shop-features-round-2-design.md 1.4): pick one of the shop's items, or type words to watch
// for ("Tula Pink", "Kaffe Fassett"). One main button.
import { useState } from "react";
import { findItems } from "@/actions/register";
import { addWant } from "@/actions/want-lists";
import type { RegisterItem } from "@/lib/register-item";
import { ActionForm, Submit } from "@/components/action-form";

export function WantAddForm({ customerId }: { customerId: string }) {
  const [item, setItem] = useState<RegisterItem | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<RegisterItem[]>([]);
  return (
    <ActionForm action={addWant.bind(null, customerId)} reset className="space-y-3 text-base">
      <input type="hidden" name="partId" value={item?.id ?? ""} />
      {item ? (
        <p>
          <span className="mono">{item.partNumber}</span> {item.description}{" "}
          <button type="button" className="link text-sm" onClick={() => setItem(null)}>
            change
          </button>
        </p>
      ) : (
        <div className="field">
          <label htmlFor="want-words" className="label">
            What she wants: an item, or a designer, collection or maker
          </label>
          <input
            id="want-words"
            name="words"
            className="input text-base"
            placeholder="Tula Pink"
            autoComplete="off"
            value={q}
            onChange={async (e) => {
              const v = e.target.value;
              setQ(v);
              setHits(v.trim().length >= 3 ? (await findItems(v)).filter((x) => !x.stockUnitId).slice(0, 6) : []);
            }}
          />
          {hits.length > 0 && (
            <ul className="mt-1 divide-y divide-line rounded border border-line text-sm" aria-label="Items that match">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    className="min-h-11 w-full px-3 text-left hover:bg-surface-2"
                    onClick={() => {
                      setItem(h);
                      setHits([]);
                      setQ("");
                    }}
                  >
                    This item: <span className="mono">{h.partNumber}</span> {h.description}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="muted text-sm">Pick an item above, or keep the words: anything new that matches them shows &quot;Here now&quot;.</p>
        </div>
      )}
      <div className="field">
        <label htmlFor="want-note" className="label">
          Note (optional)
        </label>
        <input id="want-note" name="note" className="input text-base" placeholder="For her granddaughter's quilt" />
      </div>
      <Submit className="btn btn-primary min-h-11">Add to her want list</Submit>
    </ActionForm>
  );
}
