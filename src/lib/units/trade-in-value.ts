import "server-only";
// The trade-in's expected price (shop-features-round-2-design.md 5.4 and the 1.9 rule): what the shop's own used units
// of the same model sold for and how long they took (else the same brand and kind), and the number to start from:
// what we expect to sell it for, less the shop's percentage. The program's numbers; staff change the credit freely.
// Never on a receipt. This company's sales only.
import { db } from "@/lib/db";
import { modelKey } from "@/lib/format";
import { median } from "@/lib/reports/tickets";

/**
 * The 1.9 rule, "what we expect to sell it for, less 30%". `trade-up` (phase 1) adds the shop's own setting
 * (Shop.tradeInLessPct); until it lands on this branch the rule is the design's default.
 */
export const TRADE_IN_LESS_PCT = 30;

export type TradeInEstimate = {
  /** What the past sales were matched on: the same model, or the same brand and kind; null when there were none. */
  basis: "model" | "brand" | null;
  count: number;
  medianCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  medianDays: number | null;
  lessPct: number;
  /** The expected price less the rule, to the dollar: the credit to start from. */
  startCents: number | null;
};

const DAY = 86_400_000;

export async function tradeInEstimate(shopId: string, o: { kind?: string | null; brand: string; model: string }): Promise<TradeInEstimate> {
  const lessPct = TRADE_IN_LESS_PCT;
  const brand = String(o.brand ?? "").trim();
  const key = modelKey(String(o.model ?? ""));
  const none: TradeInEstimate = { basis: null, count: 0, medianCents: null, lowCents: null, highCents: null, medianDays: null, lessPct, startCents: null };
  if (!brand && !key) return none;
  const sold = (where: object) =>
    db.stockUnit.findMany({
      where: { shopId, soldAt: { not: null }, condition: { in: ["USED", "REFURB"] }, machine: { shopId, ...(o.kind ? { kind: o.kind } : {}), ...where } },
      select: { soldNetCents: true, priceCents: true, soldAt: true, createdAt: true },
      orderBy: { soldAt: "desc" },
      take: 50,
    });
  let basis: TradeInEstimate["basis"] = "model";
  let rows = key ? await sold({ modelKey: key }) : [];
  if (!rows.length && brand) {
    basis = "brand";
    rows = await sold({ brand: { equals: brand, mode: "insensitive" } });
  }
  const prices = rows.map((r) => r.soldNetCents ?? r.priceCents).filter((c): c is number => c != null && c > 0);
  if (!prices.length) return none;
  const mid = Math.round(median(prices)!);
  const days = rows.filter((r) => r.soldAt).map((r) => Math.max(0, Math.round((r.soldAt!.getTime() - r.createdAt.getTime()) / DAY)));
  return {
    basis,
    count: prices.length,
    medianCents: mid,
    lowCents: Math.min(...prices),
    highCents: Math.max(...prices),
    medianDays: days.length ? Math.round(median(days)!) : null,
    lessPct,
    startCents: Math.round((mid * (100 - lessPct)) / 100 / 100) * 100,
  };
}
