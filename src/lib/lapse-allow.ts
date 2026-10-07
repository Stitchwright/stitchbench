// What still works while the program itself is read-only (hub-accounts-billing-design.md 3.5 and decision 1): the
// company's "base" key has lapsed, so new tickets, sales, parts and edits are refused, and only what is listed here
// goes through. Pure: no "server-only", no database. scripts/checks/base-license.check.ts asserts every name exists.
//
// Server actions wrapped with safe() are refused by default while lapsed; one named here passes `{ whileLapsed }` to
// safe() with its own name (TypeScript holds it to this list), so the rule and the list can't drift apart.
export const WHILE_LAPSED = [
  // Passwords and logins (signing in and out are next-auth's, never actions); the resets of package hosted-provisioning:
  // forgot your password and its link, the administrator's reset link for an owner, and the Windows window's answer to
  // a reset asked for on the StitchHub account
  "changePassword",
  "resetUserPassword",
  "requestPasswordReset",
  "finishPasswordReset",
  "makeOwnerResetLink",
  "allowHubReset",
  "refuseHubReset",
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
  // Bookkeeping names and the "exported through" day: no business record changes
  "saveBooksSettings",
  "markBooksExported",
  // Off-site backup: never lost to a lapse (later-round-1-design.md 1.7)
  "makeOffsiteKey",
  "confirmOffsiteKey",
  "saveOffsiteTarget",
  "saveOffsiteBucket",
  "testOffsiteBucket",
  "turnOffsiteOff",
  "backUpNow",
  "testOffsiteKey",
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
  "orderRetry",
  "recordEstimateAnswer",
  // A customer's opt-out always works (the law says so), and so does noting that a reply was dealt with
  "recordOptOut",
  // A customer's request to be deleted is honoured like an opt-out, whatever the shop's standing
  "deleteCustomer",
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
  // The manual repository on a hosted install (the browser reads, hashes and sends the file): an offer or a download is new work
  "startHostedOffer",
  "finishHostedOffer",
  "failHostedOffer",
  "repositoryDownloadInfo",
  // Layaway money at the register (tax-machine-sales-layaway-design.md 4): a start refuses while lapsed, a payment and
  // a pick-up go through completeSaleAs, which refuses a sale and lets a return through
  "startLayaway",
  "payLayaway",
  "pickUpLayaway",
] as const;

/**
 * Hand-rolled actions that need no gate: they only read (searches, lookups, histories, lists for the register), or
 * they finish work already in (a part that came in for an open ticket, a ticket told ready or back at the counter, a
 * settings test message). The check script asserts that every exported action not wrapped with safe() is in BY_HAND
 * or here, so a new hand-rolled write can't slip past the rule unnoticed.
 */
export const HAND_ALLOWED = [
  "itemByCode",
  // A gift card or store credit looked up by its number (the register, the card page): reading is always allowed
  "giftCardByNumber",
  "findItems",
  "pickupJobs",
  "pickupJobByTag",
  "saleForReturn",
  "findCustomers",
  "customerTaxExempt",
  "bookingsDue",
  "findStockedParts",
  "findFabricItems",
  // The register's "Find a color" (shop-features-round-2-design.md 2.2): a lookup
  "findColors",
  // Help switching (shop-features-round-2-design.md 4.7): "See what will come in" only reads the file
  "previewSwitchFile",
  // What fits the customer's machines, and what goes with a machine being sold (2.4): lookups
  "fitsForCustomerNow",
  "fitsForUnitsNow",
  "readCatalogSheet",
  "previewCatalog",
  "openClassSeats",
  "barcodeDetails",
  "manualLinkHistory",
  "crossRefHistory",
  "vacSupplies",
  "customerVacuums",
  "unitsForSale",
  "unitsToReturn",
  // The register's layaway list and service plan choices: reads
  "openLayaways",
  "planChoices",
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
// the tray's removal of a moved company's old copy (/api/move/remove): it deletes, it writes nothing. And StitchHub's
// "Start a hosted shop" (/api/platform/companies): it makes another company, with the hub's token and no signed-in person.
export const ALSO_ALLOWED = [
  "/api/export/*",
  "/api/sales",
  "/api/reports/*",
  "/api/books/*",
  "/api/move/download/*",
  "/api/move/upload/*",
  "/api/move/local",
  "/api/move/remove",
  "/api/platform/companies",
  "hub sync",
  "partner sync",
  "backups",
  "sign in / out",
] as const;
