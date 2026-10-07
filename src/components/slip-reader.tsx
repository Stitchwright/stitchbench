"use client";
// "Receive from a photo" (shop-features-round-2-design.md 1.10): take or choose up to five pictures of the packing slip
// or invoice (each shrunk here; "these pictures go to the Assistant"), then the lines come back in three groups: On the
// order (ticked), New to us (tap "Make it"), Not on the order (unticked). Each line shows the amount on the order beside
// the slip's; a changed cost says "Cost up 12% ($4.10 to $4.60)" and is ticked to update the item. One main button:
// Receive these.
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera } from "lucide-react";
import { readSlip, receiveSlip } from "@/actions/invoice-reader";
import { runAction } from "@/components/action-form";
import { shrinkImage } from "@/components/photo-upload";
import type { ReadRow, ReceiveRow } from "@/lib/invoice-reader";

const toBase64 = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(new Error("Could not read that picture."));
    r.readAsDataURL(blob);
  });

const dollars = (tenThou: number | null) => (tenThou == null ? "" : `$${(tenThou / 10_000).toFixed(tenThou % 100 ? 4 : 2)}`);

type Row = ReadRow & { tick: boolean; qty: string; cost: boolean };

export function SlipReader({ orderId, unavailable, canCost }: { orderId: string | null; unavailable?: string; canCost: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pics, setPics] = useState<{ blob: Blob; url: string }[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  // This reading's key: "Receive these" sent again (a retry, a second tap) receives nothing twice.
  const [key, setKey] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (unavailable) return <p className="muted text-base">{unavailable}</p>;

  async function add(files: FileList | null) {
    const list = [...(files ?? [])].slice(0, 5 - pics.length);
    const out: { blob: Blob; url: string }[] = [];
    for (const f of list) {
      try {
        const blob = await shrinkImage(f, 1800, 0.75);
        out.push({ blob, url: URL.createObjectURL(blob) });
      } catch {
        toast.error(`Couldn't open ${f.name}. Pictures only (a PDF: print it, or take a picture of each page).`);
      }
    }
    setPics((p) => [...p, ...out].slice(0, 5));
  }

  function read() {
    start(async () => {
      const photos = await Promise.all(pics.map(async (p) => ({ data: await toBase64(p.blob), mediaType: "image/jpeg" })));
      const r = await runAction(() => readSlip(orderId, photos));
      if (r.error) return void toast.error(r.error);
      const got = JSON.parse(r.shown ?? "{}") as { rows: ReadRow[] };
      setRows(got.rows.map((x) => ({ ...x, tick: x.group === "order", qty: String(x.slip.qty), cost: canCost && x.group !== "new" && x.costChange != null })));
      setKey(`slip-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")}`);
    });
  }

  function receive() {
    if (!rows) return;
    const send: ReceiveRow[] = rows
      .filter((r) => r.tick)
      .map((r) => ({
        group: r.group,
        lineId: r.group === "order" ? r.lineId : null,
        partId: r.group === "order" || r.group === "item" ? r.partId : null,
        qty: Number(r.qty) || 0,
        costTenThou: r.slip.unitCostTenThou,
        updateCost: r.cost,
        itemNumber: r.slip.itemNumber,
        description: r.slip.description,
      }));
    if (!send.length) return void toast.error("Tick what came.");
    start(async () => {
      const r = await runAction(() => receiveSlip(orderId, send, key));
      if (r.error) return void toast.error(r.error);
      toast.success(r.note ?? "Received.", { duration: 10_000 });
      setRows(null);
      setPics([]);
      router.refresh();
    });
  }

  const set = (i: number, patch: Partial<Pick<Row, "tick" | "qty" | "cost">>) => setRows((rs) => rs && rs.map((r, j) => (j === i ? ({ ...r, ...patch } as Row) : r)));
  const groups: { key: Row["group"]; title: string }[] = [
    { key: "order", title: "On the order" },
    { key: "new", title: "New to us" },
    { key: "item", title: "Not on the order" },
  ];

  return (
    <div className="space-y-3 text-base">
      {!rows && (
        <>
          <p className="muted text-sm">Up to five pictures of the packing slip or invoice. Only the pictures go to the Assistant; nothing about your customers.</p>
          <div className="flex flex-wrap gap-2">
            {pics.map((p, i) => (
              // eslint-disable-next-line @next/next/no-img-element -- a picture taken here, not a static asset
              <img key={i} src={p.url} alt={`Page ${i + 1}`} className="h-24 w-20 rounded border border-line object-cover" />
            ))}
          </div>
          <input ref={input} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => add(e.target.files)} />
          <div className="flex flex-wrap gap-2">
            {pics.length < 5 && (
              <button type="button" className="btn min-h-11" onClick={() => input.current?.click()}>
                <Camera size={16} aria-hidden /> {pics.length ? "Add a page" : "Take or choose a picture"}
              </button>
            )}
            {pics.length > 0 && (
              <button type="button" className="btn btn-primary min-h-11" disabled={pending} onClick={read}>
                {pending ? "Reading..." : `Read ${pics.length === 1 ? "it" : `the ${pics.length} pages`}`}
              </button>
            )}
          </div>
        </>
      )}
      {rows && (
        <div className="space-y-4">
          {groups.map((g) => {
            const list = rows.map((r, i) => [r, i] as const).filter(([r]) => r.group === g.key);
            if (!list.length) return null;
            return (
              <section key={g.key} className="space-y-2">
                <h3 className="font-semibold">{g.title}</h3>
                <ul className="divide-y divide-line rounded border border-line">
                  {list.map(([r, i]) => (
                    <li key={i} className="flex flex-wrap items-center gap-3 p-2">
                      <label className="flex min-h-11 flex-1 items-center gap-2">
                        <input type="checkbox" checked={r.tick} onChange={(e) => set(i, { tick: e.target.checked })} className="h-5 w-5" aria-label={`Receive ${r.slip.itemNumber ?? r.name}`} />
                        <span>
                          <span className="mono">{r.slip.itemNumber}</span> {r.name}
                          {r.group === "order" && (
                            <span className="muted block text-sm">
                              On the order {r.onOrder}, still to come {r.outstanding}; the slip says {r.slip.qty}
                            </span>
                          )}
                          {r.group === "new" && <span className="muted block text-sm">Tick to make it an item ({dollars(r.slip.unitCostTenThou) || "no cost shown"})</span>}
                        </span>
                      </label>
                      <div className="field">
                        <label htmlFor={`slip-qty-${i}`} className="label">
                          Came
                        </label>
                        <input id={`slip-qty-${i}`} className="input num w-20" inputMode="decimal" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} />
                      </div>
                      {r.group !== "new" && r.costChange != null && (
                        <label className="flex min-h-11 items-center gap-2 text-sm">
                          <input type="checkbox" checked={r.cost} disabled={!canCost} onChange={(e) => set(i, { cost: e.target.checked })} className="h-5 w-5" />
                          Cost {r.costChange > 0 ? "up" : "down"} {Math.abs(Math.round(r.costChange * 100))}% ({dollars(r.oldCostTenThou)} to {dollars(r.slip.unitCostTenThou)}): update it
                        </label>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn min-h-11" onClick={() => setRows(null)}>
              Start again
            </button>
            <button type="button" className="btn btn-primary min-h-11" disabled={pending} onClick={receive}>
              {pending ? "Receiving..." : "Receive these"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
