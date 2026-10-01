// The sewing-machine kind: exactly today's behaviour (modules-design.md section 9.3). Pure.
import { ACCESSORIES, MACHINE_TYPES } from "@/lib/constants";
import { quickLinks } from "@/lib/quick-links";
import { DEFAULT_CHECKLIST, DEFAULT_SERVICE_MENU } from "@/lib/service-menu";
import type { EquipmentKind } from "./types";

export const SEWING_KIND: EquipmentKind = {
  key: "sewing",
  equipment: "SEWING",
  module: null,
  label: "Sewing machine",
  plural: "Sewing machines",
  noun: "machine",
  types: MACHINE_TYPES,
  brands: [],
  modelHint: "e.g. MC6700P",
  accessories: ACCESSORIES.filter((a) => a !== "Other"),
  defaultChecked: ["Power cord", "Foot control"],
  checklist: DEFAULT_CHECKLIST,
  serviceMenu: DEFAULT_SERVICE_MENU,
  intakeFields: [],
  readings: [],
  panels: { tension: true, timing: true },
  links: (b, m) => quickLinks(b, m, null),
  builtIn: true,
};
