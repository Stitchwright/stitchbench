"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Camera } from "lucide-react";
import { readBoltLabel } from "@/actions/assistant";
import { runAction } from "@/components/action-form";
import { shrinkImage } from "@/components/photo-upload";

type Label = { itemNumber: string | null; name: string | null; color: string | null; maker: string | null; collection: string | null; widthInches: number | null; content: string | null; sure: boolean };

const toBase64 = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(new Error("Could not read that photo."));
    r.readAsDataURL(blob);
  });

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Puts a value into one of the form's own fields by name (uncontrolled inputs, so the form sends it like typed text). */
function setField(form: HTMLFormElement, name: string, value: string | null, onlyIfEmpty = false) {
  if (!value) return false;
  const el = form.elements.namedItem(name) as Field | null;
  if (!el || el instanceof RadioNodeList) return false;
  if (onlyIfEmpty && el.value.trim()) return false;
  if (el instanceof HTMLSelectElement) {
    const opt = [...el.options].find((o) => o.value.toLowerCase() === value.toLowerCase());
    if (!opt) return false;
    el.value = opt.value;
  } else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function setFile(form: HTMLFormElement, name: string, blob: Blob) {
  const el = form.elements.namedItem(name) as HTMLInputElement | null;
  if (!el || el.type !== "file") return false;
  const dt = new DataTransfer();
  dt.items.add(new File([blob], "swatch.jpg", { type: "image/jpeg" }));
  el.files = dt.files;
  return true;
}

const clean = (s: string | null) => (s ? s.replace(/\s+/g, " ").trim() : null);

/**
 * "Photograph the bolt label" (fabric-smarts-design.md section 3): one photo, shrunk in the browser, shown to the person
 * ("this photo goes to the Assistant"), then sent. The answer prefills the form it sits in and is only a suggestion until
 * the form is saved. `mode` "collection" fills the maker and collection once and the next empty colorway row; "fabric"
 * fills a new fabric (number, description, maker, collection, notes with the width and content). With "Use the photo as
 * the swatch" ticked the picture goes into the form's picture field too. `unavailable` replaces the button with the
 * reason (no internet).
 */
export function BoltLabelButton({ mode, unavailable }: { mode: "collection" | "fabric"; unavailable?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [pending, start] = useTransition();
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [asSwatch, setAsSwatch] = useState(false);
  const [check, setCheck] = useState<string | null>(null);

  if (unavailable) return <p className="muted text-xs sm:col-span-2">{unavailable}</p>;

  async function pick(file: File | undefined) {
    if (!file) return;
    try {
      const blob = await shrinkImage(file, 1280, 0.7);
      setPhoto({ blob, url: URL.createObjectURL(blob) });
      setCheck(null);
    } catch {
      toast.error("Couldn't open that photo. Try another.");
    }
  }

  function fill(l: Label, blob: Blob) {
    const form = holder.current?.closest("form") as HTMLFormElement | null;
    if (!form) return 0;
    const color = clean(l.color);
    const extras = [l.widthInches ? `Width ${l.widthInches}"` : null, clean(l.content)].filter(Boolean).join(", ");
    let n = 0;
    if (mode === "collection") {
      if (setField(form, "maker", clean(l.maker), true)) n++;
      if (setField(form, "collection", clean(l.collection) ?? clean(l.name), true)) n++;
      let row = -1;
      for (let i = 0; i < 60; i++) {
        const num = form.elements.namedItem(`number.${i}`) as HTMLInputElement | null;
        if (!num) break;
        const col = form.elements.namedItem(`color.${i}`) as HTMLInputElement | null;
        if (!num.value.trim() && !col?.value.trim()) {
          row = i;
          break;
        }
      }
      if (row < 0) toast.error("Every row is in use. Add more rows, then read the label again.");
      else {
        if (setField(form, `number.${row}`, clean(l.itemNumber))) n++;
        if (setField(form, `color.${row}`, color ?? clean(l.name))) n++;
        if (asSwatch) setFile(form, `photo.${row}`, blob);
      }
    } else {
      if (setField(form, "partNumber", clean(l.itemNumber))) n++;
      setField(form, "kind", "FABRIC");
      setField(form, "unit", "yd");
      const desc = [clean(l.collection) ?? clean(l.name), color].filter(Boolean).join(" ");
      if (setField(form, "description", desc || null)) n++;
      if (setField(form, "brand", clean(l.maker))) n++;
      setField(form, "collection", clean(l.collection) ?? clean(l.name), true);
      setField(form, "notes", extras || null, true);
      if (asSwatch) setFile(form, "swatch", blob);
    }
    return n;
  }

  function send() {
    if (!photo) return;
    const p = photo;
    start(async () => {
      const data = await toBase64(p.blob).catch(() => "");
      const r = await runAction(() => readBoltLabel(data, "image/jpeg"));
      if (r?.error) return void toast.error(r.error);
      let label: Label | null = null;
      try {
        label = r?.shown ? (JSON.parse(r.shown) as { label: Label }).label : null;
      } catch {
        label = null;
      }
      if (!label) return void toast.error("The Assistant couldn't read that label. Type it in, or try another photo.");
      const filled = fill(label, p.blob);
      setPhoto(null);
      URL.revokeObjectURL(p.url);
      setCheck(label.sure ? null : "The photo wasn't clear enough to be sure. Compare the item number and color with the label before you save.");
      if (filled) toast.success(label.sure ? "Filled in from the label. Check it, then save." : "Filled in, but check it against the label.");
      else toast.error("Nothing could be read from that photo.");
    });
  }

  return (
    <div ref={holder} className="space-y-2 sm:col-span-2" data-assistant-label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => input.current?.click()}>
          <Camera size={14} aria-hidden /> Photograph the bolt label
        </button>
        <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Photo of the bolt label" onChange={(e) => void pick(e.target.files?.[0])} />
        {mode === "fabric" && <input type="file" name="swatch" className="hidden" aria-label="Swatch picture" tabIndex={-1} />}
        <span className="muted text-xs">{mode === "collection" ? "Fills the next empty colorway row." : "Fills in the number, color, maker, width and content."}</span>
      </div>
      {photo && (
        <div className="flex flex-wrap items-center gap-3 rounded border border-line p-2 text-xs">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.url} alt="The photo to read" className="h-20 w-28 rounded border border-line object-cover" />
          <div className="space-y-1">
            <p>This photo goes to the Assistant (through StitchHub) to be read. Nothing else is sent.</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="check" checked={asSwatch} onChange={(e) => setAsSwatch(e.target.checked)} /> Use the photo as the swatch picture too
            </label>
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
