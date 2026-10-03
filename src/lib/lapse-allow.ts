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
  // Moving the company to another install (company-move-design.md section 7): a lapsed company may leave, and Cancel
  // is what lifts the move's own freeze
  "startCompanyMove",
  "cancelCompanyMove",
  // The hub's part of a move (package move-hub): the old copy's "The move is done" (it is frozen), "Re-point the hub"
  // (the connection itself), and the administrator deleting an old copy 30 days on (as setCompanyModule)
  "confirmCompanyMoved",
  "repointCompanyHub",
  "removeMovedCompany",
] as const;

export type WhileLapsed = (typeof WHILE_LAPSED)[number];

/**
 * Server actions that aren't wrapped with safe() (they return data) and apply the rule in their own body, where the
 * line falls: setStatus allows a closing status, completeSale a return (every line a refund), the rest refuse while
 * lapsed. Named here so the check script can see each one exists and the list is in one place.
 */
export const BY_HAND = [
  "setStatus",
  "completeSale",
  "quickAddCustomer",
  "takeInMachine",
  "scanCode",
  "saveCounts",
  "enrollAtRegister",
  "makePartnerCode",
  "placePartnerOrder",
  // Stock received or recounted, imports, and marketing sends by hand are new work: refused while lapsed
  "moveStock",
  "importCustomers",
  "importItems",
  "sendCampaignTest",
  "sendBagReminders",
] as const;

/**
 * Hand-rolled actions that need no gate: they only read (searches, lookups, histories, lists for the register), or
 * they finish work already in (a part that came in for an open ticket, a ticket told ready or back at the counter, a
 * settings test message). The check script asserts that every exported action not wrapped with safe() is in BY_HAND
 * or here, so a new hand-rolled write can't slip past the rule unnoticed.
 */
export const HAND_ALLOWED = [
  "itemByCode",
  "findItems",
  "pickupJobs",
  "pickupJobByTag",
  "saleForReturn",
  "findCustomers",
  "bookingsDue",
  "findStockedParts",
  "openClassSeats",
  "barcodeDetails",
  "manualLinkHistory",
  "crossRefHistory",
  "vacSupplies",
  "customerVacuums",
  "unitsForSale",
  "unitsToReturn",
  "receiveWaits",
  "tellThenSendReady",
  "markBackAtCounter",
  "markManyBack",
  "sendTestMessage",
] as const;

/**
 * What else keeps working, outside actions: CSV exports (/api/export/*, /api/sales), printing, every page (read-only),
 * the background hub and partner syncs, the Windows program's backups and restore, signing in and out.
 * What stops: /api/photos (403), public online booking and the online shop (paused), the message worker (the company is
 * skipped, as modules-design.md 6.4 does for Scheduling and Marketing).
 */
// The StitchBench administrator's company import (/api/move/upload/*, the PC's /api/move/local) is outside the rule too:
// it makes another company, and the administrator's own standing is beside the point (as with setCompanyModule). So is
// the tray's removal of a moved company's old copy (/api/move/remove): it deletes, it writes nothing.
export const ALSO_ALLOWED = [
  "/api/export/*",
  "/api/sales",
  "/api/move/download/*",
  "/api/move/upload/*",
  "/api/move/local",
  "/api/move/remove",
  "hub sync",
  "partner sync",
  "backups",
  "sign in / out",
] as const;
