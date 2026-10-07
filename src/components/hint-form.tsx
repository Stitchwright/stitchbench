// "Offer a hint about this model": what a tech found on a machine, with the photos ticked, for every shop on the hub.
// The form starts with the brand and model only (HANDOFF item 9): the customer, the serial, the problem and the
// ticket's notes are never put in it, so nothing private leaves the shop unless someone types it (and the serial or
// the customer's name typed in is refused).
import { Lightbulb } from "lucide-react";
import { ActionForm, Submit } from "@/components/action-form";
import { sharePost } from "@/actions/shared";
import { PHOTO_KIND_LABEL } from "@/lib/constants";
import type { HintForm as HintFormData } from "@/lib/offer";

export function HintForm({ hint }: { hint: HintFormData }) {
  const model = `${hint.brand} ${hint.model}`;
  return (
    <details className="card card-pad">
      <summary className="flex cursor-pointer items-center gap-2 font-semibold">
        <Lightbulb size={16} aria-hidden /> Offer a hint about this model
      </summary>
      <p className="muted mt-2 text-sm">
        Goes to the {model} page for every shop on the community hub, with the photos you tick. Only what you write here is sent: nothing from the ticket, the customer or the serial number.
      </p>
      <ActionForm action={sharePost.bind(null, hint.machineId)} reset success="Hint offered to every shop" className="mt-3 space-y-3">
        <div className="grid-form">
          <div className="field">
            <label htmlFor="hint-kind" className="label">
              What is it
            </label>
            <select id="hint-kind" name="kind" className="select" defaultValue="GOTCHA">
              <option value="GOTCHA">Issue found</option>
              <option value="TIP">Fix / tip</option>
              <option value="FACT">Fact</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="hint-title" className="label">
              Title
            </label>
            <input id="hint-title" name="title" required maxLength={140} className="input" placeholder="e.g. Thread cutter motor connector backs out" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="hint-body" className="label">
            What you found and how you fixed it
          </label>
          <textarea id="hint-body" name="body" required rows={4} maxLength={5000} className="textarea" />
        </div>
        {hint.photos.length > 0 && (
          <fieldset>
            <legend className="label mb-2">Photos to include</legend>
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {hint.photos.map((p) => (
                <li key={p.id}>
                  <label className="block cursor-pointer">
                    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset */}
                    <img src={`/api/photos/${p.id}`} alt="" className="aspect-square w-full rounded border border-line object-cover" loading="lazy" />
                    <span className="mt-1 flex items-start gap-1 text-xs">
                      <input type="checkbox" name="photoIds" value={p.id} className="check mt-0.5" />
                      <span>{p.caption || PHOTO_KIND_LABEL[p.kind]}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <Submit>Offer the hint</Submit>
      </ActionForm>
    </details>
  );
}
