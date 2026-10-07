"use server";

// Customers' used machines on consignment (shop-features-round-2-design.md 9.6, package consign-machines). Bodies in src/lib/consign-machines.ts.
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { giveBackFor, payOutFor, saveConsignDefaultFor, setConsignFor, undoPayoutFor } from "@/lib/consign-machines";

const refresh = (unitId?: string) => {
  revalidatePath("/paperwork/consign", "layout");
  revalidatePath("/customers", "layout");
  if (unitId) revalidatePath(`/units/${unitId}`);
};

export const setConsign = safe(async function setConsign(unitId: string, formData: FormData) {
  const user = await requireUser();
  const text = await setConsignFor(user, unitId, formData);
  refresh(unitId);
  return noted(text);
});

export const giveBackConsigned = safe(async function giveBackConsigned(unitId: string) {
  const user = await requireUser();
  const text = await giveBackFor(user, unitId);
  refresh(unitId);
  revalidatePath("/units");
  return noted(text);
});

export const payConsignor = safe(async function payConsignor(payoutId: string, formData: FormData) {
  const user = await requireUser();
  const text = await payOutFor(user, payoutId, formData);
  refresh();
  return noted(text);
});

export const undoConsignorPayment = safe(async function undoConsignorPayment(payoutId: string) {
  const user = await requireUser();
  const text = await undoPayoutFor(user, payoutId);
  refresh();
  return noted(text);
});

export const saveConsignDefault = safe(async function saveConsignDefault(formData: FormData) {
  const user = await requireUser();
  const text = await saveConsignDefaultFor(user, formData);
  refresh();
  return noted(text);
});
