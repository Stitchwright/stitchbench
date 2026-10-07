"use server";

// Certified on the shop's machines (shop-features-round-2-design.md 6.4). Body in src/lib/certifications.ts: owner or
// admin; anything but the longarm needs Maker Shop. Refused while the program is read-only (safe(), no exception).
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { setCertificationFor } from "@/lib/certifications";

export const certify = safe(async function certify(customerId: string, formData: FormData) {
  const user = await requireUser();
  const text = await setCertificationFor(user, customerId, str(formData.get("equipment")) ?? "", true);
  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/maker/space");
  return noted(text);
});

export const uncertify = safe(async function uncertify(customerId: string, equipment: string) {
  const user = await requireUser();
  const text = await setCertificationFor(user, customerId, equipment, false);
  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/maker/space");
  return noted(text);
});
