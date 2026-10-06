"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { runAction } from "@/components/action-form";
import { shrinkImage } from "@/components/photo-upload";
import { addCollection } from "@/actions/fabric";

const START_ROWS = 8;
const MORE_ROWS = 6;
const MAX_ROWS = 60;

/** "Add a collection": the maker, collection and designer once, then a row per colorway (number, color, yards, price, photo). */
export function CollectionForm() {
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [rows, setRows] = useState(START_ROWS);
  const [pending, start] = useTransition();
  return (
    <form
      ref={ref}
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        const form = e.currentTarget;
        start(async () => {
          const fd = new FormData(form);
          try {
            // A swatch is shrunk here first, so a dozen of them stay well under the upload limit.
            for (let i = 0; i < MAX_ROWS; i++) {
              const f = fd.get(`photo.${i}`);
              if (f instanceof File && f.size > 0) fd.set(`photo.${i}`, await shrinkImage(f, 800, 0.8), "swatch.jpg");
              else fd.delete(`photo.${i}`);
            }
          } catch {
            toast.error("One of the pictures couldn't be read. Use a JPEG, PNG or WebP photo.");
            return;
          }
          const r = await runAction(() => addCollection(fd));
          if (r?.error) return void toast.error(r.error);
          toast.success(r?.note ?? "Collection added");
          router.push("/fabric");
          router.refresh();
        });
      }}
    >
      <div className="grid-form">
        <div className="field">
          <label htmlFor="maker" className="label">
            Maker
          </label>
          <input id="maker" name="maker" required className="input" placeholder="Moda, Riley Blake..." />
        </div>
        <div className="field">
          <label htmlFor="collection" className="label">
            Collection
          </label>
          <input id="collection" name="collection" required className="input" />
        </div>
        <div className="field">
          <label htmlFor="designer" className="label">
            Designer
          </label>
          <input id="designer" name="designer" className="input" />
        </div>
        <div className="field">
          <label htmlFor="supplier" className="label">
            Bought from
          </label>
          <input id="supplier" name="supplier" className="input" placeholder="Distributor or rep" />
        </div>
        <div className="field">
          <label htmlFor="inPrint" className="label">
            Still in print?
          </label>
          <select id="inPrint" name="inPrint" defaultValue="UNKNOWN" className="select">
            <option value="UNKNOWN">Don&apos;t know</option>
            <option value="YES">Yes</option>
            <option value="NO">No</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="boltYards" className="label">
            Yards on a full bolt
          </label>
          <input id="boltYards" name="boltYards" inputMode="decimal" defaultValue="15" className="input num" />
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="label">Colorways</legend>
        <div className="muted hidden gap-2 text-xs sm:grid sm:grid-cols-12" aria-hidden="true">
          <span className="sm:col-span-3">Item number</span>
          <span className="sm:col-span-3">Color</span>
          <span className="sm:col-span-2">Yards received</span>
          <span className="sm:col-span-2">Price per yd ($)</span>
          <span className="sm:col-span-2">Picture</span>
        </div>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 rounded border border-line p-2 sm:grid-cols-12 sm:border-0 sm:p-0">
            <input name={`number.${i}`} aria-label={`Row ${i + 1} item number`} placeholder="Item number" className="input mono col-span-2 sm:col-span-3" />
            <input name={`color.${i}`} aria-label={`Row ${i + 1} color`} placeholder="Color" className="input col-span-2 sm:col-span-3" />
            <input name={`yards.${i}`} aria-label={`Row ${i + 1} yards received`} inputMode="decimal" placeholder="Yards" className="input num sm:col-span-2" />
            <input name={`price.${i}`} aria-label={`Row ${i + 1} price per yard`} inputMode="decimal" placeholder="Price" className="input num sm:col-span-2" />
            <input name={`photo.${i}`} type="file" accept="image/jpeg,image/png,image/webp" aria-label={`Row ${i + 1} picture`} className="col-span-2 min-w-0 text-xs" />
          </div>
        ))}
        {rows < MAX_ROWS && (
          <button type="button" className="btn btn-sm" onClick={() => setRows((n) => Math.min(MAX_ROWS, n + MORE_ROWS))}>
            Add {MORE_ROWS} more rows
          </button>
        )}
      </fieldset>
      <p className="muted text-sm">Blank rows are skipped. Each colorway becomes a fabric sold by the yard; the yards received are recorded as a receipt. Nothing is added if any row has a problem.</p>
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Adding..." : "Add the collection"}
      </button>
    </form>
  );
}
