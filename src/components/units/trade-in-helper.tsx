"use client";
// The trade-in helper on the register's trade-in step (shop-features-round-2-design.md 5.4): "What is it worth?" (the
// shop's own past sales of used units of the model, else the brand and kind, and the rule: expected price less 30%)
// with one tap to use the number, and, with the Assistant, up to four condition photos and "Draft a condition note" for
// staff to change. The credit is always hers to set; the note stays with the machine, never on a receipt.
import { useState, useTransition } from "react";
import { Camera, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { draftTradeInNote } from "@/actions/assistant";
import { tradeInValue } from "@/actions/units";
import { runAction } from "@/components/action-form";
import { money } from "@/lib/format";
import type { TradeInEstimate } from "@/lib/units/trade-in-value";

const MAX_PHOTOS = 4;

/** Up to four photos side by side in one JPEG (the hub takes one picture a call), each cell at most 512 pixels. */
async function collage(files: File[]): Promise<string> {
  const cell = 512;
  const bitmaps = await Promise.all(files.slice(0, MAX_PHOTOS).map((f) => createImageBitmap(f)));
  const cols = bitmaps.length === 1 ? 1 : 2;
  const rows = Math.ceil(bitmaps.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  bitmaps.forEach((b, i) => {
    const s = Math.min(cell / b.width, cell / b.height);
    const w = b.width * s;
    const h = b.height * s;
    g.drawImage(b, (i % cols) * cell + (cell - w) / 2, Math.floor(i / cols) * cell + (cell - h) / 2, w, h);
    b.close();
  });
  // Small enough for the hub (about 150 KB): lower the quality until it fits.
  for (const q of [0.7, 0.55, 0.4]) {
    const url = canvas.toDataURL("image/jpeg", q);
    const data = url.split(",")[1] ?? "";
    if (data.length <= 210_000) return data;
  }
  throw new Error("Those photos are too large. Take fewer, or closer.");
}

export function TradeInHelper({
  kind,
  brand,
  model,
  note,
  onNote,
  onCredit,
  noteEntry,
}: {
  kind: string | null;
  brand: string;
  model: string;
  note: string;
  onNote: (s: string) => void;
  onCredit: (dollars: string) => void;
  /** The Assistant's "Draft a condition note": absent when it can't be used here; `unavailable` when offline. */
  noteEntry?: { unavailable?: string } | null;
}) {
  const [pending, start] = useTransition();
  const [est, setEst] = useState<TradeInEstimate | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const ready = brand.trim() && model.trim();

  const worth = () =>
    start(async () => {
      const r = await runAction(() => tradeInValue(kind, brand, model));
      if (r?.error) toast.error(r.error);
      else if (r?.shown) setEst(JSON.parse(r.shown) as TradeInEstimate);
    });
  const draft = () =>
    start(async () => {
      let data = "";
      try {
        data = await collage(files);
      } catch (e) {
        return void toast.error(e instanceof Error ? e.message : "Couldn't open those photos.");
      }
      const r = await runAction(() => draftTradeInNote(data, "image/jpeg", files.length, kind, brand, model));
      if (r?.error) toast.error(r.error);
      else if (r?.shown) onNote((JSON.parse(r.shown) as { note: string }).note);
    });

  return (
    <div className="space-y-3 rounded border border-line p-3 sm:col-span-2" data-trade-in-helper>
      <div className="space-y-1 text-sm">
        <button type="button" className="btn btn-sm" disabled={pending || !ready} onClick={worth}>
          What is it worth?
        </button>
        {!ready && <p className="muted text-xs">Enter the brand and model first.</p>}
        {est &&
          (est.basis == null ? (
            <p data-trade-in-value>No used {brand} sold here yet to go by. Set the credit yourself.</p>
          ) : (
            <div data-trade-in-value className="space-y-1">
              <p>
                {est.count} used {est.basis === "model" ? `${brand} ${model}` : brand} sold here: about <strong>{money(est.medianCents)}</strong>
                {est.count > 1 ? ` (${money(est.lowCents)} to ${money(est.highCents)})` : ""}
                {est.medianDays != null ? `, in about ${est.medianDays} days` : ""}.
              </p>
              <p>
                Your rule, less {est.lessPct}%: start at <strong>{money(est.startCents)}</strong>.{" "}
                <button type="button" className="btn btn-sm" onClick={() => onCredit(((est.startCents ?? 0) / 100).toFixed(2))}>
                  Use {money(est.startCents)}
                </button>
              </p>
            </div>
          ))}
      </div>
      {noteEntry && (
        <div className="space-y-2 text-sm">
          {noteEntry.unavailable ? (
            <p className="muted text-xs">{noteEntry.unavailable}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="field">
                <label htmlFor="ti-photos" className="label">
                  <Camera size={14} aria-hidden className="inline" /> Condition photos (up to {MAX_PHOTOS})
                </label>
                <input
                  id="ti-photos"
                  type="file"
                  accept="image/*"
                  multiple
                  className="input"
                  onChange={(e) => {
                    const list = Array.from(e.currentTarget.files ?? []);
                    if (list.length > MAX_PHOTOS) toast.warning(`Only the first ${MAX_PHOTOS} photos are used.`);
                    setFiles(list.slice(0, MAX_PHOTOS));
                  }}
                />
              </div>
              <button type="button" className="btn btn-sm" disabled={pending || !files.length} onClick={draft}>
                <Sparkles size={14} aria-hidden /> {pending ? "Looking..." : "Draft a condition note"}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="field">
        <label htmlFor="ti-note" className="label">
          Condition note (staff only, never on a receipt)
        </label>
        <textarea id="ti-note" rows={2} maxLength={500} className="input" value={note} onChange={(e) => onNote(e.target.value)} placeholder="Light scratches on the bed, bobbin cover missing" />
      </div>
    </div>
  );
}
