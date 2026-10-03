# Handoff: where the work stands (1 Oct 2026)

Read this first in a new Claude Code session. Everything below is on `main` in both repos (bwattendorf/stitchbench
and bwattendorf/stitchhub): the round-3 review fixes, the parts condition feature and Windows program 1.6.0 were
merged on 30 Sep 2026 (pull request #1 in each repo) and deployed the same day: the hub, hosted StitchShop and hosted
StitchBench run it, this PC has StitchBench 1.6.0, and the 1.6.0 installers were built (workflow run 36753645022).
Next is section 3 step 4 (the paid-modules foundation).

## 0. First steps on the owner's PC (done 30 Sep 2026)

All done on 30 Sep 2026 (a backup `stitchbench-2026-09-30-13-47-56` was taken first). Kept as the recipe for the
next release. Lessons: commands the owner runs with the `!` prefix go through Bash, which strips backslashes from
Windows paths, so give forward-slash paths joined with `&&` (a failed `cd` deployed the StitchBench folder to the
stitchshop project twice); `desktop/backup-now.mjs` makes the same backup as the tray menu from a console.

1. The PC may have work that was never committed. In the StitchBench folder, then the StitchHub folder: `git status`
   and `git branch --show-current`. If anything is modified or untracked (check `.env` and other secrets are NOT
   listed), save it on its own branch (`git switch -c my-pc-work`, `git add -A`, `git commit`,
   `git push -u origin my-pc-work`) and ask the owner what it was for before merging it into `main`.
2. Get `main`: `git switch main` and `git pull` in both folders. In StitchBench: `npm ci` (it works again),
   `npx prisma migrate deploy` for the dev database, and `npm install` in `desktop/`.
3. Deploy, hub first (old and new installs and hubs work with each other):
   - Hub: `railway up --ci` in the stitchhub folder. Its migrations 008-010 run at start.
   - Hosted StitchShop: `railway up --service stitchshop --ci` in the stitchbench folder.
   - Hosted StitchBench: `railway link --project stitchbench`, `railway up --service stitchbench --ci`, then
     `railway link --project stitchshop --service stitchshop`.
   - Each app applies its migrations on start and reloads the shipped specs once (a few seconds); Railway now
     health-checks `/api/health` on the apps and `/health` on the hub. Open each address and sign in to check.
4. Windows program 1.6.0: make a backup from the tray menu first. Build the installers with the "Windows installers"
   workflow (GitHub, Actions tab, Run workflow on `main`; the cloud session wasn't allowed to start it), or update this
   PC in place: `npm run prepare-app` in `desktop/`, then `scripts/local-test/update_installed.ps1 -Version 1.6.0`.
   Everyone on the program signs in once after this update.
5. Then carry on with section 3. Sections 2b-2d list what changed for the shops, so the owner knows what they'll
   notice.

## 0b. Where things run (27 Sep 2026)

- Hub: https://stitchhub-production.up.railway.app (Railway project `stitchhub`; deploy with `railway up --ci` in the
  stitchhub folder).
- Hosted StitchShop: https://stitchshop-production.up.railway.app (project `stitchshop`, service `stitchshop`).
- Hosted StitchBench: https://stitchbench-production-e554.up.railway.app (project `stitchbench`, service `stitchbench`;
  owner login bwattendorf@gmail.com, password file in the owner's Documents folder).
- StitchBench 1.6.1 installed on the owner's PC (since 30 Sep 2026, evening; round3-tail and round3-tail2 deployed everywhere the same evening); installers for both programs build with the
  GitHub Actions workflow `installers.yml` (unsigned; `gh workflow run installers.yml --ref main` starts it).

## 1. Get set up on the PC

```
git clone https://github.com/bwattendorf/stitchbench && cd stitchbench
git checkout main
npm ci                 # works again (H1 fixed)
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

Merged to `main` in both repos and deployed on 30 Sep 2026 (section 0). Every high and medium
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

## 2e. Round-3 tail (30 Sep 2026, evening, branch round3-tail)

Finished the leftovers that needed no owner decision: M12, L22, L51, L90, L117, L121, L130, L133, L139 (statuses in
`docs/round3/ROUND3_FINDINGS.md`). Hub migration `011_revision_company.sql` (company name on link and cross-reference
revisions). New e2e setup: `npm run e2e:setup` also makes a tech user and a second company (`scripts/local-test/README.md`),
with `tests/tenant.spec.ts`, `tests/roles.spec.ts` and more of `tests/auth.spec.ts` (I4, I5, I19, I20). What the owner will
notice: the register scan box takes a claim tag (T101 or 101) and a receipt (S1004, loaded as a return); check-in has a
customer search instead of a long list; cross-reference history has "Load older"; the Companies form asks for a time zone.
Still waiting on owner decisions: L7/L31, L42, L126, L127, L95, L134/I27 (section 2c).

## 2f. Paid modules foundation (1 Oct 2026, branch `modules-foundation`, PR open)

Built from `docs/plans/modules-design.md`, package `modules-foundation` (section 13.2), all of it: the schema and
migration, the licensing library and gating API, Settings → Modules, the Companies switch, equipment kinds at check-in
and on tickets, machines and model pages, the register's Vac Shop plumbing, the owner's CLI, the Windows restore
changes, the check scripts and `tests/modules-basics.spec.ts`. Checked on this PC: `tsc`, `npm run lint`,
`npm run test:unit`, `scripts/checks/{license,modules,equipment,modules-tenant}.check.ts`, the drift check, `npm run
build` and `STITCH_TEST_BUILD=1 npm run build`, `cd desktop && npm test`, the CLI acceptance, and the Playwright specs
modules-basics, smoke, register, auth, tenant and roles on the test build (hub, market, partners, inventory not re-run:
they need the test hub). Nothing is deployed and no module is on anywhere: with no `k1` line in `src/lib/license-keys.ts`
a pasted key verifies only on a development server, so shops see no change until the rollout checklist is done.

Where it departs from the design, and why:
- The migration is `20261001120000_paid_modules` (the design's `20260926120000` would sort before folders already on
  `main`; the design itself asks for a later name). `desktop/backup.mjs`'s version-gated fix-up uses the new name. The
  scheduling design's migration (`20260926150000_scheduling_messaging`) must be renamed the same way when it is built.
- `RegisterItem` and the Part → item mapping moved to `src/lib/register-item.ts` (`viewItem`): a `"use server"` file may
  export only async functions, and Turbopack refuses even a type re-export there. `registerUnitHits` builds items from it.
- `createShopWithOwner`'s option is the existing `allowReserved` (the design's `byPlatformAdmin`).
- The tickets CSV keeps its per-line layout and adds `job_type, kind, site_address, details, intake, kind_readings` at the
  end (`readings` was already the name of the timing-readings column).
- `src/lib/license.ts` `validYmd` guards an out-of-range date (the reference threw a RangeError).
- `--key` in `npm run license` falls back to the newest non-retired pem when no compiled-in kid exists, with the warning.
- The module notice shows only on pages and tickets that can't take new work; a ticket opened before a module ended shows
  no notice while it can still be finished (D3).

Before the first release of modules (INSTALL.md, "Paid modules"): fill `MODULE_SALES.email`, run keygen for `k1` and
`h1`, commit their lines, set `LICENSE_HOSTED_KEY` / `LICENSE_HOSTED_KID` on the hosted services. Next packages: the
scheduling design's `foundation` (alone), then `vac-repair`, `vac-finder`, `vac-sales-warranty`, `appliance-repair`
(section 13.1 build order).

## 2g. Scheduling and messaging foundation (1 Oct 2026, branch `scheduling-foundation`, merged as PR #10)

Built from `docs/plans/scheduling-messaging-design.md`, package `foundation` (section 15.1): migration
`20261001130000_scheduling_messaging` (15 models; fields on Customer, Machine, Ticket, SaleLine, PartnerLink,
RepairJob), nodemailer 10, the messaging core (`src/lib/messaging/*`: settings with sealed secrets, templates, quiet
hours, the consent gate, the queue, SMTP, Twilio, replies, service due, the worker and its timer), `src/lib/zoned.ts`,
`ticket-status.ts` (`setStatus` is now a data action returning a toast note), `estimate-answer.ts`, `module-gate.ts`,
Settings → Messages (Setup / Automatic messages / Rules), `/messages` (outbox, replies, opt-outs), consent on the counter
tablet (`/consent/[customerId]`) and the paper form, "How should we tell them" on customers, check-in and take-in, the
nav items Calendar / Classes / Messages (gated), the slot stubs and placeholder pages for the feature packages, the
desktop links gate (`desktop/links-gate.mjs`, `publicUrl` in config.json) and the restore carry-over of opt-outs, the
sink and mock (`npm run mail:sink`, `npm run sms:mock`), checks `messaging-core`, `worker`, `links-gate`,
`restore-optouts`, and `tests/messaging.spec.ts`. Checked here: tsc, lint, unit tests, every check script, desktop tests,
`STITCH_TEST_BUILD=1 npm run build`, and the Playwright specs messaging, smoke, roles, tenant, register and
modules-basics on the test build with the sink and mock (16.3 shows the server variables).

Worth knowing:
- Nothing sends until a shop sets up email or texts in Settings → Messages and has Marketing on; `MESSAGES=off` stops
  every send path on a dev copy. Hosted production needs `SETTINGS_KEY` before a password can be saved.
- `tests/messaging.spec.ts` gives its company a time zone where it is mid-day, because texts only go out 9:00-20:00 shop
  time; it also resets the shop's reply watermark before the STOP step (replies are read at most every 5 minutes).
- The paper-form prototypes the design mentions under `scratch/` never existed here; the sink and mock were written
  from the design's description.
- Next: the feature packages of section 15 (notices, estimate-links, campaigns, classes, appointments,
  register-bookings, shifts, partner-runs), each in its own worktree and database, then `modules-crossover` and the
  Vac Shop / appliance packages from the modules design.

## 2h. Scheduling packages `notices` and `estimate-links` (1 Oct 2026, pushed straight to `main`)

Both packages of the scheduling design (15.2 and 15.3) are on `main` and deployed to hosted StitchShop and hosted
StitchBench; this PC's StitchBench 1.6.1 was updated in place the same day (and the installer file list now ships
`desktop/links-gate.mjs`, which the in-place update had left out: the program would not start without it).

- `notices`: `src/lib/notices/{hooks,scheduler,vars,abandon}.ts`, `src/actions/notices.ts`, the slots
  `ticket-notices`, `job-notices`, `repairs-back`, `todo-lines`, the notice-letter pages under tickets and repairs,
  `/u/[token]` and `/api/u/[token]` (unsubscribe, RFC 8058 one-click), `scripts/checks/abandon.check.ts`,
  `notices.check.ts`, `seed-marketing.ts` (seeds one sent marketing email and prints its unsubscribe token:
  `npx tsx --conditions=react-server scripts/checks/seed-marketing.ts --shop "<company>" --email <address>`),
  `tests/notices.spec.ts`.
- `estimate-links`: `src/lib/estimate-links.ts`, `src/actions/estimate-links.ts`, the slots `ticket-estimate`,
  `job-estimate`, `estimates-todo`, `src/components/auto-refresh.tsx`, `/e/[token]` and `/api/e/[token]`,
  `scripts/checks/estimate-links.check.ts`, `tests/estimate-links.spec.ts`.

Checked here: tsc, eslint, the check scripts abandon (6 groups), notices (11), estimate-links (17) and worker (26), and
on a test build (`STITCH_TEST_BUILD=1 npx next build`, server on :3501 with the sink on 2526/2581 and the mock on 3402,
`MESSAGE_WORKER_SECONDS=5 READY_NOTICE_DELAY_SECONDS=1`, the package ports of design 16.3 with n = 1) the specs
notices (3 tests), estimate-links with `PUBLIC_URL=http://localhost:3501` on the server and in the spec's process (the
link tests) and again without it (the "they call or reply" tests), and smoke. Not checked by a spec (design 15.2
acceptance 5): the "send it by hand (Messages is off)" wording with Marketing off and "Marked ready by the repair
shop. Are they here?" on `/repairs`; both are in the slot code, look at them by hand on a retail company.

Worth knowing:
- The specs make their own company from Companies (the e2e owner must be in `PLATFORM_ADMIN_EMAILS` on the server),
  switch Marketing on, set up email against the sink from Settings -> Messages, and delete the company at the end.
- A text or email a person asked for shows on the ticket as "Sent by text ..., asked for by <name>"; only letters,
  certified mail and phone calls say "Given by ... recorded by".
- The dev database: when every Prisma query fails with "Server has closed the connection" while `docker exec psql`
  works, the WSL relay on `[::1]:5433` is hanging (Node tries IPv6 first); run with
  `DATABASE_URL=postgresql://stitchbench:stitchbench@127.0.0.1:5433/stitchbench` or restart Docker Desktop. On 1 Oct the
  real cause was a full disk (0 bytes free); Docker Desktop had died with it and had to be started again.
- Next: the remaining feature packages (campaigns, classes, appointments, register-bookings, shifts, partner-runs),
  then `e2e-docs`, then `modules-crossover` and the Vac Shop / appliance packages.

## 2i. Deep review of the two packages, fixed (1 Oct 2026, evening, on `main`)

`/code-review max 9af9b15..HEAD` (10 finder angles, verifiers) found 15 problems in notices and estimate-links; all are
fixed, with regression groups in `estimate-links.check.ts` ("reviewFixes"), `notices.check.ts` (stillWanted estimate)
and `messaging-core.check.ts` (render). What changed, for anyone reading the code:

- Migration `20261001200000_ticket_estimate_answer`: `Ticket.estimateAnswer` / `estimateAnsweredAt`, written by
  `answerTicketEstimate` whichever way the answer came (link, phone, text reply), cleared by `statusData` when the
  ticket waits for an OK again and by `sendEstimateAs` (a revised estimate). A declined ticket keeps its status
  (design 10.4) but is answered: the to-do, the panel, the link page and `estimateStillWanted` all use it.
- `stillWanted` for estimate rows is `estimateStillWanted` (one copy): rows without a link are checked against the
  ticket / job too, a missing or expired link cancels, and an answer (by link, by phone, or a status change away from
  WAITING_CUSTOMER_OK) cancels the queued estimate messages (`cancelQueuedEstimates`, `onTicketStatus`).
- Estimate links are for direct tickets only: a trade-account ticket (viaAccountId) is refused like a partner's.
- A phone approval records the OPEN link's total, else the bill as it stands; `closeOut` handles the replies of the
  whole round (since the previous answer), not just since the newest send.
- `render()` keeps the leading space / blank line of the `_line` fields ("ready to pick up. Balance: $145.00.").
- The ready toast and "It's back" note say when a text really goes (quiet hours: "9:00 am tomorrow"); "Send the
  current notice now" refuses when that stage is already waiting to go out; by-hand notices carry a `byhand:` dedupe
  key and don't count toward the 3-a-day staff cap; a tracking number is stored only for certified mail.
- `ActionResult` has `note` (shown as the success toast) and `warn` (toast.warning: it worked, staff must call
  someone); `markBackAtCounter` / `markManyBack` / `tellThenSendReady` return them, and the slots pass the actions
  straight through (no inline "use server" closures). `recordBack` runs with a 60 s transaction timeout.
- "They said: Text / Email / Both" shows for worker-skipped ready notices too (the row holds the label then).
- Service-due and review requests: when marketing email can't be used (no postal address, or no watched reply-to on
  the Windows program / without a public address) a SKIPPED row says so on the Messages page instead of a silent
  fallback to texts.
- `/api/e/[token]` reads at most 8 KB and always answers 303 back to the page; `/e/[token]` shows nothing of the
  estimate once the link is stopped or expired; `/api/u/[token]` tolerates two clicks at once.

Checked here: tsc, eslint, every check script, unit tests, and on a fresh test build the specs notices, estimate-links
(with and without PUBLIC_URL) and smoke.

The low-severity leftovers were done the same evening (commit after 06ca44a): `uncollected()` computes the stages
from the ready dates first and queries only the machines with a stage due (one query for the rows that exist, then
`abandonTarget` for the few to queue); migration `20261001210000_notice_indexes` adds `Ticket(shopId, status,
closedAt)`, `RepairJob(shopId, side, backAt)` and `RepairJob(shopId, side, pickedUpAt)`; `ready_date` / `abandon_date`
carry the year (`fmtDayYear`, "Fri, Oct 2, 2026"; the design said fmtDay, changed on purpose: the abandon date can be
months away and a letter is read later); the estimate page says the link works until a time, not a day; the slots read
the time zone through `shopTimeZone()`. Checked: tsc, eslint, the notices / abandon / worker / estimate-links checks,
unit tests, `prisma migrate diff` (no drift). The Playwright specs were not rerun for this one (no spec asserts on it).

## 2j. Scheduling package `campaigns` (2 Oct 2026, on `main`)

Design section 11 and package 15.4. Files: `src/lib/messaging/audiences.ts` (the audience kinds, `audienceMembers`,
`previewCampaign`, `upcomingClassesLine`), `campaign-build.ts` (the stub filled: 500 members per campaign per worker
run, rows with per-row unsubscribe tokens, `same_address` counted, QUEUING -> SENDING), `campaigns.ts` (the bodies of
the actions with a user, so the checks can drive them: save / test / queue / cancel / copy / delete / import),
`src/actions/campaigns.ts`, `src/actions/customer-import.ts`, the pages `/campaigns`, `/campaigns/new`,
`/campaigns/[id]`, `/customers/import`, the components `campaign-form`, `customer-import`, `two-tap-button`,
`scripts/checks/audiences.check.ts` (8 groups), `campaigns.check.ts` (8 groups), `tests/campaigns.spec.ts` (4 tests).
Checked: tsc, eslint, both checks and the other messaging checks, unit tests. The spec: its first test passed on a test
build; the other three had not been run when the PC ran out of memory (the build was killed), so run the spec before
trusting the pages: `STITCH_TEST_BUILD=1 npx next build`, the server with PUBLIC_URL on :3501, sink 2526/2581, mock 3402.

Worth knowing:
- "Came to a class" (`classes`) means enrolled (not waiting, not cancelled) in a class that held a meeting in the window:
  there is no per-person attendance record (the roster is on paper), so that is the nearest the data can say.
- A text campaign body is at most 480 characters and `plainText()` keeps it to 160-character parts, so the "more than
  4 parts" rule can't trigger today; it stays in code for a longer shop name or a future limit.
- The campaigns check sets `PUBLIC_URL` (the hosted rules: `List-Unsubscribe-Post`); the test server for the spec needs
  it too. Marketing texts need the shop AND the number's area code inside 9:00-20:00: the spec's company is Eastern,
  its numbers 212, and the text test skips itself outside 10:00-18:00 Eastern.
- The channel is fixed after the first save (copy the campaign to send it the other way); the subject and body accept
  `{first_name} {name} {shop_name} {shop_phone} {machine} {upcoming_classes}` (`checkTemplate`).
- Next packages: classes, appointments, register-bookings, shifts, partner-runs, then e2e-docs.

## 2k. Scheduling package `classes` (2 Oct 2026, committed, built without a browser run)

Design 12.1 and package 15.5. `src/lib/classes.ts` (seatCounts, syncClassDates, classLine, meetingDays, enrollIn under
the class lock, nextMeetings), `src/lib/class-actions.ts` (the bodies with a user: save / meetings / status / delete /
enroll / cancel / moveUp / price / messageClass, and the register's openClassSeatsFor / enrollAtRegisterAs),
`src/actions/classes.ts` and `class-register.ts` (thin wrappers), the pages `/classes`, `/classes/new`,
`/classes/[id]`, `/classes/[id]/roster`, `/classes/print`, `src/components/class-form.tsx` (ClassForm + MeetingFields),
the slot `customer-classes.tsx`, `scripts/checks/classes.check.ts` (8 groups), `tests/classes.spec.ts` (4 tests).

Worth knowing:
- The owner asked for the remaining packages to be written before the next build-and-test batch (the PC runs out of
  memory with a Next build, the test server, Chrome and Docker together). So: tsc, eslint, every check script and the
  unit tests pass; `tests/campaigns.spec.ts` (3 of 4 tests) and `tests/classes.spec.ts` (all) have NOT run yet. Run
  them on the next test build, with PUBLIC_URL on the server and the sink and mock up.
- `messageClass` sends one note per person, however many of their family are signed up; the register never waitlists.
- `ymdParts` in `src/lib/zoned.ts` is exported now (meetingDays uses it).
- Next packages: appointments, register-bookings, shifts, partner-runs, then e2e-docs.

## 2l. Scheduling package `appointments` (2 Oct 2026, committed, built without a browser run)

Design 12.2 and package 15.6. `src/lib/appointments.ts` (Hours, hoursFromForm / hoursText / withinHours, freeSlots,
freeWeek, poolKey, overlapCount), `src/lib/calendar.ts` (calendarItems: appointments and blocks, class meetings, pickup
runs, shifts when asked, installs through the vac stub), `src/lib/appointment-actions.ts` (saveApptTypeAs, bookAs,
rescheduleApptAs, setApptStatusAs, linkedWords), `src/actions/appointments.ts`, the pages `/calendar` (Day / Week,
"Show staff"), `/calendar/new` (free times as buttons), `/calendar/appointments/[id]`, `/calendar/types`, the
components `calendar-view`, `appointment-form`, `appt-type-form`, the slots `today` (register strip / Dashboard card)
and `customer-appointments`, `scripts/checks/appointments.check.ts` (10 groups), `tests/calendar.spec.ts` (4 tests).

Worth knowing:
- Types naming the same resource share its capacity AND its spelling: saving "longarm" next to "Longarm" stores
  "Longarm", so the "already booked" message and the pool key agree.
- `hoursText` groups days by window ("Mon, Wed 09:00-12:00, Sat 10:00-14:00"; runs of 3+ read "Tue-Sat").
- The booking form reloads with `?type=` when the type changes (the server computes the free week); the Week view
  draws both the 7-column grid (xl) and the per-day list (below xl) and hides one with CSS.
- The spec, like campaigns' and classes', has NOT run yet: it needs the next test build.

## 2m. Scheduling package `register-bookings` (2 Oct 2026, committed, built without a browser run)

Design 12.3 and package 15.7. The sale and void moved out of `src/actions/register.ts` into
`src/lib/register-sale.ts` as `completeSaleAs(user, input)` / `voidSaleAs(user, saleId, reason)` (the actions are thin
wrappers now, so a check script can drive a sale); the booking rules live there too (loadBookings, bookingLine,
settleBooking, unsettleBooking, bookingsDueFor). `bookingsDue` is the register's data action; `register.tsx` has the
"Classes & appointments" picker (Owed / Refund in return mode / Sign up for a class, with name + phone when no customer
is on the sale), booking lines with their inputs off (an admin's refund price on), and the `preload` from a roster's
"Ring up"; `/register?booking=enrollment:<id>` loads it; the sales report has Classes and Appointments buckets.
`scripts/checks/register-bookings.check.ts` (6 groups), `tests/register-bookings.spec.ts` (3 tests, not yet run).

## 2n. Scheduling package `shifts` (2 Oct 2026, committed, built without a browser run)

Design 12.4 and package 15.8. `src/lib/shifts.ts` (weekShifts, minutesByName, hoursText, and the bodies saveShiftAs /
deleteShiftAs / copyWeekAs), `src/actions/shifts.ts`, `src/components/shift-form.tsx`, the pages `/shifts` (grid people
x days from the xl width, one list per day below it, hours per person, the signed-in person's row bold, add / change /
delete / "Copy last week" for admins) and `/shifts/print`, `scripts/checks/shifts.check.ts` (5 groups),
`tests/shifts.spec.ts` (3 tests, not yet run). Overlaps are refused per person (the same login, or the same name in
any case); copyWeek copies by weekday and wall clock, so the DST week keeps 8:30 am.

## 2o. Scheduling package `partner-runs` (2 Oct 2026, committed, built without a browser run)

Design 13 and package 15.9. `src/lib/partner-runs.ts` (pure: canDo, planOutcome, receivedList, okWords),
`src/lib/partners.ts` (the five message types in FROM, `applyRun`, `runPlan`, `sendRun`, `runEffects`,
`pushFeatures`; `caps.update` re-sends our scheduled runs to a partner that just learned to take them; the run messages
get a notices context in applyOnce), `src/lib/partner-run-actions.ts` (rideJobs, defaultStart, propose / change / OK /
cancel / record with a user), `src/actions/partner-runs.ts`, `src/components/run-form.tsx`, the pages
`/partners/[id]/runs/new` and `/partners/[id]/runs/[runId]`, the slots `partner-runs`, `job-run`, `repairs-runs`,
`dashboard-runs`, the three run lines in `partner-todo.tsx`, `cancelJob` refusing a collected job,
`scripts/checks/partner-runs.check.ts` (9 groups: the pure rules, both flows relayed through PartnerOutbox + applyRun,
replays, a third link, the non-owner's plan, a 30-day-old DONE, pushFeatures once), `tests/partner-runs.spec.ts`
(HUB_URL only; its hub join steps are written from partners.spec.ts' shape and need a look on the first run).

## 2q. Vac Shop packages `vac-repair` and `vac-finder` (2 Oct 2026, committed, built without a browser run)

Modules design 10.a and 10.b. **vac-repair** (c57f675): the full vacuum kind in `src/lib/equipment/vacuum.ts` (30
brands, 13 accessories, the `bagged` / `bagType` / `power` / `smell` intake fields, the 10-line checklist, the 16-name
starter menu, suction / amps / brush-roll readings, `brandMatches`), the Vac Shop home with its counts and the
"filed as sewing machines?" count, `/vac/convert`, `src/lib/equipment/links.ts` (genericLinks moved out of the
registry to break a circular import), `scripts/checks/vacuum-kind.check.ts` (pure, 6 groups).
**vac-finder**: `src/lib/vac/finder.ts` (`suppliesFor`: exact fits under the maker, the prefix "close match"
fallback through `$queryRaw`, type / number search, one stock query with the brand-aware `partIsSupply` rule, the
local Fits fallback, sort then cap at 60; `customerVacuumsFor`, `finderHref`, `newSupplyHref`, `VAC_SEARCH_SITES`),
`src/actions/vac-finder.ts` (`vacSupplies`, `customerVacuums`: requireUser + requireModule vac), `src/lib/xref-rules.ts`
(`numberOwner` moved out of the action file so a check can drive it), `src/actions/xref.ts` hardened (every hub write
goes through `requireHubWrites` and sends its byName; remove, merge and roll back are `requireAdmin`), the xref form's
category datalist and `category` default, `/xref` reading `category`, `kind`, `fits`, `name` for the add form and
keeping "Brand, model" Fits lines, `/xref/[id]` hiding Remove / Merge / Roll back from techs, `/vac/finder` (brand +
one box, groups Bags / Belts / Filters / Other, stock lines, Details and "This fits another model", the New bag /
belt / filter links, the not-joined and offline notes), the register's `VacSupplyPicker` (a customer's vacuums as
buttons, or brand + box; Add per stocked item with the vacuum's machineId), `SuppliesThatFit` on vacuum machine
pages, `scripts/checks/vac-finder.check.ts` (13 groups incl. the tenant section). No schema change, no hub change.
Not run in a browser: acceptance items 2 to 5 of package `vac-finder` (design 13.2) belong in the test batch of 2p.

## 2r. Vac Shop package `vac-sales-warranty` (2 Oct 2026, committed, built without a browser run)

Modules design 10.c. `src/lib/vac/units.ts` (`warrantyEnd` in shop time with the day clamped, `warrantyThrough`,
`unitDescription`, `listUnits` on the four tabs with the search, `unitDetail`, `receiveUnitsFor` one unit per serial
with the customer's-vacuum and already-in-stock refusals, `updateUnitFor`, `setUnitOffSaleFor`,
`recordRegistrationFor`, `unitFromAbandonedFor` at the ticket's unpaid balance, `unitsForSaleFor`,
`unitsToReturnFor`), `src/lib/vac/sale-units.ts` (the register hooks: `prepareUnitLines` with the per-line rules and
the lapsed gate that still allows a return, `applyUnitLine` for sale / return / trade-in with the `prev` snapshot on
a traded-back unit, `voidUnitLines` in both orders, `registerUnitHits`), `src/actions/vac-units.ts`, the register's
`VacUnitTools` (Vacuum for sale, Trade-in, Return a vacuum), `UnitBadge` (with "Put up for sale" on an abandoned
vacuum), `SaleUnitNotes` on the receipt, `/vac/units` (tabs, table, the admin "Add vacuums for sale" form with the
vacuum's intake fields) and `/vac/units/[id]` (details, history, registration, the admin edit and off-sale forms),
`scripts/checks/vac-units.check.ts` (15 groups through the real `completeSaleAs` / `voidSaleAs`, the gate on a lapsed
company, the tenant section). No schema change. Acceptance items that need a browser (the register flows, the
receipt, the export's `for_machine`) belong in the test batch of 2p.

## 2s. Vac Shop package `vac-bags-due` (2 Oct 2026, committed, built without a browser run)

Modules design 10.c′. `src/lib/vac/bags-due.ts` (`bagsDue`: bagged vacuums with a customer, not stopped or snoozed,
the base date from the unit's sale, bags rung up for the vacuum, bag PART lines on its tickets, or bags on a sale with
no vacuum picked when the customer has one bagged vacuum; "looks like bags" by the word or a part meeting a "Vacuum
bag" cross-reference entry; the 14-day window and the contacted rule; the bag to offer from the finder;
`bagsDueCount`; `bagsDueStillWanted` with its five reasons; `markCalledFor`, `snoozeBagsFor`, `stopBagsFor`,
`saveBagDaysFor`; `sendBagRemindersFor` through `queueToCustomer` with channels "one" (or texts only when marketing
email isn't allowed), dedupe `bags_due:{machineId}:{dueOn}`, contacted marks only where something queued;
`runBagsDue` still a no-op by design), `src/actions/vac-bags-due.ts` (the send returns a note / warn toast),
`/vac/bags-due` (the table with Called / Snooze 30 days / Stop reminders, the admin days setting, the send button
with Marketing on, the call-list copy without it), `src/lib/notices/hooks.ts` now awaits `bagsDueStillWanted`,
`scripts/checks/bags-due.check.ts` (9 groups, with the sink, incl. the tenant section). No schema change.

## 2t. Vac Shop package `central-vac-installs` (2 Oct 2026, committed, built without a browser run)

Modules design 10.d. `src/lib/vac/installs.ts` (`INSTALL_CHECKLIST`, `createSiteJob` inside the caller's transaction:
the power unit's Machine or the "Central vac / Power unit to be chosen" placeholder, the SITE ticket with
`takeTicketNumber`, Booked or Quote sent, the menu's SERVICE line, the TicketSite; `createInstallFor` for the form with
a picked or new customer and the address defaulting to the customer's; `saveSiteFor` and `setPowerUnitFor` behind the
ticket "work" gate so a lapsed module still finishes an install booked before it ended; `listInstalls` on upcoming /
done / all; `siteJobsBetween` for the calendar, empty unless Vac Shop is active or lapsed; `siteOf`),
`src/actions/vac-installs.ts`, `src/components/vac/site-fields.tsx` (shared form fields), `SitePanel` (maps link,
window, contact, Change and Set the power unit), `SiteInvoiceBlock`, `/vac/installs` with its tabs and
`/vac/installs/new`, `scripts/checks/vac-installs.check.ts` (9 groups incl. the tenant section). No schema change;
`SiteJob` keeps the shape `src/lib/calendar.ts` already consumes, with the customer, unit and contact added.

## 2u. Small Appliance Repair package `appliance-repair` (2 Oct 2026, committed, built without a browser run)

Modules design 11. `src/lib/equipment/appliances.ts` (the four built-in kinds in full: stand mixer, 3D printer, resin
3D printer, other appliance, with their types, brands, accessories and ticks, machine and ticket questions, checklists,
unpriced starter menus and readings), `src/lib/equipment/lines.ts` (pure: `readListBox`, `readAccessoryBox` /
`accessoryBoxText` with the "*" tick, `slug`, `uniqueKey`, `readQuestionRows` reading the `q.*` arrays by index with
removal by key and "Question n:" errors), `src/lib/equipment/shop-kinds.ts` (`saveEquipmentKindFor`: a new kind by
the label's slug, a given key the company has or doesn't yet, built-in and repeated names refused; `setKindActiveFor`;
`saveCheckInKindFor`), `src/actions/equipment.ts`, `/settings/equipment` ("Check-in opens on", the built-in kinds
read-only, the company's own kinds as forms with the question rows plus three blank ones, switch on / off, "Add your
own kind"), `scripts/checks/equipment-lines.check.ts` (11 groups: pure plus the database and tenant sections). No
schema change. Acceptance items 2 to 5 (the check-in forms, the ticket page readings, the dashboard order, the
switched-off behaviour) need a browser: the test batch of 2p.

## 2v. Package `modules-crossover` (2 Oct 2026, committed)

Modules design 12.4 and 13.2. Of the shared edits, four were already in place (the calendar's install items, the
estimate send gate in `sendEstimateAs`, `{machine}` "central vac install" in `ticketVars`, service due's equipment and
BENCH-only query with the scheduler's `canWorkOn` skip; `stillWanted` now awaits `bagsDueStillWanted`, done in 2s).
Made here: the `bags_due.sms` / `bags_due.email` defaults are the 10.c′ text (no "months since"), and
`answerTicketEstimate`'s APPROVED branch moves a SITE ticket to Booked (AT_SHOP_AWAITING_PICKUP) and leaves a ticket
that can no longer be worked on where it is (`ticketWorkable`), recording the answer either way.
`scripts/checks/modules-crossover.check.ts` (6 groups: the copy, a queued bags_due cancelled after Stop reminders, an
install's estimate approved by link, {machine} on an install, the install on the calendar, and after Vac Shop ends: a
pre-lapse approval goes to the bench, a collected ticket can't be sent an estimate, closing out works, new work is
refused, a post-lapse approval records the answer only). bags-due, estimate-links, notices, worker checks and the
unit tests pass with the new copy.

## 2w. Packages `modules-e2e` and the two `e2e-docs` specs (2 Oct 2026, committed, not yet run)

Modules design 13.2 `modules-e2e` and scheduling design 15.10. Five Playwright specs, written against the code and
never run: `tests/vac-shop.spec.ts` (check in, work and collect a vacuum; the finder with a local part and the
register's picker ringing a bag up for the customer's vacuum; a unit received, sold with its warranty line on the
receipt, a trade-in and its void; an install made, its power unit set, completed, "Work done at" on the invoice;
"Install: {customer}" on the calendar's day; bags due for a unit sold 200 days ago), `tests/appliances.spec.ts`
(mixer, 3D printer, resin printer, the shop's own Espresso machine with a relabelled question, "Check-in opens on"),
`tests/modules-lapse.spec.ts` (companies D and E with ended keys through `dev.ts --grant`; read-only units, no new
vacuum check-in, T1 finished, the unit returned, the export; E's "keeps working until" banner),
`tests/scheduling-messaging.spec.ts` (both modules: a class sign-up with its confirmation, an appointment, reminders
queued, a ready email, an estimate approved by link, both modules off with locks, read-only pages, a held message, the
roster, the classes CSV, the unsubscribe link; back on, the held message goes out) and `tests/two-servers.spec.ts`
(skipped without `E2E_SECOND_URL`: 30 queued notices arrive once each across two servers). `src/lib/calendar.ts` now
titles an install "Install: {customer}" (the ticket number when the install has no customer).
Expect label and selector slips on the first run: these specs belong to the test batch of 2p.

## 2x. The test batch, run (2 Oct 2026 morning, on this PC)

Every spec ran on a test build at :3501 with the sink (:2526 / :2581), the Twilio mock (:3402), a second server at
:3500 for two-servers and the local test hub at :3200 for partner-runs. Final results, one spec at a time:
smoke 1, modules-basics 4, notices 4, estimate-links 2 (+1 expected skip: the no-PUBLIC_URL variant), campaigns 3
(the text campaign ran in the afternoon window and passed too: 4 of 4), classes 4, calendar 4,
register-bookings 3, shifts 3, appliances 5, vac-shop 6, modules-lapse 3, scheduling-messaging 5, two-servers 1,
partner-runs 1. All passing.

**Real bugs the batch caught (fixed, in the build):**
- `src/app/(app)/campaigns/[id]/page.tsx` counted the admin's "Send me a test" message among the campaign's recipients
  (Sent 3 for 2 people). It now counts kind `campaign` only.
- `src/lib/class-actions.ts` read the class form's waiting-list checkbox with `fd.get("waitlist") !== "off"`; the form
  sends a hidden `off` before the checkbox's `on`, so the first value was always `off` and no class ever kept a
  waiting list. Now `fd.getAll("waitlist").includes("on")`.
- `src/lib/appointment-actions.ts` had the same slip for an appointment type's "Bookable now": every type saved
  inactive, so the booking form had nothing to pick. Same fix.
- `src/app/(app)/register/page.tsx` parsed `?booking=enrollment:<id>` with one capture group, so the id was never
  read and "Ring up" from a roster opened an empty register. The id is captured now.

**Spec slips fixed** (labels written against the code): URL checks that accepted `/x/new` before the redirect
(campaigns, classes, partner-runs), text that appears twice (toasts and status lines, select options, folded
previews, nested lists), rows matched by raw text where a cell's edit form lists every user (shifts), a `StockUnit`
insert without `updatedAt`, the ready toast with Marketing on naming the notice instead of the status, the
estimate link's "Yes, approve" button, the one-click unsubscribe being a POST, one customer per address for
two-servers, the take-in form's ids and "Take it in and make the claim tag", the run form naming a machine
"Tag 101 · Mary M. · Bernina B770". Specs `classes`, `register-bookings` and `partner-runs` accept `E2E_KEEP=1` to
leave their companies behind after a failure.

**How it was run** (the scripts live in this session's scratchpad; recreate as needed): the bundled Chromium
(`npx playwright install chromium`; the installed Chrome quit when the owner closed Chrome to free memory), the
server started with `PLATFORM_ADMIN_EMAILS=bwattendorf@gmail.com,e2e@stitchbench.test SMTP_ALLOW_HOSTS=127.0.0.1:2526
TWILIO_API_BASE=http://127.0.0.1:3402 MESSAGE_WORKER_SECONDS=5 READY_NOTICE_DELAY_SECONDS=1
PUBLIC_URL=http://localhost:3501 npx next start -p 3501`, specs with `E2E_BASE_URL=http://localhost:3501
E2E_EMAIL=e2e@stitchbench.test E2E_PASSWORD=e2e-password-1 SMTP_SINK_PORT=2526 SMTP_SINK_HTTP=2581
TWILIO_MOCK_PORT=3402 PUBLIC_URL=http://localhost:3501 npx playwright test tests/<name>.spec.ts --workers 1`
(smoke reads `E2E_EMAIL` / `E2E_PASSWORD` itself). A `next build` run as a background shell was killed by the
memory guard; run it in the foreground (about 4 minutes).

## 2y. Package `parts-in`: parts a ticket is waiting for (2 Oct 2026, committed, check and spec pass)

`online-and-parts-design.md` section 1, the first of the owner's three requests. Migration
`20261002120000_part_waits` adds `PartWait` (ticket, optional stocked part, description, qty, supplier, ordered /
expected / received / cancelled, `noticedAt`). `src/lib/part-waits.ts`: `addWaitFor` (a part by number fills in the
description and supplier; a description alone works; the ticket goes to Waiting on parts when asked),
`receiveWaitsFor` (one or many; per ticket one `parts_in` message naming every part received together, `channels
"preferred"`, dedupe per receipt, `noticedAt` only where something queued; "back on the bench" when asked and nothing
else is on order; the words for the toast say who hears and who to call), `reopenWaitFor` (within an hour; cancels
the queued message), `cancelWaitFor`, `openWaits`, `waitsForTicket`, `groupBySupplier`, `partsInStillWanted` (the
worker's reasons: the wait gone, not received after all, the part isn't coming, the ticket closed).
`src/actions/part-waits.ts`; the ticket card `src/components/slots/ticket-waits.tsx` (mounted above "Status and
work"); `/parts/on-order` (by supplier, Received per row and "Received all of these" per supplier, Cancel; the Parts
page links it as "On order"); message kind `parts_in` (notice) with its label, fields and default wording;
`stillWanted` routes it. `scripts/checks/part-waits.check.ts` (11 groups incl. the tenant section) passes;
`tests/parts-in.spec.ts` (3 tests) passes on the rebuilt test build. The rest of the design followed the same
afternoon: receiving stock on a part's page (`moveStock`, now returning its own result) warns in the toast when
tickets are waiting for that part and points at Parts, On order; the tickets export has `parts_waiting` and
`parts_received` columns and Settings → Your data has a "Parts on order" file (`/api/export/part-waits`, every wait
with its dates and who was told); the dashboard's "Waiting on parts" card opens `/parts/on-order`.

**Running the check scripts while a test server is up:** stop the server first (or start it with `MESSAGES=off`).
Its worker shares the dev database and sends or skips the check companies' queued rows, which made `notices.check`
report a stage as not sent.

## 2z. Package `online-booking`: customers book from the shop's website (2 Oct 2026, committed)

`online-and-parts-design.md` section 2, the owner's second request. Migration `20261002150000_online_booking`:
`Shop.bookingSlug` (unique) / `bookingOn` / `bookingLeadHours` / `bookingDaysAhead` / `bookingWelcome`,
`AppointmentType.online`, `ShopClass.online`, `Appointment.source` and `Enrollment.source` ("counter" | "online"),
and `BookingLink` (the hashed manage token, expiring a day after the booking). `src/lib/online-booking.ts`:
`publicShop(slug)` (open only when switched on and Scheduling is active), `publicTypes`, `publicClasses` (open, with
seats or a waiting list), `publicFreeTimes` (the type's free times over 14 days, none inside the lead time or past
how far ahead), `bookOnline` (customer matched by mobile or email within the shop or made as RETAIL with how to tell
them and a consent record; a trade account refused; the counter's room check under the same lock; the appointment
marked `online`; a manage link; the `booking` confirmation with the link when Marketing is on), `signUpOnline`
(`enrollIn`, the waiting list when full, the class_signup confirmation for a seat), `manageByToken`, `moveByToken`,
`cancelByToken` (allowed until the lead time; queued messages cancelled), `bookingSettings` /
`saveBookingSettingsFor`. Public pages outside `(app)`: `/book/{slug}`, `/book/{slug}/a/{typeId}` (times as links,
then the form), `/book/{slug}/c/{classId}`, `/book/m/{token}` (the booking, cancel with a confirm step, move);
`/api/book/{slug}` and `/api/book/m/{token}` POST (rate-limited per address and per shop, a honeypot field and a
five-second minimum fill time, always a 303 back to a page that says what happened). `src/auth.config.ts` lets
`/book/` through without a session; `src/lib/links-host.ts` and `desktop/links-gate.mjs` serve `/book/` and
`/api/book/` on the public address. Settings → Online booking (`/settings/booking`, linked from Settings → Modules):
the address, on / off, lead time, how far ahead, the welcome, which types and classes are offered, the link and an
iframe snippet; without `PUBLIC_URL` it says what to set. "Booked online" shows on the appointment page and the
roster. `scripts/checks/online-booking.check.ts` (8 groups incl. the last-slot race and the tenant section) passes;
`tests/online-booking.spec.ts` (3 tests) passes on the rebuilt test build. Fees are paid at the counter in this version; a public page that frames
well on another site is plain by design (no nav, the shop's name and phone at the top).
Also here: the morning's checkbox fix (2x) is refined. A form with no `active` / `waitlist` field at all now means on
(`checkbox()` in `appointment-actions.ts` and `class-actions.ts`); only a hidden `off` with no `on` means off. The
appointments check, whose forms send neither, had started saving types inactive.

## 2aa. Package `online-shop`: an online shop from the inventory (2 Oct 2026, committed)

`online-and-parts-design.md` section 3 as built (the owner's answers to its three questions: pickup and shipping,
the shop's own Stripe account or the hosted service's, order mail in the daily cap, each a setting). Migration
`20261003090000_online_shop`: `Shop.shopOn` / `shopPickup` / `shopShipping` / `shopShipCents` / `shopFreeOverCents` /
`shopPayVia` / `shopWelcome` / `shopPickupNote` / `stripeKeySealed` / `stripeWebhookSealed` / `nextWebOrderNumber`,
`Part.online` / `onlineTitle` / `onlineText`, `PartPhoto`, `WebOrder` (PENDING → PAID → READY → DONE, or
CANCELLED; the items as sold; the sale in the books; the order link sealed), `MessagingSettings.ordersInCap`.
`src/lib/shop/stripe.ts` (Checkout Sessions, refunds, the webhook signature; plain fetch against `STRIPE_API_BASE`),
`src/lib/shop/online-shop.ts` (settings, listing and photos, the public store, catalog and search, the cart in the
address, pricing as the counter, checkout, `applyPayment` once by webhook or return page with the sale under tender
`ONLINE` and short lines refunded, the staff steps, the order mail `order_notice` with templates `order_paid` /
`order_ready` / `order_shipped` / `order_cancelled`, `orderNoticeStillWanted`). Public pages `/shop/{slug}`,
`/shop/{slug}/i/{partId}`, `/shop/{slug}/cart`, `/shop/o/{token}`; routes `/api/shop/{slug}` (cart and checkout),
`/api/shop/stripe/{platform|shopId}`, `/api/shop/photo/{id}`; `src/auth.config.ts`, `links-host.ts` and
`desktop/links-gate.mjs` let `/shop/` and `/api/shop/` through. Staff: `/register/online` (nav "Online orders"),
Settings → Online shop (`/settings/shop`, linked from Settings for counters), the part page's "Online shop" card
(`src/components/shop/listing-card.tsx`). Tender `ONLINE` ("Paid online") exists in the books only: the counter's
buttons stay `TENDER_METHODS`. The worker's daily cap counts `order_notice` rows when the flag is on.
`scripts/test-mail/stripe-mock.mjs` stands in for Stripe (its own payment page; webhooks signed to
`STRIPE_MOCK_WEBHOOK_BASE`; `STRIPE_MOCK_PORT` 3403). `scripts/checks/online-shop.check.ts` (11 groups incl. the
tenant section) passes; `tests/online-shop.spec.ts` (3 tests) passes on the test build with the mock. Hosted first:
the hosted services need `STRIPE_API_BASE` unset (api.stripe.com) and, for the "through StitchShop's account"
option, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` with a webhook at `/api/shop/stripe/platform`; a shop using
its own account pastes its keys and adds the webhook Settings shows. Not in this version: customer accounts,
variants, gift cards, discount codes. One rule to know: a customer who asked for no messages ("none") gets no order
mail either, like booking.
**Stripe Tax (same day, the owner's ask):** Settings → Online shop → "Sales tax on online orders": "My rate" or
"Stripe Tax" (`Shop.shopTaxVia`, migration `20261003100000_online_shop_tax` with `WebOrder.taxVia`). Stripe Tax
applies to shipped orders only (pickup is a sale at the shop, at the rate) and only with the shop's own Stripe
account. The session asks for automatic tax with exclusive prices and the shipping tax code; the order takes
Stripe's total and tax at payment; `completeSaleAs` takes `taxCents` and records it with the effective rate; a
short line keeps its share of the tax from the session's lines. The check's group 12 covers it (12 groups now);
the mock charges 8 % per line under automatic tax. The shop must switch Stripe Tax on in its Stripe dashboard.

## 2ab. The 2 Oct evening batch, built by parallel agents and reviewed before each commit

Each item below was built by one agent, reviewed, type-checked, linted and (where there is code) checked, then
committed on its own. None is deployed; the Windows install was last updated before this batch (it has the shop
and Stripe Tax, not these).

- **Online-shop review fixes** (83f8675): a preliminary review found ten things; all fixed, the online-shop check
  gained a late-payment group (12 groups). The serious one: with "count order messages toward the daily cap" on and
  the cap reached, a `...dueWhere` spread let its `OR` replace the capped filter, so every due notice of the channel
  would have been pushed to tomorrow; now `AND: [capped, dueWhere]`. Also: stale PENDING orders expired by the
  message timer; a payment arriving after cancellation refunded at once; the register's own sales can't carry
  `taxCents` or the ONLINE tender; a cancel writes the refund down as soon as Stripe makes it (same idempotency key,
  same body, so a retry gets it back); payments applied one shop at a time with negative stock flagged; a non-hex
  webhook signature is a 400 not a 500; staff photos through `/api/parts/photo/{id}` (session) so the part page
  shows them before listing; a rate change between checkout and payment keeps the tax the customer paid; the shared
  address can't be blanked while booking is on; Stripe's error text goes to the log, the customer sees the code.
- **Online orders on the customer page and the "Online orders" CSV** (`/api/export/web-orders`) (9c9a48e).
- **Railway Infrastructure as Code** (bcc0372): `.railway/railway.ts`, not yet applied; section 3 item 14. The agent
  found both hosted services have neither `PUBLIC_URL` nor `SETTINGS_KEY` set: without them the hosted booking page
  and shop have no address and sealing Stripe keys or a mail password is refused. Set both (the names are in the
  preserve list already) before the owner's Stripe test-mode run.
- **StitchHub accounts and billing design** (7ca2dad, decisions 8bffafd): `docs/plans/hub-accounts-billing-design.md`;
  the owner took every recommended answer. **Package 1 `hub-accounts` is built** in the stitchhub repo on branch
  `hub-accounts` (commit 1350499, not merged, not deployed): migration 012_accounts, sign-up / sign-in / reset, the
  three doors, `/v1/shops/claim` real with standing, the /account pages, admin sections, a small SMTP client
  (`SMTP_URL`, `MAIL_FROM`, `HUB_URL` needed on the real hub; `MAIL_DEV_LOG` for the test hub), test/accounts.mjs.
  Package 2 `base-license` was started in this repo right after (see the next handoff entry or git log).
- **AI scope** (252a83a): `docs/plans/ai-assistant-scope.md`; build write-ups and the bench assistant first as one
  `assistant` package, every call through the hub, $15/month module proposed.
- **Repo split plan** (0519011): `docs/plans/repo-split-design.md` and the dry run `scripts/repo-split/plan.mjs`.
  Finding: the two programs share every source file (the flavour is two env vars), so the split is a restructure
  into packages/core plus thin apps; three working days plus a day of deploys; decide whether it is still wanted.
- **HTTPS on the shop network** (8a18914, item 11): the tray's "Secure address for tablets (Tailscale)" runs
  `tailscale serve` for the program's port, remembers and re-applies it, lists the https address first; the server
  learns it through `SECURE_URL`; the camera scanner and copy buttons explain on a plain-http page what to open
  instead; INSTALL.md section with the Tailscale steps and the Caddy certificate fallback (documented, not built).
  **Untested on the real PC** (Electron can't run here): the agent's seven-step list is in its commit message's
  spirit; try it after the next `update_installed.ps1`, with Tailscale present and absent.
- **Manual downloads** (eb30cbd, item 12): "Download all" for a model, brand or every link not in the library, a
  queue (`ManualDownload`) worked by its own timer on the shop PC only (`LIBRARY_DIR` present; `MANUAL_DOWNLOADS=off`
  stops it), one file at a time with `MANUAL_DOWNLOAD_PAUSE_SECONDS` between, dead links skipped, progress, Stop,
  resume; filing straight to Category/Brand/Brand_Model_DocType.pdf with a sidecar and a LibraryDoc row
  (`linkId`, `sourceUrl`, `downloadedAt`) when the link carries the data, else `_inbox`; PDFs checked by their
  first bytes (a web page is refused, not saved); dedupe by link, hub file name, earlier download or a file placed
  by hand; the model page shows doc-type coverage and groups links by type. Migration 20261003110000;
  `scripts/checks/manual-downloads.check.ts` (12 groups). Caveat: `SEED_LIBRARY=true` re-seeding drops LibraryDoc
  rows made by downloads until the Python index is rebuilt (dedupe still holds by path).
- **Package 2 `base-license`** (d73ee46, the import fix 1a66fab): the program's own standing. Module id `base` with a
  hub-signed SB1 key (kid scope `hub`, `License.source` pasted | hub, one hub row per company, `revokeKeyIds`
  honoured); every company claimed at every sync with shopRef, shopName, kind, program, version and `sole`; the
  hub's standing and last day stored on the Shop; the `pending` hub scope; Settings → Account (door 1 create the
  account, waiting for the email, send it again; door 2 a 15-minute link code; Check again; the 60-day nag; the
  reset opt-in on Windows); read-only on lapse enforced in `safe()` with the allow-list `src/lib/lapse-allow.ts`
  (`safe.whileLapsed("name")(fn)`; payments, closing statuses, returns, voids, exports, backups, syncs and sign-in
  pass; new tickets, sales, stock moves refuse; public booking and the shop pause; workers skip lapsed shops); off =
  working; the tray's "Reset a password"; migration 20261003130000_hub_accounts; `scripts/checks/base-license.check.ts`
  (15 groups with a mock hub). Today's hub (key null, standing "trial" for ever) changes nothing in the program.
  **Rule learned**: `UserError` / `isUserError` are imported from `@/lib/user-error` everywhere but the actions, because
  `@/lib/action` is server-only now (safe() asks who is signed in) and a client component reached it through
  `messaging/templates.ts`; the build, not tsc, caught it. Left for package 3 (hub): sign keys with
  HUB_LICENSE_KEY/HUB_LICENSE_KID in the claim answer, standings active/past_due/waived/lapsed, re-issued waived keys,
  the `hub1` line in license-keys.ts in both programs before the hub signs; package 4: PasswordReset and the hosted
  reset, PLATFORM_API_TOKEN provisioning; package 5: TERMS_VERSION "2026-10-02-draft" becomes the hub's published
  version. `tests/account.spec.ts` from the design is not written.
- **Hub side of item 8** (stitchhub branch `hub-accounts`, db2f573): every listing, order, post, link and xpart
  history row and buying link joins the hub's `shops` table for the company's current name; a request naming a
  company can't act on another company's rows on the same install; migration 013_companies; test/companies.mjs. The
  program side (an `X-Shop-Ref` header on every hub call, `shopRef` on order steps, claim with the name at each sync,
  which package 2's claimShops now does) is the next wave.
- **Company move design** (207adc0): `docs/plans/company-move-design.md`, after base-license, before
  hosted-provisioning; fifteen open questions with recommended answers.
- **Two late-evening test fixtures fixed** (dae199f and the spec commit after it): dev license keys now start
  yesterday (a key made after 8 pm Eastern started tomorrow in the shop's zone and showed as not yet on), and the
  scheduling-messaging spec's "tomorrow" is the shop zone's, not UTC's (after 8 pm Eastern its class was two days
  out and no reminder queued). Neither was a product bug.
- **Ultra review (2 Oct, two passes, main..8a18914 and 8a18914..HEAD)**: four findings, all fixed the same night.
  Hand-rolled actions that skipped the lapse gate (moveStock, the two imports, the campaign test send, the bag
  reminders) now call `requireBaseWritable`, and `lapse-allow.ts` gained `HAND_ALLOWED` (hand-rolled reads and
  finishing steps) so the base-license check fails on any hand-rolled action it doesn't account for. The shared
  public-POST budget is per pool (`forms` 300, `shop` 3000, `webhook` 1200 a minute), so cart clicks can't 429 a
  payment webhook. An order-mail cap trip no longer stops the channel's other notices. The per-shop payment queue
  forgets a shop when its work is done (the cleanup compared two different promises).
- **Rebuilt and rerun tonight** on the final build: smoke, modules-basics, modules-lapse, notices, campaigns (text
  test skipped by the clock), classes, calendar, parts-in, online-booking, online-shop, register-bookings, vac-shop,
  appliances, scheduling-messaging. Not run: two-servers, partner-runs, and hub (it skips without HUB_JOIN_KEY and
  PDF_URL; the local-test README has the set-up). The Windows install does NOT have tonight's batch yet (it was
  updated before it): back up, `prepare-app`, `update_installed.ps1`, then try the Tailscale tray item and a
  manual download on the real PC.

## 2ac. Overnight 2-3 Oct: the second wave (agents, each reviewed and checked before its commit)

Merged and deployed before this wave: GitHub main at deceaeb (everything through the ultra review fixes), both
hosted services redeployed, `PUBLIC_URL` and `SETTINGS_KEY` set on both (names only ever shown; the keys were made
with `openssl rand -hex 32` on the owner's PC). Everything below is on `scheduling-features` (or the stitchhub branch
`hub-accounts`) and NOT on main or deployed.

- **Standalone build size** (36ae0f1): the Windows app had grown to 807 MB because Turbopack read a dynamic
  `path.join(root, category, brand)` with a literal fallback in `src/lib/manual-downloads.ts` as a file pattern and
  traced the whole repository (installer output included) into `.next/standalone`. The library joins now go through a
  spread the bundler can't follow, `next.config.ts` excludes desktop/, docs/, tests/, scripts/ and .railway/ from
  output tracing, and tsconfig leaves the build copies out. The installed program was updated once before the fix (it
  runs, with migrations 20261003110000 and 20261003130000 applied, but carries the large copy); the next
  `prepare-app` + `update_installed.ps1` brings it back to about 150 MB. Rule: never pass a literal-fallback string
  into `path.join` with a dynamic root in server code.
- **Per-company identity, program side** (6c862f5, item 8 done end to end): `safe()` runs every action as the
  signed-in company (`src/lib/acting-company.ts`, AsyncLocalStorage), so every hub call inside an action carries
  `X-Shop-Ref`; background syncs speak as the install; order steps also carry `shopRef` in the body; the hub's 403 for
  another company's row is a plain UserError; the marketplace shop page shows the company's current name.
  `tests/account.spec.ts` (Settings → Account, doors 1 and 2) is written, not yet run: it needs the :3200 test hub on
  the hub-accounts branch, started by `start_hub.bat` (now with `MAIL_DEV_LOG=true`, so the set-password link lands in
  `scripts/local-test/.run/hub.log`).
- **Sharing chosen per item** (92da4a1, item 9 done): "Offer a hint about this model" from a machine or ticket starts
  with only brand and model (a serial or the customer's name in the text is refused); one "Offer this part" on the
  part page (partner shops at the partner price, the marketplace, or both; status shown; each withdrawable); the
  checkbox on the item form is gone. The audit found nothing else sends without a choice; the most-used report is off
  by default. `scripts/checks/sharing.check.ts` (8 groups).
- **Company move, package 1 `move-export`** (8d3b495): Settings → Company → "Move this company" freezes the company
  (read-only through the same rule as a lapsed key: `base-gate.readOnlyReason` returns lapsed or moving; workers skip
  it; no hub writes; a banner; Cancel lifts it) and streams one gzipped NDJSON file from a read-only repeatable-read
  snapshot (meta header, 50 tables parents first, ids kept, Bytes as base64, trailer counts checked); sealed secrets
  left out and named. Migration 20261003150000_company_move (CompanyMove; Shop movingAt / movedOutAt / movedTo /
  movedInAt / movedFrom). `scripts/move/export.ts`; `scripts/checks/move-export.check.ts` (9 groups).
- **Billing package 3 `hub-billing`** (stitchhub `hub-accounts` c7745a1): Stripe Billing on the hub ($25/month,
  $250/year, Checkout + Portal, webhook `/v1/stripe`), standing trial / active / past_due (14 days' grace) / waived /
  comped / lapsed, and the claim answer now carries a signed SB1 `base` key the program already accepts (package 2).
  Nothing goes read-only while billing is closed (any Stripe variable unset), so merging is safe before the Stripe
  set-up. `test/billing.mjs` (13 sections). **Before the hub signs or charges**, in this order: (1) `npm run
  license:keygen -- --kid hub1 --hub` here, paste the printed `hub1` line into `src/lib/license-keys.ts`, release both
  programs; (2) hub variables `HUB_LICENSE_KID=hub1`, `HUB_LICENSE_KEY`; check the `x` the hub logs matches; (3) comp
  every current shop on the hub's /admin; (4) Stripe: one product, two prices (`STRIPE_PRICE_MONTHLY`,
  `STRIPE_PRICE_YEARLY`), `STRIPE_SECRET_KEY`, the webhook with its eight events (`STRIPE_WEBHOOK_SECRET`), the
  Customer Portal settings; (5) mail for accounts: `SMTP_URL`, `MAIL_FROM`, `HUB_URL`. Note: the hub's
  `test/companies.mjs` needs an empty database each run (it failed on a reused one; passes on a fresh one).
- **Company move, package 2 `move-import`** (3da81b8): a move file is read twice, the first pass checking everything
  and writing nothing (format and version, the target's migrations by name, the company or any login email already
  here, rows outside the company, children before parents by the database's own foreign keys, unknown columns,
  counts and the end line, a damaged gzip, size caps), the second inserting every row in one transaction with ids
  kept; afterwards email, texts and the shop are off, marketing held, a clashing booking address cleared, and a
  summary says what to enter again. Doors: the tray's "Restore a company…" on a PC with no company (or "Import a
  company…" with platformAdminEmails), a one-use HMAC token per file over a localhost route; the hosted Companies
  page's resumable upload in 8 MB parts (platform admin, https); `scripts/move/import.ts`. `/move-in` needs no
  sign-in (first run); it shows only imports started from the PC's own window, each behind a long random id, and
  the public links host doesn't serve it. `scripts/checks/move-import.check.ts` (8 groups: a full round trip of all
  50 tables, 18 refusals each writing nothing). PartnerSeen and PartnerFailure have no foreign key to Shop, so a
  deleted company leaves rows there: the import clears its own, and package 3's delete must too.
- **Spec helper dates** (d5b472b): `tests/helpers.ts` now sends and reads dates as UTC (`pg.defaults.parseInputDatesAsUTC`
  and a type parser for `timestamp`), as Prisma stores them. node-postgres had sent local time into columns that drop
  the offset, so every date a spec inserted landed four hours early; the calendar spec's "appointment in two hours"
  became yesterday's after midnight Eastern. This was the third clock-dependent fixture of the night (with the dev key
  start and the scheduling spec's "tomorrow"); none were product bugs.
- **Spec run on the 3 Oct build** (all one at a time): smoke, modules-basics, modules-lapse, notices, campaigns (text
  test skipped by the clock), classes, calendar, register-bookings, shifts, appliances, vac-shop,
  scheduling-messaging, parts-in, online-booking, online-shop, tenant, two-servers (with :3500), move (export on :3501,
  import on :3500), and **account** (doors 1 and 2 against the :3200 test hub on the hub-accounts branch, after two
  label fixes): all pass. Not run: hub, market, partners, partner-runs (they need HUB_JOIN_KEY / PDF_URL and a joined
  second install; scripts/local-test/README.md).
- **Windows install** updated after the size fix: StitchBench 1.6.1 with migrations through
  20261003150000_company_move; the packaged server is 176 MB again (807 MB before the fix), the whole installed
  program 633 MB with its own Electron and Postgres. Not yet tried on the PC by hand: the Tailscale tray item, a manual
  download, "Restore a company…".
- **Company move, package 3 `move-hub`** (program 15d756f, stitchhub `hub-accounts` a4aeae2): a frozen move gets a
  one-use hub token (sealed on the move row, written into the file); after an import commits, the new install
  re-points the company on the hub (joining with the returned key if it had none) and pulls the moved partner links'
  messages from the file's cursor; with the hub down the import stands and "Re-point the hub" retries; the old copy
  learns from the hub's 410 that the company moved, stops partner sends, usage and note uploads, and can be deleted 30
  days later (Companies, or the tray's "Remove the moved company…"; PartnerSeen, PartnerFailure, Listing and
  MarketOrder rows removed explicitly, none has a foreign key to Shop). Hub migration 015_shop_moves, program
  migration 20261003170000_company_move_hub, `scripts/checks/move-hub.check.ts` (11 groups), hub `test/move.mjs`,
  INSTALL.md "Moving a company". The company move is now complete (three packages). Untested: the move spec's
  partner half (it needs a third server on its own database, `E2E_THIRD_URL`).
- **Windows app size, for good** (8f85b00): the 36ae0f1 fix covered routes, not the server's start-up hook, and the
  move's temp-folder paths (`os.tmpdir()` joined with `${id}.json`) traced every .json file in the repository again,
  the previous build nested inside included (232 MB). Paths built from folders the bundler can't evaluate now go
  through `src/lib/opaque-path.ts` (`under()`), and `desktop/prepare-app.mjs` drops src, desktop, docs, scripts, tests
  and the Railway files whatever the tracer does. Packaged server 144 MB; installed program 603 MB with Electron and
  Postgres; the Windows install has every migration through 20261003170000.
- **Final spec pass on the 3 Oct test build** (after every package): smoke, modules-lapse, online-shop, parts-in,
  two-servers, account (both doors) and move (export/import half) pass against the test hub on the latest hub
  branch. The test servers and the test hub were stopped afterwards; `.next` holds the test build.
- **Railway Infrastructure as Code**: `railway config plan` (read-only) run against both projects after the new
  variables: each "0 to add, 1 to change, 0 to destroy", only the four deploy settings. To apply, per project
  (stitchshop as linked; for stitchbench link it first and link back after), from Bash:
  `powershell -NoProfile -Command '$env:_ = "$env:APPDATA/npm/node_modules/@railway/cli/bin/railway.exe"; railway
  config apply --yes; railway config migrate --apply'` (the wrapper gets past the SDK's Windows version check);
  afterwards delete `railway.json` and commit.

## 2p. The next test batch (what to run before trusting the pages)

(How to run it on any machine, a cloud session included: `docs/TESTING.md`.)

Every package from 2j to 2o was written without a browser run (the PC runs out of memory with a Next build, the test
server, Chrome and Docker together). Checked: tsc, eslint, every check script, the unit tests. To finish:

1. `STITCH_TEST_BUILD=1 npx next build` (stop the test server first; a `prepare-app` in desktop/ overwrites `.next`
   with a non-test build, so rebuild after one).
2. Sink `SMTP_SINK_PORT=2526 SMTP_SINK_HTTP=2581`, mock `TWILIO_MOCK_PORT=3402`, server on :3501 with
   `PLATFORM_ADMIN_EMAILS=...,e2e@stitchbench.test SMTP_ALLOW_HOSTS=127.0.0.1:2526 TWILIO_API_BASE=http://127.0.0.1:3402
   MESSAGE_WORKER_SECONDS=5 READY_NOTICE_DELAY_SECONDS=1 PUBLIC_URL=http://localhost:3501`.
3. One at a time, with `E2E_BASE_URL=http://localhost:3501 PW_CHANNEL=chrome SMTP_SINK_PORT=2526 SMTP_SINK_HTTP=2581
   TWILIO_MOCK_PORT=3402 PUBLIC_URL=http://localhost:3501`: campaigns (3 of its 4 tests unverified), classes,
   calendar, register-bookings, shifts; then notices, estimate-links and smoke again (the register and partners code
   moved); partner-runs needs `HUB_URL` and the test hub on :3200. Then the new specs of 2w: vac-shop, appliances,
   modules-lapse (needs `DATABASE_URL` in the spec process for `dev.ts --grant`), scheduling-messaging, and
   two-servers with a second server on :3501 and `E2E_SECOND_URL`. Then the Vac Shop acceptance items of 2q by hand
   (the xref admin-only controls).
4. Expect label and selector slips in the new specs: they were written against the code, not a running page.
5. Then push to `main`, deploy both hosted services, and update the Windows install (`npm run prepare-app`, the
   update script); then `e2e-docs`, `modules-crossover` and the Vac Shop / appliance packages.

## 3. What to do next, in order

**Asked for by the owner on 2 Oct 2026** (first-draft design in `docs/plans/online-and-parts-design.md`, for the owner to
correct before building; its three open questions are at the end of that file):
1. **Parts arrived notice.** Built and tested (section 2y).
2. **Online booking on the shop's own website.** Built (section 2z). Hosted first: the hosted services have
   `PUBLIC_URL`; the Windows program needs its tunnel (Settings → Online booking says so).
3. **An online shop.** Built (section 2aa). Hosted first: the services need the Stripe environment described there
   before a shop can take an order.



Steps 1-3 below are done, merged to `main` and deployed (sections 0 and 2b-2d). Step 4.1 (`modules-foundation`) is
merged (PR #9, section 2f). Step 4.2's `foundation` package is merged (PR #10, section 2g) and its `notices` and
`estimate-links` packages are on `main` and deployed (section 2h); `campaigns` (2j), `classes` (2k) and `appointments`
(2l), `register-bookings` (2m), `shifts` (2n) and `partner-runs` (2o) are committed: every feature package of the
scheduling design is written, and so are e2e-docs (the INSTALL and README sections, the two specs in 2w) and every
package of the modules design: `vac-repair` and `vac-finder` (2q), `vac-sales-warranty` (2r), `vac-bags-due` (2s),
`central-vac-installs` (2t), `appliance-repair` (2u), `modules-crossover` (2v) and `modules-e2e` (2w). Steps 4.2 and
4.3 are therefore written but not browser-tested. Next: the test batch of 2p (now including the 2w specs), then push
the local commits to `main`, deploy both hosted services and update the Windows install, then step 4.4 / 5 (StitchHub
accounts and billing: design first).


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
   (`SHADOW_DATABASE_URL=postgresql://stitchbench:stitchbench@localhost:5433/stitchbench_shadow npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code`; Prisma 7.10 reads the shadow URL from prisma.config.ts, create that empty database once), run the
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
   the Windows program itself (read-only when it lapses, never lose data). Hub membership itself is free (the
   26 Sep decision below): an account replaces emailing join keys; current members are grandfathered. The hub
   signs license keys with its own revocable key and installs refresh them when online. Password resets: hub
   account by email; hosted app by email; Windows tray "Reset a password" on the shop PC (decided, not built
   yet); and from the hub account to a Windows install (only if that shop opted in on its PC, signed, one-time,
   short-lived, owner login only, shown on the PC). **Designed 2 Oct 2026:**
   `docs/plans/hub-accounts-billing-design.md`, the owner took every recommended answer; build its five packages
   in order (hub-accounts, base-license, hub-billing, hosted-provisioning, terms-launch), each with a check and a
   spec, the ultra review before each deploy.
6. Later rounds (owner approved): off-site backup, gift cards/store credit, reports + sales-tax report +
   QuickBooks export, audit log; then layaway/special orders, block-of-the-month clubs, kits, purchase orders,
   loaners, per-ticket time clock, warranty claims, drop-off signature. Needs owner decisions first: card
   reader (Square or Stripe), Shopify sync, two-way texting inbox (online sign-up and booking pages are built:
   section 2z).
7. **Split StitchBench and StitchShop into separate repositories** **Decided 3 Oct 2026: not now, keep one codebase.** The plan (`docs/plans/repo-split-design.md`, dry run `scripts/repo-split/plan.mjs`) found the two programs share every source file (the flavour is APP_NAME and DEFAULT_SHOP_KIND); a split would cost about three days plus a day of deploys and stall every in-flight package for little gain, while one codebase keeps fixes landing in both. Instead, if wanted: a version number per program in the installer setup (half a day). Revisit if StitchShop needs many pages StitchBench shouldn't have, someone must work on only one program, or one program's code is licensed separately. (owner request, 27 Sep 2026). Today StitchShop
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

8. **Hosted = one shared instance for every shop** **Done 3 Oct 2026** (sections 2ab and 2ac: every company acts on the hub under its own name, both sides; still open: the one-command template for a dedicated instance) (owner decision, 27 Sep 2026): partner quilt shops and hosted
   bench customers are companies on the one StitchShop/StitchBench instance, not one instance each. That makes the
   per-company hub identity (round-2/3 finding: every company posts, lists and is rated under the install's one
   name) the first hub job: send `shopRef` + `shopName` on marketplace, note and usage calls, and store/show them
   per company on the hub, as the partner channel already does. A dedicated instance stays an option for a shop
   that asks for it (template it: one command per shop).
9. **Sharing is chosen per item, never automatic** **Done 3 Oct 2026** (section 2ac) (owner decision, 27 Sep 2026; wording is "offer"). From a
   machine or ticket: "Offer a hint about this model" sends that hint only, with nothing private from the ticket
   pre-filled (fixes the "Share with other techs" pre-fill finding). From a part: one "Offer this part" action
   where the shop picks where it goes: to its partner shops (partner price; today's "Offer to partner shops"
   checkbox), on the marketplace, or both. Nothing reaches the hub unless chosen. The monthly most-used-parts
   report is the one automatic share today: make it a per-company setting, off unless turned on.
10. **A shop chooses where it runs, and can change its mind** **Done 3 Oct 2026** (section 2ac: the company move, three packages; the move spec's partner half not yet run) (owner decision, 27 Sep 2026): on the owner's shared
   hosted instance, as the Windows program on its own PC, or self-hosted on its own Railway (INSTALL.md covers all
   three; same hub, same partner links). Missing piece: a per-company export/import so one company can leave the
   shared instance for a PC or its own server, or join it from one, keeping its ids (partner records are keyed by
   them) and its hub/partner state. The Windows backup covers a whole install, not one company.
11. **HTTPS for the Windows program on the shop network** **Built 2 Oct 2026** (section 2ab), untested on the real PC. so tablets and phones can use the camera barcode scanner
   and copy buttons (browsers allow those only on secure pages; plain http://<pc>:3100 can't). Preferred: Tailscale
   (`tailscale serve` / a Tailscale certificate gives the shop PC an https://...ts.net address on every device on the
   tailnet); document it in INSTALL.md and have the tray list that address first. A locally installed certificate
   is the fallback for shops without Tailscale. Until then the app shows a clear message on non-secure pages.
12. **Manual links: download all, file on download, what's missing** **Built 2 Oct 2026** (section 2ab), parts a, b and c. (owner request, 27 Sep 2026). The hub is the
   community's catalog of links (the hub never hosts OEM manuals; each shop downloads into its own library).
   (a) "Download everything" for a model, a brand, or every link not yet in this library: a queued job, one file
   at a time with a pause between, skipping links the checker marks dead, with progress and resume.
   (b) File on download: when a link has category, brand, model and doc type, save straight to
   Category/Brand/Brand_Model_DocType.pdf (the library's naming) and add the LibraryDoc row so the model page shows
   it at once; only links missing that data, or downloads that aren't PDFs, go to _inbox. Keep the source URL and
   the link id with the file (index + a sidecar or the LibraryDoc row) so re-downloads and dedupe work.
   (c) Per model, show which doc types exist (service, parts, operator, error codes, wiring) and which are missing,
   so members know what to look for. Links already carry the doc type; the model page groups by it.
13. **Look into what AI to add** **Scoped 2 Oct 2026** (section 2ab): `docs/plans/ai-assistant-scope.md`. **Decided 3 Oct 2026**: the owner took every recommended answer; the `assistant` package (write-ups + bench assistant + the plumbing through the hub, about 4.5 days) is queued after billing packages 4 and 5 and the test-mode card, because it adds a migration in each repo and edits the hub's server and the ticket page. (owner request, 27 Sep 2026): scope and cost it first, then build the one or two
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
14. **Railway: Config as Code to Infrastructure as Code before 2026-12-01** (file written 2 Oct 2026, not yet applied).
   Railway stops reading `railway.json` on that date (every deploy prints the warning). `.railway/railway.ts` holds the
   same four settings (healthcheck `/api/health`, 600 s timeout, restart ON_FAILURE, 5 retries) and nothing else:
   `export const partial = "app"` so the Postgres service, not declared there, is left alone; the service and project
   name come from the linked project (`ctx.projectName`), so the one file serves both `stitchshop` and `stitchbench`;
   and the 11 variables both services hold are listed with `preserve()`, because IaC deletes any variable of a declared
   service that the file leaves out (the first plan without that list said "11 to destroy"). Add a new variable's name
   to that list before the next `railway config apply`. The `railway` npm package (3.12.0) is a devDependency because
   the CLI refuses to evaluate the file without it; `tsc` and ESLint cover the file. The CLI's own `railway config
   migrate` was run as a dry run only: it dropped the restart policy and named the service `stitchbench` inside project
   `stitchshop`, so the file was written by hand. `railway config plan` against stitchshop (read-only, 2 Oct) shows
   "0 to add, 1 to change, 0 to destroy": the four settings go from null to the railway.json values, which confirms
   they live only in railway.json today and would be lost at the cutoff. Railway does not read `.railway/` on deploy,
   so `railway up --service stitchshop --ci` behaves exactly as before until the steps below are done.
   On this PC the SDK's CLI check fails ("requires Railway CLI 5.42.1 or newer" although 5.63.1 is installed) because
   it runs `railway --version` without the `.exe`; run the config commands from PowerShell with
   `$env:_ = "$env:APPDATA\npm\node_modules\@railway\cli\bin\railway.exe"` set first.
   Owner, per project (stitchshop first; then `railway link --project stitchbench --service stitchbench`, repeat, and
   `railway link --project stitchshop --service stitchshop` to link back): (1) `railway config plan`, must say
   "0 to destroy" and list only the four deploy settings on the one service; (2) `railway config apply`; (3)
   `railway config migrate --apply` (clears the service's "Railway Config File" setting so Railway stops reading
   railway.json; without `--force` it does not overwrite the hand-written `.railway/railway.ts`); (4)
   `railway up --service <name> --ci`, then confirm in the dashboard that the deploy waited on `/api/health`, that the
   service's Settings show the healthcheck and the restart policy, and that the deprecation warning is gone. After
   both projects are done, delete `railway.json` and commit.

16. **Online shop payments: no "through StitchShop's account"; Stripe Connect instead** (owner decision, 3 Oct 2026).
   One account taking payments for other businesses is what Stripe Connect is for, and it would put every shop's
   refunds, disputes, payouts and tax reporting on the owner. The option is now off unless `SHOP_PLATFORM_PAYMENTS=on`
   (never set it). Queued: "Connect with Stripe" (Connect Standard or Express onboarding, payments straight to the
   shop's account, an optional platform fee per order) as the easier door than pasting keys; a day or two.

17. **Follow-ups found while drafting the terms and privacy text** (3 Oct 2026; drafts in `docs/legal/`, for a lawyer):
   - **Owner decision: manual figures go to the hub automatically.** `src/app/api/figures/route.ts` calls `shareFigure`
     whenever the program draws a factory-setting figure on a joined install (since the hub client's first version).
     That predates and conflicts with item 9 ("chosen per item"), and figure crops from OEM manuals are a lawyer
     question. Options: keep (the draft discloses it), an install setting off by default, or stop sharing figures.
   - **Hub billing**: subscribing during the 30-day trial charges the same day (pass the trial end to Checkout so the
     first charge falls when the trial ends); a refund inside the trial makes the shop read-only at once (should go
     back to its trial); a won chargeback isn't undone (handle `charge.dispute.closed` with status won).
   - **Customers can't be deleted or merged** (L126 decided, not built): needed to honour a customer's deletion request.
   - **No LICENSE file** in this repository, so self-hosting shops have no stated licence for the code (the hub is
     AGPL). Owner and lawyer decision.
   - The hub README still mentions "a one-time contribution toward server costs" (the hub is free since 26 Sep).
   - Before the pages go live: the hub's `/terms` and `/privacy` routes, Checkout recording the accepted version, and
     `TERMS_VERSION` in `src/lib/hub-account.ts` (still "2026-10-02-draft"): billing package 5.

15. **Diagnostic / test mode per model** (owner idea, 3 Oct 2026; not started). The factory settings refer to test
   mode constantly (254 rows mention test or service mode, 233 of them Brother / Baby Lock, e.g. "measure in test
   mode 36") but none says how to enter it. Plan: a reference set like TensionSpec / FactorySetting (per model family:
   how to enter, how to exit, what the numbered tests do, a warning for modes that clear settings, source file and
   page, confidence), extracted from the 650 service manuals in C:\Manuals with page numbers for the owner to verify
   (Brother, Baby Lock, Janome first) and shipped as seed data; a card on the machine page and the ticket next to the
   factory specs, opening the manual at the page when the PDF is in the library; "test mode 36" in a factory setting
   becomes a link to it; techs fill gaps through "Offer a hint". Steps in our own words with the page reference,
   never copied manual pages; the embroidery service-password notes stay private to the owner's shop. About a day for
   the table and card; the extraction is the larger part.

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
- Round-3 open findings (30 Sep 2026, evening; all answered yes, not built yet, do them after the round3-tail2 pass
  or fold them into the modules foundation where they touch the same tables):
  1. L7/L31: email addresses unique per company, not across the install; sign-in asks which company when one address
     has more than one.
  2. L42: signing out ends the session on every device (sessionVersion bump), not just the one used.
  3. L126: customers and machines can be merged and deleted (duplicates folded into one record, history kept).
  4. L127: a payment is reversed by a new opposite entry, never deleted; the day's totals keep their history.
  5. L95: a single-writer lock on the hub (accept a few seconds of errors during a deploy overlap).
  6. L134/I27: partner invites and messages signed end to end so the hub operator can't forge them; design first.
  7. M56: a partner's consignment return needs "Confirm it arrived", like settlement payments.
  8. L79: supplier costs may carry more than two decimals (store the cost with enough precision; prices stay cents).


## 5. Things to know

- Project rules are in AGENTS.md (shopId on every query, safe()/UserError, integer cents, Next.js 16 differs
  from what you know: read `node_modules/next/dist/docs/`).
- Manuals stay local; never add manual upload to the server.
- The Windows program (`desktop/`) has never been run in a cloud session. Its backup and migrate code has tests
  (`cd desktop && npm test`, needs Postgres; they run in the Checks workflow); the Electron parts were only read.
- How the 30 Sep cloud work was run, and worth repeating: one helper agent per fix package, each in its own git
  worktree and database, split so no two touched the same files; then everything merged, built and tested together
  (Playwright specs, hub smoke test) and the risky parts read line by line. Well-scoped work went to a cheaper model
  (Sonnet) to save usage. Start a fresh session for new work: a long one costs more per step.
