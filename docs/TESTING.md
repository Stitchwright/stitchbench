# Running the test batch (any machine, including a Claude Code cloud session)

Everything here is in the repo. Nothing needs the owner's PC except the Windows-install steps at the end.

## What you need

- Node 22 or newer, npm, and a Postgres you can create databases in. The repo's `.env` on the owner's PC points at
  `postgresql://stitchbench:stitchbench@localhost:5433/stitchbench` (a Docker container); any Postgres works. Put
  its URL in `DATABASE_URL` (a `.env` file in the repo root is read by the app, the check scripts and the specs).
  Use an IPv4 address rather than `localhost` if Node's IPv6 lookup hangs.
- `npm install`, then `npx prisma migrate deploy` and `npx prisma generate`.
- `npx playwright install chromium` (the bundled Chromium; `PW_CHANNEL=chrome` would use an installed Chrome instead).
- A shadow database for the drift check: `stitchbench_shadow` (empty, same credentials).

## The three layers

1. **Unit tests**: `npm run test:unit` (60 tests, pure code).
2. **Check scripts**: `npm run check scripts/checks/<name>.check.ts`, one at a time. Each makes a throwaway company
   "Check <run>", drives the library code and removes what it made. Those that send mail start the SMTP sink and the
   Twilio mock themselves on free ports. **Stop any test server first** (or start it with `MESSAGES=off`): a running
   server's message worker shares the database and sends or skips the check companies' queued rows, which fails
   `notices.check` and `online-booking.check`. Current list: license, links-gate, modules, modules-tenant, equipment,
   equipment-lines, vacuum-kind, abandon, restore-optouts, messaging-core, worker, notices, estimate-links,
   audiences, campaigns, classes, appointments, register-bookings, shifts, partner-runs, vac-finder, vac-units,
   bags-due, vac-installs, modules-crossover, part-waits, online-booking.
3. **Playwright specs** against a **test build** (dev license keys work; the Companies page can switch modules on).

## The test build and its servers

```
# the build (about four minutes; run it in the foreground: a backgrounded build has been killed by memory pressure)
STITCH_TEST_BUILD=1 npx next build

# the sink and the Twilio mock (background)
SMTP_SINK_PORT=2526 SMTP_SINK_HTTP=2581 node scripts/test-mail/smtp-sink.mjs &
TWILIO_MOCK_PORT=3402 node scripts/test-mail/twilio-mock.mjs &

# the server (background)
PLATFORM_ADMIN_EMAILS=bwattendorf@gmail.com,e2e@stitchbench.test SMTP_ALLOW_HOSTS=127.0.0.1:2526 \
TWILIO_API_BASE=http://127.0.0.1:3402 MESSAGE_WORKER_SECONDS=5 READY_NOTICE_DELAY_SECONDS=1 \
PUBLIC_URL=http://localhost:3501 npx next start -p 3501 &

# the e2e logins (idempotent)
npm run e2e:setup
```

`npm run prepare-app` in `desktop/` replaces `.next` with a non-test build: rebuild the test build after it.

## Running the specs

One at a time (two Chromes at once crash the owner's PC; a cloud box may cope, but the specs also share the
database, so serial is the rule):

```
E2E_BASE_URL=http://localhost:3501 E2E_EMAIL=e2e@stitchbench.test E2E_PASSWORD=e2e-password-1 \
SMTP_SINK_PORT=2526 SMTP_SINK_HTTP=2581 TWILIO_MOCK_PORT=3402 PUBLIC_URL=http://localhost:3501 \
npx playwright test tests/<name>.spec.ts --workers 1
```

Order that has run clean (2 Oct 2026): smoke, modules-basics, notices, estimate-links, campaigns, classes, calendar,
register-bookings, shifts, appliances, vac-shop, modules-lapse, scheduling-messaging, parts-in, online-booking, then
two-servers and partner-runs with their extras below.

- **campaigns**: its text-campaign test runs only between **12:00 and 20:00 Eastern** (a marketing text to a US
  number waits until it is 9:00 in every mainland zone, so noon Eastern). Outside that it skips itself.
- **estimate-links**: one test skips with `PUBLIC_URL` set (the no-link variant) and one without; both variants
  together need two runs.
- **two-servers**: start a second server on :3500 against the same database with `MESSAGE_WORKER_SECONDS=2` and
  set `E2E_SECOND_URL=http://localhost:3500`; without it the spec skips.
- **partner-runs** (and partners, hub, market): need a test StitchHub on :3200 (the stitchhub repo,
  `scripts/local-test/start_hub.bat` shows its environment) that this install has joined, and `HUB_URL=http://localhost:3200`.
- `E2E_KEEP=1` leaves a spec's throwaway company behind after a run (classes, campaigns, register-bookings,
  partner-runs, parts-in, online-booking), to look at the rows when something fails. Delete it afterwards:
  `DELETE FROM "Shop" WHERE name LIKE '<prefix> %'`.
- The specs read and write the database directly through `pg` with `DATABASE_URL`; `modules-lapse` also runs
  `scripts/license/dev.ts --grant`, so the spec process needs `DATABASE_URL` too (`.env` covers it).

## Before pushing

`npx tsc --noEmit`, `npx eslint src tests scripts`, the unit tests, the check scripts touched, and the drift check:

```
SHADOW_DATABASE_URL=postgresql://stitchbench:stitchbench@127.0.0.1:5433/stitchbench_shadow \
npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code
```

## Owner-only steps (the PC)

Deploys: `railway up --service stitchshop --ci` and, for StitchBench, `railway link --project stitchbench &&
railway up --service stitchbench --ci && railway link --project stitchshop --service stitchshop`. The Windows install:
`node desktop/backup-now.mjs`, `npm run prepare-app` in `desktop/`, then `scripts/local-test/update_installed.ps1
-Version <version>`. See `docs/HANDOFF.md` for where everything stands.
