import type { FieldDef } from "@/lib/equipment/types";

/** A kind's intake questions as form fields named `f:<key>` (ids `f-<key>`), inside a grid-form. */
export function IntakeFields({ defs, on, values = {}, required = [] }: { defs: FieldDef[]; on: "machine" | "ticket"; values?: Record<string, unknown>; required?: string[] }) {
  const mine = defs.filter((d) => d.on === on);
  if (!mine.length) return null;
  return (
    <>
      {mine.map((d) => {
        const id = `f-${d.key}`;
        const name = `f:${d.key}`;
        const v = values[d.key];
        const must = required.includes(d.key);
        if (d.type === "checkbox") {
          return (
            <label key={d.key} className="flex items-center gap-2 text-sm">
              <input id={id} name={name} type="checkbox" className="check" defaultChecked={v === true} /> {d.label}
            </label>
          );
        }
        return (
          <div key={d.key} className="field">
            <label htmlFor={id} className="label">
              {d.label}
            </label>
            {d.type === "select" ? (
              <select id={id} name={name} className="select" defaultValue={typeof v === "string" ? v : ""} required={must}>
                <option value="">-</option>
                {(d.options ?? []).map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  id={id}
                  name={name}
                  className={`input ${d.type === "number" ? "num" : ""}`}
                  inputMode={d.type === "number" ? "decimal" : undefined}
                  defaultValue={v == null ? "" : String(v)}
                  placeholder={d.placeholder}
                  required={must}
                  autoComplete="off"
                />
                {d.unit && <span className="muted text-sm">{d.unit}</span>}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
