"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera } from "lucide-react";

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
        fd.set("file", blob, "photo.jpg");
        const r = await fetch("/api/photos", { method: "POST", body: fd });
        if (!r.ok) throw new Error((await r.text()) || "Upload failed.");
      }
      toast.success(files.length > 1 ? `${files.length} photos added` : "Photo added");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <>
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
      <label htmlFor={`photo-${machineId}`} className={`btn btn-sm cursor-pointer ${busy ? "opacity-60" : ""}`}>
        <Camera size={14} aria-hidden /> {busy ? "Uploading..." : "Add photo"}
      </label>
    </>
  );
}
