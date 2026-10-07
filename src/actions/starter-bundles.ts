"use server";

// Starter bundles (shop-features-round-2-design.md 6.1, package maker-machines). Bodies in src/lib/starter-bundles.ts.
// starterBundlesNow only reads (lapse-allow.ts HAND_ALLOWED); saving and removing are edits (safe(), no exception).
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { bundlesForUnits, deleteBundleFor, saveBundleFor, type UnitBundles } from "@/lib/starter-bundles";

export const saveStarterBundle = safe(async function saveStarterBundle(id: string | null, formData: FormData) {
  const user = await requireUser();
  const text = await saveBundleFor(user, id, formData);
  revalidatePath("/settings/sales");
  return noted(text);
});

export const deleteStarterBundle = safe(async function deleteStarterBundle(id: string) {
  const user = await requireUser();
  const text = await deleteBundleFor(user, id);
  revalidatePath("/settings/sales");
  return noted(text);
});

/** The register: the starter bundles for each machine for sale on the sale. */
export async function starterBundlesNow(unitIds: string[]): Promise<UnitBundles[]> {
  const user = await requireUser();
  return bundlesForUnits(user.shopId, Array.isArray(unitIds) ? unitIds.map(String) : []);
}
