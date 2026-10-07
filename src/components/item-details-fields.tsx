"use client";

// The item form's "What is it?" list and, under it, the details that type has (shop-features-round-2-design.md 2.1 and
// 6.2): a thread's color number, name, swatch, weight, fibre and spool; a filament's material, color, diameter, spool
// weight and finish; and so on. Only the chosen type's fields show; the server keeps only those (src/lib/item-details.ts).
import { useState } from "react";
import { ITEM_TYPES, KIND_CHOICES, parseKindChoice, type DetailKey, type Specs } from "@/lib/item-details";

export type DetailValues = { colorNumber: string | null; colorName: string | null; colorHex: string | null; material: string | null; specs: Specs };

/** `craft`: offer the cutter, laser and 3D printer supplies (shops with a counter). */
export function ItemTypeFields({ choice, details, craft }: { choice: string; details?: DetailValues; craft: boolean }) {
  const [value, setValue] = useState(choice);
  const [hex, setHex] = useState(details?.colorHex ?? "");
  let type = null as ReturnType<typeof parseKindChoice>["itemType"];
  try {
    type = parseKindChoice(value).itemType;
  } catch {
    type = null;
  }
  const choices = KIND_CHOICES.filter((c) => !c.craft || craft || c.value === choice);
  const initial = (k: DetailKey): string => {
    if (!details) return "";
    if (k === "colorNumber" || k === "colorName" || k === "material") return details[k] ?? "";
    if (k === "colorHex") return details.colorHex ?? "";
    return details.specs[k] ?? "";
  };
  return (
    <>
      <div className="field">
        <label htmlFor="kind" className="label">
          What is it?
        </label>
        <select id="kind" name="kind" value={value} onChange={(e) => setValue(e.currentTarget.value)} className="select">
          <optgroup label="Sewing and the shop">
            {choices
              .filter((c) => !c.craft)
              .map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
          </optgroup>
          {choices.some((c) => c.craft) && (
            <optgroup label="Cutters, lasers and 3D printers">
              {choices
                .filter((c) => c.craft)
                .map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
            </optgroup>
          )}
        </select>
      </div>
      {/* Tells the server this form carries the details (an older form that doesn't leaves them as they are). */}
      <input type="hidden" name="details" value="1" />
      {type && (
        <fieldset className="grid gap-3 rounded border border-line p-3 sm:col-span-2 sm:grid-cols-2">
          <legend className="px-1 text-base font-semibold">{ITEM_TYPES[type].label} details</legend>
          {ITEM_TYPES[type].fields.map((f) =>
            f.key === "colorHex" ? (
              <div key={`${type}-${f.key}`} className="field">
                <span className="label" id="hex-label">
                  {f.label}
                </span>
                <input type="hidden" name="colorHex" value={hex} />
                <div className="flex flex-wrap items-center gap-2">
                  <input type="color" aria-labelledby="hex-label" value={hex || "#ffffff"} onChange={(e) => setHex(e.currentTarget.value)} className="h-11 w-16 cursor-pointer rounded border border-line" />
                  <span className="text-sm">{hex ? hex : "No swatch yet: tap the square to pick one"}</span>
                  {hex && (
                    <button type="button" className="btn btn-sm" onClick={() => setHex("")}>
                      No swatch
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div key={`${type}-${f.key}`} className="field">
                <label htmlFor={`d-${f.key}`} className="label">
                  {f.label}
                </label>
                <input id={`d-${f.key}`} name={f.key} defaultValue={initial(f.key)} placeholder={f.placeholder} list={f.list ? `dl-${type}-${f.key}` : undefined} className="input" autoComplete="off" />
                {f.list && (
                  <datalist id={`dl-${type}-${f.key}`}>
                    {f.list.map((x) => (
                      <option key={x} value={x} />
                    ))}
                  </datalist>
                )}
              </div>
            ),
          )}
        </fieldset>
      )}
    </>
  );
}
