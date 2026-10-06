// Longarm quilting's arithmetic and words (fabric-smarts-design.md 4a): pure, so the order form can show the price as it
// is typed and the check script can hold the math. Integer cents throughout; the rate is in tenths of a cent per square
// inch (2.5 cents a square inch is 25), so a quilt of 60 x 80 inches at 2.5 cents is 4800 x 25 / 10 = 12000 cents.
import type { LongarmDesign, LongarmPricing, LongarmStatus } from "@/generated/prisma/enums";

export const MAX_INCHES = 400;
export const MAX_RATE_TENTH = 1000; // 100 cents a square inch: far above any real rate
export const MAX_LONGARM_CENTS = 10_000_000;

export const STATUS_LABEL: Record<LongarmStatus, string> = { RECEIVED: "Received", ON_FRAME: "On the frame", READY: "Ready", COLLECTED: "Collected", CANCELLED: "Cancelled" };
export const STATUS_ORDER: LongarmStatus[] = ["RECEIVED", "ON_FRAME", "READY", "COLLECTED"];
export const OPEN_LONGARM: LongarmStatus[] = ["RECEIVED", "ON_FRAME", "READY"];
export const DESIGN_LABEL: Record<LongarmDesign, string> = { PANTOGRAPH: "Pantograph (edge to edge)", CUSTOM: "Custom" };
export const PRICING_LABEL: Record<LongarmPricing, string> = { PER_SQIN: "By the square inch", FLAT: "Flat price" };

/**
 * Where a work order may go from here by hand: forward one step, back one step, or cancelled while open; a cancelled
 * order can be reopened. Collected is reached only by collecting (which bills it at the register) and is final.
 */
export const MOVES: Record<LongarmStatus, LongarmStatus[]> = {
  RECEIVED: ["ON_FRAME", "CANCELLED"],
  ON_FRAME: ["READY", "RECEIVED", "CANCELLED"],
  READY: ["ON_FRAME", "CANCELLED"],
  COLLECTED: [],
  CANCELLED: ["RECEIVED"],
};

export const squareInches = (widthIn: number, lengthIn: number) => widthIn * lengthIn;

/** The quilting alone: size x rate (rounded to the cent), or the flat price. */
export function quiltCents(o: { pricing: LongarmPricing; widthIn: number; lengthIn: number; rateTenthCents: number; flatCents: number }): number {
  return o.pricing === "FLAT" ? o.flatCents : Math.round((squareInches(o.widthIn, o.lengthIn) * o.rateTenthCents) / 10);
}

/** The order's price before tax: quilting + thread + batting + extras. */
export function orderCents(o: { pricing: LongarmPricing; widthIn: number; lengthIn: number; rateTenthCents: number; flatCents: number; threadCents: number; battingCents: number; extraCents: number }): { quiltCents: number; totalCents: number } {
  const q = quiltCents(o);
  return { quiltCents: q, totalCents: q + o.threadCents + o.battingCents + o.extraCents };
}

/** "2.5" (cents a square inch) -> 25 tenths; one decimal at most; null when it isn't one. */
export function rateTenthFrom(text: string | null | undefined): number | null {
  const t = (text ?? "").trim().replace(/^\$/, "").replace(/c$/i, "").trim();
  if (!/^\d{1,3}(\.\d)?$/.test(t)) return null;
  const n = Math.round(Number(t) * 10);
  return n >= 0 && n <= MAX_RATE_TENTH ? n : null;
}

/** 25 -> "2.5" (cents a square inch). */
export const rateText = (tenth: number) => (tenth % 10 === 0 ? String(tenth / 10) : (tenth / 10).toFixed(1));

/** A rental by the hour: the rate x the time booked, to the cent. */
export const rentalFeeCents = (hourlyCents: number, minutes: number) => Math.round((hourlyCents * minutes) / 60);
