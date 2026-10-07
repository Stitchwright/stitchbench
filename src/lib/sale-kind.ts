// The category a register line is reported under (later-round-1-design.md 3.2), written on the line when it is sold so a
// part deleted or re-kinded later doesn't move old sales. Pure: no database. The migration's fill for older lines follows
// the same order (20261006330000_report_kinds).

/** What each category is called on the reports. */
export const SALE_KIND_LABEL: Record<string, string> = {
  PART: "Parts",
  ACCESSORY: "Accessories",
  SUPPLY: "Supplies",
  NOTION: "Notions",
  FABRIC: "Fabric",
  THREAD: "Thread",
  PATTERN: "Patterns and books",
  CLASS: "Classes",
  APPOINTMENT: "Appointments",
  UNIT: "Machines sold",
  SERVICE_PLAN: "Service plans",
  REPAIR: "Partner repair bills",
  TRADE_IN: "Trade-ins",
  GIFT_CARD: "Gift cards",
  LAYAWAY: "Layaway payments (held for customers)",
  LAYAWAY_FEE: "Layaway cancel fees",
  DEPOSIT: "Special order deposits (held for customers)",
  DEPOSIT_KEPT: "Kept deposits",
  MEMBERSHIP: "Memberships",
  LOAN_FEE: "Loaner charges",
  RENT: "Rentals",
  MISC: "Other",
};

/** Lines that are not sales: a gift card or a layaway payment is money owed to the customer, a trade-in a purchase, a partner repair bill the repair shop's sale. */
export const NOT_SALE_KINDS = ["GIFT_CARD", "TRADE_IN", "REPAIR", "LAYAWAY", "DEPOSIT"];

type KindInput = {
  kind?: string | null;
  giftCardId?: string | null;
  machinePlanId?: string | null;
  tradeInUnitId?: string | null;
  stockUnitId?: string | null;
  repairJobId?: string | null;
  enrollmentId?: string | null;
  appointmentId?: string | null;
  partKind?: string | null;
};

/** The line's category: the one written when sold, else worked out from what the line points at. */
export function saleLineKind(l: KindInput): string {
  if (l.kind) return l.kind;
  if (l.giftCardId) return "GIFT_CARD";
  if (l.machinePlanId) return "SERVICE_PLAN";
  if (l.tradeInUnitId) return "TRADE_IN";
  if (l.stockUnitId) return "UNIT";
  if (l.repairJobId) return "REPAIR";
  if (l.enrollmentId) return "CLASS";
  if (l.appointmentId) return "APPOINTMENT";
  return l.partKind ?? "MISC";
}
