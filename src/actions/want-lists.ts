"use server";

// Want lists (shop-features-round-2-design.md 1.4): add a line to a customer's list, take one off, let her know an item
// is here. Bodies in src/lib/want-lists.ts.
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { str } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { addWantFor, doneWantFor, tellWantFor } from "@/lib/want-lists";

function refresh(customerId?: string | null) {
  revalidatePath("/want-lists");
  if (customerId) revalidatePath(`/customers/${customerId}`);
  revalidatePath("/");
}

export const addWant = safe(async function addWant(customerId: string, formData: FormData) {
  const words = await addWantFor(await requireUser(), { customerId, partId: str(formData.get("partId")), words: str(formData.get("words")), note: str(formData.get("note")) });
  refresh(customerId);
  return noted(words);
});

export const doneWant = safe(async function doneWant(id: string, customerId: string | null) {
  await doneWantFor(await requireUser(), id);
  refresh(customerId);
});

export const tellWant = safe(async function tellWant(id: string, customerId: string | null) {
  const words = await tellWantFor(await requireUser(), id);
  refresh(customerId);
  return noted(words);
});
