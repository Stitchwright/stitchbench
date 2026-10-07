// The quilt appraisal form's fields (shop-features-round-2-design.md 9.8), for a new appraisal and a draft. The usual
// ones first; materials, condition and the long description fold away.
import { PURPOSES } from "@/lib/appraisals-words";

export type AppraisalDraft = { title: string; widthIn: string; lengthIn: string; maker: string; made: string; techniques: string; materials: string; condition: string; description: string; value: string; purpose: string; appraiser: string; credential: string; fee: string };

export function AppraisalFields({ d, p, lockFee }: { d: AppraisalDraft; p: string; lockFee: boolean }) {
  const f = (name: keyof AppraisalDraft, label: string, o: { wide?: boolean; inputMode?: "decimal"; placeholder?: string; disabled?: boolean } = {}) => (
    <div className={`field ${o.wide ? "sm:col-span-2" : ""}`}>
      <label className="label" htmlFor={`${p}${name}`}>
        {label}
      </label>
      <input id={`${p}${name}`} name={name} className={`input ${o.inputMode ? "num" : ""}`} inputMode={o.inputMode} defaultValue={d[name]} placeholder={o.placeholder} disabled={o.disabled} />
    </div>
  );
  return (
    <>
      {f("title", "The quilt's name", { wide: true, placeholder: "Grandmother's Flower Garden" })}
      {f("widthIn", "Width (inches)", { inputMode: "decimal" })}
      {f("lengthIn", "Length (inches)", { inputMode: "decimal" })}
      {f("maker", "Made by", { placeholder: "Unknown, or her name" })}
      {f("made", "When it was made", { placeholder: "About 1930" })}
      {f("techniques", "Techniques", { wide: true, placeholder: "Hand pieced, hand quilted" })}
      {f("value", "Value ($)", { inputMode: "decimal" })}
      <div className="field">
        <label className="label" htmlFor={`${p}purpose`}>
          Value for
        </label>
        <select id={`${p}purpose`} name="purpose" className="select" defaultValue={d.purpose}>
          {Object.entries(PURPOSES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${p}photo`}>
          Photos of the quilt
        </label>
        <input id={`${p}photo`} name="photo" type="file" accept="image/jpeg,image/png,image/webp" multiple className="input" />
      </div>
      <details className="sm:col-span-2">
        <summary className="link cursor-pointer text-sm">Materials, condition, description, appraiser and fee</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {f("materials", "Materials", { wide: true, placeholder: "Cotton feed sacks, cotton batting" })}
          {f("condition", "Condition", { wide: true, placeholder: "Light fading, two small repairs" })}
          <div className="field sm:col-span-2">
            <label className="label" htmlFor={`${p}description`}>
              Description
            </label>
            <textarea id={`${p}description`} name="description" className="input" rows={4} defaultValue={d.description} />
          </div>
          {f("appraiser", "Appraiser")}
          {f("credential", "Her credential", { placeholder: "AQS Certified Appraiser" })}
          {f("fee", "Fee ($)", { inputMode: "decimal", disabled: lockFee })}
        </div>
      </details>
    </>
  );
}
