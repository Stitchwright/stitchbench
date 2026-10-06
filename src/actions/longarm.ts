"use server";

// Longarm quilting (fabric-smarts-design.md section 4a, package F7): quilting work orders, their status, collecting (billed
// as a register sale), photos, and the "certified to rent" flag on a customer. Bodies in src/lib/longarm.ts. Refused while
// the program key has lapsed (safe() with no exception: new work).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { collectFor, createOrderFor, deletePhotoFor, saveOrderFor, setCertifiedFor, setStatusFor } from "@/lib/longarm";
import type { LongarmStatus } from "@/generated/prisma/enums";

const refresh = (id?: string) => {
  revalidatePath("/longarm");
  revalidatePath("/calendar");
  if (id) revalidatePath(`/longarm/${id}`);
};

export const startLongarmOrder = safe(async function startLongarmOrder(formData: FormData) {
  const user = await requireUser();
  const r = await createOrderFor(user, formData);
  refresh();
  redirect(`/longarm/${r.id}`);
});

export const saveLongarmOrder = safe(async function saveLongarmOrder(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await saveOrderFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const setLongarmStatus = safe(async function setLongarmStatus(id: string, to: LongarmStatus) {
  const user = await requireUser();
  const text = await setStatusFor(user, id, to);
  refresh(id);
  return noted(text);
});

export const collectLongarmOrder = safe(async function collectLongarmOrder(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await collectFor(user, id, formData);
  refresh(id);
  revalidatePath("/register/sales");
  return noted(text);
});

export const deleteLongarmPhoto = safe(async function deleteLongarmPhoto(id: string, photoId: string) {
  const user = await requireUser();
  await deletePhotoFor(user, photoId);
  refresh(id);
  return noted("Photo deleted.");
});

export const setLongarmCertified = safe(async function setLongarmCertified(customerId: string, on: boolean) {
  const user = await requireUser();
  const text = await setCertifiedFor(user, customerId, on);
  revalidatePath(`/customers/${customerId}`);
  return noted(text);
});
