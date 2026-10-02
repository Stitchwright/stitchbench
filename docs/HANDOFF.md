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

## 3. What to do next, in order



Steps 1-3 below are done, merged to `main` and deployed (sections 0 and 2b-2d). Step 4.1 (`modules-foundation`) is
merged (PR #9, section 2f). Step 4.2's `foundation` package is merged (PR #10, section 2g) and its `notices` and
`estimate-links` packages are on `main` and deployed (section 2h); `campaigns` (2j), `classes` (2k) and `appointments`
(2l) and `register-bookings` (2m) are committed and await a browser run. Next: shifts, partner-runs, then e2e-docs,
then step 4.3.


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
