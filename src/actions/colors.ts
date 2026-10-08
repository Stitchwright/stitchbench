"use server";

// Color lookup (shop-features-round-2-design.md 2.2, package color-lookup): the register's "Find a color" panel and the
// item page's "Same color as" links. Bodies in src/lib/colors.ts. findColors only reads (allowed while the program is
// read-only, lapse-allow.ts HAND_ALLOWED); the links are edits, refused then (safe() with no exception).
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { colorsBoughtBy, findColorsFor, linkSameAsFor, unlinkSameAsFor, type ColorHit } from "@/lib/colors";

/** What was typed, matched on the shop's items' details; with a customer chosen, also the colors she bought before. */
export async function findColors(q: string, customerId?: string | null): Promise<{ hits: ColorHit[]; bought: ColorHit[] }> {
  const user = await requireUser();
  const text = String(q ?? "").trim().slice(0, 80);
  const [hits, bought] = await Promise.all([text.length >= 2 ? findColorsFor(user.shopId, text) : Promise.resolve([]), customerId ? colorsBoughtBy(user.shopId, String(customerId), 12) : Promise.resolve([])]);
  return { hits, bought };
}

export const linkSameColor = safe(async function linkSameColor(partId: string, formData: FormData) {
  const user = await requireUser();
  const text = await linkSameAsFor(user, partId, str(formData.get("other")) ?? "");
  revalidatePath(`/parts/${partId}`);
  return noted(text);
});

export const unlinkSameColor = safe(async function unlinkSameColor(partId: string, otherId: string) {
  const user = await requireUser();
  const text = await unlinkSameAsFor(user, partId, otherId);
  revalidatePath(`/parts/${partId}`);
  return noted(text);
});
