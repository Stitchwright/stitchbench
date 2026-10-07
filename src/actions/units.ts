"use server";

// Machines for sale (modules-design.md 10.c; every shop since tax-machine-sales-layaway-design.md section 3): the admin
// forms on /units, the warranty registration anyone records, "Put up for sale" on an abandoned machine, the maker's
// warranty terms and the shop's service plans (Settings), a ticket line covered by a plan, and the register's lookups.
// Bodies in src/lib/units/.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { safe, shownOnce } from "@/lib/action";
import { tradeInEstimate } from "@/lib/units/trade-in-value";
import { db } from "@/lib/db";
import { requireAdmin, requireUser } from "@/lib/session";
import {
  deleteMakerTermsFor,
  receiveUnitsFor,
  recordRegistrationFor,
  saveMakerTermsFor,
  setUnitOffSaleFor,
  unitFromAbandonedFor,
  unitsForSaleFor,
  unitsToReturnFor,
  updateUnitFor,
  type UnitForSale,
  type UnitToReturn,
} from "@/lib/units/units";
import { coverLineFor, endPlanFor, plansForRegister, savePlanFor } from "@/lib/units/plans";

function refresh(id?: string, machineId?: string) {
  revalidatePath("/units");
  if (id) revalidatePath(`/units/${id}`);
  if (machineId) revalidatePath(`/machines/${machineId}`);
}

export const receiveUnits = safe(async function receiveUnits(formData: FormData) {
  const user = await requireAdmin();
  const ids = await receiveUnitsFor(user, formData);
  refresh();
  redirect(ids.length === 1 ? `/units/${ids[0]}` : "/units?tab=stock");
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
  revalidatePath("/");
});

export const unitFromAbandoned = safe(async function unitFromAbandoned(machineId: string) {
  const user = await requireAdmin();
  const id = await unitFromAbandonedFor(user, machineId);
  refresh(id, machineId);
  redirect(`/units/${id}`);
});

export const saveMakerTerms = safe(async function saveMakerTerms(formData: FormData) {
  const user = await requireAdmin();
  await saveMakerTermsFor(user, formData);
  revalidatePath("/settings/sales");
});

export const deleteMakerTerms = safe(async function deleteMakerTerms(id: string) {
  const user = await requireAdmin();
  await deleteMakerTermsFor(user, id);
  revalidatePath("/settings/sales");
});

export const savePlan = safe(async function savePlan(id: string | null, formData: FormData) {
  const user = await requireAdmin();
  await savePlanFor(user, id, formData);
  revalidatePath("/settings/sales");
});

export const endPlan = safe(async function endPlan(machinePlanId: string) {
  const user = await requireAdmin();
  const machineId = await endPlanFor(user, machinePlanId);
  revalidatePath(`/machines/${machineId}`);
});

/** A ticket line covered by a plan on its machine, or (planId null) charged again. */
export const coverLine = safe(async function coverLine(lineId: string, machinePlanId: string | null) {
  const user = await requireUser();
  const ticketId = await coverLineFor(user, lineId, machinePlanId);
  revalidatePath(`/tickets/${ticketId}`);
});

/** In-stock units the register may sell (matching the search), of the kinds the shop may sell now. */
export async function unitsForSale(q: string): Promise<UnitForSale[]> {
  const user = await requireUser();
  return unitsForSaleFor(user.shopId, q);
}

/** Units this shop sold that may come back, with the most each refunds; any module state. */
export async function unitsToReturn(q: string): Promise<UnitToReturn[]> {
  const user = await requireUser();
  return unitsToReturnFor(user.shopId, q);
}

/** The register's "Service plan" picker: the plans on sale, and the customer's own machines a plan can be for. */
export async function planChoices(customerId: string | null): Promise<{ plans: Awaited<ReturnType<typeof plansForRegister>>; machines: { id: string; label: string }[] }> {
  const user = await requireUser();
  const [plans, machines] = await Promise.all([
    plansForRegister(user.shopId),
    customerId ? db.machine.findMany({ where: { shopId: user.shopId, customerId }, select: { id: true, brand: true, model: true, serial: true }, orderBy: { createdAt: "desc" }, take: 30 }) : [],
  ]);
  return { plans, machines: machines.map((m) => ({ id: m.id, label: `${m.brand} ${m.model}${m.serial ? ` S/N ${m.serial}` : ""}` })) };
}

/** The trade-in helper's "What is it worth?" (shop-features-round-2-design.md 5.4): the shop's own past sales and the rule. */
export const tradeInValue = safe(async function tradeInValue(kind: string | null, brand: string, model: string) {
  const user = await requireUser();
  return shownOnce(JSON.stringify(await tradeInEstimate(user.shopId, { kind, brand: String(brand ?? "").slice(0, 60), model: String(model ?? "").slice(0, 60) })));
});
