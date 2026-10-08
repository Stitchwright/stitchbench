"use server";

// An item's bin and reorder point at one store (shop-features-round-2-design.md 7.2).
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { saveStoreLevelFor } from "@/lib/store-orders";

export const saveStoreLevel = safe(async function saveStoreLevel(partId: string, storeId: string, formData: FormData) {
  const user = await requireUser();
  await saveStoreLevelFor(user, String(partId), String(storeId), formData);
  revalidatePath(`/parts/${partId}`);
});
