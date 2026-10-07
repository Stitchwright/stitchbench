"use server";

// Co-op advertising and rebate claims (shop-features-round-2-design.md 9.2, package coop-claims). Bodies in src/lib/coop-claims.ts.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { createCoopFor, denyCoopFor, fileCoopFor, recordCoopPaymentFor, removeProofFor, saveCoopFor, undoCoopFor } from "@/lib/coop-claims";

const refresh = (id?: string) => {
  revalidatePath("/paperwork/coop", "layout");
  revalidatePath("/");
  if (id) revalidatePath(`/paperwork/coop/${id}`);
};

export const startCoop = safe(async function startCoop(formData: FormData) {
  const user = await requireUser();
  const r = await createCoopFor(user, formData);
  refresh();
  redirect(`/paperwork/coop/${r.id}`);
});

export const saveCoop = safe(async function saveCoop(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await saveCoopFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const removeCoopProof = safe(async function removeCoopProof(claimId: string, proofId: string) {
  const user = await requireUser();
  const text = await removeProofFor(user, proofId);
  refresh(claimId);
  return noted(text);
});

export const fileCoop = safe(async function fileCoop(id: string) {
  const user = await requireUser();
  const text = await fileCoopFor(user, id);
  refresh(id);
  return noted(text);
});

export const recordCoopPayment = safe(async function recordCoopPayment(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await recordCoopPaymentFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const denyCoop = safe(async function denyCoop(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await denyCoopFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const undoCoop = safe(async function undoCoop(id: string) {
  const user = await requireUser();
  const text = await undoCoopFor(user, id);
  refresh(id);
  return noted(text);
});
