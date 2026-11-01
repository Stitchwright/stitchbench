// Demo mode (docs/demo.md): DEMO_MODE=on makes a server safe to show to the public. It is meant for a server of its own
// with its own database (the public demo shops, reset every night), never for a shop's real server. With it on:
//  - the actions that touch accounts, passwords, billing, the hub, backups, company setup and outside connections are
//    refused (DEMO_BLOCKED, enforced in safe(), src/lib/action.ts);
//  - nothing is sent by email or text (messagesSwitchedOff, used where MESSAGES=off is);
//  - the Assistant is switched off (assistantSwitchedOff, src/lib/assistant/client.ts), so it can never spend credits;
//  - uploads are limited to 1 MB (next.config.ts) and each visitor address has a limit on writes (demoAllowWrite, src/proxy.ts);
//  - a banner says what this is (src/components/demo-banner.tsx).
// Pure and dependency free: the proxy, the pages and the check scripts all import it. With DEMO_MODE unset nothing changes.

export const isDemo = (): boolean => (process.env.DEMO_MODE ?? "").trim().toLowerCase() === "on";

export const DEMO_REFUSAL = "That isn't available in the demo. Join the beta to try it in your own shop.";

/**
 * The server actions (their function names, which safe() reads) that a demo refuses. A name here that no action has is
 * caught by src/lib/demo-mode.test.ts, so the list can't drift from the code.
 */
export const DEMO_BLOCKED: readonly string[] = [
  // Passwords and people
  "changePassword", "resetUserPassword", "makeOwnerResetLink", "requestPasswordReset", "finishPasswordReset", "addUser", "setUserRole", "setUserActive",
  // StitchHub, the Foundry Account and licences
  "startHubAccount", "makeHubLinkCode", "refreshHubStanding", "setHubResetOptIn", "allowHubReset", "refuseHubReset",
  "joinCommunityHub", "syncCommunityHub", "setUsageSharing", "leaveCommunityHub",
  "linkFoundryAccount", "unlinkFoundryAccount", "checkFoundryAccount", "linkMyLogin", "activateLicense",
  // Companies and moving them
  "createCompany", "setCompanyModule", "setHubWrites", "startCompanyMove", "cancelCompanyMove", "confirmCompanyMoved", "repointCompanyHub", "removeMovedCompany",
  // Backups
  "makeOffsiteKey", "confirmOffsiteKey", "saveOffsiteTarget", "saveOffsiteBucket", "testOffsiteBucket", "turnOffsiteOff", "backUpNow", "testOffsiteKey",
  // Outside connections: mail and text providers, card reader, shipping labels, payment links, the Assistant's settings
  "saveEmailSettings", "saveTextSettings", "setSmsRegistered", "saveReaderSettings", "pairReader", "removeReader", "saveShippoSettings", "labelRates", "buyLabel",
  "sendPayLink", "resendPayLink", "saveAssistantSettings", "saveAssistantSource", "bringSwitchIn",
];

const BLOCKED = new Set(DEMO_BLOCKED);

/** Whether this server refuses the action of that name right now. */
export const demoRefuses = (actionName: string): boolean => isDemo() && BLOCKED.has(actionName);

/** The "MESSAGES=off" rule, plus every demo: no email or text ever leaves a demo. */
export const messagesSwitchedOff = (): boolean => process.env.MESSAGES === "off" || isDemo();

// ----- a limit on writes per visitor address (the proxy calls this for every POST on a demo) -----
const WRITES_PER_MINUTE = 90;
const hits = new Map<string, number[]>();

/** True while this address is within its writes per minute (and counts this one). Keeps at most 5 000 addresses. */
export function demoAllowWrite(address: string, now = Date.now()): boolean {
  const recent = (hits.get(address) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= WRITES_PER_MINUTE) {
    hits.set(address, recent);
    return false;
  }
  recent.push(now);
  hits.delete(address);
  hits.set(address, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value as string);
  return true;
}

/** The visitor's address as the proxy sees it: the first hop of X-Forwarded-For (Railway sets it), else "unknown". */
export const demoAddress = (forwardedFor: string | null): string => (forwardedFor ?? "").split(",")[0]?.trim() || "unknown";
