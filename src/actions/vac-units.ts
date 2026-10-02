"use server";

// Vacuums for sale (modules-design.md 10.c): the admin forms on /vac/units, the warranty registration anyone records,
// "Put up for sale" on an abandoned vacuum, and the register's two lookups. Bodies in src/lib/vac/units.ts.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { safe } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { receiveUnitsFor, recordRegistrationFor, setUnitOffSaleFor, unitFromAbandonedFor, unitsForSaleFor, unitsToReturnFor, updateUnitFor, type UnitForSale, type UnitToReturn } from "@/lib/vac/units";

function refresh(id?: string, machineId?: string) {
  revalidatePath("/vac");
  revalidatePath("/vac/units");
  if (id) revalidatePath(`/vac/units/${id}`);
  if (machineId) revalidatePath(`/machines/${machineId}`);
}

export const receiveUnits = safe(async function receiveUnits(formData: FormData) {
  const user = await requireAdmin();
  const ids = await receiveUnitsFor(user, formData);
  refresh();
  redirect(ids.length === 1 ? `/vac/units/${ids[0]}` : "/vac/units?tab=stock");
});

export const updateUnit = safe(async function updateUnit(id: string, formData: FormData) {
  const user = await requireAdmin();
  await updateUnitFor(user, id, formData);
  refresh(id);
});

export const setUnitOffSale = safe(async function setUnitOffSale(id: string, off: boolean, formData: FormData) {
  const user = await requireAdmin();
  await setUnitOffSaleFor(user, id, off, formData);
  refresh(id);
});

export const recordRegistration = safe(async function recordRegistration(id: string, formData: FormData) {
  const user = await requireUser();
  await recordRegistrationFor(user, id, formData);
  refresh(id);
});

export const unitFromAbandoned = safe(async function unitFromAbandoned(machineId: string) {
  const user = await requireAdmin();
  const id = await unitFromAbandonedFor(user, machineId);
  refresh(id, machineId);
  redirect(`/vac/units/${id}`);
});

/** In-stock units the register may sell (matching the search); [] when Vac Shop isn't active. */
export async function unitsForSale(q: string): Promise<UnitForSale[]> {
  const user = await requireUser();
  return unitsForSaleFor(user.shopId, q);
}

/** Units this shop sold that may come back, with the most each refunds; any module state. */
export async function unitsToReturn(q: string): Promise<UnitToReturn[]> {
  const user = await requireUser();
  return unitsToReturnFor(user.shopId, q);
}
