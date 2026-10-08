"use server";

// Sales commissions and "listed elsewhere" (shop-features-round-2-design.md 9.7, package commissions-listed). Bodies in src/lib/commissions.ts.
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { saveCommissionFor, setListedFor } from "@/lib/commissions";

export const saveListed = safe(async function saveListed(what: "part" | "unit", id: string, formData: FormData) {
  const user = await requireUser();
  const text = await setListedFor(user, what === "unit" ? "unit" : "part", id, formData);
  revalidatePath(what === "unit" ? `/units/${id}` : `/parts/${id}`);
  return noted(text);
});

export const saveCommission = safe(async function saveCommission(userId: string, formData: FormData) {
  const user = await requireUser();
  const text = await saveCommissionFor(user, userId, formData);
  revalidatePath("/paperwork/commissions");
  return noted(text);
});
