"use server";

// "What you repair" (modules-design.md 11.2): a company's own equipment kinds and which kind check-in opens on.
// Bodies in src/lib/equipment/shop-kinds.ts; every action is for owners and admins.
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireAdmin } from "@/lib/session";
import { saveCheckInKindFor, saveEquipmentKindFor, setKindActiveFor } from "@/lib/equipment/shop-kinds";

function refresh() {
  revalidatePath("/settings/equipment");
  revalidatePath("/tickets/new");
  revalidatePath("/");
}

export const saveEquipmentKind = safe(async function saveEquipmentKind(key: string | null, formData: FormData) {
  const user = await requireAdmin();
  await saveEquipmentKindFor(user, key, formData);
  refresh();
});

export const setKindActive = safe(async function setKindActive(key: string, active: boolean) {
  const user = await requireAdmin();
  await setKindActiveFor(user, key, active);
  refresh();
});

export const saveCheckInKind = safe(async function saveCheckInKind(formData: FormData) {
  const user = await requireAdmin();
  await saveCheckInKindFor(user, formData);
  refresh();
});
