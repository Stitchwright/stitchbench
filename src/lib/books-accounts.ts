// The bookkeeping export's accounts (later-round-1-design.md 3.4). Pure: no database, so the settings page, the builder and
// the check share one list. Each key has a default name the bookkeeper can rename in Settings -> Bookkeeping.

export const ACCOUNT_KEYS = [
  { key: "undeposited", label: "Cash, check and other money taken", def: "Undeposited Funds" },
  { key: "stripe", label: "Paid online (Stripe)", def: "Stripe Clearing" },
  { key: "giftLiability", label: "Gift cards owed", def: "Gift Card Liability" },
  { key: "creditLiability", label: "Store credit owed", def: "Store Credit Liability" },
  { key: "giftAdjust", label: "Gift card and credit adjustments (balance fixed by hand)", def: "Gift Card Adjustments" },
  { key: "sales", label: "Counter sales", def: "Sales" },
  { key: "discounts", label: "Discounts given", def: "Discounts Given" },
  { key: "salesTax", label: "Sales tax collected", def: "Sales Tax Payable" },
  { key: "repairClearing", label: "Repair payments taken, until the machine goes home", def: "Repair Tickets Clearing" },
  { key: "repairIncome", label: "Repair income", def: "Repair Income" },
  { key: "receivable", label: "Bills put on a trade account", def: "Accounts Receivable" },
  { key: "dueFromPartners", label: "Collected for us by a partner shop", def: "Due from Partner Shops" },
  { key: "dueToPartners", label: "Partner repair bills taken at the counter", def: "Due to Partner Shops" },
  { key: "tradeIns", label: "Trade-in credit given", def: "Trade-in Purchases" },
  { key: "customerDeposits", label: "Money held for customers (layaway payments)", def: "Customer Deposits" },
  { key: "lenderReceivable", label: "Owed by lenders (financed sales not paid yet)", def: "Due from Lenders" },
  { key: "makerReceivable", label: "Owed by makers (warranty claims sent, not paid yet)", def: "Due from Manufacturers" },
  { key: "warrantyIncome", label: "Warranty work the makers pay for", def: "Warranty Claims Income" },
  { key: "consignorLiability", label: "Owed to consignors (their machines sold, not paid out yet)", def: "Due to Consignors" },
  { key: "coopIncome", label: "Co-op advertising and rebates paid by makers", def: "Co-op and Rebates Received" },
] as const;

export type AccountKey = (typeof ACCOUNT_KEYS)[number]["key"];

export type BooksConfig = {
  /** Only the names the bookkeeper changed; a blank or missing key uses the default. */
  accounts: Partial<Record<AccountKey, string>>;
  byCategory: boolean;
  netDiscounts: boolean;
  /** Card payments go here instead of "Undeposited Funds" when set. */
  cardClearing: string;
};

export const DEFAULT_BOOKS: BooksConfig = { accounts: {}, byCategory: false, netDiscounts: false, cardClearing: "" };

/** An account name as QuickBooks takes it: no tabs, newlines or quotes; colons would make a sub-account, so they become dashes. */
export function cleanAccount(name: string): string {
  return name.replace(/[\t\r\n"]+/g, " ").replace(/:/g, "-").trim().slice(0, 100);
}

export function accountName(cfg: BooksConfig, key: AccountKey): string {
  const given = cfg.accounts[key]?.trim();
  return cleanAccount(given || ACCOUNT_KEYS.find((a) => a.key === key)!.def);
}

/** The accounts as saved in the database's JSON column, cleaned: unknown keys dropped, blanks dropped. */
export function readAccounts(raw: unknown): BooksConfig["accounts"] {
  const out: BooksConfig["accounts"] = {};
  if (!raw || typeof raw !== "object") return out;
  for (const a of ACCOUNT_KEYS) {
    const v = (raw as Record<string, unknown>)[a.key];
    if (typeof v === "string" && v.trim()) out[a.key] = cleanAccount(v);
  }
  return out;
}
