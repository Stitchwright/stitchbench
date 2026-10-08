"use client";

// The register's "Match from a photo" (shop-features-round-2-design.md 9.10): a photo of her thread or fabric, shrunk
// here, goes to the Assistant; back come the main colors it read and, for each, the closest threads you stock, with
// where they are and Add. Offered as "Pull these and check against the swatch card": photos are never exact.
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Camera } from "lucide-react";
import { matchThreadPhoto } from "@/actions/assistant";
import { runAction } from "@/components/action-form";
import { shrinkImage } from "@/components/photo-upload";
import { money } from "@/lib/format";
import type { RegisterItem } from "@/lib/register-item";
import type { ThreadMatch } from "@/lib/thread-photo";

const toBase64 = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(new Error("Could not read that picture."));
    r.readAsDataURL(blob);
  });

export function ThreadPhotoMatch({ unavailable, returnMode, onAdd }: { unavailable?: string; returnMode: boolean; onAdd: (item: RegisterItem) => void }) {
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ matches: ThreadMatch[]; unmatched: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  if (returnMode) return null;

  async function picked(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const data = await toBase64(await shrinkImage(file, 640, 0.75));
      const r = await runAction(() => matchThreadPhoto(data, "image/jpeg"));
      if (r?.error) return void toast.error(r.error);
      setFound(JSON.parse(r?.shown ?? "{}"));
    } catch {
      toast.error("The photo couldn't be read. Take it again.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <>
      <button type="button" className="btn btn-sm" disabled={busy || !!unavailable} title={unavailable} onClick={() => input.current?.click()}>
        <Camera size={14} aria-hidden /> {busy ? "Looking..." : "Match from a photo"}
      </button>
      <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Photo of her thread or fabric" onChange={(e) => picked(e.target.files?.[0])} />
      {found && (
        <div className="card card-pad w-full space-y-3" aria-label="Threads to pull">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold">Pull these and check them against the swatch card</h3>
            <button type="button" className="link text-sm" onClick={() => setFound(null)}>
              Close
            </button>
          </div>
          {found.matches.map((m) => (
            <div key={m.color.hex} className="space-y-1">
              <p className="flex items-center gap-2 text-base">
                <span className="inline-block h-6 w-6 rounded border border-line" style={{ background: m.color.hex }} aria-hidden />
                {m.color.name ?? m.color.hex}
                {m.color.where ? <span className="muted text-sm">({m.color.where})</span> : null}
              </p>
              <ul className="grid gap-2 md:grid-cols-2">
                {m.hits.map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-2 rounded border border-line p-2">
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-8 w-8 rounded border border-line" style={{ background: h.colorHex ?? undefined }} aria-hidden />
                      <span>
                        <span className="block text-base">{h.details || h.description}</span>
                        <span className="muted block text-sm">
                          {h.closeness} · {h.qtyOnHand > 0 ? `${h.qtyOnHand} on hand${h.location ? `, ${h.location}` : ""}` : "none on the shelf"}
                        </span>
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="num">{money(h.priceCents)}</span>
                      <button type="button" className="btn btn-sm" disabled={h.qtyOnHand < 1} onClick={() => onAdd(h)}>
                        Add
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {found.unmatched > 0 && <p className="muted text-sm">{found.unmatched} of your threads have no swatch color, so they can&apos;t be matched from a photo.</p>}
        </div>
      )}
    </>
  );
}
