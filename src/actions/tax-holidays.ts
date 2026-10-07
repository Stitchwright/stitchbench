"use server";

// Sales tax holidays (tax-machine-sales-layaway-design.md section 1): Settings → Selling's add, change and remove.
// Bodies in src/lib/tax-holidays.ts.
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireAdmin } from "@/lib/session";
import { deleteHolidayFor, saveHolidayFor } from "@/lib/tax-holidays";

function refresh() {
  revalidatePath("/settings/sales");
  revalidatePath("/register");
  revalidatePath("/");
}

export const saveHoliday = safe(async function saveHoliday(id: string | null, formData: FormData) {
  const user = await requireAdmin();
  await saveHolidayFor(user, id, formData);
  refresh();
});

export const deleteHoliday = safe(async function deleteHoliday(id: string) {
  const user = await requireAdmin();
  await deleteHolidayFor(user, id);
  refresh();
});
