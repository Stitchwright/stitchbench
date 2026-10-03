"use server";

// The online shop's staff side (online-and-parts-design.md section 3): Settings -> Online shop, an item's listing and
// photos on the part page, and the orders screen. Bodies in src/lib/shop/online-shop.ts.
import { revalidatePath } from "next/cache";
import { safe, UserError } from "@/lib/action";
import { str } from "@/lib/format";
import { requireAdmin, requireUser } from "@/lib/session";
import { addPhotoFor, cancelOrderFor, markDoneFor, markReadyFor, noteOrderFor, removePhotoFor, retryOrderFor, saveListingFor, saveShopSettingsFor } from "@/lib/shop/online-shop";

export const saveShopSettings = safe(async function saveShopSettings(formData: FormData) {
  const user = await requireAdmin();
  await saveShopSettingsFor(user, formData);
  revalidatePath("/settings/shop");
  revalidatePath("/settings");
});

export const saveListing = safe(async function saveListing(partId: string, formData: FormData) {
  const user = await requireUser();
  await saveListingFor(user, partId, formData);
  revalidatePath(`/parts/${partId}`);
});

export const addPhoto = safe(async function addPhoto(partId: string, formData: FormData) {
  const user = await requireUser();
  const file = formData.get("photo");
  if (!(file instanceof File) || !file.size) throw new UserError("Choose a photo first.");
  await addPhotoFor(user, partId, file);
  revalidatePath(`/parts/${partId}`);
});

export const removePhoto = safe(async function removePhoto(partId: string, photoId: string) {
  const user = await requireUser();
  await removePhotoFor(user, photoId);
  revalidatePath(`/parts/${partId}`);
});

export const orderReady = safe.whileLapsed("orderReady")(async function orderReady(orderId: string) {
  const user = await requireUser();
  await markReadyFor(user, orderId);
  revalidatePath("/register/online");
});

export const orderDone = safe.whileLapsed("orderDone")(async function orderDone(orderId: string, formData: FormData) {
  const user = await requireUser();
  await markDoneFor(user, orderId, { tracking: str(formData.get("tracking")) });
  revalidatePath("/register/online");
});

export const orderCancel = safe.whileLapsed("orderCancel")(async function orderCancel(orderId: string, formData: FormData) {
  const user = await requireUser();
  await cancelOrderFor(user, orderId, str(formData.get("reason")) ?? "");
  revalidatePath("/register/online");
});

export const orderRetry = safe.whileLapsed("orderRetry")(async function orderRetry(orderId: string) {
  const user = await requireUser();
  await retryOrderFor(user, orderId);
  revalidatePath("/register/online");
  revalidatePath("/register", "layout");
  revalidatePath("/parts", "layout");
});

export const orderNote = safe(async function orderNote(orderId: string, formData: FormData) {
  const user = await requireUser();
  await noteOrderFor(user, orderId, str(formData.get("note")) ?? "");
  revalidatePath("/register/online");
});
