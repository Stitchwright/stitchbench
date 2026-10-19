// The switch for signing in with a Foundry Account (docs/plan.md FA-2). Hosted editions only: the Windows/Mac/Linux program
// keeps its local logins (FA-3 adds an optional link there), so it is always "off".
//   FOUNDRY_SIGNIN unset or "off"  the sign-in page is exactly as it was
//   "on"                           the page offers the Foundry Account first and the old email and password beside it;
//                                  both work, and "Link my Foundry Account" connects a login to its account
//   "only"                         the old email and password no longer sign anyone in (they still prove who you are
//                                  when linking), and a session without a linked Foundry sign-in is ended
import { isDesktop } from "@/lib/modules";

export type FoundryMode = "off" | "on" | "only";

export function foundrySignInMode(): FoundryMode {
  if (isDesktop()) return "off";
  const v = (process.env.FOUNDRY_SIGNIN ?? "").trim().toLowerCase();
  return v === "on" || v === "only" ? v : "off";
}
