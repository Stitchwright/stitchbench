"use server";

// Help switching from Square, Rain or Like Sew, and QuickBooks Point of Sale (shop-features-round-2-design.md 4.7): see
// what a file will bring in, then bring it in. Bodies in src/lib/switch/import.ts.
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { isUserError } from "@/lib/user-error";
import { requireUser } from "@/lib/session";
import { applySwitchFor, previewSwitch, type SwitchPreview } from "@/lib/switch/import";

/** "See what will come in": only reads (allowed while the program is read-only; lapse-allow HAND_ALLOWED). */
export async function previewSwitchFile(system: string, kind: string, text: string): Promise<SwitchPreview | { error: string }> {
  try {
    const user = await requireUser();
    return await previewSwitch(user, system, kind, text);
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

export const bringSwitchIn = safe(async function bringSwitchIn(system: string, kind: string, text: string, itemKind: string | null, addQty: boolean) {
  const user = await requireUser();
  const told = await applySwitchFor(user, system, kind, text, { itemKind, addQty });
  revalidatePath("/parts", "layout");
  revalidatePath("/customers");
  revalidatePath("/register/gift-cards");
  return noted(told);
});
