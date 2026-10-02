// Add or fix a cross-reference entry. Numbers, fits and where-to-buy are one per line.
import { ActionForm, Submit } from "@/components/action-form";
import { saveCrossRef } from "@/actions/xref";
import { fitsText, numbersText, sourcesText, type XFit, type XNumber, type XSource } from "@/lib/parts";
import { VAC_SUPPLY_CATEGORIES } from "@/lib/constants";

type X = {
  id: string;
  name: string;
  kind: string;
  category: string | null;
  specs: string | null;
  notes: string | null;
  numbers: unknown;
  fits: unknown;
  sources: unknown;
  updatedAt: Date;
};

export function XrefForm({ x, defaults }: { x?: X; defaults?: { name?: string; kind?: string; category?: string; numbers?: string; fits?: string } }) {
  const id = x?.id ?? "new";
  return (
    <ActionForm action={saveCrossRef.bind(null, x?.id ?? null)} success={x ? "Saved for every shop" : undefined} className="space-y-3">
      {/* The version shown: the hub refuses the save when someone changed the entry since. */}
      {x && <input type="hidden" name="baseUpdatedAt" value={x.updatedAt.toISOString()} />}
      <div className="grid-form">
        <div className="field">
          <label htmlFor={`xn-${id}`} className="label">
            Name
          </label>
          <input id={`xn-${id}`} name="name" required defaultValue={x?.name ?? defaults?.name} className="input" placeholder="Needle plate screw" />
        </div>
        <div className="field">
          <label htmlFor={`xk-${id}`} className="label">
            Type
          </label>
          <select id={`xk-${id}`} name="kind" defaultValue={x?.kind ?? defaults?.kind ?? "PART"} className="select">
            <option value="PART">Part</option>
            <option value="ACCESSORY">Accessory</option>
            <option value="SUPPLY">Supply</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`xc-${id}`} className="label">
            Category
          </label>
          <input id={`xc-${id}`} name="category" list={`xcl-${id}`} defaultValue={x?.category ?? defaults?.category ?? ""} className="input" placeholder="Screw, Presser foot, Bobbin case..." />
          {/* The finder reads these three spellings exactly (modules-design.md 10.b). */}
          <datalist id={`xcl-${id}`}>
            {VAC_SUPPLY_CATEGORIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor={`xs-${id}`} className="label">
            Specs
          </label>
          <input id={`xs-${id}`} name="specs" defaultValue={x?.specs ?? ""} className="input" placeholder="M3 x 6 mm pan head" />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`xnum-${id}`} className="label">
          Part numbers, one per line: Brand, number
        </label>
        <textarea
          id={`xnum-${id}`}
          name="numbers"
          rows={3}
          defaultValue={x ? numbersText(x.numbers as XNumber[]) : defaults?.numbers}
          className="textarea mono text-sm"
          placeholder={"Brother, XA1234-001\nBaby Lock, XA1234-001"}
          aria-describedby={`xnum-hint-${id}`}
        />
        <p id={`xnum-hint-${id}`} className="muted text-xs">
          Leave the numbers blank for a part the maker gave none, and list the models it fits below.
        </p>
      </div>
      <div className="field">
        <label htmlFor={`xfit-${id}`} className="label">
          Fits, one per line: Brand, model (new lines are marked &ldquo;fitted by a tech&rdquo;)
        </label>
        <textarea
          id={`xfit-${id}`}
          name="fits"
          rows={4}
          defaultValue={x ? fitsText(x.fits as XFit[]) : defaults?.fits}
          className="textarea text-sm"
          placeholder={"Brother, PE770\nBaby Lock, BMP8"}
        />
      </div>
      <div className="field">
        <label htmlFor={`xsrc-${id}`} className="label">
          Where to buy, one per line: Vendor, link, price
        </label>
        <textarea
          id={`xsrc-${id}`}
          name="sources"
          rows={2}
          defaultValue={x ? sourcesText(x.sources as XSource[]) : ""}
          className="textarea text-sm"
          placeholder="Sewing Parts Online, https://..., 4.95"
          aria-describedby={`xsrc-hint-${id}`}
        />
        <p id={`xsrc-hint-${id}`} className="muted text-xs">
          A 3D printed version: put &ldquo;3D print file&rdquo; as the vendor and the link to the design (no price needed).
        </p>
      </div>
      <div className="grid-form">
        <div className="field">
          <label htmlFor={`xno-${id}`} className="label">
            Notes
          </label>
          <input id={`xno-${id}`} name="notes" defaultValue={x?.notes ?? ""} className="input" />
        </div>
        <div className="field">
          <label htmlFor={`xnote-${id}`} className="label">
            Note for the history (optional)
          </label>
          <input id={`xnote-${id}`} name="note" className="input" placeholder="e.g. checked it fits the PE800 too" />
        </div>
      </div>
      <Submit>{x ? "Save for everyone" : "Add to the cross-reference"}</Submit>
    </ActionForm>
  );
}
