"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Tags } from "lucide-react";
import { tagFabric } from "@/actions/assistant";
import { runAction } from "@/components/action-form";
import { shrinkImage } from "@/components/photo-upload";

const toBase64 = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(new Error("Could not read that picture."));
    r.readAsDataURL(blob);
  });

/** One fabric: its swatch picture (fetched from this program, shrunk here to about 640 pixels) to the Assistant; the tags come back added to the fabric's own. */
async function tagOne(partId: string, photoId: string): Promise<{ tags?: string[]; error?: string }> {
  let data = "";
  try {
    const res = await fetch(`/api/parts/photo/${photoId}`);
    if (!res.ok) return { error: "The picture couldn't be opened." };
    const blob = await res.blob();
    data = await toBase64(await shrinkImage(new File([blob], "swatch", { type: blob.type || "image/jpeg" }), 640, 0.7));
  } catch {
    return { error: "The picture couldn't be read." };
  }
  const r = await runAction(() => tagFabric(partId, data, "image/jpeg"));
  if (r?.error) return { error: r.error };
  try {
    return { tags: (JSON.parse(r?.shown ?? "{}") as { tags?: string[] }).tags ?? [] };
  } catch {
    return { error: "The answer didn't come through." };
  }
}

/** "Tag from the picture" on a fabric's page: one call, on demand. */
export function TagOneButton({ partId, photoId, unavailable }: { partId: string; photoId: string; unavailable?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (unavailable) return <p className="muted text-xs">{unavailable}</p>;
  return (
    <div className="flex flex-wrap items-center gap-2" data-assistant-tag>
      <button
        type="button"
        className="btn btn-sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await tagOne(partId, photoId);
            if (r.error) return void toast.error(r.error);
            toast.success(`Tags: ${r.tags?.join(", ")}`);
            router.refresh();
          })
        }
      >
        <Tags size={14} aria-hidden /> {pending ? "Looking..." : "Tag from the picture"}
      </button>
      <span className="muted text-xs">Sends this swatch picture to the Assistant (through StitchHub); adds color and theme tags. Counts as one call.</span>
    </div>
  );
}

/** "Tag 20 fabrics": the next fabrics with a picture and no tags, after a confirm that says how many calls it uses. Stops at the first refusal (the allowance, the internet). */
export function TagBatch({ items, more, unavailable }: { items: { id: string; photoId: string }[]; more: number; unavailable?: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  if (unavailable) return <p className="muted text-xs">{unavailable}</p>;
  if (!items.length) return null;

  async function run() {
    setConfirming(false);
    setRunning(true);
    setDone(0);
    let ok = 0;
    for (const it of items) {
      const r = await tagOne(it.id, it.photoId);
      if (r.error) {
        toast.error(`${r.error} Stopped after ${ok} of ${items.length}.`);
        break;
      }
      ok++;
      setDone(ok);
    }
    setRunning(false);
    if (ok) toast.success(`Tagged ${ok} fabric${ok === 1 ? "" : "s"}.`);
    router.refresh();
  }

  return (
    <div className="card card-pad space-y-2 text-sm" data-assistant-tag-batch>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" disabled={running} onClick={() => setConfirming(true)}>
          <Tags size={14} aria-hidden /> Tag {items.length} fabric{items.length === 1 ? "" : "s"}
        </button>
        <span className="muted text-xs">
          {more > 0 ? `${items.length + more} fabrics have a picture and no tags; this does the first ${items.length}.` : "Fabrics with a picture and no color tags."} {running ? `Working... ${done} of ${items.length}` : ""}
        </span>
      </div>
      {confirming && (
        <div className="space-y-2 rounded border border-line p-2" role="alertdialog" aria-label="Confirm tagging">
          <p>
            This sends {items.length} swatch picture{items.length === 1 ? "" : "s"} to the Assistant (through StitchHub), one at a time, and uses {items.length} call{items.length === 1 ? "" : "s"} of this month&apos;s allowance. Tags are added to each
            fabric&apos;s own. Nothing else is sent.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void run()}>
              Tag them
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
