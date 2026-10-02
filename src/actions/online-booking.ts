"use server";

// Settings → Online booking (online-and-parts-design.md section 2). Body in src/lib/online-booking.ts.
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireAdmin } from "@/lib/session";
import { saveBookingSettingsFor } from "@/lib/online-booking";

export const saveBookingSettings = safe(async function saveBookingSettings(formData: FormData) {
  const user = await requireAdmin();
  await saveBookingSettingsFor(user, formData);
  revalidatePath("/settings/booking");
  revalidatePath("/settings");
});
