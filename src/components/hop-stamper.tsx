"use client";
// "Stamp a passport" (shop-features-round-2-design.md 4.6): the camera reads the passport's code (or a scanner, or it is
// typed), and a big green tick says "Stamp 4 of 10". No sign-up at the counter.
import { useState } from "react";
import { Camera, CameraOff, Check } from "lucide-react";
import { stampPassport } from "@/actions/hops";
import { beep, CAMERA_INSTEAD, useBarcodeCamera } from "@/components/barcode-camera";
import { InsecureNotice } from "@/components/secure-page";

type Shown = { ok: boolean; words: string; extra?: string };

export function HopStamper({ hopId }: { hopId: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  async function stamp(raw: string) {
    if (!raw.trim() || busy) return;
    setBusy(true);
    const r = await stampPassport(hopId, raw).catch(() => ({ error: "Couldn't stamp it: check the connection and try again." }));
    setBusy(false);
    if ("error" in r) {
      beep(false);
      setShown({ ok: false, words: r.error });
      return;
    }
    beep(true);
    setCode("");
    setShown({ ok: true, words: r.words, extra: [r.complete ? "Her passport is complete!" : "", r.shopper ? `Shared with you: ${r.shopper}` : ""].filter(Boolean).join(" ") });
  }
  const { video: camVideo, on: camOn, page: camPage, start: camStart, stop: camStop } = useBarcodeCamera((c) => void stamp(c));
  return (
    <div className="card card-pad space-y-4">
      <h2 className="h2">Stamp a passport</h2>
      {shown && (
        <div className={`flex items-center gap-4 rounded border p-4 ${shown.ok ? "border-green-600" : "border-red-600"}`} role="status" aria-live="polite">
          {shown.ok && <Check size={56} className="text-green-700" aria-hidden />}
          <div>
            <p className="text-3xl font-semibold">{shown.words}</p>
            {shown.extra && <p className="text-base">{shown.extra}</p>}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary min-h-11 px-6 text-lg" onClick={() => (camOn ? camStop() : camStart())}>
          {camOn ? <CameraOff size={18} aria-hidden /> : <Camera size={18} aria-hidden />} {camOn ? "Stop the camera" : "Open the camera"}
        </button>
      </div>
      <InsecureNotice what="The camera" instead={CAMERA_INSTEAD} page={camPage} />
      <video ref={camVideo} className={camOn ? "w-full max-w-md rounded border border-line" : "hidden"} muted playsInline aria-label="Camera" />
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void stamp(code);
        }}
      >
        <div className="field">
          <label htmlFor="hop-code" className="label">
            Or type the code on her passport
          </label>
          <input id="hop-code" className="input mono text-lg" autoComplete="off" placeholder="HOP-7K2M-9QXD" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <button type="submit" className="btn min-h-11 text-base" disabled={busy || !code.trim()}>
          {busy ? "Stamping..." : "Stamp it"}
        </button>
      </form>
    </div>
  );
}
