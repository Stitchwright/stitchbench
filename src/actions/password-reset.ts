"use server";

// Password links on the hosted service (package hosted-provisioning): "Forgot your password?", the page the link opens,
// and the StitchBench administrator's reset link for a company's owner. Bodies: src/lib/password-reset.ts. All of them
// work while the program is read-only (safe.whileLapsed): they are how someone gets back in.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { safe, shownOnce } from "@/lib/action";
import { clientAddress } from "@/lib/client-ip";
import { finishReset, ownerResetLinkFor, requestResetFor } from "@/lib/password-reset";
import { rememberThisDevice } from "@/lib/known-device";
import { assertId } from "@/lib/input";
import { requirePlatformAdmin } from "@/lib/session";

/** /reset: the email goes out after the answer, which is the same whether or not the address has a login. */
export const requestPasswordReset = safe.whileLapsed("requestPasswordReset")(async function requestPasswordReset(fd: FormData) {
  const r = requestResetFor(fd.get("email"), clientAddress(await headers()));
  r.work.catch(() => undefined);
});

/**
 * /reset?t=...: the new password, then the sign-in page. The browser the link was used in is known for that login from
 * now on (the link proved the mailbox), so the owner gets in there even while someone floods the account with wrong
 * passwords (src/lib/known-device.ts, round 3 M44).
 */
export const finishPasswordReset = safe.whileLapsed("finishPasswordReset")(async function finishPasswordReset(fd: FormData) {
  const { email } = await finishReset(fd.get("t"), fd.get("password"), fd.get("again"));
  await rememberThisDevice(email);
  redirect("/login?reset=1");
});

/** Companies: a one-hour reset link for a company's owner, shown once to the administrator to pass on. */
export const makeOwnerResetLink = safe.whileLapsed("makeOwnerResetLink")(async function makeOwnerResetLink(shopId: string) {
  const admin = await requirePlatformAdmin();
  return shownOnce(await ownerResetLinkFor(admin, assertId(shopId)));
});
