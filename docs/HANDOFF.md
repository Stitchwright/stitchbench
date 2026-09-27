# Handoff: where the work stands (27 Sep 2026)

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

## 3. What to do next, in order

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

## 4. Owner decisions already made (don't re-ask)

- Scheduling (StitchShop): classes/workshops (seats, waitlist, fee at the register), customer appointments
  (lessons, longarm time, drop-off; day/week calendar), partner repair pickup runs (both shops see them),
  staff shifts.
- Email through each shop's own SMTP; texts through Twilio. Campaigns plus automatic reminders, ready-for-pickup
  notices, estimate approval by link, service-due reminders, review requests, dated abandoned-machine notices.
- Paid modules: Vac Shop (repair bench, bag/belt/filter finder shared via the hub, sales + warranty + trade-ins,
  central vac installs), Small Appliance Repair (KitchenAid-type mixers, 3D printers, other), Scheduling,
  Marketing. Unlocked by license keys the owner signs (checked offline) plus an admin switch on hosted.
  Monthly or yearly; renew reminders, grace period, read-only when lapsed.

## 5. Things to know

- Project rules are in AGENTS.md (shopId on every query, safe()/UserError, integer cents, Next.js 16 differs
  from what you know: read `node_modules/next/dist/docs/`).
- Manuals stay local; never add manual upload to the server.
- The Windows program (`desktop/`) was never run during the review, only read.
