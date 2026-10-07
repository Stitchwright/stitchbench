// Item details (shop-features-round-2-design.md 2.1 and 6.2, package item-details): what an item is beyond its kind
// (thread, filament, resin, cutter blade, mat, vinyl, laser material, die), with the maker's color number and name, a
// swatch color, the material and the specs that type has. Pure: no "server-only", no database, so the item form (client),
// the server actions, the register and the check scripts share one description. The lists are in src/lib/constants.ts.
import { UserError } from "@/lib/user-error";
import {
  BLADE_TYPES,
  FILAMENT_DIAMETERS,
  FILAMENT_FINISHES,
  FILAMENT_MATERIALS,
  FILAMENT_SPOOLS,
  LASER_MATERIALS,
  LASER_THICKNESSES,
  MAT_SIZES,
  MAT_TYPES,
  RESIN_TYPES,
  RESIN_VOLUMES,
  THREAD_FIBRES,
  THREAD_PUT_UPS,
  THREAD_WEIGHTS,
  VINYL_SIZES,
  VINYL_TYPES,
} from "@/lib/constants";

export const ITEM_TYPE_IDS = ["thread", "filament", "resin", "blade", "mat", "vinyl", "laser-material", "die"] as const;
export type ItemType = (typeof ITEM_TYPE_IDS)[number];
export const isItemType = (v: unknown): v is ItemType => typeof v === "string" && (ITEM_TYPE_IDS as readonly string[]).includes(v);

/** The columns (color number, name, swatch, material) and the specs keys (kept in Part.specs). */
export const SPEC_KEYS = ["weight", "putUp", "diameter", "spool", "finish", "volume", "size", "thickness", "shape"] as const;
export type SpecKey = (typeof SPEC_KEYS)[number];
export type DetailKey = "colorNumber" | "colorName" | "colorHex" | "material" | SpecKey;
export type Specs = Partial<Record<SpecKey, string>>;

export type FieldDef = { key: DetailKey; label: string; list?: readonly string[]; placeholder?: string };

type KindName = "THREAD" | "SUPPLY" | "ACCESSORY";

const COLOR: FieldDef[] = [
  { key: "colorName", label: "Color name", placeholder: "Navy" },
  { key: "colorHex", label: "Swatch color" },
];

/** Each type: its label, the item kind it files under, whether it is a craft supply (cutters, lasers, 3D printers), and its fields in form order. */
export const ITEM_TYPES: Record<ItemType, { label: string; kind: KindName; craft: boolean; fields: FieldDef[] }> = {
  thread: {
    label: "Thread",
    kind: "THREAD",
    craft: false,
    fields: [
      { key: "colorNumber", label: "Color number (the maker's)", placeholder: "0015" },
      ...COLOR,
      { key: "weight", label: "Weight", list: THREAD_WEIGHTS, placeholder: "40 wt" },
      { key: "material", label: "Fibre", list: THREAD_FIBRES },
      { key: "putUp", label: "Spool or cone", list: THREAD_PUT_UPS, placeholder: "1,000 m spool" },
    ],
  },
  filament: {
    label: "3D printer filament",
    kind: "SUPPLY",
    craft: true,
    fields: [
      { key: "material", label: "Material", list: FILAMENT_MATERIALS, placeholder: "PLA" },
      ...COLOR,
      { key: "colorNumber", label: "Color number (the maker's, if any)" },
      { key: "diameter", label: "Diameter", list: FILAMENT_DIAMETERS, placeholder: "1.75 mm" },
      { key: "spool", label: "Spool weight", list: FILAMENT_SPOOLS, placeholder: "1 kg" },
      { key: "finish", label: "Finish", list: FILAMENT_FINISHES },
    ],
  },
  resin: {
    label: "Resin (3D printing)",
    kind: "SUPPLY",
    craft: true,
    fields: [{ key: "material", label: "Type", list: RESIN_TYPES, placeholder: "Standard" }, ...COLOR, { key: "volume", label: "Bottle", list: RESIN_VOLUMES, placeholder: "1 l" }],
  },
  blade: {
    label: "Cutter blade",
    kind: "SUPPLY",
    craft: true,
    fields: [{ key: "material", label: "Type", list: BLADE_TYPES, placeholder: "Fine point" }],
  },
  mat: {
    label: "Cutting mat",
    kind: "SUPPLY",
    craft: true,
    fields: [{ key: "material", label: "Grip", list: MAT_TYPES, placeholder: "Standard grip" }, { key: "size", label: "Size", list: MAT_SIZES, placeholder: "12 x 12 in" }, ...COLOR],
  },
  vinyl: {
    label: "Vinyl",
    kind: "SUPPLY",
    craft: true,
    fields: [{ key: "material", label: "Type", list: VINYL_TYPES, placeholder: "Permanent" }, ...COLOR, { key: "colorNumber", label: "Color number (the maker's, if any)" }, { key: "size", label: "Size", list: VINYL_SIZES, placeholder: "12 x 12 in sheet" }],
  },
  "laser-material": {
    label: "Laser material (wood, acrylic...)",
    kind: "SUPPLY",
    craft: true,
    fields: [
      { key: "material", label: "Material", list: LASER_MATERIALS, placeholder: "Birch plywood" },
      { key: "thickness", label: "Thickness", list: LASER_THICKNESSES, placeholder: "3 mm" },
      { key: "size", label: "Sheet size", placeholder: "12 x 20 in" },
      ...COLOR,
    ],
  },
  die: {
    label: "Die (fabric cutter)",
    kind: "ACCESSORY",
    craft: true,
    fields: [
      { key: "shape", label: "Shape", placeholder: "2 1/2 in square" },
      { key: "size", label: "Size", placeholder: "6 x 12 in" },
    ],
  },
};

/** What the item form's "What is it?" list offers: the plain kinds, then the types with details. A value is a kind, or "KIND:type". */
export type KindChoice = { value: string; label: string; craft?: boolean };
export const KIND_CHOICES: KindChoice[] = [
  { value: "PART", label: "Part" },
  { value: "ACCESSORY", label: "Accessory (feet, hoops, extension tables...)" },
  { value: "SUPPLY", label: "Supply (needles, oil, bobbins...)" },
  { value: "NOTION", label: "Notion (scissors, rulers, pins, marking tools...)" },
  { value: "FABRIC", label: "Fabric" },
  { value: "THREAD", label: "Thread" },
  { value: "PATTERN", label: "Pattern / book" },
  ...ITEM_TYPE_IDS.filter((t) => ITEM_TYPES[t].craft).map((t) => ({ value: `${ITEM_TYPES[t].kind}:${t}`, label: ITEM_TYPES[t].label, craft: true })),
];

export const PLAIN_KINDS = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"] as const;
export type PlainKind = (typeof PLAIN_KINDS)[number];

/** "SUPPLY:filament" -> { kind SUPPLY, itemType filament }; "THREAD" -> thread; a plain kind -> no type. Unknown: an error in words. */
export function parseKindChoice(v: string | null | undefined): { kind: PlainKind; itemType: ItemType | null } {
  const raw = (v ?? "PART").trim() || "PART";
  const [k, t] = raw.split(":");
  if (!(PLAIN_KINDS as readonly string[]).includes(k)) throw new UserError("Pick what kind of item it is.");
  const kind = k as PlainKind;
  if (t == null) return { kind, itemType: kind === "THREAD" ? "thread" : null };
  if (!isItemType(t) || ITEM_TYPES[t].kind !== kind) throw new UserError("Pick what kind of item it is.");
  return { kind, itemType: t };
}

/** The value the "What is it?" list shows for a saved item. */
export function kindChoiceOf(p: { kind: string; itemType?: string | null }): string {
  const t = typeOf(p);
  if (t && t !== "thread" && ITEM_TYPES[t].kind === p.kind) return `${p.kind}:${t}`;
  return p.kind;
}

/** What the item is: its saved type, or thread for a THREAD item saved before types existed. */
export function typeOf(p: { kind: string; itemType?: string | null }): ItemType | null {
  if (isItemType(p.itemType)) return p.itemType;
  return p.kind === "THREAD" ? "thread" : null;
}

/** The specs JSON as saved, cleaned to the known keys and short strings (a hand-edited row can't break a page). */
export function specsOf(v: unknown): Specs {
  const out: Specs = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const k of SPEC_KEYS) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === "string" && x.trim()) out[k] = x.trim().slice(0, 60);
    else if (typeof x === "number" && Number.isFinite(x)) out[k] = String(x);
  }
  return out;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9.+]/g, "");

/** A typed word matched to a list's own spelling in any case ("petg" -> "PETG"), else as typed (trimmed). */
export function canonical(list: readonly string[] | undefined, typed: string): string {
  const t = typed.trim().replace(/\s+/g, " ");
  if (!list) return t;
  const k = squash(t);
  return list.find((x) => squash(x) === k) ?? t;
}

/** "#ABC", "abc", "#aabbcc" -> "#aabbcc"; blank -> null; anything else is an error in words. */
export function hexOf(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().replace(/^#/, "");
  if (!t) return null;
  if (/^[0-9a-f]{3}$/i.test(t)) return `#${t.split("").map((c) => c + c).join("").toLowerCase()}`;
  if (/^[0-9a-f]{6}$/i.test(t)) return `#${t.toLowerCase()}`;
  throw new UserError("Pick the swatch color again (it didn't come through as a color).");
}

const num = (s: string) => {
  const m = /^(\d+(?:[.,]\d+)?)/.exec(s.trim());
  return m ? Number(m[1].replace(",", ".")) : NaN;
};

/** Forgiving input for each spec: "40" -> "40 wt", "1.75" -> "1.75 mm", "1000" or "1kg" -> "1 kg", "500" -> "500 ml", "3" -> "3 mm". */
export function normalSpec(key: SpecKey, typed: string, list?: readonly string[]): string {
  const t = typed.trim().replace(/\s+/g, " ");
  const bare = /^\d+(?:[.,]\d+)?$/.test(t);
  switch (key) {
    case "weight":
      if (/^\d+\s*(wt|w|weight)?$/i.test(t)) return `${num(t)} wt`;
      break;
    case "diameter":
      if (bare || /^\d+(\.\d+)?\s*mm$/i.test(t)) return `${num(t)} mm`;
      break;
    case "spool": {
      const kg = /^(\d+(?:\.\d+)?)\s*kg$/i.exec(t);
      const g = bare ? num(t) : /^(\d+)\s*g(rams?)?$/i.test(t) ? num(t) : kg ? Number(kg[1]) * 1000 : NaN;
      if (Number.isFinite(g) && g > 0) return g >= 1000 && g % 1000 === 0 ? `${g / 1000} kg` : `${g} g`;
      break;
    }
    case "volume": {
      const l = /^(\d+(?:\.\d+)?)\s*(l|liter|litre)s?$/i.exec(t);
      const ml = bare ? num(t) : /^(\d+)\s*ml$/i.test(t) ? num(t) : l ? Number(l[1]) * 1000 : NaN;
      if (Number.isFinite(ml) && ml > 0) return ml >= 1000 && ml % 1000 === 0 ? `${ml / 1000} l` : `${ml} ml`;
      break;
    }
    case "thickness":
      if (bare || /^\d+(\.\d+)?\s*mm$/i.test(t)) return `${num(t)} mm`;
      break;
  }
  return canonical(list, t);
}

export type Details = { colorNumber: string | null; colorName: string | null; colorHex: string | null; material: string | null; specs: Specs };

const MAX = { colorNumber: 30, colorName: 60, material: 60, spec: 60 };

/**
 * The details a form sent for an item of this type, cleaned. Only the type's own fields are kept: a field of another type
 * (left from switching the list) is dropped, and an item with no type keeps none. `get` reads a form field (blank: none).
 */
export function detailsFrom(type: ItemType | null, get: (name: string) => string | null): Details {
  const out: Details = { colorNumber: null, colorName: null, colorHex: null, material: null, specs: {} };
  if (!type) return out;
  for (const f of ITEM_TYPES[type].fields) {
    const raw = get(f.key)?.trim();
    if (!raw) continue;
    if (f.key === "colorHex") out.colorHex = hexOf(raw);
    else if (f.key === "colorNumber") out.colorNumber = raw.slice(0, MAX.colorNumber);
    else if (f.key === "colorName") out.colorName = raw.replace(/\s+/g, " ").slice(0, MAX.colorName);
    else if (f.key === "material") out.material = canonical(f.list, raw).slice(0, MAX.material);
    else out.specs[f.key] = normalSpec(f.key, raw, f.list).slice(0, MAX.spec);
  }
  return out;
}

type Shown = { kind: string; itemType?: string | null; brand?: string | null; colorNumber?: string | null; colorName?: string | null; material?: string | null; specs?: unknown };

/**
 * The details in one line, as the counter reads them: "Isacord 0015 White · 40 wt polyester · 1,000 m spool",
 * "PLA black · 1.75 mm · 1 kg · matte", "Birch plywood 3 mm · 12 x 20 in". Empty when there's nothing to say.
 */
export function detailsLine(p: Shown): string {
  const t = typeOf(p);
  if (!t) return "";
  const s = specsOf(p.specs);
  const color = [p.colorNumber ? [p.brand, p.colorNumber].filter(Boolean).join(" ") : null, p.colorName].filter(Boolean).join(" ");
  const mat = p.material ?? "";
  switch (t) {
    case "thread":
      return [color, [s.weight, mat.toLowerCase()].filter(Boolean).join(" "), s.putUp].filter(Boolean).join(" · ");
    case "filament":
      return [[mat, p.colorName?.toLowerCase(), p.colorNumber ? `(${p.colorNumber})` : null].filter(Boolean).join(" "), s.diameter, s.spool, s.finish?.toLowerCase()].filter(Boolean).join(" · ");
    case "laser-material":
      return [[mat, s.thickness].filter(Boolean).join(" "), s.size, p.colorName].filter(Boolean).join(" · ");
    case "die":
      return [s.shape, s.size].filter(Boolean).join(" · ");
    default:
      return [mat, color, s.volume, s.size].filter(Boolean).join(" · ");
  }
}
