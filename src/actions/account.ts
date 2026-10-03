"use server";

// Settings → Account: the company's StitchHub account (hub-accounts-billing-design.md 2.2). Bodies: src/lib/hub-account.ts.
// Every one of these works while the program is read-only (safe.whileLapsed): they are the way back to a working program.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { safe } from "@/lib/action";
import { linkCodeFor, refreshStandingFor, setResetOptInFor, startHubAccountFor } from "@/lib/hub-account";
import { requireUser } from "@/lib/session";

function refresh() {
  revalidatePath("/", "layout");
}

/** Door 1: start the account with the owner's email (or send the email again). */
export const startHubAccount = safe.whileLapsed("startHubAccount")(async function startHubAccount(fd: FormData) {
  await startHubAccountFor(await requireUser(), fd);
  refresh();
});

/** Door 2: a link code for 15 minutes, shown on the page (it rides in the address, where only this browser sees it). */
export const makeHubLinkCode = safe.whileLapsed("makeHubLinkCode")(async function makeHubLinkCode() {
  const r = await linkCodeFor(await requireUser());
  redirect(`/settings/account?code=${encodeURIComponent(r.code)}&until=${encodeURIComponent(r.expiresAt)}`);
});

export const refreshHubStanding = safe.whileLapsed("refreshHubStanding")(async function refreshHubStanding() {
  await refreshStandingFor(await requireUser());
  refresh();
});

export const setHubResetOptIn = safe.whileLapsed("setHubResetOptIn")(async function setHubResetOptIn(on: boolean) {
  await setResetOptInFor(await requireUser(), on);
  revalidatePath("/settings/account");
});
