// The Foundry switches that need nothing else: pure, so the seed script (which runs without server-only support) and the
// pages read the same rule. mode.ts re-exports these with the rest (docs/plan.md FA-2, FA-5).
//   FOUNDRY_SIGNIN unset or "off"  the sign-in page and every session behave exactly as before
//   "on"                           the Foundry Account beside the old email and password; both work; a login is linked at /login/link
//   "only"                         the old email and password no longer sign anyone in, and no local password is asked for or handed out:
//                                  new logins come in by a one-time link that links a Foundry Account (FA-5)
// Hosted editions only: the Windows/Mac/Linux program (STITCH_DESKTOP=1) keeps its local logins and is always "off".
export type FoundryMode = "off" | "on" | "only";

export function foundrySignInMode(): FoundryMode {
  if (process.env.STITCH_DESKTOP === "1") return "off";
  const v = (process.env.FOUNDRY_SIGNIN ?? "").trim().toLowerCase();
  return v === "on" || v === "only" ? v : "off";
}
