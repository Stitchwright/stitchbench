"use server";

// The Windows program's window answering a password reset asked for on the owner's StitchHub account (package
// hosted-provisioning; why each check: src/lib/hub-reset-grants.ts). Nobody need be signed in: the owner who forgot the
// password is at the PC's sign-in page. Only the program's own window can answer (X-Stitch-Window).
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { safe, shownOnce } from "@/lib/action";
import { answerResetGrant } from "@/lib/hub-reset-grants";

/** Allow: the owner's new password, shown once in the window. */
export const allowHubReset = safe.whileLapsed("allowHubReset")(async function allowHubReset(id: string) {
  const password = await answerResetGrant(id, true, await headers());
  return password ? shownOnce(password) : undefined;
});

export const refuseHubReset = safe.whileLapsed("refuseHubReset")(async function refuseHubReset(id: string) {
  await answerResetGrant(id, false, await headers());
  revalidatePath("/login");
});
