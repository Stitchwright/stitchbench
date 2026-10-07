"use client";

// The register's "Find a color" (shop-features-round-2-design.md 2.2 and 6.2): a maker and number in any shape ("isa 15",
// "Aurifil 2024"), a color name ("navy") or a supply in words ("PLA black 1.75") shows big swatches with what is on the
// shelf, where and the price; one tap adds it to the sale. With a customer chosen it first shows the colors she bought
// before. None on the shelf: "Order more" puts it on its supplier's draft order. The shop's own matches show under each.
import { useEffect, useRef, useState } from "react";
import { Palette } from "lucide-react";
import { toast } from "sonner";
import { findColors } from "@/actions/colors";
import { orderMore } from "@/actions/fabric-orders";
import type { ColorHit } from "@/lib/colors";
import type { RegisterItem } from "@/lib/register-item";
import { money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";

function Swatch({ hex, photoId }: { hex: string | null | undefined; photoId: string | null | undefined }) {
  if (hex) return <span aria-hidden="true" className="block h-14 w-14 shrink-0 rounded border border-line" style={{ backgroundColor: hex }} />;
  if (photoId) {
    // eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset
    return <img src={`/api/parts/photo/${photoId}`} alt="" className="h-14 w-14 shrink-0 rounded border border-line object-cover" loading="lazy" />;
  }
  return <span aria-hidden="true" className="block h-14 w-14 shrink-0 rounded border border-dashed border-line" />;
}

function Tile({ hit, why, verb, returnMode, onAdd, onOrder }: { hit: ColorHit; why?: string; verb: string; returnMode: boolean; onAdd: (item: RegisterItem) => void; onOrder: (hit: ColorHit) => void }) {
  const none = hit.qtyOnHand <= 0;
  return (
    <li className="flex flex-col gap-2 rounded border border-line p-3">
      <div className="flex items-start gap-3">
        <Swatch hex={hit.colorHex} photoId={hit.photoId} />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">{hit.details || hit.description}</div>
          <div className="muted text-sm">
            <span className="mono">{hit.partNumber}</span> {hit.details ? hit.description : ""}
          </div>
          <div className="text-sm">
            {none ? <span className="pill tone-bad">None on the shelf</span> : <span>{qtyText(hit.qtyOnHand, hit.unit)} on the shelf</span>}
            {hit.location ? ` · bin ${hit.location}` : ""} · <span className="num">{money(hit.priceCents)}</span>
            {why ? <span className="muted"> · {why}</span> : null}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            onAdd(hit);
            toast.success(`${verb === "Add" ? "Added" : "Returning"} ${hit.details || hit.description}.`);
          }}
        >
          {verb} {hit.colorNumber ?? ""}
          {!hit.colorNumber ? "it" : ""}
        </button>
        {none && !returnMode && (
          <button type="button" className="btn" onClick={() => onOrder(hit)}>
            Order more
          </button>
        )}
      </div>
      {hit.sameAs.length > 0 && (
        <div className="space-y-1 border-t border-line pt-2 text-sm">
          <div className="muted">The same color, as your shop matched it:</div>
          {hit.sameAs.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2">
              {s.colorHex && <span aria-hidden="true" className="inline-block h-5 w-5 rounded border border-line" style={{ backgroundColor: s.colorHex }} />}
              <span>
                {s.label} · {s.qtyOnHand > 0 ? `${s.qtyOnHand} on the shelf` : "none on the shelf"}
                {s.location ? ` · bin ${s.location}` : ""}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => onAdd(s.item)}>
                {verb} this one
              </button>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

export function ColorFinder({ customerId, customerName, returnMode, onAdd }: { customerId: string | null; customerName: string | null; returnMode: boolean; onAdd: (item: RegisterItem) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ q: string; hits: ColorHit[]; bought: ColorHit[]; customerId: string | null } | null>(null);
  const box = useRef<HTMLInputElement>(null);

  async function look(text: string) {
    setBusy(true);
    try {
      const r = await findColors(text, customerId);
      setFound({ q: text, ...r, customerId });
    } catch {
      toast.error("Couldn't look that up. Check the connection, then try again.");
    } finally {
      setBusy(false);
    }
  }

  // Opening the panel with a customer chosen shows the colors she bought before.
  useEffect(() => {
    if (!open) return;
    box.current?.focus();
    if (customerId) {
      let live = true;
      findColors("", customerId)
        .then((r) => live && setFound((f) => (f && f.q ? { ...f, bought: r.bought, customerId } : { q: "", hits: [], bought: r.bought, customerId })))
        .catch(() => undefined);
      return () => {
        live = false;
      };
    }
  }, [open, customerId]);

  async function order(hit: ColorHit) {
    const fd = new FormData();
    fd.set("qty", "1");
    const r = await orderMore(hit.id, fd);
    if (r && "error" in r && r.error) toast.error(r.error);
    else toast.success(r && "note" in r && r.note ? r.note : "Added to the supplier's draft order.");
  }

  const bought = found && found.customerId === customerId ? found.bought : [];
  const verb = returnMode ? "Return" : "Add";

  return (
    <>
      <button type="button" className={`btn btn-sm ${open ? "btn-primary" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Palette size={14} aria-hidden /> Find a color
      </button>
      {open && (
        <div className="card card-pad w-full space-y-3" aria-label="Find a color">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim().length >= 2) look(q.trim());
            }}
          >
            <div className="field min-w-64 flex-1">
              <label htmlFor="color-q" className="label">
                Maker and number, or a color
              </label>
              <input id="color-q" ref={box} value={q} onChange={(e) => setQ(e.target.value)} className="input text-lg" placeholder="isa 15, Aurifil 2024, navy, PLA black 1.75" autoComplete="off" />
            </div>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Looking..." : "Find"}
            </button>
          </form>
          {bought.length > 0 && !(found?.q) && (
            <div className="space-y-2">
              <h3 className="text-base font-semibold">Colors {customerName ? customerName.split(" ")[0] : "this customer"} bought before</h3>
              <ul className="grid gap-2 md:grid-cols-2">
                {bought.map((h) => (
                  <Tile key={h.id} verb={verb} returnMode={returnMode} onAdd={onAdd} onOrder={order} hit={h} why={h.boughtText ? `last bought ${h.boughtText}` : undefined} />
                ))}
              </ul>
            </div>
          )}
          {found?.q && (
            <div className="space-y-2">
              {found.hits.length === 0 ? (
                <p className="text-base">
                  No color matches &quot;{found.q}&quot;. Try the number alone (&quot;0015&quot;), the maker and number (&quot;isa 15&quot;), or a color name (&quot;navy&quot;).
                </p>
              ) : (
                <ul className="grid gap-2 md:grid-cols-2" aria-label="Colors found">
                  {found.hits.map((h) => (
                    <Tile key={h.id} verb={verb} returnMode={returnMode} onAdd={onAdd} onOrder={order} hit={h} />
                  ))}
                </ul>
              )}
            </div>
          )}
          {!found?.q && bought.length === 0 && (
            <p className="muted text-sm">Type the number on the spool end, the maker and number, or a color. Thread, filament, vinyl and other supplies with a color show here with what is on the shelf.</p>
          )}
        </div>
      )}
    </>
  );
}
