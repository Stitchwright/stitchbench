"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, X } from "lucide-react";
import { takeInMachine } from "@/actions/repair-jobs";
import { findCustomers, type CustomerHit } from "@/actions/register";
import { shrinkImage } from "@/components/photo-upload";
import { NotifyByField } from "@/components/notify-by-field";
import { PlateButton } from "@/components/assistant/plate-button";
import { ACCESSORIES, MACHINE_TYPES } from "@/lib/constants";

type Photo = { blob: Blob; url: string };

// The same caps takeInMachine enforces: checked here too, so hitting one never means starting the intake over.
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 2_600_000;

/**
 * Taking a customer's machine in at the sewing shop counter, for the partner repair shop.
 * notifyRequired: Marketing is on and email or texts are ready, so "How should we tell them" must be answered for a
 * customer who hasn't been asked yet. marketingHidden: the question isn't shown at all.
 */
export function IntakeForm({
  partners,
  notifyRequired = false,
  marketingHidden = true,
  plate = null,
}: {
  partners: { id: string; name: string }[];
  notifyRequired?: boolean;
  marketingHidden?: boolean;
  /** "Read the plate" (the Assistant): shown unless null; `unavailable` is the reason it can't work now. */
  plate?: { unavailable?: string } | null;
}) {
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const photoBytes = photos.reduce((n, p) => n + p.blob.size, 0);
  const tooBig = photoBytes > MAX_PHOTO_BYTES;

  return (
    <form
      className="space-y-6"
      // Submitted by hand (not a React form action) so what was typed stays when the server says what's missing.
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        if (tooBig || photos.length > MAX_PHOTOS) {
          toast.error("The photos are too large together. Remove a photo or two, then try again.");
          return;
        }
        const fd = new FormData(e.currentTarget);
        setBusy(true);
        try {
          fd.delete("photoPick");
          if (customer) fd.set("customerId", customer.id);
          photos.forEach((p, i) => fd.append("photo", p.blob, `photo${i}.jpg`));
          const r = await takeInMachine(fd);
          if ("error" in r) toast.error(r.error);
          else {
            toast.success("Taken in. Print the claim tag.");
            router.push(`/repairs/${r.id}`);
          }
        } catch {
          toast.error("That didn't save. Check the connection (and try fewer photos), then try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <section className="card card-pad grid-form">
        <div className="field">
          <label htmlFor="linkId" className="label">
            Repair shop
          </label>
          <select id="linkId" name="linkId" className="select" defaultValue={partners[0]?.id}>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div />
        {customer ? (
          <div className="field sm:col-span-2">
            <div className="label">Customer</div>
            <div className="flex items-center gap-2">
              <strong>{customer.name}</strong> <span className="muted">{customer.phone}</span>
              <button type="button" className="link text-xs" onClick={() => setCustomer(null)}>
                change
              </button>
            </div>
            {/* The search hit doesn't say whether they were asked how to be told, so while the answer is required it's
                asked here; otherwise an optional change (blank keeps what they said before). */}
            {!marketingHidden && (
              <div className="mt-3">{notifyRequired ? <NotifyByField required name="notifyBy" /> : <NotifyByField name="notifyBy" label="Change how we tell them (blank keeps it as it is)" />}</div>
            )}
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="customerName" className="label">
                Customer name
              </label>
              <input
                id="customerName"
                name="customerName"
                className="input"
                autoComplete="off"
                onChange={async (e) => setHits(await findCustomers(e.target.value))}
              />
              {hits.length > 0 && (
                <ul className="mt-1 divide-y divide-line rounded border border-line text-sm" aria-label="Existing customers">
                  {hits.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="w-full px-2 py-1 text-left hover:bg-surface-2"
                        onClick={() => {
                          setCustomer(c);
                          setHits([]);
                        }}
                      >
                        {c.name} <span className="muted">{c.phone}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="field">
              <label htmlFor="customerPhone" className="label">
                Phone
              </label>
              <input id="customerPhone" name="customerPhone" type="tel" className="input" />
            </div>
            <div className="field">
              <label htmlFor="customerEmail" className="label">
                Email (optional)
              </label>
              <input id="customerEmail" name="customerEmail" type="email" className="input" />
            </div>
            {!marketingHidden && <NotifyByField required={notifyRequired} name="notifyBy" />}
          </>
        )}
      </section>

      <section className="card card-pad grid-form">
        <div className="field">
          <label htmlFor="brand" className="label">
            Brand
          </label>
          <input id="brand" name="brand" required className="input" placeholder="Janome" />
        </div>
        <div className="field">
          <label htmlFor="model" className="label">
            Model
          </label>
          <input id="model" name="model" required className="input" placeholder="MC6700P" />
        </div>
        <div className="field">
          <label htmlFor="serial" className="label">
            Serial number
          </label>
          <input id="serial" name="serial" className="input mono" />
        </div>
        {plate && <PlateButton unavailable={plate.unavailable} />}
        <div className="field">
          <label htmlFor="machineType" className="label">
            Type
          </label>
          <select id="machineType" name="machineType" className="select" defaultValue="">
            <option value="">-</option>
            {MACHINE_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="field sm:col-span-2">
          <label htmlFor="problem" className="label">
            What&apos;s wrong (the customer&apos;s words)
          </label>
          <textarea id="problem" name="problem" rows={3} required className="textarea" />
        </div>
        <div className="field">
          <label htmlFor="serviceRequested" className="label">
            Service asked for
          </label>
          <input id="serviceRequested" name="serviceRequested" className="input" placeholder="Clean, oil and adjust" />
        </div>
        <div className="field">
          <label htmlFor="preApproved" className="label">
            Customer OK&apos;d up to ($, without a call)
          </label>
          <input id="preApproved" name="preApproved" inputMode="decimal" className="input num" />
        </div>
        <fieldset className="sm:col-span-2">
          <legend className="label">Came in with</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {ACCESSORIES.filter((a) => a !== "Other").map((a) => (
              <label key={a} className="flex items-center gap-1">
                <input type="checkbox" name="accessories" value={a} className="check" defaultChecked={a === "Power cord" || a === "Foot control"} /> {a}
              </label>
            ))}
          </div>
          <input name="accessoriesOther" aria-label="Other accessories" className="input mt-2" placeholder="Other: walking foot, 1/4 inch foot" />
        </fieldset>
        <div className="field sm:col-span-2">
          <label htmlFor="note" className="label">
            Note for the repair shop
          </label>
          <input id="note" name="note" className="input" />
        </div>
      </section>

      <section className="card card-pad space-y-2">
        <div className="label">Photos of its condition (scratches, cracks, what&apos;s missing)</div>
        <label className={`btn w-fit ${photos.length >= MAX_PHOTOS ? "opacity-60" : ""}`}>
          <Camera size={14} aria-hidden /> Add photos
          <input
            name="photoPick"
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="sr-only"
            disabled={photos.length >= MAX_PHOTOS}
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (photos.length + files.length > MAX_PHOTOS) toast.error(`${MAX_PHOTOS} photos at most: the extra ones were left out.`);
              const next: Photo[] = [];
              for (const f of files.slice(0, Math.max(0, MAX_PHOTOS - photos.length))) {
                try {
                  const blob = await shrinkImage(f, 1280, 0.8);
                  next.push({ blob, url: URL.createObjectURL(blob) });
                } catch {
                  toast.error(`Couldn't read ${f.name}.`);
                }
              }
              // Counted against the photos there now, not when the picker opened: two quick picks can't get past the cap.
              setPhotos((p) => {
                const keep = next.slice(0, Math.max(0, MAX_PHOTOS - p.length));
                next.slice(keep.length).forEach((x) => URL.revokeObjectURL(x.url));
                return [...p, ...keep];
              });
            }}
          />
        </label>
        {photos.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <div key={p.url} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt={`Intake photo ${i + 1}`} className="h-24 w-24 rounded border border-line object-cover" />
                  <button
                    type="button"
                    className="btn btn-sm absolute right-1 top-1"
                    aria-label={`Remove photo ${i + 1}`}
                    onClick={() => {
                      URL.revokeObjectURL(p.url);
                      setPhotos((ps) => ps.filter((x) => x.url !== p.url));
                    }}
                  >
                    <X size={12} aria-hidden />
                  </button>
                </div>
              ))}
            </div>
            <p className={`text-xs ${tooBig ? "text-[var(--bad)]" : "muted"}`}>
              {photos.length} of {MAX_PHOTOS} photos, {(photoBytes / 1e6).toFixed(1)} MB of {(MAX_PHOTO_BYTES / 1e6).toFixed(1)} MB together
              {tooBig ? ": remove a photo or two before taking it in." : "."}
            </p>
          </>
        )}
      </section>

      <button className="btn btn-primary" disabled={busy || !partners.length}>
        {busy ? "Saving..." : "Take it in and make the claim tag"}
      </button>
    </form>
  );
}
