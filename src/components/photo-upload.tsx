"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera } from "lucide-react";
import { PHOTO_KINDS, PHOTO_KIND_LABEL } from "@/lib/constants";
import type { PhotoKind } from "@/generated/prisma/enums";

/** Shrink a photo in the browser so the database only stores ~200 KB per picture. */
export async function shrinkImage(file: File, maxSide = 1600, quality = 0.82): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not read that image."))), "image/jpeg", quality));
}

export function PhotoUpload({ machineId, ticketId }: { machineId: string; ticketId?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<PhotoKind>("CONDITION");
  const [caption, setCaption] = useState("");
  const router = useRouter();

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const blob = await shrinkImage(f);
        const fd = new FormData();
        fd.set("machineId", machineId);
        if (ticketId) fd.set("ticketId", ticketId);
        fd.set("kind", kind);
        if (caption.trim()) fd.set("caption", caption.trim());
        fd.set("file", blob, "photo.jpg");
        const r = await fetch("/api/photos", { method: "POST", body: fd });
        if (!r.ok) throw new Error((await r.text()) || "Upload failed.");
      }
      toast.success(files.length > 1 ? `${files.length} photos added` : "Photo added");
      setCaption("");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="field">
        <label htmlFor={`photo-kind-${machineId}`} className="label">
          Photo of
        </label>
        <select id={`photo-kind-${machineId}`} value={kind} onChange={(e) => setKind(e.target.value as PhotoKind)} className="select w-48">
          {PHOTO_KINDS.map((k) => (
            <option key={k} value={k}>
              {PHOTO_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <div className="field min-w-56 flex-1">
        <label htmlFor={`photo-caption-${machineId}`} className="label">
          Caption
        </label>
        <input
          id={`photo-caption-${machineId}`}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          className="input"
          placeholder={kind === "WIRING" ? "e.g. CN5 main motor plug, red wire to pin 1" : "Optional"}
        />
      </div>
      <input
        ref={input}
        id={`photo-${machineId}`}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="sr-only"
        onChange={(e) => upload(e.target.files)}
      />
      <label htmlFor={`photo-${machineId}`} className={`btn cursor-pointer ${busy ? "opacity-60" : ""}`}>
        <Camera size={14} aria-hidden /> {busy ? "Uploading..." : "Add photo"}
      </label>
    </div>
  );
}
