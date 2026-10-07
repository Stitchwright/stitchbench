import { db } from "@/lib/db";

/**
 * What the register took in a period (the "Total" on Register sales): the sales rung up in it, less the ones voided
 * inside it (they net to nothing), less earlier sales voided in it (the money went back then). Integer cents.
 * Same rule as src/app/(app)/register/sales/page.tsx, which also breaks it down by tender and type.
 */
export async function registerTakenCents(shopId: string, start: Date, end: Date): Promise<number> {
  const [sales, voidedHere] = await Promise.all([
    db.sale.findMany({ where: { shopId, createdAt: { gte: start, lt: end } }, select: { totalCents: true, voidedAt: true } }),
    db.sale.findMany({ where: { shopId, status: "VOIDED", voidedAt: { gte: start, lt: end }, createdAt: { lt: start } }, select: { totalCents: true } }),
  ]);
  const inside = (s: { voidedAt: Date | null }) => s.voidedAt != null && s.voidedAt >= start && s.voidedAt < end;
  return sales.filter((s) => !inside(s)).reduce((a, s) => a + s.totalCents, 0) - voidedHere.reduce((a, s) => a + s.totalCents, 0);
}
