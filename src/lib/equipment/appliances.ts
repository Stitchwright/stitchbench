// The built-in small-appliance kinds (Small Appliance Repair module, modules-design.md section 11.1): stand mixers,
// filament and resin 3D printers, and "other appliance". Every kind: equipment APPLIANCE, module appliance, panels off,
// generic quick links; the starter menus carry no prices, so they are added switched off at $0 (section 9.5).
import { genericLinks } from "./links";
import type { EquipmentKind, ServiceDef } from "./types";

const menu = (names: string[]): ServiceDef[] => names.map((name) => ({ name }));

type Spec = Pick<EquipmentKind, "key" | "label" | "plural" | "noun" | "modelHint" | "types" | "brands" | "accessories" | "defaultChecked" | "checklist" | "intakeFields" | "readings"> & { menu: string[] };

/** A kind sold with no module (shop-features-round-2-design.md 6.1). */
export const sellFree = (k: EquipmentKind): EquipmentKind => ({ ...k, sellFree: true });

export function kind(a: Spec): EquipmentKind {
  const { menu: names, ...rest } = a;
  return {
    ...rest,
    equipment: "APPLIANCE",
    module: "appliance",
    serviceMenu: menu(names),
    panels: { tension: false, timing: false },
    links: (b, m) => genericLinks(a.noun)(b, m),
    builtIn: true,
  };
}

export const STAND_MIXER_KIND = kind({
  key: "stand-mixer",
  label: "Stand mixer",
  plural: "Stand mixers",
  noun: "stand mixer",
  modelHint: "e.g. KSM150PS",
  types: ["Tilt-head", "Bowl-lift", "Center-drive (Bosch)", "Open-bowl (Ankarsrum)", "Other"],
  brands: ["KitchenAid", "Bosch", "Kenwood", "Ankarsrum", "Cuisinart", "Hamilton Beach", "Sunbeam", "Breville", "Smeg"],
  accessories: ["Bowl", "Flat beater", "Dough hook", "Wire whip", "Pouring shield", "Bowl cover", "Attachments"],
  defaultChecked: ["Bowl"],
  intakeFields: [
    { key: "bowl", label: "Bowl size", type: "select", options: ["3.5 qt", "4.5 qt", "5 qt", "5.5 qt", "6 qt", "7 qt", "Other"], on: "machine" },
    { key: "color", label: "Color", type: "text", on: "machine" },
    { key: "grease", label: "Leaking grease", type: "checkbox", on: "ticket" },
    { key: "noise", label: "Noise or grinding", type: "checkbox", on: "ticket" },
  ],
  checklist: [
    "Old grease removed, gearbox cleaned",
    "Worm gear and worm follower gear checked (replaced if worn)",
    "Regreased with food-grade grease",
    "Planetary height set (dime test, planetary mixers)",
    "Speed control checked and adjusted",
    "Motor brushes checked",
    "Attachment hub checked",
    "Cord and switch checked",
    "Test run at every speed",
    "Cleaned outside",
  ],
  menu: ["Mixer service: grease repack and adjust", "Worm gear / worm follower gear replacement", "Planetary height adjustment (dime test)", "Speed control repair", "Motor brushes", "Motor replacement", "Diagnosis & estimate"],
  readings: [
    { key: "dime", label: "Dime test (planetary mixers)", type: "passfail", foundLeft: true },
    { key: "speeds", label: "Runs smoothly at every speed", type: "passfail", foundLeft: true },
  ],
});

export const PRINTER_KIND = sellFree(kind({
  key: "3d-printer",
  label: "3D printer",
  plural: "3D printers",
  noun: "3D printer",
  modelHint: "e.g. MK4, X1C, Ender-3 V3",
  types: ["Bed-slinger", "CoreXY", "Other"],
  brands: ["Prusa", "Bambu Lab", "Creality", "Anycubic", "Elegoo", "Voron", "Ultimaker", "Flashforge", "Sovol", "Qidi"],
  accessories: ["Power cord / brick", "Build plate", "Spool holder", "AMS / MMU unit", "Filament", "SD card / USB stick", "Tool kit", "Enclosure"],
  defaultChecked: ["Power cord / brick", "Build plate"],
  intakeFields: [
    { key: "mods", label: "Changes from stock (mods)", type: "text", on: "machine" },
    { key: "nozzle", label: "Nozzle size", type: "select", options: ["0.2", "0.4", "0.6", "0.8", "Other"], on: "machine" },
    { key: "filament", label: "Filament in use", type: "select", options: ["PLA", "PETG", "ABS / ASA", "TPU", "Nylon", "Other"], on: "ticket" },
  ],
  checklist: [
    "Nozzle and hotend checked (clog, wear, leaks)",
    "PTFE tube checked or replaced",
    "Extruder gears cleaned, tension set",
    "Belts tension checked",
    "Bed levelled / mesh calibrated, Z offset set",
    "Rails, rods and wheels cleaned and lubricated",
    "Fans checked (hotend and part cooling)",
    "Wiring and connectors checked",
    "Firmware version recorded (updated if agreed)",
    "Test print done",
  ],
  menu: [
    "Printer tune-up (clean, belts, level, test print)",
    "Nozzle / hotend replacement",
    "Clogged hotend service",
    "PTFE tube replacement",
    "Bed levelling and calibration",
    "Belt replacement or tensioning",
    "Extruder gear service",
    "Firmware update",
    "Mainboard / wiring diagnosis",
  ],
  readings: [
    { key: "firmware", label: "Firmware version", type: "text", foundLeft: true },
    { key: "testprint", label: "Test print", type: "passfail", foundLeft: true },
  ],
}));

export const RESIN_PRINTER_KIND = sellFree(kind({
  key: "resin-printer",
  label: "Resin 3D printer",
  plural: "Resin 3D printers",
  noun: "resin printer",
  modelHint: "e.g. Mars 4, Photon Mono",
  types: ["MSLA", "DLP", "Other"],
  brands: ["Elegoo", "Anycubic", "Phrozen", "Formlabs", "Creality", "Uniformation"],
  accessories: ["Power cord / brick", "Build plate", "Resin vat", "Wash & cure station", "FEP film (spare)"],
  defaultChecked: ["Power cord / brick", "Build plate", "Resin vat"],
  intakeFields: [{ key: "resin", label: "Resin in use", type: "select", options: ["Standard", "ABS-like", "Water-washable", "Tough", "Other"], on: "ticket" }],
  checklist: [
    "FEP / release film checked or replaced",
    "LCD exposure test done",
    "UV light source checked",
    "Build plate levelled",
    "Z-axis lead screw cleaned and lubricated",
    "Vat checked for leaks",
    "Firmware version recorded",
    "Test print done",
  ],
  menu: ["FEP film replacement", "LCD screen replacement", "UV light board replacement", "Build plate levelling", "Z-axis service", "Firmware update", "Diagnosis & estimate"],
  readings: [
    { key: "firmware", label: "Firmware version", type: "text", foundLeft: true },
    { key: "exposure", label: "LCD exposure test", type: "passfail", foundLeft: true },
    { key: "testprint", label: "Test print", type: "passfail", foundLeft: true },
  ],
}));

export const OTHER_APPLIANCE_KIND = kind({
  key: "other",
  label: "Other appliance",
  plural: "Other appliances",
  noun: "appliance",
  modelHint: "Model number from the label",
  types: ["Espresso machine", "Blender", "Stand fan", "Food processor", "Coffee grinder", "Toaster oven", "Air fryer", "Other"],
  brands: [],
  accessories: ["Power cord", "Parts in the box"],
  defaultChecked: [],
  intakeFields: [],
  checklist: ["Safety check: cord, plug, switch", "Fault found and fixed", "Cleaned inside and out", "Test run"],
  menu: ["Diagnosis & estimate", "Small appliance repair"],
  readings: [],
});

export const APPLIANCE_KINDS: EquipmentKind[] = [STAND_MIXER_KIND, PRINTER_KIND, RESIN_PRINTER_KIND, OTHER_APPLIANCE_KIND];
