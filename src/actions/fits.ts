"use server";

// Accessories that fit a machine (shop-features-round-2-design.md 2.4, package fits-machines): an item's models and fit
// groups, the fit groups themselves, and the register's lookups (what fits the customer's machines, what goes with a
// machine being sold). Bodies in src/lib/fits.ts. The lookups only read (lapse-allow.ts HAND_ALLOWED); the rest are
// edits, refused while the program is read-only (safe() with no exception).
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { addFitModelFor, deleteFitGroupFor, fitsForCustomer, fitsForUnits, removeFitModelFor, saveFitGroupFor, setFitGroupsFor, type MachineFits } from "@/lib/fits";

export const addFitModel = safe(async function addFitModel(partId: string, formData: FormData) {
  const user = await requireUser();
  const text = await addFitModelFor(user, partId, str(formData.get("brand")), str(formData.get("model")));
  revalidatePath(`/parts/${partId}`);
  return noted(text);
});

export const removeFitModel = safe(async function removeFitModel(partId: string, label: string) {
  const user = await requireUser();
  const text = await removeFitModelFor(user, partId, label);
  revalidatePath(`/parts/${partId}`);
  return noted(text);
});

export const setFitGroups = safe(async function setFitGroups(partId: string, formData: FormData) {
  const user = await requireUser();
  const text = await setFitGroupsFor(user, partId, formData.getAll("group").map(String));
  revalidatePath(`/parts/${partId}`);
  return noted(text);
});

export const saveFitGroup = safe(async function saveFitGroup(id: string | null, formData: FormData) {
  const user = await requireUser();
  const text = await saveFitGroupFor(user, id, formData);
  revalidatePath("/parts/fit-groups");
  return noted(text);
});

export const deleteFitGroup = safe(async function deleteFitGroup(id: string) {
  const user = await requireUser();
  const text = await deleteFitGroupFor(user, id);
  revalidatePath("/parts/fit-groups");
  return noted(text);
});

/** The register's quiet line: what is on the shelf that fits each of the customer's machines. */
export async function fitsForCustomerNow(customerId: string): Promise<MachineFits[]> {
  const user = await requireUser();
  return fitsForCustomer(user.shopId, String(customerId ?? ""));
}

/** The register's machine sale: what goes with each machine for sale on it. */
export async function fitsForUnitsNow(unitIds: string[]): Promise<MachineFits[]> {
  const user = await requireUser();
  return fitsForUnits(user.shopId, Array.isArray(unitIds) ? unitIds.map(String) : []);
}
