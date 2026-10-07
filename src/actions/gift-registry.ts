"use server";

// Wish lists and gift registries (shop-features-round-2-design.md 9.9, package gift-registry). Bodies in src/lib/gift-registry.ts.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { addRegistryItemFor, createRegistryFor, registriesByName, removeRegistryItemFor, setRegistrySharedFor } from "@/lib/gift-registry";

const refresh = (id?: string) => {
  revalidatePath("/customers", "layout");
  if (id) revalidatePath(`/gift-lists/${id}`);
};

export const startGiftList = safe(async function startGiftList(customerId: string, formData: FormData) {
  const user = await requireUser();
  const r = await createRegistryFor(user, customerId, formData);
  refresh();
  redirect(`/gift-lists/${r.id}`);
});

export const addGiftListItem = safe(async function addGiftListItem(registryId: string, formData: FormData) {
  const user = await requireUser();
  const text = await addRegistryItemFor(user, registryId, formData);
  refresh(registryId);
  return noted(text);
});

export const removeGiftListItem = safe(async function removeGiftListItem(registryId: string, itemId: string) {
  const user = await requireUser();
  const text = await removeRegistryItemFor(user, itemId);
  refresh(registryId);
  return noted(text);
});

export const shareGiftList = safe(async function shareGiftList(registryId: string, shared: boolean) {
  const user = await requireUser();
  const text = await setRegistrySharedFor(user, registryId, shared);
  refresh(registryId);
  return noted(text);
});

/** The register's "Gift lists": a read. */
export async function findGiftLists(q: string) {
  const user = await requireUser();
  return registriesByName(user.shopId, String(q ?? ""));
}
