// The switches (docs/plan.md FA-2 to FA-5). The sign-in one is in switches.ts, pure, so the seed script can read it too.
import { isDesktop } from "@/lib/modules";

export { foundrySignInMode, type FoundryMode } from "./switches";

// The desktop program's optional link to a Foundry Account (docs/plan.md FA-3). Desktop only; hosted editions sign in with
// one (FOUNDRY_SIGNIN, see switches.ts) and are always "off" here.
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

// Where the Assistant's AI comes from (docs/plan.md FA-4), hosted and desktop alike.
//   FOUNDRY_AI unset or "off"  the Assistant goes through StitchHub's proxy exactly as before
//   "on"                       the program asks the AI itself, never through the hub: paid in Foundry credits through the
//                              Foundry Account service (the default), or with the company's own Anthropic key (Settings →
//                              Assistant). No call limit of ours, and no Assistant add-on key: the balance, or the shop's own
//                              Anthropic account, is the limit.
export { foundryAiOn } from "@/lib/free-program";
