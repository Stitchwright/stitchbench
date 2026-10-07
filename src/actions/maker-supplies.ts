"use server";

// Maker Shop's Supplies due list (shop-features-round-2-design.md 6.3). Bodies in src/lib/supplies-due.ts; each needs
// the Maker Shop module, and the send needs Marketing too. Refused while the program is read-only (safe(), no exception).
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { markSuppliesCalledFor, sendSuppliesRemindersFor, snoozeSuppliesFor, stopSuppliesFor } from "@/lib/supplies-due";

const refresh = () => revalidatePath("/maker", "layout");

export const markSuppliesCalled = safe(async function markSuppliesCalled(machineId: string, formData: FormData) {
  const user = await requireUser();
  const text = await markSuppliesCalledFor(user, machineId, formData);
  refresh();
  return noted(text);
});

export const snoozeSupplies = safe(async function snoozeSupplies(machineId: string) {
  const user = await requireUser();
  const text = await snoozeSuppliesFor(user, machineId);
  refresh();
  return noted(text);
});

export const stopSupplies = safe(async function stopSupplies(machineId: string, stopped: boolean) {
  const user = await requireUser();
  const text = await stopSuppliesFor(user, machineId, stopped);
  refresh();
  return noted(text);
});

export const sendSuppliesReminders = safe(async function sendSuppliesReminders() {
  const user = await requireUser();
  const r = await sendSuppliesRemindersFor(user);
  refresh();
  const parts = [`Queued ${r.queued}.`];
  if (r.skipped) parts.push(`${r.skipped} have no consent or no address: they stay on the list to call.`);
  if (r.already) parts.push(`${r.already} already had one queued.`);
  return noted(parts.join(" "));
});
