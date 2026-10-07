"use server";

// Shipping labels through Shippo (shop-features-round-2-design.md 9.5, package shippo). Bodies in src/lib/shippo.ts.
import { revalidatePath } from "next/cache";
import { noted, safe, shownOnce } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { buyLabelFor, ratesFor, saveShippoSettingsFor } from "@/lib/shippo";

export const saveShippoSettings = safe(async function saveShippoSettings(formData: FormData) {
  const user = await requireUser();
  const text = await saveShippoSettingsFor(user, formData);
  revalidatePath("/settings/shipping");
  revalidatePath("/register/online");
  return noted(text);
});

/** The cheapest rates for an order's parcel (read back through shownOnce). */
export const labelRates = safe(async function labelRates(orderId: string, formData: FormData) {
  const user = await requireUser();
  return shownOnce(JSON.stringify(await ratesFor(user, orderId, formData)));
});

export const buyLabel = safe(async function buyLabel(orderId: string, rateId: string) {
  const user = await requireUser();
  const text = await buyLabelFor(user, orderId, rateId);
  revalidatePath("/register/online");
  return noted(text);
});
