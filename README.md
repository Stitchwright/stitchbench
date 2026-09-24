# StitchBench

A repair bench for sewing, embroidery, longarm and industrial machine techs.

- **Machines by model and serial.** Every machine that comes in gets a page with photos, the accessories that came with it (ticked off as they go back), the service checklist and who did each step, gauge readings as found and as left, and its full service history.
- **Factory tension specs.** 500+ upper and bobbin tension-gauge values read out of OEM service, technical and operator manuals, shown next to the readings you take so out-of-spec jumps out.
- **Important facts and gotchas** per brand + model, written by your techs, shown on every machine and ticket of that model.
- **Your manuals stay on your PC.** Connect your manuals folder once (Chrome or Edge). StitchBench matches files to the machine's model and opens them from your own disk, straight to the spec page when it's the same manual. Nothing is uploaded.
- **Scan a manual.** Photograph a paper manual page by page (or add flatbed images, or file a scanner PDF) and it's saved into your manuals folder as `Brand_Model_DocType_Year.pdf`.
- **Tickets / POS.** Check-in with accessories, statuses that follow a quilt-shop pickup route, service menu, labor, parts from inventory, fees, discounts, sales tax, payments, printable invoice, trade-account commission.
- **Parts inventory.** Stock on hand, bins, reorder points, receiving, shelf counts, and automatic stock-out when a part goes on a ticket.
- **Sales log** by date range with CSV export.

## Stack

Next.js 16 (App Router, server actions) · React 19 · Prisma 7 + PostgreSQL · Auth.js v5 (email + password) · Tailwind 4 · pdf-lib. Deploys to Railway (`railway.json`).

## Run it locally

```bash
docker compose up -d            # Postgres on localhost:5433
cp .env.example .env            # then set AUTH_SECRET (npx auth secret) and the SEED_ values
npm install
npm run db:migrate              # create tables
npm run db:seed                 # tension specs + first shop and owner (prints the password)
npm run dev
```

## Tests

```bash
npm run e2e:setup               # throwaway "E2E Test Shop" user
PW_CHANNEL=chrome E2E_EMAIL=e2e@stitchbench.test E2E_PASSWORD=e2e-password-1 npm run e2e
```

`PW_CHANNEL=chrome` uses the installed Google Chrome instead of downloading a Playwright browser.

## Deploy (Railway)

1. New project, add a PostgreSQL service, add this repo as a service.
2. Variables: `DATABASE_URL` (reference the Postgres service), `AUTH_SECRET`, `AUTH_TRUST_HOST=true`, `SEED_OWNER_EMAIL`, `SEED_OWNER_NAME`, `SEED_SHOP_NAME`, `SEED_OWNER_PASSWORD`.
3. Deploys run `prisma migrate deploy` first. Run `npm run db:seed` once (Railway shell) for the specs and the owner account.
4. `ALLOW_SIGNUP=true` lets other repair shops create their own account at `/signup`. Every shop's data is separate.

## How the pieces fit

- One **Shop** per business; every business table carries `shopId`, and every query filters by the signed-in user's shop.
- **Tension specs** are shared reference data (`prisma/seed-data/tension_specs.json`), matched to machines by a normalized model key (`BES-1216AC` → `BES1216AC`).
- **Manuals** never touch the server: `src/lib/local-manuals.ts` keeps the folder handle and a file-name index in the browser's IndexedDB.
- **Photos** are shrunk in the browser (~200 KB) and stored in Postgres, served only to the owning shop.
- Server actions return `{ error }` for problems the user can fix (`src/lib/action.ts`), shown as toasts.
