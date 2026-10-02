"use server";

// Central vac installs (modules-design.md 10.d): the New install form, the site's details and the power unit on a
// ticket. Bodies in src/lib/vac/installs.ts.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { createInstallFor, saveSiteFor, setPowerUnitFor } from "@/lib/vac/installs";

function refresh(ticketId?: string) {
  revalidatePath("/vac/installs");
  revalidatePath("/vac");
  revalidatePath("/calendar");
  if (ticketId) revalidatePath(`/tickets/${ticketId}`);
}

export const createInstall = safe(async function createInstall(formData: FormData) {
  const user = await requireUser();
  const { ticketId } = await createInstallFor(user, formData);
  refresh(ticketId);
  revalidatePath("/tickets");
  redirect(`/tickets/${ticketId}`);
});

export const saveSite = safe(async function saveSite(ticketId: string, formData: FormData) {
  const user = await requireUser();
  await saveSiteFor(user, ticketId, formData);
  refresh(ticketId);
});

export const setPowerUnit = safe(async function setPowerUnit(ticketId: string, formData: FormData) {
  const user = await requireUser();
  await setPowerUnitFor(user, ticketId, formData);
  refresh(ticketId);
  revalidatePath(`/tickets/${ticketId}/invoice`);
});
