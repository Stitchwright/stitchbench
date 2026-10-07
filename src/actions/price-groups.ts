"use server";

// Customer price groups, memberships and the lifetime discount (shop-features-round-2-design.md 1.5): Settings → Prices,
// a customer's group on her page, an item that sells a membership, a machine's lifetime discount. Bodies in
// src/lib/price-groups.ts.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { str } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { saveGroupFor, saveLifetimeDefaultFor, saveMembershipItemFor, setCustomerGroupFor } from "@/lib/price-groups";

export const savePriceGroup = safe(async function savePriceGroup(id: string | null, formData: FormData) {
  await saveGroupFor(await requireUser(), formData, id);
  revalidatePath("/settings/prices");
});

export const saveLifetimeDefault = safe(async function saveLifetimeDefault(formData: FormData) {
  await saveLifetimeDefaultFor(await requireUser(), formData);
  revalidatePath("/settings/prices");
});

export const setCustomerGroup = safe(async function setCustomerGroup(customerId: string, formData: FormData) {
  await setCustomerGroupFor(await requireUser(), customerId, formData);
  revalidatePath(`/customers/${customerId}`);
});

export const saveMembershipItem = safe(async function saveMembershipItem(partId: string, formData: FormData) {
  await saveMembershipItemFor(await requireUser(), partId, formData);
  revalidatePath(`/parts/${partId}`);
});

/** A machine for sale's lifetime discount on its supplies (owner or admin): ticked with the percent, or off. */
export const saveUnitLifetime = safe(async function saveUnitLifetime(unitId: string, formData: FormData) {
  const user = await requireUser();
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  const on = formData.get("on") != null;
  const pct = Number(str(formData.get("pct"))?.replace(/%$/, "") ?? "");
  if (on && (!Number.isInteger(pct) || pct < 1 || pct > 90)) throw new UserError("Lifetime discount: a whole percent from 1 to 90.");
  const r = await db.stockUnit.updateMany({ where: { id: unitId, shopId: user.shopId }, data: { lifetimePctOff: on ? pct : null } });
  if (!r.count) throw new UserError("Machine not found.");
  revalidatePath(`/units/${unitId}`);
});
