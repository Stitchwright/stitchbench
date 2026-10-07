"use server";

// Quilt appraisal certificates (shop-features-round-2-design.md 9.8, package appraisals). Bodies in src/lib/appraisals.ts.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { createAppraisalFor, issueAppraisalFor, removeAppraisalPhotoFor, saveAppraisalFor, saveAppraisalSettingsFor } from "@/lib/appraisals";

const refresh = (id?: string) => {
  revalidatePath("/appraisals", "layout");
  if (id) revalidatePath(`/appraisals/${id}`);
};

export const startAppraisal = safe(async function startAppraisal(formData: FormData) {
  const user = await requireUser();
  const r = await createAppraisalFor(user, formData);
  refresh();
  redirect(`/appraisals/${r.id}`);
});

export const saveAppraisal = safe(async function saveAppraisal(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await saveAppraisalFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const removeAppraisalPhoto = safe(async function removeAppraisalPhoto(id: string, photoId: string) {
  const user = await requireUser();
  const text = await removeAppraisalPhotoFor(user, photoId);
  refresh(id);
  return noted(text);
});

export const issueAppraisal = safe(async function issueAppraisal(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await issueAppraisalFor(user, id, formData);
  refresh(id);
  revalidatePath("/register/sales");
  return noted(text);
});

export const saveAppraisalSettings = safe(async function saveAppraisalSettings(formData: FormData) {
  const user = await requireUser();
  const text = await saveAppraisalSettingsFor(user, formData);
  refresh();
  return noted(text);
});
