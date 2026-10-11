"use server";

// The Windows program's window answering a password reset asked for on the owner's StitchHub account (package
// hosted-provisioning; why each check: src/lib/hub-reset-grants.ts). Nobody need be signed in: the owner who forgot the
// password is at the PC's sign-in page. Only the program's own window can answer (X-Stitch-Window).
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { safe, shownOnce } from "@/lib/action";
import { answerResetGrant } from "@/lib/hub-reset-grants";
import { rememberThisDevice } from "@/lib/known-device";

/**
 * Allow: the owner's new password, shown once in the window. The reset ends every browser's standing with that login
 * (sessionVersion + 1), this window's too, so the window is known for it again at the new version, as the browser a
 * reset link was used in is: a device on the shop's network sending wrong passwords for the owner can't queue the new
 * password out on the PC itself (src/lib/known-device.ts, round 3 M44).
 */
export const allowHubReset = safe.whileLapsed("allowHubReset")(async function allowHubReset(id: string) {
  const done = await answerResetGrant(id, true, await headers());
  if (!done) return undefined;
  // The password is already set and is shown nowhere else: it reaches the window even if marking the window fails.
  await rememberThisDevice(done.userId).catch((e) => console.error(`[password] the program's window wasn't marked as known: ${e instanceof Error ? e.message : String(e)}`));
  return shownOnce(done.password);
});

export const refuseHubReset = safe.whileLapsed("refuseHubReset")(async function refuseHubReset(id: string) {
  await answerResetGrant(id, false, await headers());
  revalidatePath("/login");
});
