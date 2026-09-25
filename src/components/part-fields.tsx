type P = {
  partNumber: string;
  kind?: string;
  altNumbers?: string[];
  description: string;
  brand: string | null;
  fits: string | null;
  location: string | null;
  reorderAt: number;
  costCents: number | null;
  priceCents: number | null;
  supplier: string | null;
  notes: string | null;
};

const c2d = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

export function PartFields({ part, withQty = false, defaultNumber }: { part?: P; withQty?: boolean; defaultNumber?: string }) {
  return (
    <>
      <div className="field">
        <label htmlFor="partNumber" className="label">
          Part number
        </label>
        <input id="partNumber" name="partNumber" required defaultValue={part?.partNumber ?? defaultNumber} className="input mono" />
      </div>
      <div className="field">
        <label htmlFor="description" className="label">
          Description
        </label>
        <input id="description" name="description" required defaultValue={part?.description} className="input" />
      </div>
      <div className="field">
        <label htmlFor="kind" className="label">
          Type
        </label>
        <select id="kind" name="kind" defaultValue={part?.kind ?? "PART"} className="select">
          <option value="PART">Part</option>
          <option value="ACCESSORY">Accessory (feet, hoops, extension tables...)</option>
          <option value="SUPPLY">Supply (needles, oil, bobbins, thread...)</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="altNumbers" className="label">
          Other part numbers (other makers, generic)
        </label>
        <input id="altNumbers" name="altNumbers" defaultValue={part?.altNumbers?.join(", ") ?? ""} className="input mono" placeholder="XA1234-001, 822020503" />
      </div>
      <div className="field">
        <label htmlFor="brand" className="label">
          Brand
        </label>
        <input id="brand" name="brand" defaultValue={part?.brand ?? ""} className="input" />
      </div>
      <div className="field">
        <label htmlFor="fits" className="label">
          Fits models
        </label>
        <input id="fits" name="fits" defaultValue={part?.fits ?? ""} className="input" placeholder="MC6700P, MC6600P" />
      </div>
      <div className="field">
        <label htmlFor="location" className="label">
          Bin / location
        </label>
        <input id="location" name="location" defaultValue={part?.location ?? ""} className="input" placeholder="Drawer B3" />
      </div>
      <div className="field">
        <label htmlFor="supplier" className="label">
          Supplier
        </label>
        <input id="supplier" name="supplier" defaultValue={part?.supplier ?? ""} className="input" />
      </div>
      <div className="field">
        <label htmlFor="cost" className="label">
          Cost each ($)
        </label>
        <input id="cost" name="cost" inputMode="decimal" defaultValue={c2d(part?.costCents)} className="input num" />
      </div>
      <div className="field">
        <label htmlFor="price" className="label">
          Price each ($, blank = cost + markup)
        </label>
        <input id="price" name="price" inputMode="decimal" defaultValue={c2d(part?.priceCents)} className="input num" />
      </div>
      <div className="field">
        <label htmlFor="reorderAt" className="label">
          Reorder when at or below
        </label>
        <input id="reorderAt" name="reorderAt" inputMode="numeric" defaultValue={part?.reorderAt ?? 1} className="input num" />
      </div>
      {withQty && (
        <div className="field">
          <label htmlFor="qtyOnHand" className="label">
            Quantity on hand
          </label>
          <input id="qtyOnHand" name="qtyOnHand" inputMode="numeric" defaultValue="0" className="input num" />
        </div>
      )}
      <div className="field sm:col-span-2">
        <label htmlFor="notes" className="label">
          Notes
        </label>
        <input id="notes" name="notes" defaultValue={part?.notes ?? ""} className="input" />
      </div>
    </>
  );
}
