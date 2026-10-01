// Equipment kinds: what a shop checks in (sewing machines, vacuums, stand mixers...) and what each kind asks for.
// Pure types (modules-design.md section 9.2).
import type { ModuleId } from "@/lib/module-info";
import type { QuickLink } from "@/lib/quick-links";

export type Equipment = "SEWING" | "VACUUM" | "APPLIANCE";

export type FieldDef = {
  key: string; // [a-z0-9-]{1,40}, stable: answers are stored under it
  label: string;
  type: "text" | "number" | "select" | "checkbox";
  options?: string[]; // select
  unit?: string; // number: shown after the box
  placeholder?: string;
  on: "machine" | "ticket"; // Machine.details (the unit, asked once) or Ticket.intake (this visit)
};

export type ReadingDef = {
  key: string;
  label: string;
  type: "number" | "text" | "passfail";
  unit?: string;
  min?: number;
  max?: number; // number: "in range" / "out" pill like the tension readings
  foundLeft: boolean; // true: As found + As left; false: one value (stored as "left")
};

export type ServiceDef = { name: string; description?: string; priceCents?: number }; // priceCents: suggested; absent = 0

export type EquipmentKind = {
  key: string;
  equipment: Equipment;
  module: ModuleId | null;
  label: string; // "Vacuum"            (chips, section titles)
  plural: string; // "Vacuums"           (filters)
  noun: string; // "vacuum"            (sentences: "Check in a vacuum")
  types: string[]; // Machine.machineType choices
  brands: string[]; // brand suggestions (sewing: the page loads TensionSpec brands as today)
  modelHint: string; // model placeholder: "e.g. UH70120"
  accessories: string[];
  defaultChecked: string[];
  checklist: string[]; // sewing: see checklistFor
  serviceMenu: ServiceDef[]; // the starter list
  intakeFields: FieldDef[];
  readings: ReadingDef[]; // built-in kinds only; a shop kind has none
  panels: { tension: boolean; timing: boolean }; // sewing only
  links: (brand: string, model: string) => QuickLink[];
  builtIn: boolean;
};

/** "a vacuum" / "an appliance": the article from the first letter. */
export function withArticle(noun: string) {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}
