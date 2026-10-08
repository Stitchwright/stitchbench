"use client";
// The live sale's claim form (shop-features-round-2-design.md 4.3), big for a phone or tablet beside the camera: the item
// (tap one on today's show, or search), the buyer (finds the customer as you type; a new name is fine, with a phone or
// email to send her link to), how many (yards for fabric), and Claim. The item stays chosen for the next buyer.
import { useRef, useState } from "react";
import { findCustomers, findItems, type CustomerHit } from "@/actions/register";
import type { RegisterItem } from "@/lib/register-item";
import type { ActionResult } from "@/lib/action";
import { toast } from "sonner";
import { ActionForm, runAction, Submit } from "@/components/action-form";

type Pick = { id: string; partNumber: string; description: string; priceCents: number | null; unit: string | null; left: number };
const money = (c: number | null) => (c == null ? "no price" : `$${(c / 100).toFixed(2)}`);

export function LiveClaimForm({
  claim,
  addPick,
  picks,
  admin,
}: {
  claim: (fd: FormData) => Promise<ActionResult>;
  addPick: (partId: string, on: boolean) => Promise<ActionResult>;
  picks: Pick[];
  admin: boolean;
}) {
  const [item, setItem] = useState<Pick | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<RegisterItem[]>([]);
  const [buyer, setBuyer] = useState<CustomerHit | null>(null);
  const [name, setName] = useState("");
  const [people, setPeople] = useState<CustomerHit[]>([]);
  const nameBox = useRef<HTMLInputElement>(null);
  const pickItem = (p: Pick) => {
    setItem(p);
    setQ("");
    setHits([]);
    nameBox.current?.focus();
  };
  return (
    <ActionForm
      action={async (fd) => {
        const r = await claim(fd);
        if (!r?.error) {
          setBuyer(null);
          setName("");
          setPeople([]);
          nameBox.current?.focus();
        }
        return r;
      }}
      success="Claimed"
      className="card card-pad space-y-4"
    >
      <h2 className="h2">Claim an item</h2>
      <input type="hidden" name="partId" value={item?.id ?? ""} />
      {picks.length > 0 && (
        <div className="space-y-2">
          <p className="label">On today&apos;s show</p>
          <div className="flex flex-wrap gap-2">
            {picks.map((p) => (
              <button key={p.id} type="button" onClick={() => pickItem(p)} className={`btn min-h-11 text-base ${item?.id === p.id ? "btn-primary" : ""}`} aria-pressed={item?.id === p.id}>
                {p.description} <span className="muted">({p.left} left)</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="live-item" className="label">
          {item ? "Item" : "Search an item"}
        </label>
        {item ? (
          <div className="flex flex-wrap items-center gap-3 text-lg">
            <span className="font-semibold">{item.description}</span>
            <span className="num">
              {money(item.priceCents)}
              {item.unit === "yd" ? " a yard" : ""}
            </span>
            <button type="button" className="link min-h-11 text-base" onClick={() => setItem(null)}>
              Change
            </button>
            {!picks.some((p) => p.id === item.id) && (
              <button
                type="button"
                className="link min-h-11 text-base"
                onClick={async () => {
                  const r = await runAction(() => addPick(item.id, true));
                  if (r?.error) toast.error(r.error);
                  else toast.success("Added to today's show");
                }}
              >
                Add to today&apos;s show
              </button>
            )}
          </div>
        ) : (
          <>
            <input
              id="live-item"
              className="input text-lg"
              autoComplete="off"
              placeholder="Name or number"
              value={q}
              onChange={async (e) => {
                const v = e.target.value;
                setQ(v);
                setHits(v.trim().length >= 2 ? (await findItems(v)).filter((h) => !h.stockUnitId) : []);
              }}
            />
            {hits.length > 0 && (
              <ul className="divide-y divide-line rounded border border-line text-base">
                {hits.slice(0, 8).map((h) => (
                  <li key={h.id}>
                    <button type="button" className="min-h-11 w-full px-3 py-2 text-left hover:bg-surface-2" onClick={() => pickItem({ id: h.id, partNumber: h.partNumber, description: h.description, priceCents: h.priceCents, unit: h.unit, left: h.qtyOnHand })}>
                      {h.description} <span className="muted">{h.partNumber} · {money(h.priceCents)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <div className="field">
          <label htmlFor="live-name" className="label">
            Buyer&apos;s name
          </label>
          <input type="hidden" name="customerId" value={buyer?.id ?? ""} />
          {buyer ? (
            <div className="flex items-center gap-3 text-lg">
              <span className="font-semibold">{buyer.name}</span>
              <button type="button" className="link min-h-11 text-base" onClick={() => setBuyer(null)}>
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                id="live-name"
                ref={nameBox}
                name="name"
                className="input text-lg"
                autoComplete="off"
                placeholder="Jane Smith"
                value={name}
                onChange={async (e) => {
                  const v = e.target.value;
                  setName(v);
                  setPeople(v.trim().length >= 2 ? await findCustomers(v) : []);
                }}
              />
              {people.length > 0 && (
                <ul className="divide-y divide-line rounded border border-line text-base">
                  {people.slice(0, 6).map((c) => (
                    <li key={c.id}>
                      <button type="button" className="min-h-11 w-full px-3 py-2 text-left hover:bg-surface-2" onClick={() => {
                          setBuyer(c);
                          setPeople([]);
                        }}>
                        {c.name} {c.phone ? <span className="muted">{c.phone}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="field">
          <label htmlFor="live-qty" className="label">
            {item?.unit === "yd" ? "Yards" : "How many"}
          </label>
          <input id="live-qty" name="qty" inputMode="decimal" defaultValue="1" className="input num text-lg" />
        </div>
      </div>
      {!buyer && name.trim().length > 1 && people.length === 0 && (
        <div className="field">
          <label htmlFor="live-phone" className="label">
            New buyer: her mobile number or email (for the pay link)
          </label>
          <input id="live-phone" name="phone" className="input text-base" autoComplete="off" placeholder="555-123-4567" />
        </div>
      )}
      {admin && (
        <details>
          <summary className="link cursor-pointer text-base">More choices</summary>
          <div className="field mt-3 max-w-xs">
            <label htmlFor="live-price" className="label">
              Show price (leave empty for the usual price)
            </label>
            <input id="live-price" name="price" inputMode="decimal" className="input num text-base" placeholder={item?.priceCents != null ? (item.priceCents / 100).toFixed(2) : ""} />
          </div>
        </details>
      )}
      <div className="flex justify-end">
        <Submit className="btn btn-primary min-h-11 px-8 text-lg">Claim</Submit>
      </div>
    </ActionForm>
  );
}
