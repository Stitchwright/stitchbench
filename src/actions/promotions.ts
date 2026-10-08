"use server";

// Promotions (tax-machine-sales-layaway-design.md section 2): Settings → Selling's add, change and remove, and the
// owner's switch for "price includes the tax" (off by default, behind the state-law warning). Bodies in
// src/lib/promotions.ts.
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireAdmin } from "@/lib/session";
import { deletePromotionFor, savePromotionFor, setTaxIncludedFor } from "@/lib/promotions";

function refresh() {
  revalidatePath("/settings/sales");
  revalidatePath("/register");
}

export const savePromotion = safe(async function savePromotion(id: string | null, formData: FormData) {
  const user = await requireAdmin();
  await savePromotionFor(user, id, formData);
  refresh();
});

export const deletePromotion = safe(async function deletePromotion(id: string) {
  const user = await requireAdmin();
  await deletePromotionFor(user, id);
  refresh();
});

export const setTaxIncluded = safe(async function setTaxIncluded(formData: FormData) {
  const user = await requireAdmin();
  await setTaxIncludedFor(user, formData.get("on") === "on");
  refresh();
});
