// What still works while the program itself is read-only (hub-accounts-billing-design.md 3.5 and decision 1): the
// company's "base" key has lapsed, so new tickets, sales, parts and edits are refused, and only what is listed here
// goes through. Pure: no "server-only", no database. scripts/checks/base-license.check.ts asserts every name exists.
//
// Server actions wrapped with safe() are refused by default while lapsed; one named here passes `{ whileLapsed }` to
// safe() with its own name (TypeScript holds it to this list), so the rule and the list can't drift apart.
export const WHILE_LAPSED = [
  // Passwords and logins (signing in and out are next-auth's, never actions)
  "changePassword",
  "resetUserPassword",
  // Settings → Account: the way back to a working program
  "startHubAccount",
  "makeHubLinkCode",
  "refreshHubStanding",
  "setHubResetOptIn",
  // A key pasted from the hub's email (or the owner's) switches the program back on
  "activateLicense",
  // The hosted StitchBench administrator's switch and sharing mute (their own company's standing is beside the point)
  "setCompanyModule",
  "setHubWrites",
  // Payments, returns and voids
  "addPayment",
  "removePayment",
  "voidSale",
  // Finishing and closing what is open: partner repairs picked up, marketplace and partner orders moved along, web
  // orders handed over or cancelled, a customer's answer to an estimate written down
  "markPickedUp",
  "orderAction",
  "partnerOrderAction",
  "orderReady",
  "orderDone",
  "orderCancel",
  "recordEstimateAnswer",
  // A customer's opt-out always works (the law says so), and so does noting that a reply was dealt with
  "recordOptOut",
  "withdrawTextConsent",
  "markReplyHandled",
  // Hub sync and the connection itself
  "syncCommunityHub",
  "joinCommunityHub",
  "leaveCommunityHub",
  "syncPartnersNow",
  "refreshOrders",
] as const;

export type WhileLapsed = (typeof WHILE_LAPSED)[number];

/**
 * Server actions that aren't wrapped with safe() (they return data) and apply the rule in their own body, where the
 * line falls: setStatus allows a closing status, completeSale a return (every line a refund), the rest refuse while
 * lapsed. Named here so the check script can see each one exists and the list is in one place.
 */
export const BY_HAND = ["setStatus", "completeSale", "quickAddCustomer", "takeInMachine", "scanCode", "saveCounts", "enrollAtRegister", "makePartnerCode", "placePartnerOrder"] as const;

/**
 * What else keeps working, outside actions: CSV exports (/api/export/*, /api/sales), printing, every page (read-only),
 * the background hub and partner syncs, the Windows program's backups and restore, signing in and out.
 * What stops: /api/photos (403), public online booking and the online shop (paused), the message worker (the company is
 * skipped, as modules-design.md 6.4 does for Scheduling and Marketing).
 */
export const ALSO_ALLOWED = ["/api/export/*", "/api/sales", "hub sync", "partner sync", "backups", "sign in / out"] as const;
