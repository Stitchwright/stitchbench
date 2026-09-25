# StitchBench

A repair bench for sewing, embroidery, longarm and industrial machine techs.

**Install it:** see **[INSTALL.md](INSTALL.md)**. It runs either as a Windows program on the shop PC (no monthly
cost) or hosted on Railway.

- **Machines by model and serial.** Every machine that comes in gets a page with:
  - photos by type: check-in condition, inside the machine, wiring and connectors, parts, after repair
  - the accessories that came with it, ticked off as they go back
  - the service checklist, and who did each step
  - gauge readings as found and as left
  - its full service history, and every other machine of the same model you've worked on
- **Factory specs.** 634 upper and bobbin tension-gauge values and 14,000+ timing and adjustment settings, read
  out of OEM service, technical and operator manuals. Each comes with the page it came from and, where
  available, the manual's figure.
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
  a part goes on a ticket.
- **Companies and people.** Each company's data is separate, and every employee has their own login (owner,
  admin or tech).
- **Community hub (StitchHub).** Shops share:
  - manual links (never the manuals themselves), with status checks, edit history and rollback
  - tech notes and photos
  - manual figure snapshots

  There's also a Community chat link to the group's Discord. The hub's server code is public:
  https://github.com/bwattendorf/stitchhub.
- **Sales log** by date range, with CSV export.

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

## Tests

```bash
npm run e2e:setup               # throwaway "E2E Test Shop" user
PW_CHANNEL=chrome E2E_EMAIL=e2e@stitchbench.test E2E_PASSWORD=e2e-password-1 npm run e2e
```

`PW_CHANNEL=chrome` uses the installed Google Chrome instead of downloading a Playwright browser.

Opt-in suites:
- `tests/hub.spec.ts` needs a test StitchHub (`HUB_URL`, `HUB_JOIN_KEY`, `PDF_URL`).
- `tests/shop-library.spec.ts` runs against the Windows program (`SHOP_LIBRARY=1`).
- `tests/walkthrough.spec.ts` records the demo screens (`DEMO_DIR`).

## How the pieces fit

- **Companies:** one **Shop** per business. Every business table carries `shopId`, and every query filters by the
  signed-in user's shop.
- **Specs:** factory specs are shared reference data (`prisma/seed-data/`). They're matched to machines by a
  normalized model key (`BES-1216AC` → `BES1216AC`). `npm start` applies database migrations and loads any
  missing reference data before the server starts.
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
