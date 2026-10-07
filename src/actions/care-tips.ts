"use server";
// Care tips and the pickup sheet (shop-features-round-2-design.md 5.5): Settings → Care tips (owners and admins) and
// a ticket's pickup sheet ("What we did" and the tips ticked, printed with the invoice). Bodies in src/lib/care-tips.ts.
import { revalidatePath } from "next/cache";
import { noted, safe, shownOnce } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { addCareTipFor, addStartersFor, removeCareTipFor, restoreCareTipFor, savePickupSheetFor } from "@/lib/care-tips";

export const addCareTip = safe(async (kind: string, fd: FormData) => {
  const user = await requireUser();
  await addCareTipFor(user, kind, String(fd.get("text") ?? ""));
  revalidatePath("/settings/care-tips");
});

/** Removes a tip; the page's Undo puts it back with what this returns. */
export const removeCareTip = safe(async (id: string) => {
  const user = await requireUser();
  const r = await removeCareTipFor(user, id);
  revalidatePath("/settings/care-tips");
  return shownOnce(JSON.stringify(r));
});

export const restoreCareTip = safe(async (o: { kind: string; text: string; sortOrder: number }) => {
  const user = await requireUser();
  await restoreCareTipFor(user, o);
  revalidatePath("/settings/care-tips");
});

export const addStarterTips = safe(async (kind: string) => {
  const user = await requireUser();
  const n = await addStartersFor(user, kind);
  revalidatePath("/settings/care-tips");
  return noted(`Added ${n} starter tips. Change any you like.`);
});

/** The pickup sheet on a ticket: "What we did" and the tips ticked. */
export const savePickupSheet = safe(async (ticketId: string, fd: FormData) => {
  const user = await requireUser();
  await savePickupSheetFor(user, ticketId, { what: String(fd.get("pickupWhat") ?? ""), tipIds: fd.getAll("tip").map(String) });
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath(`/tickets/${ticketId}/invoice`);
});
