"use client";

import { useRef, useTransition } from "react";
import { toast } from "sonner";
import { createListing } from "@/actions/market";
import { shrinkImage } from "@/components/photo-upload";
import { ORIGINS, ORIGIN_OPTION } from "@/lib/part-labels";

type Defaults = {
  title?: string | null;
  partNumber?: string | null;
  brand?: string | null;
  fits?: string | null;
  kind?: string | null;
  condition?: string | null;
  origin?: string | null;
  priceCents?: number | null;
  qty?: number | null;
};

const d2 = (c?: number | null) => (c == null ? "" : (c / 100).toFixed(2));

/** Put a part or accessory up for sale to other shops on the community hub. Photos are shrunk before upload. */
export function ListingForm({ defaults = {} }: { defaults?: Defaults }) {
  const form = useRef<HTMLFormElement>(null);
  // One id for this form's listing: pressed again after an answer got lost, it's the same listing on the hub.
  const clientId = useRef<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    clientId.current ??= `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    fd.set("clientId", clientId.current);
    start(async () => {
      try {
        const files = fd.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
        fd.delete("photos");
        for (const f of files.slice(0, 8)) fd.append("photos", new File([await shrinkImage(f)], "photo.jpg", { type: "image/jpeg" }));
        const r = await createListing(fd);
        if (r?.error) toast.error(r.error);
      } catch (err) {
        // A successful listing redirects to its page, which surfaces here as a navigation, not an error.
        if (!(err instanceof Error && /NEXT_REDIRECT/.test(err.message))) toast.error(err instanceof Error ? err.message : "Couldn't list it.");
        else throw err;
      }
    });
  }

  return (
    <form ref={form} onSubmit={submit} className="space-y-3">
      <div className="grid-form">
        <div className="field sm:col-span-2">
          <label htmlFor="ls-title" className="label">
            Title
          </label>
          <input id="ls-title" name="title" required maxLength={160} defaultValue={defaults.title ?? ""} className="input" placeholder="Brother PR bobbin case, new" />
        </div>
        <div className="field">
          <label htmlFor="ls-kind" className="label">
            Type
          </label>
          <select id="ls-kind" name="kind" defaultValue={defaults.kind ?? "PART"} className="select">
            <option value="PART">Part</option>
            <option value="ACCESSORY">Accessory</option>
            <option value="SUPPLY">Supply</option>
            <option value="NOTION">Notion</option>
            <option value="FABRIC">Fabric</option>
            <option value="THREAD">Thread</option>
            <option value="PATTERN">Pattern / book</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ls-cond" className="label">
            Condition
          </label>
          <select id="ls-cond" name="condition" defaultValue={defaults.condition ?? "NEW"} className="select">
            <option value="NEW">New</option>
            <option value="USED">Used, good</option>
            <option value="REFURB">Refurbished</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ls-origin" className="label">
            Made by
          </label>
          <select id="ls-origin" name="origin" defaultValue={defaults.origin ?? "GENUINE"} className="select">
            {ORIGINS.map((o) => (
              <option key={o} value={o}>
                {ORIGIN_OPTION[o]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ls-pn" className="label">
            Part number
          </label>
          <input id="ls-pn" name="partNumber" defaultValue={defaults.partNumber ?? ""} className="input mono" />
        </div>
        <div className="field">
          <label htmlFor="ls-brand" className="label">
            Brand
          </label>
          <input id="ls-brand" name="brand" defaultValue={defaults.brand ?? ""} className="input" />
        </div>
        <div className="field sm:col-span-2">
          <label htmlFor="ls-fits" className="label">
            Fits
          </label>
          <input id="ls-fits" name="fits" defaultValue={defaults.fits ?? ""} className="input" placeholder="PR650, PR655, PR1000" />
        </div>
        <div className="field">
          <label htmlFor="ls-price" className="label">
            Price each ($)
          </label>
          <input id="ls-price" name="price" required inputMode="decimal" defaultValue={d2(defaults.priceCents)} className="input num" />
        </div>
        <div className="field">
          <label htmlFor="ls-qty" className="label">
            How many to sell
          </label>
          <input id="ls-qty" name="qty" required inputMode="numeric" defaultValue={defaults.qty ?? 1} className="input num" />
        </div>
        <div className="field">
          <label htmlFor="ls-ship" className="label">
            Shipping ($, blank = quote each order)
          </label>
          <input id="ls-ship" name="shipping" inputMode="decimal" className="input num" />
        </div>
        <div className="field">
          <label htmlFor="ls-from" className="label">
            Ships from
          </label>
          <input id="ls-from" name="shipsFrom" className="input" placeholder="City, state" />
        </div>
        <div className="field sm:col-span-2">
          <label htmlFor="ls-snote" className="label">
            Shipping note (optional)
          </label>
          <input id="ls-snote" name="shippingNote" className="input" placeholder="USPS Ground Advantage, ships in 1-2 days" />
        </div>
        <div className="field sm:col-span-2">
          <label htmlFor="ls-desc" className="label">
            Description
          </label>
          <textarea id="ls-desc" name="description" rows={3} maxLength={4000} className="textarea" placeholder="What it is, what it came off, anything the buyer should know" />
        </div>
        <div className="field sm:col-span-2">
          <label htmlFor="ls-photos" className="label">
            Photos (up to 8)
          </label>
          <input id="ls-photos" name="photos" type="file" accept="image/*" multiple className="input" />
        </div>
      </div>
      <button className="btn btn-primary" disabled={pending}>
        {pending ? "Listing..." : "List it for sale"}
      </button>
    </form>
  );
}
