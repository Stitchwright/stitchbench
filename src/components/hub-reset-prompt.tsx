import "server-only";
import { headers } from "next/headers";
import { inProgramWindow, pendingResetGrants, pullResetGrantsSoon } from "@/lib/hub-reset-grants";
import { isDesktop } from "@/lib/modules";
import { HubResetDialog } from "./hub-reset-dialog";

/**
 * "StitchHub asks to reset <email>'s password: Allow / Refuse", in the Windows program's own window only (the sign-in
 * page and every page of the app): a request the owner made on their StitchHub account, for a company that allows it
 * (src/lib/hub-reset-grants.ts). Nothing is rendered anywhere else: a browser tab or a tablet never sees it. `pull`: the
 * sign-in page asks the hub now (at most every 30 seconds), where an owner who forgot the password waits; the app's
 * pages show what the sync brought.
 */
export async function HubResetPrompt({ pull = false }: { pull?: boolean }) {
  if (!isDesktop()) return null;
  if (!inProgramWindow(await headers())) return null;
  if (pull) await pullResetGrantsSoon();
  const grants = await pendingResetGrants();
  if (!grants.length) return null;
  return <HubResetDialog grants={grants} />;
}
