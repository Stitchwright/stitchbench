// Craft and maker machines a quilt shop sells (shop-features-round-2-design.md 6.1, package maker-machines): craft cutters
// (Cricut, Silhouette, ScanNCut), fabric die cutters (AccuQuilt; a serial is optional) and laser cutters, beside the
// 3D and resin printers. Selling them needs no module (sellFree); their repair tickets are the Small Appliance Repair
// module's, like every appliance kind. Pure.
import { kind, sellFree } from "./appliances";
import type { EquipmentKind } from "./types";

export const CRAFT_CUTTER_KIND = sellFree(
  kind({
    key: "craft-cutter",
    label: "Craft cutter",
    plural: "Craft cutters",
    noun: "craft cutter",
    modelHint: "e.g. Maker 3, Cameo 5, SDX325",
    types: ["Blade cutter", "Scan and cut", "Other"],
    brands: ["Cricut", "Silhouette", "Brother ScanNCut", "Sizzix"],
    accessories: ["Power cord", "Mat", "Blade housing", "USB cable", "Pen adapter"],
    defaultChecked: ["Power cord"],
    intakeFields: [{ key: "blade", label: "Blade in use", type: "text", on: "ticket" }],
    checklist: ["Blade housing cleaned, blade checked", "Rollers and mat sensor cleaned", "Firmware version recorded", "Test cut done"],
    menu: ["Cutter tune-up (clean, calibrate, test cut)", "Blade housing service", "Calibration", "Firmware update"],
    readings: [{ key: "testcut", label: "Test cut", type: "passfail", foundLeft: true }],
  }),
);

export const DIE_CUTTER_KIND: EquipmentKind = {
  ...sellFree(
    kind({
      key: "die-cutter",
      label: "Fabric die cutter",
      plural: "Fabric die cutters",
      noun: "die cutter",
      modelHint: "e.g. GO! Big, Studio 2",
      types: ["Hand crank", "Electric", "Other"],
      brands: ["AccuQuilt", "Sizzix"],
      accessories: ["Cutting mat", "Dies", "Handle"],
      defaultChecked: [],
      intakeFields: [],
      checklist: ["Rollers checked and cleaned", "Mats checked for wear", "Test cut done"],
      menu: ["Die cutter service"],
      readings: [],
    }),
  ),
  serialOptional: true,
};

export const LASER_KIND = sellFree(
  kind({
    key: "laser-cutter",
    label: "Laser cutter",
    plural: "Laser cutters",
    noun: "laser cutter",
    modelHint: "e.g. Glowforge Pro, xTool P2",
    types: ["Diode", "CO2", "Fiber", "Other"],
    brands: ["Glowforge", "xTool", "OMTech", "Thunder Laser"],
    accessories: ["Power cord", "Exhaust hose", "Crumb tray", "Air assist"],
    defaultChecked: ["Power cord"],
    intakeFields: [{ key: "power", label: "Laser power", type: "text", on: "machine" }],
    checklist: ["Lens and mirrors cleaned", "Alignment checked", "Exhaust and air assist checked", "Safety interlocks tested", "Test engrave and cut done"],
    menu: ["Laser tune-up (clean, align, test)", "Lens and mirror cleaning", "Alignment", "Tube or module check"],
    readings: [{ key: "testcut", label: "Test engrave and cut", type: "passfail", foundLeft: true }],
  }),
);

export const MAKER_KINDS: EquipmentKind[] = [CRAFT_CUTTER_KIND, DIE_CUTTER_KIND, LASER_KIND];
