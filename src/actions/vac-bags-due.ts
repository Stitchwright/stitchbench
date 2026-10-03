"use server";

// "Bags due" (modules-design.md 10.c′): the call list's marks, the days-between-bags setting and the one-off send.
// Bodies in src/lib/vac/bags-due.ts.
import { revalidatePath } from "next/cache";
import { requireBaseWritable } from "@/lib/base-gate";
import { isUserError, safe, type ActionResult } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { bagsSendWords, markCalledFor, saveBagDaysFor, sendBagRemindersFor, snoozeBagsFor, stopBagsFor } from "@/lib/vac/bags-due";

const refresh = () => {
  revalidatePath("/vac/bags-due");
  revalidatePath("/vac");
};

export const markCalled = safe(async function markCalled(machineId: string, formData: FormData) {
  const user = await requireUser();
  await markCalledFor(user, machineId, formData);
  refresh();
});

export const snoozeBags = safe(async function snoozeBags(machineId: string) {
  const user = await requireUser();
  await snoozeBagsFor(user, machineId);
  refresh();
});

export const stopBags = safe(async function stopBags(machineId: string) {
  const user = await requireUser();
  await stopBagsFor(user, machineId);
  refresh();
});

export const saveBagDays = safe(async function saveBagDays(formData: FormData) {
  const user = await requireAdmin();
  await saveBagDaysFor(user, formData);
  refresh();
});

/** The toast says what went out and who stays on the list. */
export async function sendBagReminders(): Promise<ActionResult> {
  try {
    const user = await requireAdmin();
    await requireBaseWritable(user);
    const r = await sendBagRemindersFor(user);
    refresh();
    return { ok: true, ...(r.skipped ? { warn: bagsSendWords(r) } : { note: bagsSendWords(r) }) };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}
