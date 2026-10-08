"use server";
// Customer questions (shop-features-round-2-design.md 5.6): Settings → Customer questions (owners and admins: the switch,
// the day's cap for typed questions, the opening hours, the phone-answering service's key) and the Customer questions
// list (everyone: mark one answered, with Undo). Bodies in src/lib/customer-answers.ts.
import { revalidatePath } from "next/cache";
import { safe, shownOnce } from "@/lib/action";
import { hoursFromForm } from "@/lib/appointments";
import { requireAdmin, requireUser } from "@/lib/session";
import { makeStatusKeyFor, markQuestionFor, removeStatusKeyFor, saveCustomerAnswersFor } from "@/lib/customer-answers";

export const saveCustomerAnswers = safe(async (fd: FormData) => {
  const user = await requireAdmin();
  await saveCustomerAnswersFor(user, { on: fd.get("customerOn") === "on", cap: fd.get("customerDailyCap") ?? 20, hours: hoursFromForm(fd), hoursNote: fd.get("hoursNote") });
  revalidatePath("/settings/customer-questions");
});

/** A new key for the phone-answering service, shown once. */
export const makeStatusKey = safe(async () => {
  const user = await requireAdmin();
  const key = await makeStatusKeyFor(user);
  revalidatePath("/settings/customer-questions");
  return shownOnce(key);
});

export const removeStatusKey = safe(async () => {
  const user = await requireAdmin();
  await removeStatusKeyFor(user);
  revalidatePath("/settings/customer-questions");
});

/** Mark a customer's question answered (true), or back to waiting (false: the Undo). */
export const markQuestion = safe(async (id: string, handled: boolean) => {
  const user = await requireUser();
  await markQuestionFor(user, id, handled === true);
  revalidatePath("/customer-questions");
});
