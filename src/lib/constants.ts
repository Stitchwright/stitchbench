// Lists that mirror the paper Machine Log so the bench, the route and the app use the same words.
import type { TicketStatus, PaymentMethod, LineKind, NoteKind, PhotoKind } from "@/generated/prisma/enums";

export const STATUS_LABEL: Record<TicketStatus, string> = {
  AT_SHOP_AWAITING_PICKUP: "At shop - awaiting pickup",
  IN_TRUCK: "In truck",
  ON_BENCH: "On bench",
  WAITING_CUSTOMER_OK: "Waiting on customer OK",
  WAITING_PARTS: "Waiting on parts",
  READY_IN_TRUCK: "Ready - in truck",
  READY_FOR_PICKUP: "Ready - customer called",
  COLLECTED: "Collected by customer",
  ABANDONED: "Abandoned",
  RETURNED_UNREPAIRED: "Returned unrepaired",
};

export const STATUS_ORDER: TicketStatus[] = [
  "AT_SHOP_AWAITING_PICKUP",
  "IN_TRUCK",
  "ON_BENCH",
  "WAITING_CUSTOMER_OK",
  "WAITING_PARTS",
  "READY_IN_TRUCK",
  "READY_FOR_PICKUP",
  "COLLECTED",
  "ABANDONED",
  "RETURNED_UNREPAIRED",
];

/** Statuses where the machine is in our custody (truck or bench). */
export const IN_CUSTODY: TicketStatus[] = ["IN_TRUCK", "ON_BENCH", "WAITING_CUSTOMER_OK", "WAITING_PARTS", "READY_IN_TRUCK"];
export const OPEN_STATUSES: TicketStatus[] = STATUS_ORDER.filter(
  (s) => !["COLLECTED", "ABANDONED", "RETURNED_UNREPAIRED"].includes(s),
);

export const STATUS_TONE: Record<TicketStatus, "neutral" | "work" | "wait" | "ready" | "done" | "bad"> = {
  AT_SHOP_AWAITING_PICKUP: "neutral",
  IN_TRUCK: "neutral",
  ON_BENCH: "work",
  WAITING_CUSTOMER_OK: "wait",
  WAITING_PARTS: "wait",
  READY_IN_TRUCK: "ready",
  READY_FOR_PICKUP: "ready",
  COLLECTED: "done",
  ABANDONED: "bad",
  RETURNED_UNREPAIRED: "bad",
};

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  CARD: "Card",
  CASH: "Cash",
  CHECK: "Check",
  SHOP_COLLECTED: "Shop collected",
  INVOICE: "Invoice (on account)",
  OTHER: "Other",
};

export const LINE_LABEL: Record<LineKind, string> = {
  SERVICE: "Service",
  LABOR: "Labor",
  PART: "Part",
  FEE: "Fee",
  DISCOUNT: "Discount",
};

export const NOTE_LABEL: Record<NoteKind, string> = {
  GOTCHA: "Gotcha",
  FACT: "Fact",
  TIP: "Tip",
};

export const PHOTO_KIND_LABEL: Record<PhotoKind, string> = {
  CONDITION: "Check-in condition",
  INSIDE: "Inside the machine",
  WIRING: "Wiring & connectors",
  PART: "Parts",
  AFTER: "After repair",
};
export const PHOTO_KINDS = Object.keys(PHOTO_KIND_LABEL) as PhotoKind[];
/** Photos that help with every machine of the model, so they also show on the model page. */
export const MODEL_PHOTO_KINDS: PhotoKind[] = ["INSIDE", "WIRING"];

export const MACHINE_TYPES = [
  "Mechanical",
  "Computerized",
  "Sew + embroidery",
  "Embroidery only",
  "Premium computerized",
  "Serger / cover",
  "Vintage",
  "Featherweight",
  "Industrial",
  "Sit-down quilter",
  "Longarm",
  "Multi-needle embroidery",
  "Control board",
  "Other",
];

export const ACCESSORIES = [
  "Power cord",
  "Foot control",
  "Bobbin case",
  "Bobbins",
  "Presser feet",
  "Embroidery unit",
  "Hoop",
  "Embroidery foot",
  "Extension table",
  "Knee lift",
  "Dust cover",
  "Case / bag",
  "Manual",
  "Other",
];

/** DocType vocabulary used in manual file names: Brand_Model_DocType_Year.pdf */
export const DOC_TYPES = [
  "ServiceManual",
  "TechnicalManual",
  "MaintenanceManual",
  "PartsList",
  "OperatorManual",
  "ErrorCodes",
  "WiringDiagram",
  "Schematic",
  "Training",
  "Bulletin",
];
