"use server";

// Marketing campaigns (scheduling-messaging-design.md 11.2). Every action is requireAdmin() + requireOn(user,
// "marketing") except cancelCampaign (an admin may always stop what is going out). The work is in
// src/lib/messaging/campaigns.ts.
import { redirect } from "next/navigation";
import { requireBaseWritable } from "@/lib/base-gate";
import { revalidatePath } from "next/cache";
import { isUserError, safe, type ActionResult } from "@/lib/action";
import { assertId } from "@/lib/input";
import { requireAdmin } from "@/lib/session";
import { requireOn } from "@/lib/module-gate";
import { cancelCampaignAs, copyCampaignAs, deleteCampaignAs, queueCampaignAs, saveCampaignAs, sendCampaignTestAs } from "@/lib/messaging/campaigns";

function refresh(id?: string) {
  revalidatePath("/campaigns");
  if (id) revalidatePath(`/campaigns/${id}`);
  revalidatePath("/messages");
}

async function marketingAdmin() {
  const user = await requireAdmin();
  await requireOn(user, "marketing");
  return user;
}

/** Save a draft; a new one goes to its page. */
export const saveCampaign = safe(async function saveCampaign(id: string | null, fd: FormData) {
  const user = await marketingAdmin();
  const saved = await saveCampaignAs(user, id ? assertId(id) : null, fd);
  refresh(saved);
  if (!id) redirect(`/campaigns/${saved}`);
});

/** "Send me a test": the detail comes back as the toast ("Sent to ..."). */
export async function sendCampaignTest(id: string, fd: FormData): Promise<ActionResult> {
  try {
    const user = await marketingAdmin();
    await requireBaseWritable(user);
    const detail = await sendCampaignTestAs(user, assertId(id), fd);
    return { ok: true, note: detail };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

/** "Send now" (the second tap): `confirm` is the count the page showed. */
export const queueCampaign = safe(async function queueCampaign(id: string, fd: FormData) {
  const user = await marketingAdmin();
  await queueCampaignAs(user, assertId(id), fd);
  refresh(id);
});

/** "Cancel what hasn't gone out". Not module-gated: stopping sends is always allowed. */
export const cancelCampaign = safe(async function cancelCampaign(id: string) {
  const user = await requireAdmin();
  await cancelCampaignAs(user, assertId(id));
  refresh(id);
});

export const copyCampaign = safe(async function copyCampaign(id: string) {
  const user = await marketingAdmin();
  const made = await copyCampaignAs(user, assertId(id));
  refresh();
  redirect(`/campaigns/${made}`);
});

export const deleteCampaign = safe(async function deleteCampaign(id: string) {
  const user = await marketingAdmin();
  await deleteCampaignAs(user, assertId(id));
  refresh();
  redirect("/campaigns");
});
