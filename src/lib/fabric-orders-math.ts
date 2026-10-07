// Fabric ordering math (fabric-smarts-design.md sections 5 and 9; formulas in docs/research/fabric-analytics-methods.md
// section 5). Pure: no "server-only", no database, so the Fabric page, the server bodies (src/lib/fabric-orders.ts) and the
// check script share one set of numbers. Yards are eighths, money integer cents (figures in between are floating point).
import { roundCents, yards } from "@/lib/register-math";

// ---------------------------------------------------------------------------------------------------------------
// Shop settings (Settings -> Fabric)
// ---------------------------------------------------------------------------------------------------------------

export type OrderSettings = {
  fabReviewWeeks: number;
  fabZCollection: number;
  fabZStaple: number;
  fabLeadDays: number;
  fabUrgentSoldPct: number;
  fabUrgentDays: number;
  fabUrgentWeeks: number;
};

export const ORDER_DEFAULTS: OrderSettings = {
  fabReviewWeeks: 2,
  fabZCollection: 1.28,
  fabZStaple: 1.65,
  fabLeadDays: 14,
  fabUrgentSoldPct: 60,
  fabUrgentDays: 28,
  fabUrgentWeeks: 2,
};

export const ORDER_SELECT = Object.fromEntries(Object.keys(ORDER_DEFAULTS).map((k) => [k, true])) as Record<keyof OrderSettings, true>;

export const ORDER_FIELDS: { key: keyof OrderSettings; label: string; min: number; max: number; kind: "int" | "dec" }[] = [
  { key: "fabReviewWeeks", label: "Weeks between orders (an order has to last this long, plus the lead time)", min: 0, max: 26, kind: "int" },
  { key: "fabZCollection", label: "Safety stock for collections (1.28 is a 90% chance of not running out)", min: 0, max: 4, kind: "dec" },
  { key: "fabZStaple", label: "Safety stock for staples, fabric with no collection (1.65 is 95%)", min: 0, max: 4, kind: "dec" },
  { key: "fabLeadDays", label: "Days from order to delivery for a supplier with no received order yet", min: 1, max: 180, kind: "int" },
  { key: "fabUrgentSoldPct", label: "Reorder now: this percent of the stock sold within the days below", min: 10, max: 100, kind: "int" },
  { key: "fabUrgentDays", label: "Reorder now: days", min: 7, max: 90, kind: "int" },
  { key: "fabUrgentWeeks", label: "Reorder now: ...and the weeks of supply under the lead time plus this many weeks", min: 0, max: 26, kind: "int" },
];

// ---------------------------------------------------------------------------------------------------------------
// Lead time
// ---------------------------------------------------------------------------------------------------------------

export type SupplierLead = { leadDays: number | null; learnedDays: number | null; learnedOrders: number };

/** The lead time the math uses: learned from received orders once there is one, else the supplier's own figure, else the shop's. */
export function leadDaysOf(s: SupplierLead | null | undefined, shopDefault: number): { days: number; from: "learned" | "supplier" | "shop" } {
  if (s && s.learnedOrders > 0 && s.learnedDays != null) return { days: s.learnedDays, from: "learned" };
  if (s?.leadDays != null) return { days: s.leadDays, from: "supplier" };
  return { days: shopDefault, from: "shop" };
}

/** Orders after which the learned figure keeps moving by a fixed share (so one late shipment doesn't swamp a long record). */
export const LEAD_MEMORY = 3;

/**
 * Folds one received order's lead time (days from sent to first received) into the learned figure: the first order is the
 * figure; after that a running average that remembers at most the last LEAD_MEMORY orders (weight 1 / 4 on the newest once
 * the record is long enough). Whole days, at least 1.
 */
export function learnLead(s: SupplierLead, actualDays: number): { learnedDays: number; learnedOrders: number } {
  const actual = Math.max(1, Math.round(actualDays));
  const n = s.learnedOrders;
  if (n <= 0 || s.learnedDays == null) return { learnedDays: actual, learnedOrders: 1 };
  const w = Math.min(n, LEAD_MEMORY);
  return { learnedDays: Math.max(1, Math.round((s.learnedDays * w + actual) / (w + 1))), learnedOrders: n + 1 };
}

// ---------------------------------------------------------------------------------------------------------------
// Reorder suggestion
// ---------------------------------------------------------------------------------------------------------------

/** Population standard deviation of the weekly sales (the weeks the fabric was in stock). */
export function weeklySigma(weekly: number[]): number {
  if (weekly.length < 2) return 0;
  const mean = weekly.reduce((a, b) => a + b, 0) / weekly.length;
  return Math.sqrt(weekly.reduce((a, b) => a + (b - mean) ** 2, 0) / weekly.length);
}

const eighths = (y: number) => Math.round(y * 8) / 8;

export type ReorderInput = {
  perWeek: number;
  sigmaWeek: number;
  leadWeeks: number;
  reviewWeeks: number;
  z: number;
  onHand: number;
  onOrder: number;
  boltYards: number;
};

export type ReorderOut = {
  safety: number;
  target: number;
  /** Yards short of the target, before rounding (never negative). */
  need: number;
  /** The suggestion in half bolts (0: nothing worth ordering). */
  halves: number;
  /** The suggestion in yards (halves x half a bolt). */
  yards: number;
};

/**
 * safety = z x sigma x sqrt(lead weeks); target = velocity x (lead + review weeks) + safety; need = target - on hand - on
 * order. Rounded to the nearest half bolt, at least one half bolt once the need is a quarter of one (a smaller need isn't
 * worth an order), and one half bolt at most for a fabric that sells under half a yard a week (research section 5, rule 2).
 */
export function reorderMath(o: ReorderInput): ReorderOut {
  const safety = o.z * o.sigmaWeek * Math.sqrt(o.leadWeeks);
  const target = o.perWeek * (o.leadWeeks + o.reviewWeeks) + safety;
  const need = Math.max(0, target - o.onHand - o.onOrder);
  const half = o.boltYards / 2;
  if (half <= 0 || need < half / 4) return { safety, target, need, halves: 0, yards: 0 };
  let halves = Math.max(1, Math.round(need / half));
  if (o.perWeek < 0.5) halves = 1;
  return { safety, target, need, halves, yards: eighths(halves * half) };
}

/**
 * "Reorder now": the stock of the last `days` days (what was on hand at the start plus what came in) is `soldPct` percent
 * sold or more, and the weeks of supply are under the lead time plus `extraWeeks`. The sold amount must be at least a yard
 * (a swatch-sized sale of a tiny lot is not a best seller).
 */
export function isUrgent(o: { sold: number; lot: number; weeks: number | null; leadWeeks: number }, s: Pick<OrderSettings, "fabUrgentSoldPct" | "fabUrgentWeeks">): boolean {
  if (o.lot <= 0 || o.sold < 1) return false;
  if (o.sold / o.lot * 100 < s.fabUrgentSoldPct - 1e-9) return false;
  return o.weeks != null && o.weeks < o.leadWeeks + s.fabUrgentWeeks;
}

// ---------------------------------------------------------------------------------------------------------------
// Purchase order lines
// ---------------------------------------------------------------------------------------------------------------

/** YD and BOLT are fabric's measures; EACH is pieces of any other item (shop-features-round-2-design.md 1.1). */
export type PoUnitName = "YD" | "BOLT" | "EACH";

export type PoLineLike = { unit: PoUnitName; qty: number; boltYards: number; costCents: number | null; receivedYards: number };

/**
 * What a line orders in its stock measure: yards (its quantity in yards, or bolts x the bolt size, in eighths) for fabric,
 * pieces for an EACH line. The name is from when orders were fabric only.
 */
export const lineYards = (l: Pick<PoLineLike, "unit" | "qty" | "boltYards">): number => (l.unit === "EACH" ? Math.round(l.qty) : eighths(l.unit === "BOLT" ? l.qty * l.boltYards : l.qty));

/** Still to come on a line, in its stock measure (never negative: an over-delivery leaves nothing outstanding). */
export const outstandingYards = (l: PoLineLike): number => (l.unit === "EACH" ? Math.max(0, Math.round(l.qty - l.receivedYards)) : Math.max(0, eighths(lineYards(l) - l.receivedYards)));

/** What a line costs: yards x the cost a yard (or pieces x the cost each), rounded to the cent. */
export const lineCostTotal = (l: PoLineLike): number => (l.costCents == null ? 0 : roundCents(lineYards(l) * l.costCents));

export const orderTotal = (lines: PoLineLike[]): number => lines.reduce((a, l) => a + lineCostTotal(l), 0);

/** A line's stock measure in words: "yd" for fabric, "" for pieces (a count reads plainly: "12"). */
export const isEach = (l: Pick<PoLineLike, "unit">) => l.unit === "EACH";

/** The amount as an order reads it: "1 1/2 bolts (22 1/2 yd)", "3 yd", "12". */
export function amountText(l: Pick<PoLineLike, "unit" | "qty" | "boltYards">): string {
  if (l.unit === "EACH") return String(Math.round(l.qty));
  if (l.unit === "BOLT") return `${l.qty} ${l.qty === 1 ? "bolt" : "bolts"} (${yards(lineYards(l))} yd)`;
  return `${yards(l.qty)} yd`;
}

/** An amount in a line's stock measure: "3 1/2 yd" for fabric, "12" for pieces. */
export const measureText = (l: Pick<PoLineLike, "unit">, q: number): string => (l.unit === "EACH" ? String(Math.round(q)) : `${yards(q)} yd`);

/** "/yd" or " each": what a line's cost is per. */
export const costPer = (l: Pick<PoLineLike, "unit">): string => (l.unit === "EACH" ? " each" : "/yd");

/** The whole order's amount: "45 yd", "24 pieces", or "45 yd and 24 pieces". */
export function orderAmountText(lines: Pick<PoLineLike, "unit" | "qty" | "boltYards">[]): string {
  const yd = lines.filter((l) => l.unit !== "EACH").reduce((a, l) => a + lineYards(l), 0);
  const pcs = lines.filter((l) => l.unit === "EACH").reduce((a, l) => a + lineYards(l), 0);
  const parts = [lines.some((l) => l.unit !== "EACH") ? `${yards(yd)} yd` : null, pcs ? `${pcs} ${pcs === 1 ? "piece" : "pieces"}` : null].filter(Boolean);
  return parts.length ? parts.join(" and ") : "nothing yet";
}

export type PoStatus = "DRAFT" | "SENT" | "PARTLY_RECEIVED" | "RECEIVED" | "CANCELLED";

export const PO_STATUS_LABEL: Record<PoStatus, string> = { DRAFT: "Draft", SENT: "Sent", PARTLY_RECEIVED: "Partly received", RECEIVED: "Received", CANCELLED: "Cancelled" };

/** The status after a receipt: received once no line has anything outstanding, else partly received. */
export const statusAfterReceive = (lines: PoLineLike[]): "PARTLY_RECEIVED" | "RECEIVED" => (lines.every((l) => outstandingYards(l) <= 1e-9) ? "RECEIVED" : "PARTLY_RECEIVED");

/** Orders whose outstanding amounts count as "on order". A draft isn't ordered yet. */
export const OPEN_STATUSES: PoStatus[] = ["SENT", "PARTLY_RECEIVED"];

/** The amount as the order reads it: "1.5 bolts (22 1/2 yd)" is built by amountText; this is just the unit word. */
export const unitWord = (unit: PoUnitName, qty: number) => (unit === "YD" ? "yd" : unit === "EACH" ? "each" : qty === 1 ? "bolt" : "bolts");

/**
 * The suggestion for an item sold each (not fabric by the yard), from its own reorder point: at or below it, counting
 * what is on a sent order, order enough to bring it up to twice the point (at least 1). 0: nothing to order.
 */
export function eachSuggestion(o: { reorderAt: number; onHand: number; onOrder: number }): number {
  if (!(o.reorderAt > 0)) return 0;
  const have = Math.max(0, o.onHand) + Math.max(0, o.onOrder);
  if (have > o.reorderAt + 1e-9) return 0;
  return Math.max(1, Math.ceil(o.reorderAt * 2 - have));
}
