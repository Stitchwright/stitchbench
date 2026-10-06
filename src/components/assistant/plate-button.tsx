"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Camera } from "lucide-react";
import { readPlate } from "@/actions/assistant";
import { runAction } from "@/components/action-form";
import { shrinkImage } from "@/components/photo-upload";

type Plate = { brand: string | null; model: string | null; serial: string | null; machineType: string | null; sure: boolean };

/** Puts a value into one of the form's own fields (uncontrolled inputs, so the form sends it like typed text). */
function put(id: string, value: string | null) {
  if (!value) return false;
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (!el) return false;
  if (el instanceof HTMLSelectElement) {
    const opt = [...el.options].find((o) => o.value.toLowerCase() === value.toLowerCase() || o.text.toLowerCase() === value.toLowerCase());
    if (!opt) return false;
    el.value = opt.value;
  } else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(new Error("Could not read that photo."));
    r.readAsDataURL(blob);
  });

/**
 * "Read the plate" beside Brand / Model / Serial at check-in (ai-assistant-scope.md 1.3). One photo of the rating plate:
 * shrunk in the browser, shown to the person ("this photo goes to the Assistant"), then sent. The answer fills the
 * fields and is only a suggestion until the form is saved; a yellow "Check these" note shows when it was guessing.
 * `unavailable` replaces the button with the reason (no internet).
 */
export function PlateButton({ unavailable }: { unavailable?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [check, setCheck] = useState<string | null>(null);

  if (unavailable) return <p className="muted text-xs sm:col-span-2">{unavailable}</p>;

  async function pick(file: File | undefined) {
    if (!file) return;
    try {
      // Small enough for the hub (about 150 KB): a plate is text on metal, 1280 pixels is plenty.
      const blob = await shrinkImage(file, 1280, 0.7);
      setPhoto({ blob, url: URL.createObjectURL(blob) });
      setCheck(null);
    } catch {
      toast.error("Couldn't open that photo. Try another.");
    }
  }

  function send() {
    if (!photo) return;
    const p = photo;
    start(async () => {
      const data = await toBase64(p.blob).catch(() => "");
      const r = await runAction(() => readPlate(data, "image/jpeg"));
      if (r?.error) {
        toast.error(r.error);
        return;
      }
      let answer: { plate: Plate } | null = null;
      try {
        answer = r?.shown ? (JSON.parse(r.shown) as { plate: Plate }) : null;
      } catch {
        answer = null;
      }
      if (!answer) {
        toast.error("The Assistant couldn't read that plate. Type it in, or try another photo.");
        return;
      }
      const pl = answer.plate;
      const filled = [put("brand", pl.brand), put("model", pl.model), put("serial", pl.serial), put("machineType", pl.machineType)].filter(Boolean).length;
      setPhoto(null);
      URL.revokeObjectURL(p.url);
      if (!pl.sure) setCheck("The photo wasn't clear enough to be sure. Compare brand, model and serial with the plate before you save.");
      else setCheck(null);
      if (filled) toast.success(pl.sure ? "Filled in from the plate. Press Save to keep it." : "Filled in, but check them against the plate.");
      else toast.error("Nothing could be read from that photo.");
    });
  }

  return (
    <div className="space-y-2 sm:col-span-2" data-assistant-plate>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => input.current?.click()}>
          <Camera size={14} aria-hidden /> Read the plate
        </button>
        <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Photo of the rating plate" onChange={(e) => void pick(e.target.files?.[0])} />
        <span className="muted text-xs">A photo of the rating plate fills in brand, model and serial.</span>
      </div>
      {photo && (
        <div className="flex flex-wrap items-center gap-3 rounded border border-line p-2 text-xs">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.url} alt="The photo to read" className="h-20 w-28 rounded border border-line object-cover" />
          <div className="space-y-1">
            <p>This photo goes to the Assistant (through StitchHub) to be read. Nothing else is sent.</p>
            <div className="flex gap-2">
              <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={send}>
                {pending ? "Reading..." : "Read it"}
              </button>
              <button type="button" className="btn btn-sm" disabled={pending} onClick={() => setPhoto(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {check && (
        <p className="flex flex-wrap items-center gap-2 rounded border border-line bg-surface-2 p-2 text-xs" role="status">
          <span className="pill tone-wait">Check these</span>
          {check}
        </p>
      )}
    </div>
  );
}
