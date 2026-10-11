# StitchBench

A repair bench for sewing, embroidery, longarm and industrial machine techs.

**Install it:** see **[INSTALL.md](INSTALL.md)**. It runs either as a Windows program on the shop PC (no monthly
cost) or hosted on Railway. It is free and open source (AGPL-3.0): every feature, for every shop. The extras for
particular kinds of work (Vac Shop, Small Appliance Repair, Scheduling, Marketing, Maker Shop) are free too, switched on
per shop in **Settings → Features**.

- **Machines by model and serial.** Every machine that comes in gets a page with:
  - photos by type: check-in condition, inside the machine, wiring and connectors, parts, after repair
  - the accessories that came with it, ticked off as they go back
  - the service checklist, and who did each step
  - gauge readings as found and as left
  - its full service history, and every other machine of the same model you've worked on
- **Factory specs.** 634 upper and bobbin tension-gauge values and 14,000+ timing and adjustment settings, read
  out of OEM service, technical and operator manuals. Each comes with the page it came from and, where
  available, the manual's figure. They come with the official installers and the hosted service; that text isn't
  part of the public code, so a copy built from the public code shows none (see
  [INSTALL.md](INSTALL.md#the-manufacturers-reference-data)).
- **Important facts and gotchas** per brand and model, written by your techs, shown on every machine and ticket of
  that model.
- **Manuals.** With the Windows program, the shop PC's manuals folder is served to every device. When hosted,
  each PC connects its own folder in the browser. Nothing is uploaded either way.
- **Scan a manual.** Photograph a paper manual page by page (or add flatbed images, or a scanner PDF). It's saved
  as `Brand_Model_DocType_Year.pdf`.
- **Tickets, invoices and point of sale.**
  - Check-in with accessories, and statuses that follow a quilt-shop pickup route.
  - Service menu, labor, parts from inventory, fees, discounts, sales tax and payments.
  - Printable invoices, an Invoices area (paid, unpaid, what's owed), and trade-account commission.
- **Price list.** A printable price sheet built from the service menu, with categories and descriptions.
- **Parts inventory.** Stock on hand, bins, reorder points, receiving, shelf counts, and automatic stock-out when
  a part goes on a ticket. A part is new, used or refurbished, and genuine, compatible or 3D printed; the customer's
  invoice says when it is used, refurbished, compatible or 3D printed. A part the maker gave no number gets the
  shop's own (SB-00001), which prints on labels and scans like any other.
- **Companies and people.** Each company's data is separate, and every employee has their own login (owner,
  admin or tech).
- **Community hub (StitchHub).** Shops share:
  - manual links (never the manuals themselves), with status checks, edit history and rollback
  - tech notes and photos
  - manual figure snapshots

  There's also a Community chat link to the group's Discord. The hub's server code is public:
  https://github.com/bwattendorf/stitchhub.
- **Sales log** by date range, with CSV export.
- **Messages**: email and texts to customers through the shop's own mail account and Twilio number: "it's ready"
  notices and estimate approval by link, and with *Marketing* switched on in Settings → Features also
  uncollected-machine notices and letters, service-due and review requests, and campaigns to chosen groups; consent,
  STOP and unsubscribe handled by the book.
- **Scheduling** (switched on in Settings → Features): a day and week calendar, appointment types with shared resources
  (two longarms), classes with seats, waiting lists, rosters and reminders, class and appointment fees rung up at the
  register, staff shifts, and pickup runs planned with a partner shop.

## StitchShop: sewing and quilt shops, and their repair shop
The same program, set to **Sewing / quilt shop** (at sign-up, or Settings → What this company does), becomes
**StitchShop**:
- **Register.** Scan a barcode (USB/Bluetooth scanner or the camera) or search, fabric by the yard in eighths, line
  and whole-sale discounts, sales tax, split payments (cash with change, card on your own reader, check, gift card),
  returns, voids, printable receipts, and a day's takings by payment type.
- **Inventory** of notions, fabric, thread, patterns and accessories, with barcode labels, shelf counts, a spreadsheet
  import (paste a supplier's line sheet from Excel, or a CSV), and an online lookup of store barcodes (UPC/EAN).
- **Repairs sent to the partner repair shop.** Take a machine in at the counter (customer, machine, problem,
  accessories, photos), print a two-part claim tag, and watch its status: waiting for pickup, being repaired,
  **needs the customer's OK** (the estimate arrives; the shop calls the customer and answers), ready. The customer
  pays at the register; the shop's commission is worked out from the repair shop's bill.
- **Ordering** parts, notions and accessories from the repair shop's catalog at partner prices.
- **Consignment.** The repair shop's stock on the sewing shop's shelf: each sale is reported to the owner, shelf
  counts, returns.
- **The partnership.** Terms both shops accept (commission on repairs, consignment split, who covers losses,
  statements, notice, and whether the repair shop provides the software), a printable agreement, and a monthly
  statement netting repairs, consignment and orders into one payment either way.

On the repair shop's side, a machine taken in at a partner shop arrives as a ticket under the shop's trade account;
its status, bill and a note go back to the shop automatically, and the customer's answer to an estimate comes back
onto the ticket. A repair shop can **set up StitchShop for a sewing shop** on its own install (Partner shops →
"Set up StitchShop for a sewing shop"): the company, its owner login and the partnership in one step. The two shops
talk through StitchHub (a private channel per partnership), so either can run the Windows program or a hosted copy.

StitchShop installs the same two ways as StitchBench: a **StitchShop Windows program** (`npm run dist:stitchshop`
builds `StitchShop Setup <version>.exe`, with its own data, ports and backups) or **StitchShop on Railway**
(`APP_NAME=StitchShop`, `DEFAULT_SHOP_KIND=retail`). See [INSTALL.md](INSTALL.md#installing-stitchshop-sewing-and-quilt-shops).

## Stack

Next.js 16 (App Router, server actions) · React 19 · Prisma 7 + PostgreSQL · Auth.js v5 (email + password) ·
Tailwind 4 · pdf.js / pdf-lib · Electron (Windows program, `desktop/`).

## Run it for development

```bash
docker compose up -d            # Postgres on localhost:5433
cp .env.example .env            # then set AUTH_SECRET (npx auth secret) and the SEED_ values
npm install
npm run db:migrate              # create tables
npm run db:seed                 # factory specs + first shop and owner (prints the password)
npm run dev
```

The factory specs are the manufacturers' reference data, which isn't in the public code: without it the seed says so
and skips them, and everything else works. With access to it, set `STITCH_DATA_TOKEN` and run
`node scripts/data/fetch-reference-data.mjs` before seeding ([INSTALL.md](INSTALL.md#the-manufacturers-reference-data)).

## Tests

`npm run dev` serves on port 3000, but the specs go to `http://localhost:3100` (the Windows program's port) unless
`E2E_BASE_URL` says otherwise. Point them at the dev server, or start it on 3100 (`npx next dev -p 3100`):

```bash
npm run e2e:setup               # throwaway "E2E Test Shop" user
PW_CHANNEL=chrome E2E_BASE_URL=http://localhost:3000 E2E_EMAIL=e2e@stitchbench.test E2E_PASSWORD=e2e-password-1 npm run e2e
```

`PW_CHANNEL=chrome` uses the installed Google Chrome; without it, install Playwright's browser first
(`npx playwright install chromium`). The specs share one install (its hub connection, partnerships and E2E shop), so
they run one file at a time, in order.

Two smaller suites run without the app or a browser (the Checks workflow runs both):
- `npm run test:unit` tests the guards on "Download to library" and the pure messaging code (`tests/unit/`,
  `src/**/*.test.ts`).
- **Check scripts** `scripts/checks/*.check.ts`, run one at a time with `npm run check scripts/checks/<name>.check.ts`
  against the dev database: each makes a throwaway company (`Check <run>`), drives the library code with a user, and
  removes what it made. They cover Features and the Assistant's key, the messaging core and worker, notices, estimate
  links, audiences, campaigns, classes, appointments, register bookings, shifts and partner runs. The ones that send
  start the **SMTP sink** (`npm run mail:sink`, `scripts/test-mail/smtp-sink.mjs`) and the **Twilio mock**
  (`npm run sms:mock`, `scripts/test-mail/twilio-mock.mjs`) on ephemeral ports themselves.
- The Windows program's database code (migrations, reference data, backup and restore) runs against a scratch
  Postgres whose user is a superuser: `cd desktop && npm ci --ignore-scripts`, then
  `TEST_DATABASE_URL=postgresql://user:password@localhost:5433/postgres npm test`.

Opt-in suites (each skips itself unless its variables are set):
- `tests/hub.spec.ts` needs a test StitchHub (`HUB_URL`, `HUB_JOIN_KEY`, `PDF_URL`; `HUB_ADMIN_TOKEN` loads the catalog
  links into a fresh hub).
- `tests/market.spec.ts` needs a test StitchHub too (`HUB_URL`, `HUB_JOIN_KEY`; `HUB_ADMIN_TOKEN`). `inventory.spec.ts`
  also checks the community's most-used parts when `HUB_URL` is set.
- `tests/partners.spec.ts` plays both sides of a partnership on one install (`HUB_URL`; the E2E user must be in
  `PLATFORM_ADMIN_EMAILS`).
- `tests/offline.spec.ts` checks the shop keeps working when the hub is unreachable. It runs in phases (`OFFLINE_PHASE`,
  `OFFLINE_STATE`, `HUB_URL`, `PLATFORM_ADMIN_EMAILS`) that something has to cut the connection between:
  `scripts/local-test/offline_test.ps1` does that on Windows (see `scripts/local-test/README.md`).
- `tests/figure.spec.ts` draws a manual figure from a PDF (`MANUAL_DIR`, a folder holding the manual; optionally
  `MANUAL_BRAND` and `MANUAL_MODEL`, default Janome MC6700P; the E2E shop needs a machine of that model).
- `tests/shop-library.spec.ts` runs against the Windows program (`SHOP_LIBRARY=1`).
- `tests/walkthrough.spec.ts` records the demo screens (`DEMO_DIR`).

- The messaging and scheduling specs (`messaging`, `notices`, `estimate-links`, `campaigns`, `classes`, `calendar`,
  `register-bookings`, `shifts`) run against a **test build** (`STITCH_TEST_BUILD=1 npx next build`, then
  `npx next start`) with the sink and the mock running and the server told about them: `SMTP_ALLOW_HOSTS=127.0.0.1:<sink
  port> TWILIO_API_BASE=http://127.0.0.1:<mock port> MESSAGE_WORKER_SECONDS=5 READY_NOTICE_DELAY_SECONDS=1
  PUBLIC_URL=http://localhost:<port>`; the spec process gets `SMTP_SINK_PORT`, `SMTP_SINK_HTTP`, `TWILIO_MOCK_PORT`
  and the same `PUBLIC_URL`. Each spec makes its own company from the Companies page (the E2E user must be in
  `PLATFORM_ADMIN_EMAILS`) and removes it. `tests/partner-runs.spec.ts` needs `HUB_URL` as well. The specs for the
  add-ons (`features`, `vac-shop`, `appliances`) run on the same test build; the specs switch a company's Features on in
  the database (`tests/helpers/modules.ts`), and the Assistant's specs run `scripts/license/dev.ts --grant`, so the spec
  process needs `DATABASE_URL`. `scheduling-messaging` walks Scheduling and Marketing together, and `two-servers` needs
  a second server on the same database (`E2E_SECOND_URL`).
- When several feature packages are built at once, each gets its own git worktree, database (`stitchbench_feat_<key>`)
  and ports (package number n: sink 2525+n, mock 3401+n, server 3500+n), so builds, workers and test servers never
  share anything (design section 16.3).

`scripts/local-test/` has the Windows helpers used for the review: a test hub, a test app, and a runner for the
specs above.

## How the pieces fit

- **Companies:** one **Shop** per business. Every business table carries `shopId`, and every query filters by the
  signed-in user's shop.
- **Specs:** factory specs are shared reference data (`prisma/seed-data/`). They're matched to machines by a
  normalized model key (`BES-1216AC` → `BES1216AC`). `npm start` applies database migrations and loads the
  shipped reference data when it is new or changed (a hash of each file is kept as the table's comment) before the
  server starts.
- **Manuals:**
  - Hosted: the browser keeps the folder handle and a file-name index in IndexedDB (`src/lib/local-manuals.ts`).
  - Windows program: the server reads `LIBRARY_DIR` (`src/lib/library-dir.ts`, `/api/library/*`).
- **Photos** are shrunk in the browser (about 200 KB) and stored in Postgres, served only to the owning shop.
- **Community hub:** `src/lib/hub.ts` syncs a local copy of the hub's links, notes and figures (every 10 minutes,
  from `src/instrumentation.ts`).
- **Windows program:** `desktop/` runs its own PostgreSQL, the StitchBench server, a window and tray icon, and the
  nightly backups.
- **Errors:** server actions return `{ error }` for problems the user can fix (`src/lib/action.ts`), shown as
  toasts.
