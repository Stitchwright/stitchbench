# Handoff: where the work stands (30 Sep 2026)

Read this first in a new Claude Code session. It picks up work started in a cloud session: a code/QA/security
review, fixes, and the design of several new features. Everything below is on the branch
`claude/code-qa-security-review-agqf4z` in both repos (bwattendorf/stitchbench and bwattendorf/stitchhub).

## 0. First steps on the owner's PC (do these before anything else)

The PC may have work that was never committed. Save it before switching branches. Run in the StitchBench
folder, then the same in the StitchHub folder:

1. See what's uncommitted: `git status` and `git branch --show-current`.
2. If anything is modified or untracked, put it on its own branch (check `.env` and other secrets are NOT listed):
   ```
   git switch -c my-pc-work
   git add -A
   git commit -m "Work from my PC before merging the review branch"
   git push -u origin my-pc-work
   ```
3. Get the review branch: `git fetch origin` then `git switch claude/code-qa-security-review-agqf4z`.
4. If step 2 saved anything: `git merge my-pc-work`. On conflicts (likely in register.ts, tickets.ts,
   settings.ts), resolve them keeping both the PC work and the round-3 fixes, and ask the owner what the PC
   work was for if unclear.
5. `npm install` (not `npm ci`), `docker compose up -d` if the dev DB runs in Docker, `npx prisma migrate deploy`,
   `npm run dev`.
6. Don't merge into `main` until the build and tests pass (section 3.2). Before installing a new Windows program
   build, make a backup from the tray menu.

## 0b. Where things run (27 Sep 2026)

- Hub: https://stitchhub-production.up.railway.app (Railway project `stitchhub`; deploy with `railway up --ci` in the
  stitchhub folder).
- Hosted StitchShop: https://stitchshop-production.up.railway.app (project `stitchshop`, service `stitchshop`).
- Hosted StitchBench: https://stitchbench-production-e554.up.railway.app (project `stitchbench`, service `stitchbench`;
  owner login bwattendorf@gmail.com, password file in the owner's Documents folder).
- StitchBench 1.5.0 installed on the owner's PC; installers for both programs build with the GitHub Actions workflow
  `installers.yml` (unsigned).

## 1. Get set up on the PC

```
git clone https://github.com/bwattendorf/stitchbench && cd stitchbench
git checkout claude/code-qa-security-review-agqf4z
npm install            # not `npm ci`: package-lock.json is missing @emnapi/core and @emnapi/runtime (review finding)
docker compose up -d   # Postgres on localhost:5433 (see .env.example)
copy .env.example .env # set AUTH_SECRET, SEED_OWNER_PASSWORD
npx prisma migrate deploy && npm run db:seed
npm run dev
```

StitchHub, same branch name: `npm install`, set DATABASE_URL/ADMIN_TOKEN/JOIN_KEY, `npm start`,
`HUB_URL=... ADMIN_TOKEN=... JOIN_KEY=... npm test` (smoke test).

Checks to run before every commit: `npx tsc --noEmit`, `npx eslint src`, `npx next build`, and the Playwright
specs (`npm run e2e:setup`, then `E2E_EMAIL=e2e@stitchbench.test E2E_PASSWORD=e2e-password-1 HUB_URL=...
HUB_JOIN_KEY=... npx playwright test smoke inventory market partners register`). Known and not new:
`tests/hub.spec.ts:47` fails on a fresh hub with no catalog links; eslint reports errors in the pdf.js files
copied into `public/` (the eslint config should ignore `public/`).

## 2. What is done

- **Sign-in fix** (commit a5964f6): people added in Settings, at sign-up or on the Windows first run could
  be given emails that sign-in refused. One email rule now (`src/lib/email.ts`); the Windows program no longer
  restarts its server mid sign-up.
- **Round-3 review**: 259 verified findings (6 high, 86 medium, 139 low, 28 info), with status, in
  `docs/round3/ROUND3_FINDINGS.md`. Interactive copy: https://claude.ai/artifact/8fjYFHAaZMz4gEuHasQvEG
- **Round-3 fixes, partly done** (the latest commit, "Round 3 fixes, part 1"):
  - Register and money (package `bench-register`): finished. Cash refunds work again, tech discount lock,
    exact part number wins at scan, whole-sale discount shared with consigned items, tender caps, repair bills
    that go up after payment, retry-safe sales (`Sale.clientKey`), scanner typing into the wrong field,
    yardage in eighths, returned-unrepaired tickets in the sales log. New spec `tests/register.spec.ts`.
    Partner message `job.paid` now carries `paidCents` (running total).
  - StitchHub core (package `hub-core`, stitchhub repo): finished. Body limits on every route, rate limits not
    keyed on spoofable X-Forwarded-For, link-checker SSRF guard, pool error handling, deleted notes stop going
    out, export/import fixes (migration 007).
  - Tickets and bench (package `bench-tickets`): **stopped part-way** (usage limit). Its edits to
    tickets.ts, records.ts, settings.ts, invoices and ticket pages plus migration
    `20260927110000_round3_bench-tickets` are committed but unverified: re-read that package's findings and
    finish/check each one.
  - None of these fixes has had the independent re-test yet (see step 3.2).

## 2b. Round-3 high + medium fixes finished (30 Sep 2026, cloud session)

On branch `claude/remaining-tasks-l5s9q3` in both repos (not merged into `main`, not deployed). Every high and medium
finding is fixed or partly done; the statuses in `docs/round3/ROUND3_FINDINGS.md` say what is left for the 7 partly
done ones (M12, M44, M53, M56, M58, M68, M71). Checked on Linux: `npm ci`, tsc, lint (0 errors), `next build`, all
migrations on an empty and on a used database, drift check empty, Playwright specs smoke, hub, inventory, market,
partners and register all pass, hub smoke test passes.

- New migrations: StitchBench `20260927110100_round3_bench-tickets-2`, `20260927120000_round3_partners`,
  `20260927140000_round3_hub-market-parts`, `20260927160000_round3_time-zone` (data only); StitchHub
  `008_round3_partners.sql`, `009_round3_hub-market-parts.sql`. Deploy the hub first; old and new installs and hubs
  work with each other (new fields are optional).
- Behaviour the owner will notice:
  - The monthly most-used-parts report is off for every company until it's turned on (Parts > Most used > "Offer our
    counts"), per the sharing decision.
  - A settlement payment a partner reports counts once someone clicks "Confirm it arrived" on the statement.
  - Leaving the hub is refused while marketplace orders are open; an ended partnership takes no new work (updates and
    payments still go through).
  - Every date prints in the company's time zone (Settings). The Windows program's one company gets the PC's zone
    once, if it was still on the New York default.
  - "Add it to the cross-reference" opens the cross-reference form filled in from the part (no notes) instead of
    posting at once.
  - Settings > Your data exports tickets (with lines and readings), machines, payments and model notes too.
  - Sign-up with a partner code only connects to a hub when the install is already on one (or it's the first company).
  - Hosted installs load the shipped specs and factory settings again whenever the shipped files change.
- Follow-ups noted during the work: use `assertId` (src/lib/input.ts) at the top of every server action that takes
  an id (done in parts and scan); a held partner message makes each sync re-read the backlog after it (bandwidth);
  "byShop" on hub link and cross-reference revisions per company; the Settings time-zone field is free text; hosted
  sign-up could take the browser's time zone; the typed paper ticket number is unbounded (L35).
- Testing in a Linux cloud session: Postgres 16 is installed (`/usr/lib/postgresql/16/bin`), Node 24 via nvm, and
  Playwright needs `executablePath: "/opt/pw-browsers/chromium"` (a local config that spreads playwright.config.ts).
  The hub spec loads its catalog links itself when HUB_ADMIN_TOKEN is set.

## 2c. Round-3 low and info pass (30 Sep 2026, same branch)

Low: 116 fixed, 15 partly done, 8 open; info: 4 fixed, 13 partly, 11 open (statuses say what is left). Everything
passes: `npm ci`, tsc, lint, `npm run test:unit` (33 tests), `next build`, migrations + drift check, every Playwright
spec (smoke, auth, hub, inventory, market, partners, register), hub `npm run check` and smoke test.

- New migrations: `20260930120000_round3_lo-infra` (12 indexes), `20260930130000_round3_lo-tickets`
  (PartnerLink.endNote/endedBy). No hub migration.
- Behaviour the owner will notice:
  - Techs can't change a part's cost or price (same rule as the register); say if techs should.
  - Everyone on the Windows program signs in once after the update (each program now has its own cookies, so
    StitchBench and StitchShop on one PC no longer sign each other out).
  - The community most-used list shows a part once 3 shops report it (hub `USAGE_MIN_SHOPS`; the local test hub uses 1).
  - A partner ticket can't be marked Collected until the sewing shop has picked it up; the register hands a repair
    over only once it's back from the repair shop; consigned items can't be sold past what's on the shelf.
  - Settings > People has "Change role". Railway health-checks `/api/health`. The hub needs Node 20.12+ and reads `.env`.
  - The note typed when a partnership is ended now shows on the other shop's partner page.
- New tests: `npm run test:unit`; `cd desktop && npm test` (needs Postgres; runs in the Checks workflow); hub
  `npm run test:db` (scratch database) and, with IMPORT_HUB_URL, a hub-move check in the smoke test.
- Owner decisions the open ones wait on: per-company email uniqueness (L7, L31); signing out other devices (L42);
  merging customer/machine records (L126); reversing payments instead of deleting (L127); a single-writer lock on the
  hub (L95); signed partner invites/messages (L134, I27).

## 2d. Parts: condition, who made it, shop numbers (30 Sep 2026, same branch)

Built from `docs/plans/part-condition-origin.md` (owner's decisions are in it). Migrations
`20260930200000_part_condition_origin` and hub `010_listing_origin.sql`. Every check and Playwright spec passes (new
steps in smoke, inventory and market specs; hub smoke test covers a listing's origin, old-style listings too).
Worth knowing: "compatible, not genuine <Brand>" uses the part's Brand field (the machine maker); a shop number isn't
marked as one on the partner wire (the partner sees it as an ordinary number).

## 3. What to do next, in order



Steps 1-3 below are done (sections 2b and 2c): next is merging to `main` and deploying (hub first), then step 4.


1. **Finish round-3 fixes** for the remaining packages. Each file in `docs/round3/fix-packages/<pkg>.json`
   lists that package's findings (title, file:line, problem, scenario, suggested fix, evidence). Order and
   file ownership (two packages at a time never touch the same files):
   - `bench-tickets` (finish), then `partners` (both repos: StitchBench lib/partners.ts, partner actions,
     repair-jobs, partners/repairs pages; StitchHub src/partners.mjs, migration 008)
   - `bench-parts`, and `hub-market-parts` (both repos: lib/hub.ts, lib/parts.ts, market/xref actions;
     StitchHub market.mjs, parts.mjs, usage.mjs, migration 009)
   - `bench-auth-desktop` (signup, auth pacing, platform-admin email reservation, desktop backup/main, seed),
     and `time-zone` (print and group every date in the shop's time zone, `src/lib/format.ts` + call sites)
   - Migration folder names reserved per package: 2026092710/11/12/13/14/15/16 0000_round3_<pkg>.
   - Keep old installs working against an updated hub and the other way round.
2. **Verify**: build, apply all migrations to an empty DB and to a copy of a populated one, check drift
   (`npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma`), run the
   specs and the hub smoke test, and re-run each finding's reproduction (evidence in the findings file).
3. Then the low and info findings (the owner chose high + medium first).
4. **New features** (all designed; designs in `docs/plans/`). Build order:
   1. `modules-design.md` package `modules-foundation` (paid modules: license keys, gating API, Settings >
      Modules, Companies switch, owner CLI signer, equipment categories). It must also absorb the StitchHub
      accounts changes in 5 below (base program licensed; hub as a second key issuer; auto key refresh).
   2. `scheduling-messaging-design.md` package `foundation`, then its feature packages (notices,
      estimate-links, campaigns, classes, appointments, register-bookings, shifts, partner-runs, e2e-docs).
      Scheduling and Marketing are paid modules gated through the modules API.
   3. `modules-design.md` Vac Shop and Small Appliance packages.
   4. StitchHub accounts and billing (5 below): not designed yet; design it first.
   Reference schema/migration/license code the designs refer to is in `docs/plans/reference/` (rename the
   `.txt` files back when using them). Codebase maps: `docs/plans/maps/`.
5. **StitchHub dealer accounts and billing** (owner decisions, not yet designed): dealers register (email
   confirmation), sign in and reset passwords on StitchHub; they buy monthly or yearly through Stripe
   (Checkout + Customer Portal, webhooks): add-on modules, hosted StitchBench (company created automatically),
   the Windows program itself (read-only when it lapses, never lose data), and hub membership (replaces
   emailing join keys; grandfather current members). The hub signs license keys with its own revocable key and
   installs refresh them when online. Password resets: hub account by email; hosted app by email; Windows
   tray "Reset a password" on the shop PC; and from the hub account to a Windows install (only if that shop
   opted in on its PC, signed, one-time, short-lived, owner login only, shown on the PC).
6. Later rounds (owner approved): off-site backup, gift cards/store credit, reports + sales-tax report +
   QuickBooks export, audit log; then layaway/special orders, block-of-the-month clubs, kits, purchase orders,
   loaners, per-ticket time clock, warranty claims, drop-off signature. Needs owner decisions first: card
   reader (Square or Stripe), Shopify sync, online sign-up/booking pages, two-way texting inbox.
7. **Split StitchBench and StitchShop into separate repositories** (owner request, 27 Sep 2026). Today StitchShop
   is a build flavor of this one codebase (desktop/package.json `flavor`, APP_NAME/DEFAULT_SHOP_KIND), so the
   register, inventory, partners and hub client are shared code. Decide the shape first, then do it:
   (a) two repos with a shared core package (register, partners, hub client, Prisma schema) published or
   vendored into each; (b) one monorepo with two apps and a shared package (npm workspaces), one repo on
   GitHub; (c) two repos by copying, accepting that shared fixes must be made twice. Keep the installers,
   the Railway services, the hub protocol and both migration histories working through the move, and update
   INSTALL.md, the GitHub Actions installer workflow and the memory/handoff notes.
   Recommendation given to the owner (27 Sep): shape (b), one repo for the two programs laid out as
   `packages/core` (register, inventory, partners, hub client, schema + migrations, tests) plus
   `apps/stitchbench` and `apps/stitchshop` (branding, defaults, installer config, own version and release tag,
   own Railway service); StitchHub stays its own repo (it shares only the message contract; a tiny
   `stitch-protocol` package can come later if wanted). Four repos (a core shared by all three plus one per
   program) only if access or licensing must differ between StitchBench and StitchShop.

8. **Hosted = one shared instance for every shop** (owner decision, 27 Sep 2026): partner quilt shops and hosted
   bench customers are companies on the one StitchShop/StitchBench instance, not one instance each. That makes the
   per-company hub identity (round-2/3 finding: every company posts, lists and is rated under the install's one
   name) the first hub job: send `shopRef` + `shopName` on marketplace, note and usage calls, and store/show them
   per company on the hub, as the partner channel already does. A dedicated instance stays an option for a shop
   that asks for it (template it: one command per shop).
9. **Sharing is chosen per item, never automatic** (owner decision, 27 Sep 2026; wording is "offer"). From a
   machine or ticket: "Offer a hint about this model" sends that hint only, with nothing private from the ticket
   pre-filled (fixes the "Share with other techs" pre-fill finding). From a part: one "Offer this part" action
   where the shop picks where it goes: to its partner shops (partner price; today's "Offer to partner shops"
   checkbox), on the marketplace, or both. Nothing reaches the hub unless chosen. The monthly most-used-parts
   report is the one automatic share today: make it a per-company setting, off unless turned on.
10. **A shop chooses where it runs, and can change its mind** (owner decision, 27 Sep 2026): on the owner's shared
   hosted instance, as the Windows program on its own PC, or self-hosted on its own Railway (INSTALL.md covers all
   three; same hub, same partner links). Missing piece: a per-company export/import so one company can leave the
   shared instance for a PC or its own server, or join it from one, keeping its ids (partner records are keyed by
   them) and its hub/partner state. The Windows backup covers a whole install, not one company.
11. **HTTPS for the Windows program on the shop network** so tablets and phones can use the camera barcode scanner
   and copy buttons (browsers allow those only on secure pages; plain http://<pc>:3100 can't). Preferred: Tailscale
   (`tailscale serve` / a Tailscale certificate gives the shop PC an https://...ts.net address on every device on the
   tailnet); document it in INSTALL.md and have the tray list that address first. A locally installed certificate
   is the fallback for shops without Tailscale. Until then the app shows a clear message on non-secure pages.
12. **Manual links: download all, file on download, what's missing** (owner request, 27 Sep 2026). The hub is the
   community's catalog of links (the hub never hosts OEM manuals; each shop downloads into its own library).
   (a) "Download everything" for a model, a brand, or every link not yet in this library: a queued job, one file
   at a time with a pause between, skipping links the checker marks dead, with progress and resume.
   (b) File on download: when a link has category, brand, model and doc type, save straight to
   Category/Brand/Brand_Model_DocType.pdf (the library's naming) and add the LibraryDoc row so the model page shows
   it at once; only links missing that data, or downloads that aren't PDFs, go to _inbox. Keep the source URL and
   the link id with the file (index + a sidecar or the LibraryDoc row) so re-downloads and dedupe work.
   (c) Per model, show which doc types exist (service, parts, operator, error codes, wiring) and which are missing,
   so members know what to look for. Links already carry the doc type; the model page groups by it.
13. **Look into what AI to add** (owner request, 27 Sep 2026): scope and cost it first, then build the one or two
   with the best return. Candidates that fit what the program already holds:
   - Bench assistant on a ticket: from the model and the problem reported, suggest likely causes and the checks to
     make, drawing on this shop's own tickets and notes, the community's gotchas, and the factory specs already in
     the database; cite where each suggestion came from.
   - Ask the manuals: questions answered from the PDFs in this shop's own library with page references ("where is
     the hook timing procedure for the MC6700P"); the manuals stay on the shop PC, so the indexing runs there.
   - Intake helper: read brand, model and serial from a photo of the plate; pre-fill the ticket.
   - Write-ups: turn a tech's shorthand into the invoice's "work done" and the note to the sewing shop; draft the
     customer text/email for ready-for-pickup and estimates (ties into the messaging design).
   - Parts: suggest cross-reference matches and likely-needed parts for a job; flag duplicate xparts on the hub.
   - Counter: smarter spreadsheet column matching on import; product details from a barcode beyond the free lookup.
   Constraints to design around: customer names/contact never leave the shop without an explicit choice (same rule
   as sharing); the Windows program must keep working offline, so AI features degrade to "unavailable" cleanly (or
   use a small local model for the simple tasks); per-call cost belongs in the paid-modules plan (an "Assistant"
   module) rather than in the $25 base price; log what was sent and answered so a tech can check it.

## 4. Owner decisions already made (don't re-ask)

- Scheduling (StitchShop): classes/workshops (seats, waitlist, fee at the register), customer appointments
  (lessons, longarm time, drop-off; day/week calendar), partner repair pickup runs (both shops see them),
  staff shifts.
- Email through each shop's own SMTP; texts through Twilio. Campaigns plus automatic reminders, ready-for-pickup
  notices, estimate approval by link, service-due reminders, review requests, dated abandoned-machine notices.
- Pricing (26 Sep 2026): one rule for all three products, $25/month per shop, free while partnered (a repair shop or
  bench tech pays; a sewing shop pays only if it isn't sending anyone repairs; a shop may license directly and the fee
  is waived once it connects to a repair shop; $250/year alongside). StitchShop is free when a repair shop sets it up
  for its quilt shops; hosted copies at cost; the hub free to everyone. Recurring (subscription) revenue preferred.
  Not charging until: signed installer, a month of real use in one or two shops, terms/privacy page and Stripe billing.
  Prerequisites to build first: code signing, a per-shop license key checked against the hub. Idea kept for later: a
  "software fee" line on the partner statement, waived on activity. Community first: keep the hub free.
- Hosting: one shared instance for all companies (per-company identity on the hub to follow); sharing to the hub is
  a shop runs on the shared instance, its own PC or its own server, its choice; a per-item choice worded "offer" (offer a hint about a model; offer a part to partners and/or the marketplace), never automatic; usage reporting becomes an opt-in setting.
- Paid modules: Vac Shop (repair bench, bag/belt/filter finder shared via the hub, sales + warranty + trade-ins,
  central vac installs), Small Appliance Repair (KitchenAid-type mixers, 3D printers, other), Scheduling,
  Marketing. Unlocked by license keys the owner signs (checked offline) plus an admin switch on hosted.
  Monthly or yearly; renew reminders, grace period, read-only when lapsed.

## 5. Things to know

- Project rules are in AGENTS.md (shopId on every query, safe()/UserError, integer cents, Next.js 16 differs
  from what you know: read `node_modules/next/dist/docs/`).
- Manuals stay local; never add manual upload to the server.
- The Windows program (`desktop/`) was never run during the review, only read.
