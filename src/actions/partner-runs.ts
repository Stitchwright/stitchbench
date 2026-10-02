"use server";

// Partner pickup runs (scheduling-messaging-design.md 13.5). Thin wrappers around src/lib/partner-run-actions.ts.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { kickPartnerSync } from "@/lib/partners";
import { cancelRunAs, changeRunAs, okRunAs, proposeRunAs, recordRunAs } from "@/lib/partner-run-actions";

function refresh(linkId: string) {
  revalidatePath(`/partners/${linkId}`, "layout");
  revalidatePath("/repairs", "layout");
  revalidatePath("/calendar", "layout");
  revalidatePath("/");
  kickPartnerSync();
}

export const proposeRun = safe(async function proposeRun(linkId: string, fd: FormData) {
  const user = await requireUser();
  const id = await proposeRunAs(user, linkId, fd);
  refresh(linkId);
  redirect(`/partners/${linkId}/runs/${id}`);
});

export const changeRun = safe(async function changeRun(linkId: string, runId: string, fd: FormData) {
  const user = await requireUser();
  await changeRunAs(user, linkId, runId, fd);
  refresh(linkId);
});

export const okRun = safe(async function okRun(linkId: string, runId: string) {
  const user = await requireUser();
  await okRunAs(user, linkId, runId);
  refresh(linkId);
});

export const cancelRun = safe(async function cancelRun(linkId: string, runId: string, fd: FormData) {
  const user = await requireUser();
  await cancelRunAs(user, linkId, runId, fd);
  refresh(linkId);
});

export const recordRun = safe(async function recordRun(linkId: string, runId: string, fd: FormData) {
  const user = await requireUser();
  await recordRunAs(user, linkId, runId, fd);
  refresh(linkId);
});
