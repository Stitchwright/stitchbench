// "Share with other techs": post what you found on this machine, with photos, for every shop on StitchBench.
import { Share2 } from "lucide-react";
import { ActionForm, Submit } from "@/components/action-form";
import { sharePost } from "@/actions/shared";
import { PHOTO_KIND_LABEL } from "@/lib/constants";
import type { PhotoKind } from "@/generated/prisma/enums";

type Photo = { id: string; caption: string | null; kind: PhotoKind };

export function ShareForm({ machineId, model, photos, defaultBody }: { machineId: string; model: string; photos: Photo[]; defaultBody?: string }) {
  return (
    <details className="card card-pad">
      <summary className="flex cursor-pointer items-center gap-2 font-semibold">
        <Share2 size={16} aria-hidden /> Share with other techs
      </summary>
      <p className="muted mt-2 text-sm">
        Posts your notes and the photos you tick to the {model} page for every shop on StitchBench. The customer&apos;s name and the serial number are
        not shared, so leave them out of the notes too.
      </p>
      <ActionForm action={sharePost.bind(null, machineId)} reset success="Shared with every shop" className="mt-3 space-y-3">
        <div className="grid-form">
          <div className="field">
            <label htmlFor="share-kind" className="label">
              What is it
            </label>
            <select id="share-kind" name="kind" className="select" defaultValue="GOTCHA">
              <option value="GOTCHA">Issue found</option>
              <option value="TIP">Fix / tip</option>
              <option value="FACT">Fact</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="share-title" className="label">
              Title
            </label>
            <input id="share-title" name="title" required maxLength={140} className="input" placeholder="e.g. Thread cutter motor connector backs out" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="share-body" className="label">
            What you found and how you fixed it
          </label>
          <textarea id="share-body" name="body" required rows={4} maxLength={5000} className="textarea" defaultValue={defaultBody} />
        </div>
        {photos.length > 0 && (
          <fieldset>
            <legend className="label mb-2">Photos to include</legend>
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {photos.map((p) => (
                <li key={p.id}>
                  <label className="block cursor-pointer">
                    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset */}
                    <img src={`/api/photos/${p.id}`} alt="" className="aspect-square w-full rounded border border-line object-cover" loading="lazy" />
                    <span className="mt-1 flex items-start gap-1 text-xs">
                      <input type="checkbox" name="photoIds" value={p.id} defaultChecked={p.kind === "WIRING" || p.kind === "INSIDE" || p.kind === "PART"} className="check mt-0.5" />
                      <span>{p.caption || PHOTO_KIND_LABEL[p.kind]}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <Submit>Share</Submit>
      </ActionForm>
    </details>
  );
}
