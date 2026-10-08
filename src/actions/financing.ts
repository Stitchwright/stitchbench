"use server";

// Financing (tax-machine-sales-layaway-design.md section 5): Settings → Selling's lenders, and marking a financed sale
// paid by its lender (Reports → Financing). Bodies in src/lib/financing.ts.
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireAdmin } from "@/lib/session";
import { markFinancedPaidFor, saveLenderFor } from "@/lib/financing";

export const saveLender = safe(async function saveLender(id: string | null, formData: FormData) {
  const user = await requireAdmin();
  await saveLenderFor(user, id, formData);
  revalidatePath("/settings/sales");
  revalidatePath("/register");
});

export const markFinancedPaid = safe(async function markFinancedPaid(id: string, paid: boolean) {
  const user = await requireAdmin();
  await markFinancedPaidFor(user, id, paid);
  revalidatePath("/reports");
});
