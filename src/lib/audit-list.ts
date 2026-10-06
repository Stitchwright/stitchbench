// What the audit log records (later-round-1-design.md section 4.1). Pure: no "server-only", no database, so the page,
// the CSV and the check script share one list. Every name here must have a call site (audit-log.check.ts greps for
// it), and audit() refuses a name that is not here. Not logged on purpose: every sale (the sale is the record),
// checklists, ticket text, readings, messages (each has its own history).

export const AUDIT_CATEGORIES = ["money", "prices", "stock", "deletes", "settings", "people", "data"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<AuditCategory, string> = {
  money: "Money",
  prices: "Prices",
  stock: "Stock",
  deletes: "Deletes",
  settings: "Settings",
  people: "People",
  data: "Data",
};

export const AUDIT_ACTIONS = {
  // Money
  "payment.add": { category: "money", label: "Payment taken on a ticket" },
  "payment.remove": { category: "money", label: "Payment taken off a ticket" },
  "sale.void": { category: "money", label: "Sale voided" },
  "sale.return": { category: "money", label: "Return or refund at the register" },
  "sale.discount": { category: "money", label: "Discount given at the register" },
  "sale.price_override": { category: "money", label: "Register price different from the item's" },
  "giftcard.sell": { category: "money", label: "Gift card sold" },
  "giftcard.load": { category: "money", label: "Gift card loaded" },
  "giftcard.opening": { category: "money", label: "Existing gift card added" },
  "giftcard.adjust": { category: "money", label: "Gift card balance adjusted" },
  "giftcard.move": { category: "money", label: "Gift card moved to a new number" },
  "giftcard.cashout": { category: "money", label: "Gift card balance paid out in cash" },
  "ticket.tax": { category: "money", label: "Tax switched off or on for a ticket" },
  "customer.taxexempt": { category: "money", label: "Customer's tax-exempt certificate changed" },
  "credit.issue": { category: "money", label: "Store credit given" },
  // Prices
  "part.price": { category: "prices", label: "Item price or cost changed" },
  "service.price": { category: "prices", label: "Service price changed" },
  "shop.rates": { category: "prices", label: "Labor rate, tax rate, markup or storage fee changed" },
  // Stock
  "stock.count": { category: "stock", label: "Stock recounted or adjusted" },
  // Deletes
  "ticketline.remove": { category: "deletes", label: "Ticket line removed" },
  // Settings
  "books.settings": { category: "settings", label: "Bookkeeping names or choices changed" },
  "shop.details": { category: "settings", label: "Shop details changed" },
  // People
  "user.add": { category: "people", label: "Login added" },
  "user.role": { category: "people", label: "Role changed" },
  "user.active": { category: "people", label: "Login made inactive or active" },
  "user.password_reset": { category: "people", label: "Password reset by an admin" },
  "user.password_change": { category: "people", label: "Own password changed" },
  "signin.ok": { category: "people", label: "Signed in" },
  "signin.fail": { category: "people", label: "Wrong password at sign-in" },
  // Data
  "books.exported": { category: "data", label: "Bookkeeping export marked as sent" },
  "export.download": { category: "data", label: "CSV downloaded" },
  "import.customers": { category: "data", label: "Customers imported" },
  "import.items": { category: "data", label: "Items imported" },
  "backup.restore": { category: "data", label: "Backup restored" },
} as const satisfies Record<string, { category: AuditCategory; label: string }>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const auditLabel = (action: string) => (AUDIT_ACTIONS as Record<string, { label: string }>)[action]?.label ?? action;

/** Years kept: everything 7 years, sign-ins 1 (design 4.3, open question 2). */
export const KEEP_YEARS = 7;
export const KEEP_SIGNIN_YEARS = 1;
