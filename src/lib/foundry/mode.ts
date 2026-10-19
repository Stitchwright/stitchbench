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

// The desktop program's optional link to a Foundry Account (docs/plan.md FA-3). Desktop only; hosted editions sign in with
// one (FOUNDRY_SIGNIN above) and are always "off" here.
//   FOUNDRY_LINK unset or "off"  nothing shows and nothing changes
//   "offer"                      Settings → Foundry Account lets the owner link; nothing depends on it
//   "required"                   the community hub, partner shops and the Assistant need the link; the rest of the program
//                                (tickets, register, stock, printing, manuals) never does, online or not
export type FoundryLinkMode = "off" | "offer" | "required";

export function foundryLinkMode(): FoundryLinkMode {
  if (!isDesktop()) return "off";
  const v = (process.env.FOUNDRY_LINK ?? "").trim().toLowerCase();
  return v === "offer" || v === "required" ? v : "off";
}
