"use server";

// Warranty claims per maker (shop-features-round-2-design.md 9.1, package warranty-claims). Bodies in src/lib/warranty-claims.ts.
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { claimLineFor, fileClaimFor, recordClaimPaymentFor, refuseClaimFor, saveClaimFor, undoClaimStepFor } from "@/lib/warranty-claims";

const refresh = (id?: string) => {
  revalidatePath("/paperwork", "layout");
  if (id) revalidatePath(`/paperwork/warranty/${id}`);
};

/** A ticket line claimed from the maker (it then charges nothing), or charged to the customer again. */
export const claimLine = safe(async function claimLine(ticketId: string, lineId: string, claim: boolean) {
  const user = await requireUser();
  const text = await claimLineFor(user, lineId, claim);
  revalidatePath(`/tickets/${ticketId}`);
  refresh();
  return noted(text);
});

export const saveClaim = safe(async function saveClaim(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await saveClaimFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const fileClaim = safe(async function fileClaim(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await fileClaimFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const recordClaimPayment = safe(async function recordClaimPayment(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await recordClaimPaymentFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const refuseClaim = safe(async function refuseClaim(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await refuseClaimFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const undoClaimStep = safe(async function undoClaimStep(id: string) {
  const user = await requireUser();
  const text = await undoClaimStepFor(user, id);
  refresh(id);
  return noted(text);
});
