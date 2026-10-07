import { costText } from "@/lib/format";
import { CONDITIONS, CONDITION_OPTION, ORIGINS, ORIGIN_OPTION } from "@/lib/part-labels";
import { kindChoiceOf, specsOf } from "@/lib/item-details";
import { ItemTypeFields } from "@/components/item-details-fields";

type P = {
  partNumber: string;
  ownNumber?: boolean;
  condition?: string;
  origin?: string;
  kind?: string;
  altNumbers?: string[];
  description: string;
  brand: string | null;
  fits: string | null;
  location: string | null;
  reorderAt: number;
  costCents: number | null;
  costTenThou?: number | null;
  priceCents: number | null;
  supplier: string | null;
  notes: string | null;
  unit?: string | null;
  wholesaleCents?: number | null;
  collection?: string | null;
  designer?: string | null;
  colorTags?: string[];
  boltYards?: number;
  inPrint?: string;
  itemType?: string | null;
  colorNumber?: string | null;
  colorName?: string | null;
  colorHex?: string | null;
  material?: string | null;
  specs?: unknown;
};

const c2d = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

/** `lockMoney`: what it costs, sells for and is offered to partner shops at is for an owner or admin to change. */
/** `fabric`: the fabric fields (collection, designer, color tags, bolt size, in print) show too: for companies that sell retail. */
export function PartFields({ part, withQty = false, defaultNumber, lockMoney = false, fabric = false }: { part?: P; withQty?: boolean; defaultNumber?: string; lockMoney?: boolean; fabric?: boolean }) {
  const locked = lockMoney ? { disabled: true, title: "Only an owner or admin can change this." } : {};
  return (
    <>
      {part?.ownNumber ? (
        // The shop's own number for an item the maker gave none: shown, never typed over.
        <div className="field">
          <div className="label">Shop number (the maker gives none)</div>
          <div className="mono py-2 text-sm">{part.partNumber}</div>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="partNumber" className="label">
            Part number
          </label>
          <input
            id="partNumber"
            name="partNumber"
            required={Boolean(part)}
            defaultValue={part?.partNumber ?? defaultNumber}
            className="input mono"
            aria-describedby={part ? undefined : "partNumber-hint"}
          />
          {!part && (
            <p id="partNumber-hint" className="muted text-xs">
              Leave it blank if the maker gave none: the shop gives the item its own number, which prints on labels and scans like any other.
            </p>
          )}
        </div>
      )}
      <div className="field">
        <label htmlFor="description" className="label">
          Description
        </label>
        <input id="description" name="description" required defaultValue={part?.description} className="input" />
      </div>
      {/* "What is it?" and the details of thread, filament and other supplies (shop-features-round-2-design.md 2.1, 6.2). */}
      <ItemTypeFields
        choice={part ? kindChoiceOf({ kind: part.kind ?? "PART", itemType: part.itemType }) : "PART"}
        craft={fabric}
        details={part ? { colorNumber: part.colorNumber ?? null, colorName: part.colorName ?? null, colorHex: part.colorHex ?? null, material: part.material ?? null, specs: specsOf(part.specs) } : undefined}
      />
      <div className="field">
        <label htmlFor="condition" className="label">
          Condition
        </label>
        <select id="condition" name="condition" defaultValue={part?.condition ?? "NEW"} className="select">
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {CONDITION_OPTION[c]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="origin" className="label">
          Made by
        </label>
        <select id="origin" name="origin" defaultValue={part?.origin ?? "GENUINE"} className="select">
          {ORIGINS.map((o) => (
            <option key={o} value={o}>
              {ORIGIN_OPTION[o]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="unit" className="label">
          Sold
        </label>
        <select id="unit" name="unit" defaultValue={part?.unit ?? ""} className="select">
          <option value="">Each</option>
          <option value="yd">By the yard (fabric, cut to 1/8 yd)</option>
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
      {fabric && (
        <>
          <div className="field">
            <label htmlFor="collection" className="label">
              Collection (fabric)
            </label>
            <input id="collection" name="collection" defaultValue={part?.collection ?? ""} className="input" />
          </div>
          <div className="field">
            <label htmlFor="designer" className="label">
              Designer (fabric)
            </label>
            <input id="designer" name="designer" defaultValue={part?.designer ?? ""} className="input" />
          </div>
          <div className="field">
            <label htmlFor="colorTags" className="label">
              Color tags (fabric)
            </label>
            <input id="colorTags" name="colorTags" defaultValue={part?.colorTags?.join(", ") ?? ""} className="input" placeholder="blue, floral, batik" />
          </div>
          <div className="field">
            <label htmlFor="boltYards" className="label">
              Yards on a full bolt (fabric)
            </label>
            <input id="boltYards" name="boltYards" inputMode="decimal" defaultValue={part?.boltYards ?? 15} className="input num" />
          </div>
          <div className="field">
            <label htmlFor="inPrint" className="label">
              Still in print? (fabric)
            </label>
            <select id="inPrint" name="inPrint" defaultValue={part?.inPrint ?? "UNKNOWN"} className="select">
              <option value="UNKNOWN">Don&apos;t know</option>
              <option value="YES">Yes</option>
              <option value="NO">No</option>
            </select>
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="fits" className="label">
          Fits (notes)
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
        <input id="cost" name="cost" inputMode="decimal" defaultValue={costText(part?.costCents, part?.costTenThou)} className="input num" {...locked} />
      </div>
      <div className="field">
        <label htmlFor="price" className="label">
          Price each ($, blank = cost + markup)
        </label>
        <input id="price" name="price" inputMode="decimal" defaultValue={c2d(part?.priceCents)} className="input num" {...locked} />
      </div>
      <div className="field">
        <label htmlFor="wholesale" className="label">
          Partner price ($, what partner shops pay once it is offered to them)
        </label>
        <input id="wholesale" name="wholesale" inputMode="decimal" defaultValue={c2d(part?.wholesaleCents)} className="input num" {...locked} />
      </div>
      <div className="field">
        <label htmlFor="reorderAt" className="label">
          Reorder when at or below
        </label>
        <input id="reorderAt" name="reorderAt" inputMode="decimal" defaultValue={part?.reorderAt ?? 1} className="input num" />
      </div>
      {withQty && (
        <div className="field">
          <label htmlFor="qtyOnHand" className="label">
            Quantity on hand
          </label>
          <input id="qtyOnHand" name="qtyOnHand" inputMode="decimal" defaultValue="0" className="input num" />
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
