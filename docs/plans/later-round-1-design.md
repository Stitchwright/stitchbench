# Later round 1: off-site backup, gift cards, reports, audit log: design (3 Oct 2026, first draft for the owner)

HANDOFF.md section 3 item 6, the first group the owner approved: off-site backup, gift cards and store credit, reports
(with the sales-tax report and a QuickBooks export), and an audit log. Section 5 recommends an answer on the three
things item 6 says need the owner first (card reader, Shopify, a texting inbox). Nothing here is built. Where this
document says "decided", the owner may still say otherwise; each section ends with open questions, each with a
recommended answer.

Files relied on: `prisma/schema.prisma`, `src/lib/register-math.ts`, `register-sale.ts`, `src/actions/tickets.ts`,
`src/app/(app)/sales`, `register/sales`, `src/app/api/export/[what]`, `api/sales`, `desktop/backup.mjs`, `main.mjs`,
`src/lib/move/*`, `modules.ts`, `lapse-allow.ts`, `action.ts`, `messaging/inbound.ts`, `shop/stripe.ts`; the hub, move
and online-shop designs; hub `accounts.mjs`, `moves.mjs`, `stripe.mjs`, migrations to `015_shop_moves.sql`.

## 0. Scope in one page

- **Off-site backup**: each company nightly, encrypted on the shop's side, to a bucket the hub arranges (a few cents a
  shop a month). The key is on a printed recovery sheet and nowhere else. The file is the company move file, so a
  restore is a company import. Photos go once, the rest nightly.
- **Gift cards and store credit**: `GIFT` gets a real balance: sold as an untaxed line, spent in part at the counter
  and on tickets, refunds to store credit, voids put it back; no expiry, no fees; printed or pre-printed numbers.
- **Reports**: sales by day, category and tender; tickets and labor; the sales-tax report by filing period; the gift
  card liability; a QuickBooks export (a balanced journal entry a day, CSV for Online, IIF for Desktop).
- **Audit log**: who changed money, prices, stock, voids, refunds, deletes, settings, people and permissions, and when;
  written in the change's transaction, never edited, kept 7 years, owners and admins, in every export and the move.
- All four are in the $25 program (`base`, open question 3.7.1) and work or stay readable while read-only. Two tracks,
  about **20 days** (section 6): money (13.5 days) and off-site backup (6.5 days).

## 1. Off-site backup

Today the Windows program backs up the whole install nightly to `Documents\StitchBench Backups` on the same PC (30
kept): a fire, a theft or a dead disk takes both. The hosted service has Railway's database snapshots, which the
operator holds, not the shop. The company move already writes one company as gzipped JSON lines with every id kept.

### 1.1 Where it goes

| Option | For | Against |
|---|---|---|
| **The hub arranges it** (recommended): an S3-compatible bucket in the owner's name; the hub hands out short-lived upload and download addresses, the bytes never pass through the hub | Nothing for the shop to set up; tied to the hub account it already has; restore on any PC with the account and the sheet | The owner pays the storage: Cloudflare R2 is about $0.015 a GB-month with free downloads, under $0.10 a month for a typical shop |
| A bucket the shop owns (B2, R2, S3, Wasabi) | No dependence on the owner | Keys and billing to set up: beyond most sewing shops |
| A folder (OneDrive, Dropbox, USB disk, NAS), Windows | Free with OneDrive | Off-site only if the folder syncs, and nobody checks |
| The owner's hosted service | none | The same place that might be what failed |

**Decided (recommended):** the hub. The folder target comes almost free with it (the same encrypted files written to
a path; the checks use it without a hub). The shop's own bucket waits until a shop asks.

### 1.2 What is in it

- **The move file, with two changes**: no freeze and no move token (`exportCompany({ purpose: "backup" })`, still
  one `REPEATABLE READ READ ONLY` snapshot), and the picture tables (`MachinePhoto`, `PartPhoto`, `SharedPhoto`)
  carry `{ ref, sha256 }` instead of bytes. Secrets are left out as in a move (sealed under the install's key, they
  would not open elsewhere anyway); a restore asks for them again.
- **Photos once**: each picture is its own encrypted object, sent the first night it exists (a changed one is a new
  object), so the nightly data file is small. **Per company**, on hosted and on a PC; the local whole-install
  backup stays as the quick way back from a mistake, off-site is the way back from losing the PC.

### 1.3 Encryption and the recovery key

- **A key pair per company**, made **in the owner's browser** (WebCrypto X25519; the Windows program's own window may
  make it on the server, which is the shop's PC). The program keeps only the public half; the private half is shown
  once as the recovery sheet and thrown away. The hosted server can make backups nightly without being able to open
  them, and nor can the hub, the bucket or the owner.
- **The recovery sheet** (print, or a PDF to keep somewhere safe): shop name and id, hub account email, date, the key
  as 52 characters in groups of four and as a QR code, and the three restore steps. Setup does not finish until the
  owner types back the last two groups. "Test my recovery key" downloads last night's file, opens it with the key
  typed in and shows its row counts beside today's; Settings reminds the owner every six months.
- **Each file**: a fresh data key; the body in 64 KB AES-256-GCM chunks (nonce = prefix + chunk number + last flag,
  so chunks can't be dropped, reordered or cut off); the data key wrapped to the public key (ephemeral X25519,
  HKDF-SHA256) in a clear header with the key's fingerprint. Node's `crypto` does it all. **A lost sheet** can't be
  reprinted: "Make a new recovery key" starts a new pair (photos sent again); older backups need the old sheet.

### 1.4 Schedule, retention, size

- **Nightly at 2 am** shop time (after the 1 am local backup), a background job under `JobLease` "offsite" (one
  company at a time on hosted, spread over the night), plus "Back up off-site now". A PC that was off runs it at
  start when the last good run is over 26 hours old. The data file first, then new photos, each resumable; a failed
  run retries hourly until 6 am.
- **Kept**: 14 dailies, 8 Sundays, 12 firsts of the month, pruned by the program after a good run. A photo object
  goes 400 days after its row left the database.
- **Size**: a busy shop's data file (10,000 tickets, 20,000 customers, 50,000 sale lines) is 30 to 60 MB of JSON, 5
  to 10 MB gzipped. Photos are 250 to 400 KB: 10,000 of them is 3 to 4 GB once (about an hour at 10 Mbit/s up, at
  night), then a few MB a day. **Decided:** 25 GB a company included; the owner is told at 80 %; over it new photos
  wait and the data file still goes.
- **Watching it**: Settings → Off-site backup shows the last good run, size and photos; owners and admins see a
  banner on every page after 3 days without one, and the tray says so on Windows.

### 1.5 Restore

- **A restore code** from the hub account page (Shops → "Restore this shop on another computer"; one use, 24 hours)
  is a move token minted from the account instead of an export, so the existing `/v1/shops/move` route re-points the
  shop to the new install afterwards.
- **Windows first run** (`/signup`) → "Restore a company from off-site backup": the code, the kept backups by date,
  the recovery key (typed, or the QR to a webcam). The program downloads, decrypts and checks the file, imports it
  through `move-import` (its refusals apply), fetches the photos, redeems the code and pulls the partner backlog from
  the file's cursor (`hub-step.ts`); then the move summary (what to enter again: mail password, Twilio, Stripe).
  **Hosted**: Companies → "Restore a company from off-site backup", same steps. A live old copy goes read-only.
- **Without the hub**: "Download a backup file" (owner) and `npx tsx scripts/offsite/restore.ts <file> --key ...`, so
  a shop that leaves the hub still has its files.
- **Lost**: work after the backup. Partner messages since then come again from the cursor; what this shop sent is on
  the partners' side, and the summary lists every partner link with traffic after the backup's time.

### 1.6 Data model

- `OffsiteSettings (shopId @id, on, target "hub" | "folder" | "bucket", folderPath, bucket fields with the secret
  sealed, publicKey, keyId, keyMadeAt, keyCheckedAt)`; travels in the move, secret left out.
- `OffsiteObject (shopId, name, kind "data" | "photo", photoId, size, sha256, uploadedAt, goneAt)`: the company's
  index of its store; travels (the store follows the company, so photos aren't sent again after a move).
- `OffsiteRun (id, shopId, startedAt, finishedAt, status, bytes, photos, error)`: this install's job history;
  `PER_INSTALL`. Program migration `20261004150000_offsite`.
- Hub `016_backups.sql` (next free number): `backup_objects (shop_id → shops.id, name, kind, size, sha256,
  created_at, deleted_at)`; env `BACKUP_S3_ENDPOINT`, `_BUCKET`, `_KEY_ID`, `_SECRET`. Keyed by the hub's `shops.id`,
  so a move (which rewrites `shops.install_id`) carries the store and `moves.mjs` is unchanged. Routes, by install
  key + `shopRef` or restore code: `POST /v1/backup/put` (name, size, sha256 → presigned PUT; refused over quota),
  `GET /v1/backup/list`, `POST /v1/backup/get`, `POST /v1/backup/delete`. SigV4 presigning by hand in `src/s3.mjs`
  (about 100 lines, like `stripe.mjs`).

### 1.7 Lapse, move, several companies

- **Lapsed**: backups run and restore works (never lose data; `ALSO_ALLOWED` lists backups); turning it on, testing
  the key and "Back up now" are `whileLapsed`. The hub keeps a store 12 months after the account closes.
- **Moving**: a frozen company still backs up (a read); once moved, the hub answers 410 to the old install and it
  stops; the new install carries on with the same key and index. **Several companies**: every query by `shopId`;
  the hub checks key or code against the shop on every call.

### 1.8 Packages

1. **`offsite-core`** (this repo, 3 days): migration, `src/lib/offsite/crypto.ts`, the backup export, the folder
   target, the job and pruning, Settings → Off-site backup, the restore CLI, `MOVE_TABLES`/`PER_INSTALL`. Check
   `offsite.check.ts`: back up a seeded company to a folder, restore into an empty database, every table equal; a
   flipped byte, a dropped chunk, a cut file, a wrong key refused; no photo sent twice; pruning keeps 14/8/12; tenant.
   Spec `tests/offsite.spec.ts`: turn on, confirm the sheet, back up now. Gate: tsc, eslint, the check, `move-export`,
   `move-import`, `base-license` checks, `tenant` spec.
2. **`offsite-hub`** (hub, then this repo, 3.5 days): hub migration, `s3.mjs`, routes, quota, the restore code, the
   admin storage column, `transfer.mjs`; `test/backup.mjs` against a local S3 stand-in (MinIO or a small mock). This
   repo: the hub target, first-run and Companies restore. Check `offsite-hub.check.ts` against the test hub (:3200);
   spec: back up on :3300, restore on the second server of `two-servers.spec.ts`, photo and tickets match, the first
   shows the moved banner. Gate: hub `npm test`, `test:db`; `move`, `two-servers`, `hub`, `smoke` specs; hub first.
3. Later, when a shop asks: **`offsite-bucket`** (1 day), the shop's own S3-compatible bucket.

### 1.9 Open questions

1. **Where.** Recommended: the hub, plus the folder target. Alternatives: the shop's own bucket only; a folder only.
2. **Who holds the key.** Recommended: the printed sheet only. Alternative: the PC also keeps it under Windows' DPAPI
   so the sheet can be reprinted (a stolen PC then opens the off-site copies too; hosted could not do the same).
3. **Included space.** Recommended: 25 GB a company. Alternatives: 10 GB, or a paid extra above it.
4. **Retention.** Recommended: 14 daily, 8 weekly, 12 monthly; after an account closes, 12 months and two mails.
   Alternatives: 30 daily; 90 days after closing.
5. **On by default.** Recommended: offered at first run and on Settings → Account, never on until the sheet is
   confirmed (a backup nobody can open is worse than none: people trust it).

## 2. Gift cards and store credit

Today `GIFT` is a register tender with an amount and a note; nothing records what a card holds, so a card can be
spent twice and nobody knows what the shop owes. Tickets have no gift tender (`PaymentMethod`: CARD, CASH, CHECK,
SHOP_COLLECTED, INVOICE, OTHER). Returns pay out in any tender; there is no store credit.

### 2.1 The rules, and the law in plain terms

- **Federal law** (the 2009 CARD Act): a gift card can't expire within 5 years of being sold or last loaded; an
  inactivity fee only after a year unused, one a month, printed on the card. **States add more**: several ban expiry
  or fees outright (California, Washington, Maine and others), several make the shop pay out a small leftover in
  cash on request (California under $10; Colorado, Oregon, Washington and others under $5), and some count balances
  unused for years as unclaimed property to report to the state.
- **Decided (recommended): no expiry and no fees, ever**, for cards and store credit: legal in every state, nothing
  to configure, and the card says "Never expires." Owners and admins can **pay out a balance in cash** at any time
  (the screen says "Some states require this for small balances"). The liability report flags balances untouched for
  3 years for the accountant to check the state's unclaimed-property rule. Plain terms, not legal advice; INSTALL.md
  says the same.
- **Selling a card is not a sale** for tax or the sales reports: it is money held for the customer, taxed when spent
  on taxable things. A card line is untaxed and never discounted.
- **Gift card** (kind `gift`): bought, numbered, whoever holds it spends it. **Store credit** (kind `credit`): given
  as a refund, on the customer when there is one (the register shows "Store credit $12.50, use it" when the customer
  is picked), a printed slip with a number when not. Cards belong to one company.

### 2.2 Data model (migration `20261004110000_gift_cards`)

- `GiftCard (id, shopId, number, kind "gift" | "credit", customerId? (SetNull), balanceCents, status "active" |
  "void", issuedAt, lastUsedAt, note, createdById)`, `@@unique([shopId, number])`, `@@index([shopId, customerId])`.
- `GiftCardEntry (id, shopId, cardId, at, amountCents (+ onto the card, - off it), reason SOLD | LOADED | REDEEMED |
  REFUNDED_TO | CASHED_OUT | ADJUSTED | OPENING | VOID, saleId?, saleLineId?, paymentId?, ticketId? (plain ids),
  userId?, note)`, indexed `[cardId, at]` and `[shopId, at]`. The ledger is the truth; `balanceCents` is its sum,
  kept in step in the same transaction, and the check asserts they agree.
- `SaleLine.giftCardId`; `Tender` gains `cardId?`; `TenderMethod` gains `CREDIT` ("Store credit"); `PaymentMethod`
  gains `GIFT` and `CREDIT`. `MOVE_TABLES`: `GiftCard` after `Customer`, `GiftCardEntry` after `Payment`.

### 2.3 Behaviour

- **Sell or load** (any role): a "Gift card" line, scan a pre-printed card or "New number", the amount ($5 to $500,
  owner-set limits); qty 1, untaxed, not discountable. The card and its `SOLD`/`LOADED` entry are written in the
  sale's transaction.
- **Spend** (register and ticket payments): tender "Gift card" or "Store credit", scan or type the number (or take the
  customer's credit); the amount defaults to the lesser of balance and due; the receipt prints what is left. The
  deduction is a guarded `updateMany` (`balanceCents >= amount`) in the sale's transaction, so two registers can't
  overdraw a card ("That card has only $4.20 left").
- **Refunds**: a return pays out to the original card (found from the sale returned; the default when it was paid by
  card) or to store credit (the customer's, or a new slip); a ticket refund the same.
- **Void** reverses each entry (`VOID`). A sale whose card has since been spent can't be voided ("That card has been
  used; $12.00 is left. Return what's left instead."), as `voidSaleAs` refuses a sale with a later return. Removing a
  gift card payment from a ticket puts the amount back.
- **Pay out in cash** (owner, admin): a register return of a "Gift card balance" line, tender cash, so the drawer
  and tender totals stay right. **Existing paper cards**: "Add an existing card" (owner, admin), an `OPENING` entry,
  in the liability, not in sales; old `GIFT` tenders stay as they are. **Adjust** (owner, reason required) and
  **move to a new number** (a lost card on a customer) write entries and audit lines.

### 2.4 Numbers, printing, screens

- **New numbers**: `GC-` and 12 random Crockford base32 characters (no I, L, O, U; 60 bits) with a check character:
  hard to guess, easy to read over the phone, unlike a bank card. Code 128 barcode; `itemByCode` recognises `GC-`.
  Lookups are rate-limited per user. **Pre-printed cards**: "Scan a blank card" stores the printed number (6 to 24
  letters and digits); a number already used is refused.
- **Printing**: a gift slip on the receipt printer (shop, amount, number, barcode, "Never expires", receipt note) and
  a card-sized page (3.375 by 2.125 in) for card stock or labels. Lists show the last four only.
- **Screens**: the register's tender picker and gift line; ticket payments; `/register/gift-cards` (find by number or
  customer, history, print, adjust, move, pay out); "Store credit" on the customer page; a Settings section for the
  limits and the slip's words. **Reports → Gift cards** (the liability): owed on cards on a date (entries summed to
  it, by kind); for a period, sold, loaded, refunded to credit, spent, paid out, adjusted, voided, opened; aging by
  last use (under 1 year, 1 to 3, over 3 flagged); the card list as CSV. The books export uses the same figures.

### 2.5 Lapse, move, several companies

- **Lapsed**: selling, loading and spending are sales and are refused, except within a return; refunds to credit and
  paying out are money back and go through (`completeSale` is `BY_HAND`: a return passes). Viewing, printing and the
  report work; adjusting is refused.
- **Moving**: frozen like everything else; both tables travel with every id, so numbers and balances are the same on
  the new install. **Several companies**: every lookup by `shopId` and number; another company's card is "not found".

### 2.6 Package

**`gift-cards`** (this repo, 4 days): migration, `src/lib/gift-cards.ts`, register and ticket changes, screens, the
slip, `/api/export/gift-cards`, `MOVE_TABLES`, `lapse-allow.ts`. Check `gift-cards.check.ts`: sell, spend part on a
sale and a ticket, two spends at once (one refused), refund to card and to credit, void (and the refused void of a
spent card), pay out, opening balance; ledger equals `balanceCents` everywhere; lapsed: sale refused, refund to credit
allowed; a move keeps every balance; tenant. Spec `tests/gift-cards.spec.ts`: sell and print a card, spend part, the
balance on the receipt, a return to store credit shown on the customer. Gate: tsc, eslint, the check, `base-license`,
`move-export`, `move-import` checks; `register`, `register-bookings`, `online-shop`, `roles` specs.

### 2.7 Open questions

1. **Expiry.** Recommended: none, ever. Alternative: 5 years with the notice printed (not legal in every state).
2. **Cash for a balance.** Recommended: owners and admins may pay out any balance. Alternative: a setting
   "Pay out balances under $X" that refuses larger ones.
3. **Partners honour each other's cards.** Recommended: no (each card is one company's liability; settling across
   shops needs a new partner message and statement line). Revisit if partners ask.
4. **Online shop.** Recommended: no cards online yet (a PIN against guessing needed). Alternative: e-gift cards, 1.5
   days. **Promotional cards** (free $10): recommended not offered; give a discount instead.

## 3. Reports, the sales-tax report and the QuickBooks export

Today: `/sales` (repair payments by method, closed tickets' service, labor, parts, tax, commission), `/register/sales`
(counter by tender, tax, by part kind; a void counts on the day it happened), CSVs in Settings → Your data and
`/api/sales`. Nothing adds counter, repair and online together or groups by day; no tax report, no bookkeeping export.

### 3.1 Rules every report follows

- Days in the shop's time zone (`monthRange`, `dateIn`); totals summed in SQL, the day cut as `(createdAt AT TIME ZONE
  tz)::date`; no summary tables (a busy shop's year is under 100,000 lines).
- **When things count**: a counter sale on its day, its void on the void's day (as `/register/sales`), a return on its
  own day; a repair when the machine is handed back (`COLLECTED`, `RETURNED_UNREPAIRED` by `closedAt`; abandoned is
  not a sale), as `/sales`; an online order on the day it was paid (its sale's day).
- **Not sales**: gift cards sold and credit given (a liability); a partner repair bill collected at the counter (the
  repair shop's sale and tax; already untaxed); trade-in credit (a purchase). Consigned items are sales, with the
  partner's share shown.
- Owners and admins only (as Settings → Your data). Every report has "Download CSV".

### 3.2 Sales, tickets and labor

- **By day**: counter, repairs, online, returns, voids, discounts, net sales, tax, money taken; a totals row.
  **By category**: counter lines by kind (the `PartKind`s, class seats, appointments, vacuums, shipping, other),
  repair lines by `LineKind`; quantity, net, cost where known (`SaleLine.costCents`), margin. **By tender**: cash
  less change, card, check, gift card, store credit, paid online, other; on account and collected by the partner for
  repairs.
- `SaleLine.kind` (new): the line's category at sale time (the part's kind, or CLASS, APPOINTMENT, REPAIR, UNIT,
  TRADE_IN, GIFT_CARD, SHIPPING, MISC), so a part deleted or re-kinded later does not move old sales; the migration
  fills it from today's rows.
- **Tickets and labor**: tickets in, out and open (age bands), by equipment kind; days intake to ready and to
  collected (median, longest); per tech (`techId`): tickets closed, labor hours (LABOR quantities), labor and parts
  billed; estimates sent, approved, declined, unanswered; comebacks (the same machine back within the warranty days);
  abandoned machines. Hours are hours billed until the per-ticket time clock (a later round); the page says so.

### 3.3 The sales-tax report

For a month, quarter or year (the owner's filing period, remembered):

- **Gross sales** less **non-taxable sales** (untaxed lines: labor where the shop set it so, misc, shipping, exempt
  customers) equals **taxable sales**; **tax collected**; returns and voids in the period netted and shown apart.
  Grouped by rate charged (`Sale.taxRatePct`, `Ticket.taxRatePct`), so a mid-quarter rate change shows two lines.
- **Stripe Tax orders** (`WebOrder.taxVia = "stripe"`, shipped) listed apart by ship-to state with the tax recorded
  on the sale: "File these from Stripe's tax report". Pickup orders are at the shop's rate, in the main figures.
- **Tax-exempt customers** (resale certificate): `Customer.taxExemptId`, `taxExemptUntil`; their sales and tickets
  charge no tax unless the cashier says otherwise and record the certificate (`Sale.taxExemptId`,
  `Ticket.taxExemptId`); the report lists exempt sales with certificate numbers, the list an auditor asks for.
- Taxable times rate equals tax to the cent per sale (`saleTotals` works in millionths); sales where it doesn't (a
  Stripe Tax amount, an old sale) are listed.

### 3.4 The QuickBooks export

- **Choice**: the QuickBooks Online API needs an Intuit app, per-shop OAuth and a public return address (the Windows
  program has none); a bookkeeper doesn't need it. **Decided (recommended):** **one summary journal entry per day**,
  the shape bookkeepers use for a shop's daily sales, as a CSV in QuickBooks Online's journal-entry import layout
  (number, date, account, debit, credit, description) and, from the same rows, an **IIF** for QuickBooks Desktop
  (`TRNS`/`SPL`, `GENERAL JOURNAL`). Customer detail stays here. Xero takes the CSV with a column rename.
- **Each day's entry** balances by construction (tenders less change equal lines less discounts plus tax):

| Line | Side | Default account (renamed in Settings → Bookkeeping) |
|---|---|---|
| Cash (less change), card, check, other | Dr | Undeposited Funds (card: Card Clearing if set) |
| Paid online | Dr | Stripe Clearing |
| Gift card / store credit spent; sold or given | Dr; Cr | Gift Card Liability / Store Credit Liability |
| Counter sales by category | Cr | Sales (one account, or one per category) |
| Discounts | Dr | Discounts Given (or netted into sales) |
| Sales tax collected | Cr | Sales Tax Payable |
| Repair payments taken | Cr | Repair Tickets Clearing |
| Repairs handed back (service, labor, parts, fees, tax) | Dr clearing; Cr income, tax | Repair Income per line kind, Sales Tax Payable |
| On account (INVOICE) / collected by the partner (SHOP_COLLECTED) | Dr | Accounts Receivable / Due from Partner Shops |
| Partner repair bills collected at the counter | Cr | Due to Partner Shops |
| Trade-in credit | Dr | Trade-in Purchases |

  Repair Tickets Clearing holds deposits on machines still in and unpaid bills of collected ones; the page shows
  its balance. Cost of goods and inventory are left out (bookkeepers book inventory from counts); an option later.
- **The page** (Reports → Bookkeeping): a range, the format, "Download", and "Exported through <date>" so the next
  export starts the day after (an already-exported day is said and asked). **Settings → Bookkeeping**: the
  bookkeeper's exact account names, one sales account or one per category, discounts netted or not.

### 3.5 Data model, lapse, move, several companies

- Migrations `20261004120000_report_kinds` (`SaleLine.kind` and its fill), `20261004130000_tax_exempt`,
  `20261004140000_books` (`BooksSettings (shopId @id, accounts Json, byCategory, netDiscounts, cardClearing,
  exportedThrough)`, in `MOVE_TABLES` after `Shop`).
- **Lapsed or frozen**: every report reads; CSV and books routes (`/api/reports/*`, `/api/books/*`) join
  `ALSO_ALLOWED`; `saveBooksSettings` and `markBooksExported` are `whileLapsed` (no business record changes);
  marking a customer tax-exempt is an edit and is refused.
- **Several companies**: `shopId` from `requireAdmin()` in every query; the tenant section runs every report as B
  over A's data and expects zeros.

### 3.6 Packages

1. **`reports`** (2.5 days): `SaleLine.kind`; `src/lib/reports/*.ts` (one function per report, shared by page and
   CSV); `/reports` with tabs Sales, Tickets, Gift cards; CSV routes; "Sales log" links there. Check
   `reports.check.ts`: a seeded month (discounts, a return, a void on a later day, a partner repair line, a gift card
   sold and spent, an online order, two tickets with labor and parts) gives hand-worked figures; days add up to the
   totals; tenant. Spec `tests/reports.spec.ts`: each tab, a new range, a CSV.
2. **`sales-tax`** (2 days, with exempt customers): check: two rates in a quarter, an exempt sale, a Stripe Tax order
   apart, a void across the quarter's end counted in the later quarter, taxable times rate equals tax. Spec: a quarter
   and an exempt customer's sale.
3. **`books-export`** (2 days): check: every day balances, the period agrees with `reports` and the liability
   movement, the IIF parses (a small reader in the check), names as set. Spec: Settings → Bookkeeping, export a week,
   "Exported through". **Before building**: one sample from a bookkeeper's QuickBooks Online import screen.
- Gate for each: tsc, eslint, its check, every existing check, `register`, `smoke`, `roles` specs.

### 3.7 Open questions

1. **Base or a paid module** (all four sections). Recommended: base; every shop needs a tax report and a backup.
   Alternative: a "Business" module.
2. **Repairs counted at hand-back or at payment.** Recommended: hand-back (as `/sales`, and when the tax is due).
   Alternative: at payment (cash basis), which splits a deposit across categories by guesswork.
3. **Techs.** Recommended: no Reports for techs. Alternative: the tickets report for a tech's own work.
4. **QuickBooks route.** Recommended: daily journal entry, CSV and IIF. Alternatives: a sales receipt per sale (big
   files, every customer made in QuickBooks); the API (8 to 10 days, an Intuit app, no Windows without the tunnel).
5. **The import layout.** Recommended: confirm with a real bookkeeper's file first; if that QuickBooks Online plan has
   no journal-entry import, the CSV goes in through the bookkeeper's accountant login or a common import tool.
6. **Tax-exempt customers.** Recommended: in `sales-tax` (half a day). Alternative: later.

## 4. Audit log

Some records are their own history (a sale and its void note, `StockMove`, `ConsentEvent`, `OutMessage`), but a ticket
payment taken off is deleted without a trace, a price change overwrites the old price, and a role change, a tax rate
change or a deleted note leaves nothing to say who did it.

### 4.1 What is logged

| Category | Entries |
|---|---|
| Money | payment added, removed; sale voided (reason); return, and a return with no original sale; discount given (line or sale); a register price different from the item's (before, after); web order cancelled and refunded; gift card sold, adjusted, moved, paid out; settlement recorded, confirmed; estimate answered (staff, or "customer by link") |
| Prices | part price, cost, partner price (an item import is one entry with the count and its changes); service prices; labor rate, tax rate, markup, storage fee; class, appointment, enrollment fees; online shipping |
| Stock | adjustments and recounts (before, after: `moveStock`, `saveCounts`); consignment placed or taken back |
| Deletes | ticket line removed (and a line added to a closed ticket), photo, note, shared post, part source, shift, class or meeting, campaign; customer or machine merges and deletes when HANDOFF 2c L126 lands |
| Settings | shop details; messaging (which fields; a secret as "changed", never its value); online shop, booking, check-in kinds; modules and keys; hub join, leave, usage sharing; the company move (start, cancel, done, moved in); off-site backup (on, off, new key); bookkeeping names |
| People | login added, role changed, made inactive or active, password reset by an admin, own password changed, reset link made, signed out everywhere, sign-in success and failure |
| Data | a CSV downloaded (which); customers or items imported (rows); a backup restored (`backup.mjs` writes it); the StitchBench administrator's actions on the company (module switch, hub writes, reset link) under "StitchBench administrator <email>" |

Not logged: every sale (the sale is the record), checklists, ticket text, readings, messages (each has its own
history). The list lives in `src/lib/audit-list.ts`; the check holds every name to a call site.

### 4.2 Data model and writing (migration `20261004100000_audit_log`)

- `AuditEntry (id, shopId, at, userId? (plain id), userName, role, actor "user" | "platform-admin" | "customer" |
  "system", category, action ("sale.void"), subjectType, subjectId, subjectLabel ("Sale #1042"), changes Json
  ({ field: [before, after] }), amountCents?, reason?, ip?)`, indexed `[shopId, at]` and `[shopId, subjectType,
  subjectId]`. No foreign keys: an entry outlives the login or record it names, with the name and label as they were.
- `src/lib/audit.ts`: `audit(tx, actor, entry)` and `diff(before, after, fields)`, called **inside the change's
  transaction** where there is one (a void and its entry commit together or not at all), else straight after the
  write in the same request. `shopId` comes from the actor, never from input. Sign-ins from `authorize` in
  `src/auth.ts` (a failure for an unknown email has no company and goes to the server log).
- No action edits or deletes entries, for anyone; pruning is the only removal.

### 4.3 Who sees it, how long, where it travels

- **Settings → Audit log** (`/settings/audit`), owners and admins: newest first, filters by person, category, dates
  and subject; ticket, sale, part, customer and gift card pages get "History" for that subject. Techs see nothing;
  the hosted administrator has no screen for a company's log.
- **Kept 7 years** (the usual span for business records), sign-ins 1 year; the worker prunes monthly. 200 to 400 bytes
  an entry, perhaps 20,000 a year for a busy shop: under 10 MB a year.
- **Travels**: `/api/export/audit` (Settings → Your data); every local backup (`backup.mjs` copies every table not
  skipped) and off-site backup; the move file (`AuditEntry` after `User` in `MOVE_TABLES`). The move's start writes its
  entry before the snapshot; the import writes "Moved in from <install>" first; entries made on the old copy after the
  snapshot stay with it.
- **Lapsed or frozen**: entries are still written (the allowed actions are the money ones that most need a trail);
  page and CSV work.

### 4.4 Package and open questions

**`audit-log`** (this repo, 3 days; first in its track so later packages add their entries as they go): migration,
`audit.ts`, `audit-list.ts`, calls in about 60 actions and routes, the sign-in hook, `backup.mjs`'s restore entry, the
page, "History" links, CSV, pruning, `MOVE_TABLES`. Check `audit.check.ts`: each listed action writes one entry with
the right category, subject and change; a failed void leaves none; a lapsed company still logs a payment; the list
matches the call sites; tenant. Spec `tests/audit.spec.ts`: change a price, void a sale, remove a payment, change a
role, all four shown; a tech gets no page. Gate: tsc, eslint, every check, `roles`, `register`, `smoke`, `move` specs.

1. **Tamper-evident chain** (each entry hashing the last). Recommended: not now: staff can't reach the database, and an
   owner who can could rewrite a chain too. Alternative: a per-company chain with "Check the log" (half a day;
   serialises writes per company).
2. **Retention.** Recommended: 7 years, sign-ins 1. Alternatives: forever (it is small), or 3 years.
3. **Who sees it.** Recommended: owners and admins. Alternative: owners only.
4. **Log every sale.** Recommended: no; the log keeps exceptions. Alternative: yes.

## 5. Decisions the owner listed as needing him

1. **Card reader: Stripe Terminal (recommended), not Square.** The program already speaks Stripe for the online shop
   (the shop's own account, `Shop.stripeKeySealed`, refunds in `src/lib/shop/stripe.ts`) and the hub's billing. Stripe's
   server-driven readers (S700 or WisePOS E, about $250 to $350) sit on the shop's Wi-Fi; the program (hosted or the
   PC) hands the reader the amount by API and polls Stripe for the result: no SDK, no driver, no inbound address (the
   Windows program has none without the tunnel). One account, payout and dashboard for counter, ticket and online
   money; returns refund through the call the online shop uses; card numbers never touch the program. Square is a
   second payment stack (OAuth, refunds, reports) at fees within a few tenths of a percent. **Offline**: neither cloud
   reader works without internet (Stripe's offline mode is for its phone SDKs, Square's for its own app), so today's
   "Card" tender stays as the fallback. Own-account shops only, as Stripe Tax. `card-reader`, about 4 days.
2. **Shopify sync: don't build it (recommended); a one-way export.** The online shop now does what these shops wanted
   Shopify for. Two-way sync needs stock pushed both ways within minutes (webhooks the Windows program can't receive),
   product matching, orders imported as sales, a token per shop and Shopify's quarterly API versions: 8 to 10 days and
   lasting upkeep for a few shops. Instead "Export for Shopify" (Settings → Your data): the inventory in Shopify's
   product CSV layout, about 1 day; a nightly one-way stock push only if two paying shops ask.
3. **Texting inbox: build the small version (recommended).** The program already reads every reply (every 5 minutes,
   every minute in a campaign), acts on STOP, START, HELP and an estimate's YES, and lists the rest on Messages →
   Replies. Staff can't answer. The small version: "Reply" on a reply and on the customer page (a one-off service text
   from the shop's Twilio number, never to a stopped number, written to `OutMessage`), a per-customer thread, an
   unread count for owners and admins, polling every minute while the page is open. About 2 days, in Marketing. Not a
   full inbox: no assignment, canned answers, pictures or instant delivery (webhooks again).

## 6. Build order, gates, effort

Each package: its own worktree and database, a check with a tenant section, a Playwright spec run alone
(`scripts/local-test/README.md`), the ultra review before deploy. Shared files touched a little by each: `schema.prisma`,
`move/format.ts` (the move check fails on a `shopId` table in neither list), `lapse-allow.ts` (the `base-license` check
fails on an unclassified action), the export route; two packages at a time never edit the same part.

| Order | Package | Track | Days | Needs |
|---|---|---|---|---|
| 1 | `audit-log` | money | 3 | none |
| 2 | `gift-cards` | money | 4 | `audit-log` |
| 3 | `reports` | money | 2.5 | `gift-cards` (what isn't a sale; the gift card tab) |
| 4 | `sales-tax` | money | 2 | `reports` |
| 5 | `books-export` | money | 2 | `reports`, `gift-cards`; a bookkeeper's sample file |
| 1 | `offsite-core` | safety | 3 | the move packages (built) |
| 2 | `offsite-hub` | safety | 3.5 | `offsite-core`; hub `move-hub` (built); hub deployed first |
| later | `offsite-bucket` | safety | 1 | a shop asking |

About 20 days for the seven (13.5 money, 6.5 safety); the tracks can run side by side. From section 5, if agreed:
`card-reader` 4, `texting-replies` 2, `shopify-export` 1. Migrations reserved: `20261004100000_audit_log`,
`20261004110000_gift_cards`, `20261004120000_report_kinds`, `20261004130000_tax_exempt`, `20261004140000_books`,
`20261004150000_offsite` (renamed if a later one lands first); hub `016_backups.sql` (the next free number). Each
package ends with its INSTALL.md section (backup and restore; gift cards and the law in plain terms; the bookkeeping
export) and its HANDOFF entry.
