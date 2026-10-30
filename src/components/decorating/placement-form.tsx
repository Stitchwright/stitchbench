"use client";

// "Add a decoration" on a decorating order: embroidery (a design file read for its stitch count, or the count typed) or screen print
// (the number of inks, an underbase for a dark garment, whether the screens have to be made). One form, the fields that
// apply to the method chosen; the server checks everything again.
import { useState } from "react";
import { ActionForm, Submit } from "@/components/action-form";
import { addDecorPlacement } from "@/actions/decorating";
import { PLACEMENTS } from "@/lib/decor-math";

export function PlacementForm({ orderId }: { orderId: string }) {
  const [method, setMethod] = useState<"EMBROIDERY" | "SCREEN_PRINT">("EMBROIDERY");
  const screen = method === "SCREEN_PRINT";
  return (
    <ActionForm action={addDecorPlacement.bind(null, orderId)} reset className="mt-2 grid gap-3 sm:grid-cols-2">
      <div className="field">
        <label className="label" htmlFor="dpl-method">
          How it is decorated
        </label>
        <select id="dpl-method" name="method" className="select" value={method} onChange={(e) => setMethod(e.target.value as "EMBROIDERY" | "SCREEN_PRINT")}>
          <option value="EMBROIDERY">Embroidery</option>
          <option value="SCREEN_PRINT">Screen print</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="dpl-loc">
          Where it goes
        </label>
        <input id="dpl-loc" name="location" list="decor-places" className="input" required maxLength={40} placeholder="Left chest" />
        <datalist id="decor-places">
          {PLACEMENTS.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
      <div className="field sm:col-span-2">
        <label className="label" htmlFor="dpl-file">
          {screen ? "The art (kept with the order for repeat orders)" : "The design file (a DST is read for its stitch count)"}
        </label>
        <input id="dpl-file" name="file" type="file" className="input" accept=".dst,.pes,.jef,.exp,.vp3,.xxx,.u01,.hus,.pec,.sew,.shv,.csd,.pcs,.tbf,.emb,.ofm,.zip,.png,.jpg,.jpeg,.pdf,.ai,.eps,.svg,.psd" />
        <p className="muted text-sm">10 MB at most.</p>
      </div>
      {screen ? (
        <>
          <div className="field">
            <label className="label" htmlFor="dpl-col">
              Colours in the print (not counting an underbase)
            </label>
            <input id="dpl-col" name="colors" inputMode="numeric" className="input num w-24" defaultValue="1" required />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-base">
            <input type="checkbox" name="underbase" value="on" className="check" /> Dark garment: a white underbase (counts as one more colour)
          </label>
        </>
      ) : (
        <>
          <div className="field">
            <label className="label" htmlFor="dpl-st">
              Stitches (when there is no DST)
            </label>
            <input id="dpl-st" name="stitches" inputMode="numeric" className="input num w-32" />
          </div>
          <div className="field">
            <label className="label" htmlFor="dpl-col">
              Colours
            </label>
            <input id="dpl-col" name="colors" inputMode="numeric" className="input num w-24" defaultValue="1" />
          </div>
        </>
      )}
      <div className="field">
        <label className="label" htmlFor="dpl-w">
          Width (mm)
        </label>
        <input id="dpl-w" name="width" inputMode="decimal" className="input num w-28" />
      </div>
      <div className="field">
        <label className="label" htmlFor="dpl-h">
          Height (mm)
        </label>
        <input id="dpl-h" name="height" inputMode="decimal" className="input num w-28" />
      </div>
      <div className="field">
        <label className="label" htmlFor="dpl-price">
          Agreed price for each piece ($, empty to use your table)
        </label>
        <input id="dpl-price" name="price" inputMode="decimal" className="input num w-28" />
      </div>
      <div className="field">
        <label className="label" htmlFor="dpl-note">
          Note
        </label>
        <input id="dpl-note" name="note" className="input" maxLength={300} placeholder={screen ? "Ink colours, like PMS 186 red and white" : ""} />
      </div>
      <label className="flex min-h-11 items-center gap-2 text-base sm:col-span-2">
        <input type="checkbox" name="newDesign" value="on" className="check" />
        {screen ? "The screens have to be made for this order (charge a screen for each colour)" : "We digitized this design for this order (charge the digitizing fee)"}
      </label>
      <div className="sm:col-span-2">
        <Submit className="btn">Add the decoration</Submit>
      </div>
    </ActionForm>
  );
}
