// "Offer this manual to the repository" (docs/plans/manual-repository-design.md section 3): one library file, its own
// dialog, the statement ticked for that file. Nothing is offered unless a person submits this form for the file. A
// disclosure block rather than a modal, as the rest of the manual pages do ("Fix link", "Add a link").
import { Upload } from "lucide-react";
import { DOC_TYPES } from "@/lib/constants";
import { libraryDocId } from "@/lib/manual-downloads";
import { REVIEW_NOTE, STATEMENT, guessFields, type OfferGuess } from "@/lib/manual-offer-pure";
import { ActionForm, Submit } from "@/components/action-form";
import { offerManual } from "@/actions/manual-repository";

export const docWords = (d: string) => d.replace(/([a-z])([A-Z])/g, "$1 $2");

/** The fields of the dialog, with a first guess in each; the person reads and changes every one. Shared by the server and hosted dialogs' look. */
export function OfferForm({
  path,
  fileName,
  doc,
  categories,
}: {
  path: string;
  fileName: string;
  doc?: { category: string; brand: string; docType: string | null; title: string | null } | null;
  categories: string[];
}) {
  const g: OfferGuess = guessFields(fileName, doc);
  const k = libraryDocId(path);
  return (
    <details className="inline-block align-top">
      <summary className="btn btn-sm cursor-pointer">
        <Upload size={12} aria-hidden /> Offer to the repository
      </summary>
      <ActionForm action={offerManual} success="Offered" className="card card-pad mt-2 max-w-xl space-y-2">
        <input type="hidden" name="path" value={path} />
        <p className="text-sm">
          <strong className="break-all">{fileName}</strong> will be sent to the hub&apos;s manual repository for every shop to download. {REVIEW_NOTE}
        </p>
        <div className="grid-form">
          <div className="field">
            <label htmlFor={`oc-${k}`} className="label">
              Category
            </label>
            <input id={`oc-${k}`} name="category" list={`ocl-${k}`} defaultValue={g.category} required className="input" placeholder="Sewing, Embroidery, Serger, Vacuum" />
            <datalist id={`ocl-${k}`}>
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor={`ob-${k}`} className="label">
              Brand
            </label>
            <input id={`ob-${k}`} name="brand" defaultValue={g.brand} required className="input" />
          </div>
          <div className="field">
            <label htmlFor={`om-${k}`} className="label">
              Model(s), separated by commas
            </label>
            <input id={`om-${k}`} name="models" defaultValue={g.models} required className="input" />
          </div>
          <div className="field">
            <label htmlFor={`od-${k}`} className="label">
              Kind of manual
            </label>
            <select id={`od-${k}`} name="docType" defaultValue={g.docType ?? "ServiceManual"} className="select">
              {DOC_TYPES.map((d) => (
                <option key={d} value={d}>
                  {docWords(d)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`oy-${k}`} className="label">
              Year (optional)
            </label>
            <input id={`oy-${k}`} name="year" inputMode="numeric" defaultValue={g.year} className="input" placeholder="2017" />
          </div>
          <div className="field">
            <label htmlFor={`ol-${k}`} className="label">
              Language
            </label>
            <input id={`ol-${k}`} name="language" defaultValue={g.language ?? "English"} className="input" />
          </div>
          <div className="field sm:col-span-2">
            <label htmlFor={`ot-${k}`} className="label">
              Title (optional)
            </label>
            <input id={`ot-${k}`} name="title" defaultValue={g.title} className="input" />
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="accepted" required className="mt-1" />
          <span>{STATEMENT}</span>
        </label>
        <Submit className="btn btn-sm btn-primary">Offer this manual</Submit>
      </ActionForm>
    </details>
  );
}
