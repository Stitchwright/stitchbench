// The vacuum kind (Vac Shop module). Foundation stub: identity, the owner's types plus Other, the `bagged` and
// `bagType` intake fields (a contract with the finder, the unit forms and bags-due) and the `suction` reading. The
// vac-repair package fills in the brands, accessories, checklist, menu and the other readings (modules-design.md 10.a).
import { genericLinks } from "./index";
import type { EquipmentKind } from "./types";

export const VACUUM_KIND: EquipmentKind = {
  key: "vacuum",
  equipment: "VACUUM",
  module: "vac",
  label: "Vacuum",
  plural: "Vacuums",
  noun: "vacuum",
  types: ["Upright", "Canister", "Central", "Backpack", "Robot", "Commercial", "Stick / cordless", "Other"],
  brands: [],
  modelHint: "e.g. UH70120",
  accessories: [],
  defaultChecked: [],
  checklist: [],
  serviceMenu: [],
  intakeFields: [
    { key: "bagged", label: "Bags or bagless", type: "select", options: ["Bagged", "Bagless"], on: "machine" },
    { key: "bagType", label: "Bag type", type: "text", placeholder: "e.g. Hoover Type Y, Miele GN", on: "machine" },
  ],
  readings: [{ key: "suction", label: "Suction", type: "number", unit: "inH2O", foundLeft: true }],
  panels: { tension: false, timing: false },
  links: (b, m) => genericLinks("vacuum")(b, m),
  builtIn: true,
};
