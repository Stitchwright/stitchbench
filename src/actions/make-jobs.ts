"use server";

// Print and cut jobs (shop-features-round-2-design.md 6.5, package make-jobs, Maker Shop). Bodies in src/lib/make-jobs.ts.
// Each is refused while the program is read-only (safe(), no exception), as the longarm's are.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { collectJobFor, createJobFor, saveJobFor, saveMakeSettingsFor, sendQuoteFor, setJobStatusFor, turnDownFor } from "@/lib/make-jobs";

const refresh = (id?: string) => {
  revalidatePath("/maker", "layout");
  if (id) revalidatePath(`/maker/jobs/${id}`);
};

export const startMakeJob = safe(async function startMakeJob(formData: FormData) {
  const user = await requireUser();
  const r = await createJobFor(user, formData);
  refresh();
  redirect(`/maker/jobs/${r.id}`);
});

export const saveMakeJob = safe(async function saveMakeJob(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await saveJobFor(user, id, formData);
  refresh(id);
  return noted(text);
});

export const setMakeJobStatus = safe(async function setMakeJobStatus(id: string, to: string) {
  const user = await requireUser();
  const text = await setJobStatusFor(user, id, to);
  refresh(id);
  return noted(text);
});

export const turnDownMakeJob = safe(async function turnDownMakeJob(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await turnDownFor(user, id, str(formData.get("why")) ?? "");
  refresh(id);
  return noted(text);
});

export const collectMakeJob = safe(async function collectMakeJob(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await collectJobFor(user, id, formData);
  refresh(id);
  revalidatePath("/register/sales");
  return noted(text);
});

export const sendMakeQuote = safe(async function sendMakeQuote(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await sendQuoteFor(user, id, { email: formData.get("email") === "on", sms: formData.get("sms") === "on", note: str(formData.get("note")) });
  refresh(id);
  return noted(text);
});

export const saveMakeSettings = safe(async function saveMakeSettings(formData: FormData) {
  const user = await requireUser();
  const text = await saveMakeSettingsFor(user, formData);
  refresh();
  return noted(text);
});
