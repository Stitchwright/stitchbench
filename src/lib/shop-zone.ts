import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";

/** The company's time zone (Settings -> Shop), read once per request however many parts of a page ask for it. */
export const shopTimeZone = cache(async (shopId: string): Promise<string> => {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true } });
  return s.timeZone;
});
