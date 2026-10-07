"use server";

// Trade-up credit and the trade-in rule (shop-features-round-2-design.md 1.9): the settings. The credit itself is used at
// the register (src/lib/register-sale.ts with src/lib/trade-up.ts).
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { saveTradeUpSettingsFor } from "@/lib/trade-up";

export const saveTradeUpSettings = safe(async function saveTradeUpSettings(formData: FormData) {
  await saveTradeUpSettingsFor(await requireUser(), formData);
  revalidatePath("/settings/sales");
});
