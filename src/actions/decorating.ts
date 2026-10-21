"use server";

// Decorating orders (docs/plans/decorators-proposal.md). Bodies in src/lib/decor.ts. Each is refused while the program is
// read-only (safe(), no exception), as the print and cut jobs' are.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { addLineFor, addPlacementFor, collectOrderFor, createOrderFor, removeLineFor, removePlacementFor, requoteFor, saveDecorPricesFor, saveOrderFor, setOrderStatusFor, turnDownOrderFor } from "@/lib/decor";

const refresh = (id?: string) => {
  revalidatePath("/decorating", "layout");
  if (id) revalidatePath(`/decorating/${id}`);
};

export const startDecorOrder = safe(async function startDecorOrder(formData: FormData) {
  const user = await requireUser();
  const r = await createOrderFor(user, formData);
  refresh();
  redirect(`/decorating/${r.id}`);
});

export const saveDecorOrder = safe(async function saveDecorOrder(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await saveOrderFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const addDecorLine = safe(async function addDecorLine(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await addLineFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const removeDecorLine = safe(async function removeDecorLine(id: string, lineId: string) {
  const user = await requireUser();
  const text = await removeLineFor(user, id, lineId);
  refresh(id);
  return noted(text);
});

export const addDecorPlacement = safe(async function addDecorPlacement(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await addPlacementFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const removeDecorPlacement = safe(async function removeDecorPlacement(id: string, placementId: string) {
  const user = await requireUser();
  const text = await removePlacementFor(user, id, placementId);
  refresh(id);
  return noted(text);
});

export const requoteDecorOrder = safe(async function requoteDecorOrder(id: string) {
  const user = await requireUser();
  const text = await requoteFor(user, id);
  refresh(id);
  return noted(text);
});

export const setDecorStatus = safe(async function setDecorStatus(id: string, to: string) {
  const user = await requireUser();
  const text = await setOrderStatusFor(user, id, to);
  refresh(id);
  return noted(text);
});

export const turnDownDecorOrder = safe(async function turnDownDecorOrder(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await turnDownOrderFor(user, id, str(formData.get("why")) ?? "");
  refresh(id);
  return noted(text);
});

export const collectDecorOrder = safe(async function collectDecorOrder(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await collectOrderFor(user, id, formData);
  refresh(id);
  revalidatePath("/register/sales");
  return noted(text);
});

export const saveDecorPrices = safe(async function saveDecorPrices(formData: FormData) {
  const user = await requireUser();
  const text = await saveDecorPricesFor(user, formData);
  refresh();
  return noted(text);
});
