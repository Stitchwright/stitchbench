"use server";

// Decorating orders (docs/plans/decorators-proposal.md). Bodies in src/lib/decor.ts. Each is refused while the program is
// read-only (safe(), no exception), as the print and cut jobs' are.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { UserError } from "@/lib/user-error";
import { takeInboxItemFor } from "@/lib/decor-inbox";
import { addLineFor, addPlacementFor, collectOrderFor, createOrderFor, removeLineFor, removeMockupFor, removePlacementFor, requoteFor, saveDecorPricesFor, saveOrderFor, sendProofFor, setMockupFor, setOrderStatusFor, turnDownOrderFor } from "@/lib/decor";

const refresh = (id?: string) => {
  revalidatePath("/decorating", "layout");
  if (id) revalidatePath(`/decorating/${id}`);
};

export const startDecorOrder = safe(async function startDecorOrder(formData: FormData) {
  const user = await requireUser();
  // Started from a file waiting in the StitchFoundry inbox: the order is made and the file goes on it as its first decoration.
  const inboxItem = str(formData.get("inboxItem"));
  if (inboxItem) {
    const r = await takeInboxItemFor(user, inboxItem, { orderId: null, newOrder: formData, location: str(formData.get("location")) });
    refresh();
    redirect(`/decorating/${r.orderId}`);
  }
  const r = await createOrderFor(user, formData);
  refresh();
  redirect(`/decorating/${r.id}`);
});

export const takeInboxIntoOrder = safe(async function takeInboxIntoOrder(itemId: string, formData: FormData) {
  const user = await requireUser();
  const orderId = str(formData.get("orderId"));
  if (!orderId) throw new UserError("Pick an order first.");
  const r = await takeInboxItemFor(user, itemId, { orderId, newOrder: null, location: str(formData.get("location")) });
  refresh(r.orderId);
  return noted(r.text);
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

export const setDecorMockup = safe(async function setDecorMockup(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await setMockupFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const removeDecorMockup = safe(async function removeDecorMockup(id: string) {
  const user = await requireUser();
  const text = await removeMockupFor(user, id);
  refresh(id);
  return noted(text);
});

export const sendDecorProof = safe(async function sendDecorProof(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await sendProofFor(user, id, { email: formData.get("email") === "on", sms: formData.get("sms") === "on", note: str(formData.get("note")) });
  refresh(id);
  return noted(text);
});
