"use server";

// Parts a ticket is waiting for (online-and-parts-design.md section 1): the ticket's card and the Parts on order page.
// Bodies in src/lib/part-waits.ts.
import { revalidatePath } from "next/cache";
import { isUserError, safe, type ActionResult } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { addWaitFor, cancelWaitFor, receiveWaitsFor, reopenWaitFor } from "@/lib/part-waits";

function refresh(ticketId?: string) {
  revalidatePath("/parts/on-order");
  revalidatePath("/");
  if (ticketId) revalidatePath(`/tickets/${ticketId}`);
}

export const addWait = safe(async function addWait(ticketId: string, formData: FormData) {
  const user = await requireUser();
  await addWaitFor(user, ticketId, formData);
  refresh(ticketId);
});

/** One wait, or several at once (the ids come from the form's `wait` checkboxes when `waitId` is null). The toast says who hears. */
export async function receiveWaits(waitId: string | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const ids = waitId ? [waitId] : formData.getAll("wait").map(String);
    const r = await receiveWaitsFor(user, ids, formData);
    refresh();
    revalidatePath("/tickets", "layout");
    return { ok: true, ...(r.queued || !/call|Not sent/i.test(r.words) ? { note: r.words } : { warn: r.words }) };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

export const reopenWait = safe(async function reopenWait(waitId: string) {
  const user = await requireUser();
  await reopenWaitFor(user, waitId);
  refresh();
  revalidatePath("/tickets", "layout");
});

export const cancelWait = safe(async function cancelWait(waitId: string, formData: FormData) {
  const user = await requireUser();
  await cancelWaitFor(user, waitId, formData);
  refresh();
  revalidatePath("/tickets", "layout");
});
