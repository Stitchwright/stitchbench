// The built-in small-appliance kinds (Small Appliance Repair module). Foundation stub: each kind's identity, types
// and brands; the appliance-repair package fills in accessories, intake fields, checklists, menus and readings
// (modules-design.md section 11.1).
import { genericLinks } from "./links";
import type { EquipmentKind } from "./types";

function kind(a: Pick<EquipmentKind, "key" | "label" | "plural" | "noun" | "modelHint" | "types" | "brands">): EquipmentKind {
  return {
    ...a,
    equipment: "APPLIANCE",
    module: "appliance",
    accessories: [],
    defaultChecked: [],
    checklist: [],
    serviceMenu: [],
    intakeFields: [],
    readings: [],
    panels: { tension: false, timing: false },
    links: (b, m) => genericLinks(a.noun)(b, m),
    builtIn: true,
  };
}

export const APPLIANCE_KINDS: EquipmentKind[] = [
  kind({
    key: "stand-mixer",
    label: "Stand mixer",
    plural: "Stand mixers",
    noun: "stand mixer",
    modelHint: "e.g. KSM150PS",
    types: ["Tilt-head", "Bowl-lift", "Center-drive (Bosch)", "Open-bowl (Ankarsrum)", "Other"],
    brands: ["KitchenAid", "Bosch", "Kenwood", "Ankarsrum", "Cuisinart", "Hamilton Beach", "Sunbeam", "Breville", "Smeg"],
  }),
  kind({
    key: "3d-printer",
    label: "3D printer",
    plural: "3D printers",
    noun: "3D printer",
    modelHint: "e.g. MK4, X1C, Ender-3 V3",
    types: ["Bed-slinger", "CoreXY", "Other"],
    brands: ["Prusa", "Bambu Lab", "Creality", "Anycubic", "Elegoo", "Voron", "Ultimaker", "Flashforge", "Sovol", "Qidi"],
  }),
  kind({
    key: "resin-printer",
    label: "Resin 3D printer",
    plural: "Resin 3D printers",
    noun: "resin printer",
    modelHint: "e.g. Mars 4, Photon Mono",
    types: ["MSLA", "DLP", "Other"],
    brands: ["Elegoo", "Anycubic", "Phrozen", "Formlabs", "Creality", "Uniformation"],
  }),
  kind({
    key: "other",
    label: "Other appliance",
    plural: "Other appliances",
    noun: "appliance",
    modelHint: "Model number from the label",
    types: ["Espresso machine", "Blender", "Stand fan", "Food processor", "Coffee grinder", "Toaster oven", "Air fryer", "Other"],
    brands: [],
  }),
];
