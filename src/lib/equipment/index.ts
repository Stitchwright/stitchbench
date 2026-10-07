// The registry of equipment kinds (modules-design.md section 9.3). Pure: no database. The shop's own kinds and the
// "usable" rule (module on, kind active) are in ./shop.ts (server).
import type { ModuleId } from "@/lib/module-info";
import { APPLIANCE_KINDS } from "./appliances";
import { MAKER_KINDS } from "./maker";
import { cleanFieldDefs } from "./form";
import { SEWING_KIND } from "./sewing";
import type { Equipment, EquipmentKind } from "./types";
import { VACUUM_KIND } from "./vacuum";

export const EQUIPMENT_MODULE: Record<Equipment, ModuleId | null> = { SEWING: null, VACUUM: "vac", APPLIANCE: "appliance" };
export const EQUIPMENT_LABEL: Record<Equipment, string> = { SEWING: "sewing machine", VACUUM: "vacuum", APPLIANCE: "appliance" };

export const isEquipment = (s: unknown): s is Equipment => s === "SEWING" || s === "VACUUM" || s === "APPLIANCE";

export const BUILT_IN_KINDS: EquipmentKind[] = [SEWING_KIND, VACUUM_KIND, ...APPLIANCE_KINDS, ...MAKER_KINDS];
export const BUILT_IN_KEYS = BUILT_IN_KINDS.map((k) => k.key);
/** The kinds sold as machines for sale with no module (shop-features-round-2-design.md 6.1). */
export const SELL_FREE_KEYS = BUILT_IN_KINDS.filter((k) => k.sellFree).map((k) => k.key);

export function builtInKind(key: string | null | undefined): EquipmentKind | undefined {
  return BUILT_IN_KINDS.find((k) => k.key === key);
}

import { genericLinks } from "./links";
export { genericLinks };

/** A kind for a machine whose shop kind was removed (or written by a newer version), so the record still renders. */
export function genericKind(equipment: string, key: string, label?: string): EquipmentKind {
  const eq: Equipment = isEquipment(equipment) ? equipment : "APPLIANCE";
  const noun = label?.toLowerCase() ?? EQUIPMENT_LABEL[eq];
  return {
    key,
    equipment: eq,
    module: EQUIPMENT_MODULE[eq],
    label: label ?? key,
    plural: label ? `${label}s` : key,
    noun,
    types: [],
    brands: [],
    modelHint: "Model number from the label",
    accessories: [],
    defaultChecked: [],
    checklist: [],
    serviceMenu: [],
    intakeFields: [],
    readings: [],
    panels: { tension: false, timing: false },
    links: genericLinks(noun),
    builtIn: false,
  };
}

export type ShopKindRow = {
  key: string;
  label: string;
  noun: string | null;
  types: string[];
  brands: string[];
  accessories: string[];
  defaultChecked: string[];
  checklist: string[];
  intakeFields: unknown;
};

/** A kind the shop added itself ("What you repair"): always APPLIANCE, no readings, generic links, no starter menu. */
export function shopKind(row: ShopKindRow): EquipmentKind {
  const noun = row.noun?.trim() || row.label.toLowerCase();
  return {
    key: row.key,
    equipment: "APPLIANCE",
    module: "appliance",
    label: row.label,
    plural: `${row.label}s`,
    noun,
    types: row.types,
    brands: row.brands,
    modelHint: "Model number from the label",
    accessories: row.accessories,
    defaultChecked: row.defaultChecked.filter((a) => row.accessories.includes(a)),
    checklist: row.checklist,
    serviceMenu: [],
    intakeFields: cleanFieldDefs(row.intakeFields),
    readings: [],
    panels: { tension: false, timing: false },
    links: genericLinks(noun),
    builtIn: false,
  };
}

/** The order kinds are offered in: sewing, vacuum, the built-in appliances, shop kinds (by sortOrder), other. */
export function sortKinds(kinds: EquipmentKind[], shopOrder: string[] = []): EquipmentKind[] {
  const rank = (k: EquipmentKind) => {
    if (k.key === "sewing") return 0;
    if (k.key === "vacuum") return 1;
    if (k.key === "other") return 1000;
    if (k.builtIn) return 2 + BUILT_IN_KEYS.indexOf(k.key);
    const i = shopOrder.indexOf(k.key);
    return 100 + (i === -1 ? 99 : i);
  };
  return [...kinds].sort((a, b) => rank(a) - rank(b));
}
