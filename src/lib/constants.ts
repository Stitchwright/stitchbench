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
  "Firmware",
  "Training",
  "Bulletin",
];

/** A repair's status as the sewing shop that took the machine in sees it (the repair shop's ticket statuses). */
export const JOB_STATUS_LABEL: Record<TicketStatus, string> = {
  AT_SHOP_AWAITING_PICKUP: "Here, waiting for the repair shop",
  IN_TRUCK: "With the repair shop",
  ON_BENCH: "Being repaired",
  WAITING_CUSTOMER_OK: "Needs the customer's OK",
  WAITING_PARTS: "Waiting for parts",
  READY_IN_TRUCK: "Fixed, on its way back",
  READY_FOR_PICKUP: "Ready for the customer",
  COLLECTED: "Customer has it",
  ABANDONED: "Abandoned",
  RETURNED_UNREPAIRED: "Returned unrepaired",
};

export const ORDER_STATUS_LABEL: Record<string, string> = {
  PLACED: "Placed",
  ACCEPTED: "Accepted",
  DELIVERED: "Delivered",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};

// ---------- paid modules (modules-design.md section 2.5) ----------

// Central vac installs (Ticket.jobType SITE) use the ticket statuses under these names (like JOB_STATUS_LABEL).
export const SITE_STATUS_ORDER: TicketStatus[] = ["WAITING_CUSTOMER_OK", "AT_SHOP_AWAITING_PICKUP", "WAITING_PARTS", "ON_BENCH", "COLLECTED", "RETURNED_UNREPAIRED"];
export const SITE_STATUS_LABEL: Record<TicketStatus, string> = {
  WAITING_CUSTOMER_OK: "Quote sent",
  AT_SHOP_AWAITING_PICKUP: "Booked",
  IN_TRUCK: "Booked",
  WAITING_PARTS: "Waiting on parts",
  ON_BENCH: "In progress",
  READY_IN_TRUCK: "In progress",
  READY_FOR_PICKUP: "In progress",
  COLLECTED: "Completed",
  ABANDONED: "Cancelled",
  RETURNED_UNREPAIRED: "Cancelled",
};
/** Statuses that close a ticket: always allowed, even after its module ended (hand the machine back, take payment). */
export const CLOSING_STATUSES: TicketStatus[] = ["COLLECTED", "RETURNED_UNREPAIRED", "ABANDONED"];
export const UNIT_STATUS_LABEL: Record<string, string> = { IN_STOCK: "In stock", SOLD: "Sold", REMOVED: "Off sale" };
export const UNIT_STATUS_TONE: Record<string, "neutral" | "ready" | "done"> = { IN_STOCK: "ready", SOLD: "done", REMOVED: "neutral" };
export const UNIT_CONDITION_LABEL: Record<string, string> = { NEW: "New", OPEN_BOX: "Open box", REFURB: "Refurbished", USED: "Used" };
/** Cross-reference categories the bag / belt / filter finder reads (XPart.category, free text on the hub). */
export const VAC_SUPPLY_CATEGORIES = ["Vacuum bag", "Vacuum belt", "Vacuum filter"] as const;

// ---------- scheduling and messages (scheduling-messaging-design.md section 2.4) ----------

export const MESSAGE_KIND_LABEL: Record<string, string> = {
  ready: "Ready for pickup",
  reminder: "Reminder",
  estimate: "Estimate",
  abandon: "Not picked up notice",
  service_due: "Service reminder",
  review: "Review request",
  campaign: "Campaign",
  class_notice: "Class message",
  booking_notice: "Appointment message",
  consent_confirm: "Text sign-up confirmation",
  help_reply: "Reply to HELP",
  bags_due: "Bags due reminder",
  test: "Test",
};
export const ABANDON_STAGE_LABEL: Record<string, string> = { first: "First notice", second: "Second notice", third: "Third notice", fourth: "Fourth notice", final: "Final notice" };
export const MESSAGE_STATUS_LABEL: Record<string, string> = {
  QUEUED: "Waiting",
  SENDING: "Sending",
  SENT: "Sent",
  FAILED: "Not sent",
  SKIPPED: "Skipped",
  CANCELLED: "Cancelled",
  EXPIRED: "Too late",
};
export const MESSAGE_STATUS_TONE: Record<string, "neutral" | "work" | "wait" | "ready" | "done" | "bad"> = {
  QUEUED: "wait",
  SENDING: "work",
  SENT: "done",
  FAILED: "bad",
  SKIPPED: "neutral",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
};
export const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  sms: "Text",
  letter: "Letter (by hand)",
  certified_mail: "Certified mail (by hand)",
  phone: "Phone call (by hand)",
};
export const NOTIFY_BY_LABEL: Record<string, string> = {
  "": "Not asked yet (email if we have one)",
  email: "Email",
  sms: "Text",
  both: "Email and text",
  none: "No messages (call them)",
};
export const SKIP_REASON_LABEL = {
  channel_off: "Email or texts aren't set up",
  no_address: "No email or mobile number on file",
  opted_out: "Opted out",
  unsubscribed: "Unsubscribed from marketing email",
  no_text_consent: "Hasn't agreed to marketing texts",
  not_asked: "Not asked if texts are OK",
  prefers_other: "Prefers the other way",
  no_messages: "Asked for no messages",
  changed: "Their details changed after it was queued",
  not_wanted: "No longer needed",
  trade: "Trade account (no marketing)",
  not_us: "Not a US number (no marketing texts)",
  too_often: "Had 4 marketing texts in the last 30 days",
  unread_reply: "They texted you back: read it first",
  staff_cap: "Already 3 messages today",
} as const;
export const CONSENT_EVENT_LABEL: Record<string, string> = {
  marketing_yes: "Agreed to marketing texts",
  marketing_no: "Marketing texts withdrawn",
  notify_pref: "Changed how to be told",
  optout: "Opted out",
  optin: "Opted back in",
  help: "Asked for help (HELP)",
};
export const CONSENT_SOURCE_LABEL: Record<string, string> = {
  counter: "At the counter",
  intake: "At check-in",
  customer_page: "Customer page",
  paper_form: "Signed paper form",
  tablet: "Signed on the counter tablet",
  unsubscribe_link: "Unsubscribe link",
  reply: "Text reply",
  carrier: "Carrier (an earlier STOP)",
  email_reply: "Replied UNSUBSCRIBE",
  staff: "Recorded by staff",
  import: "Imported list",
  ticket: "Told us at pickup time",
};
export const CLASS_STATUS_LABEL: Record<string, string> = { OPEN: "Open", CLOSED: "Sign-ups closed", CANCELLED: "Cancelled" };
export const CLASS_REMIND_LABEL: Record<string, string> = { every: "Before every meeting", first: "Before the first meeting only", never: "No reminders" };
export const ENROLLMENT_STATUS_LABEL: Record<string, string> = { ENROLLED: "Signed up", WAITLIST: "Waiting list", CANCELLED: "Cancelled" };
export const APPOINTMENT_STATUS_LABEL: Record<string, string> = { BOOKED: "Booked", DONE: "Done", NO_SHOW: "Didn't come", CANCELLED: "Cancelled" };
export const RUN_STATUS_LABEL: Record<string, string> = { SCHEDULED: "Scheduled", CANCELLED: "Cancelled", DONE: "Done" };
export const CAMPAIGN_STATUS_LABEL: Record<string, string> = { DRAFT: "Draft", QUEUING: "Getting ready", SENDING: "Sending", SENT: "Sent", CANCELLED: "Cancelled" };
