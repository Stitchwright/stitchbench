// The vacuum kind (Vac Shop module, modules-design.md 10.a): identity, types, brands, accessories, intake fields,
// checklist, the starter service menu, readings and links. The `bagged` and `bagType` keys are a contract with the
// finder, the unit forms and bags-due.
import { genericLinks } from "./links";
import type { EquipmentKind } from "./types";

export const VACUUM_BRANDS = [
  "Aerus", "Beam", "Bissell", "Cana-Vac", "Dirt Devil", "Dyson", "Electrolux", "Eureka", "Hayden", "Hoover", "iRobot", "Kenmore", "Kirby", "Lindsay", "Miele",
  "Nilfisk", "NuTone", "Oreck", "Panasonic", "ProTeam", "Rainbow", "Riccar", "Roborock", "Royal", "Sanitaire", "SEBO", "Shark", "Simplicity", "VacuMaid", "Windsor",
];

export const VACUUM_CHECKLIST = [
  "Bag / bin emptied and bag chamber cleaned",
  "Filters checked (pre-motor, post-motor, HEPA): cleaned or replaced",
  "Belt checked or replaced",
  "Brush roll: hair and string removed, bearings and end caps checked",
  "Hose and air path checked for clogs",
  "Cord, plug and strain reliefs checked",
  "Switch and wiring checked",
  "Motor and carbon brushes checked",
  "Suction tested (reading recorded)",
  "Cleaned outside, test run done",
];

/** The starter list: created switched off at $0 until the shop prices them (modules-design.md 9.5). */
export const VACUUM_SERVICE_MENU = [
  "Vacuum tune-up (clean, belt, brush roll, filters, suction test)",
  "Belt replacement",
  "Brush roll service or replacement",
  "Motor carbon brushes",
  "Motor replacement",
  "Hose clog removal",
  "Hose repair or replacement",
  "Bag chamber and air path cleaning",
  "Filter replacement",
  "Cord replacement",
  "Switch replacement",
  "Suction test and diagnosis",
  "Robot vacuum service (brushes, sensors, battery test)",
  "Central vac power unit service",
  "Central vac installation",
  "Central vac inlet (each)",
].map((name) => ({ name }));

export const VACUUM_KIND: EquipmentKind = {
  key: "vacuum",
  equipment: "VACUUM",
  module: "vac",
  label: "Vacuum",
  plural: "Vacuums",
  noun: "vacuum",
  types: ["Upright", "Canister", "Central", "Backpack", "Robot", "Commercial", "Stick / cordless", "Other"],
  brands: VACUUM_BRANDS,
  modelHint: "e.g. UH70120",
  accessories: ["Power cord", "Hose", "Wand(s)", "Power head / floor tool", "Crevice tool", "Dusting brush", "Upholstery tool", "Bag (in it)", "Filter(s)", "Battery", "Charger / dock", "Remote", "Tool caddy"],
  defaultChecked: [], // vacuums often come in bare
  checklist: VACUUM_CHECKLIST,
  serviceMenu: VACUUM_SERVICE_MENU,
  intakeFields: [
    { key: "bagged", label: "Bags or bagless", type: "select", options: ["Bagged", "Bagless"], on: "machine" },
    { key: "bagType", label: "Bag type", type: "text", placeholder: "e.g. Hoover Type Y, Miele GN", on: "machine" },
    { key: "power", label: "Power", type: "select", options: ["Corded", "Battery"], on: "machine" },
    { key: "smell", label: "Burning smell reported", type: "checkbox", on: "ticket" },
  ],
  readings: [
    { key: "suction", label: "Suction", type: "number", unit: "inH2O", foundLeft: true },
    { key: "amps", label: "Amp draw", type: "number", unit: "A", foundLeft: true },
    { key: "brushroll", label: "Brush roll spins under load", type: "passfail", foundLeft: true },
  ],
  panels: { tension: false, timing: false },
  links: (b, m) => genericLinks("vacuum")(b, m),
  builtIn: true,
};

/** A brand that names a vacuum maker (any case, spaces and hyphens ignored): "dirt devil", "Dirt-Devil", "SEBO". */
export function brandMatches(brand: string | null | undefined): boolean {
  const k = (brand ?? "").toLowerCase().replace(/[\s-]+/g, "");
  return !!k && VACUUM_BRANDS.some((b) => b.toLowerCase().replace(/[\s-]+/g, "") === k);
}
