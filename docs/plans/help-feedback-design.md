# Help, ideas, ratings and error alerts (9 Oct 2026)

The owner asked (9 Oct 2026) for an "Ask for help" button on every page of StitchBench and StitchShop, with "Something's
wrong", "I have an idea" (feature requests) and "Rate the program" (reviews), plus automatic error alerts, so the
test month's problems reach the owner without anyone filing a bug report. Everything goes to the hub; the owner reads it
on the hub's admin page and gets an email. Ease of use first (big targets, plain words, one main action).

## 1. What the shop sees (program)

- A round "Help" button, bottom-right corner of every signed-in page (not on print views, not on public pages such as
  /u/, /consent/, the online shop or booking pages). Tap targets at least 48px. Opens a panel with three big choices:
  - **Something's wrong**: "What happened?" (required, up to 4,000 characters), "Include a picture of this screen"
    (ticked by default; the picture is shown small before sending, with "It may show customer details. Untick to leave
    it out."), "Email me back at" (prefilled with the signed-in person's email, editable, may be empty).
  - **I have an idea**: "What would make the program better for you?" (required) and the same "Email me back at".
  - **Rate the program**: 1 to 5 stars (big), "Anything you'd like to tell us?" (optional), "You may quote me with my
    shop's name" (unticked by default).
  - One button: **Send**. After sending: "Thank you. It's on its way to the StitchBench team." (StitchShop: its own name) (it says "on its way" also when offline:
    it waits and goes at the next sync).
- The picture: taken in the browser of the page under the panel (panel hidden while taking it) with `modern-screenshot`
  (or `html-to-image`, whichever is smaller and works with the app's CSS), as JPEG, longest side at most 1600px, at most
  800 KB after compression (lower quality until it fits; leave it out if it can't fit). No screen-share prompt.
- Sent with each item automatically: program (`appName()`), version (`programVersion()`), the page path (no query string),
  the company's shopRef and name, the person's role (not their name unless they typed it), whether desktop or hosted,
  the browser's user agent, screen size.

## 2. Error alerts (program, automatic)

- **Server**: in `safe()` (src/lib/action.ts), any thrown error that isn't a UserError is recorded before it is rethrown:
  message, the first 20 stack lines, the action's name if known, digest. Also unexpected errors in API routes that already
  catch-and-500 (only where there is one central place; don't touch every route).
- **Browser**: `src/app/(app)/error.tsx` and `src/app/global-error.tsx` record the error they show (message, digest, stack,
  path) through a server action; a `window.onerror` / `unhandledrejection` listener in the (app) layout records the rest,
  at most 5 per page load.
- No customer data: strip anything that looks like an email address, phone number or card number from messages and stacks
  before storing (replace with `[email]`, `[phone]`, `[number]`). Never include form contents or request bodies.
- Same error (same message after stripping + same first stack frame) is counted, not repeated: one row per distinct error
  per day with a `count`.

## 3. Program storage and sending

- One new model `HelpOutbox` (migration `20261027000000_help_outbox`): id, shopId, kind (`help` | `idea` | `rating` |
  `error`), payload Json (everything in sections 1-2 but the picture), picture Bytes? (JPEG), fingerprint String? (errors),
  day String? (errors, YYYY-MM-DD), count Int default 1, createdAt, sentAt DateTime?, tries Int default 0, lastError String?.
  Unique (shopId, kind, fingerprint, day) for errors only (fingerprint null for the others).
- Sent to the hub by the existing background sync (and right away, in the background, when an item is made and the hub
  is reachable). Rows are kept 30 days after sentAt, then deleted; pictures deleted as soon as sent.
- A program on no hub yet: items wait. Settings → Account / Community hub says nothing new; the help panel says
  "Not connected to StitchHub yet: this will be sent once it is." plus, when the variable `HELP_EMAIL` is set, "For
  anything urgent, email <HELP_EMAIL>." (no address in the code).

## 4. Hub

- Migration `034_feedback.sql`: table `feedback` (id, install_id, shop_ref, shop_name, kind, body jsonb, picture bytea,
  fingerprint, day, count, created_at, status `new` | `seen` | `done`, owner_note text). Errors upsert on
  (install_id, shop_ref, fingerprint, day) adding to count.
- `POST /v1/feedback` (install key, X-Shop-Ref; pending installs allowed too, as /v1/shops/*): multipart (`item` JSON +
  optional `picture` JPEG ≤ 1 MB) or JSON. Validates sizes and kind; 60 items an hour per install, errors 200 a day per
  install (over that: 429, the program keeps them and tries later). Answers `{ ok, id }`.
- Email to `FEEDBACK_EMAIL` (a variable; unset = no email, the admin page only) for help, idea and rating at once
  (subject "Help: <shop> – first 60 characters", body with everything and a link to the admin page); errors in one digest
  email at most every hour ("3 new errors from 2 shops").
- Admin page: a new **Help & ideas** section near the top: tabs/filters New / All, kind, shop; each row shows kind icon,
  shop, program and version, page, when, text, stars, a thumbnail (click to open the picture, served by
  `GET /v1/admin/feedback/:id/picture`), "Email back" (mailto: link), and buttons Seen / Done / a note. Errors show count
  and the stack folded. `GET /v1/admin/feedback?status=&kind=`, `POST /v1/admin/feedback/:id { status, note }`.
- Pictures deleted 90 days after `done`; everything kept otherwise (it's the owner's product feedback). Included in the hub's
  export? No: feedback isn't moved with a hub move (say so in the README's export section).
- Privacy: the privacy draft (`docs/legal/`, `legal/` in the hub) gets one paragraph: what the Help button sends, that the
  picture is optional and may show what was on screen, kept until handled (pictures 90 days after), used only to fix and
  improve the programs. Mark it `[LAWYER: ...]` for review.

## 5. Also in this batch

- **Texting registration guide**: Settings → Messages, where Twilio is set up: a plain box "Before sending texts to
  customers: US carriers block texts from businesses that aren't registered. In your Twilio account, register for
  10DLC (A2P) or verify a toll-free number; it takes a few days." with the steps and a link to Twilio's pages, and a tick
  "We've registered" kept in settings so the box shrinks to one line.
- **Backup restore check**: done on the PC by the lead (restore the newest backup into a scratch company, open it,
  compare counts); written up in HANDOFF.
- **Uptime alerts**: the owner sets up UptimeRobot (free) for hub.stitchbench.app/health and the two hosted services;
  steps in the launch checklist.

## 6. Checks

- Program: `npx tsc --noEmit`, `npm run lint` on changed files, prisma migrate diff clean, a Playwright spec
  `tests/help.spec.ts`: open the panel, send each of the three kinds (with and without a picture) against the test hub,
  see them in the hub's admin API; an error thrown by a test-only action shows up once with count 2 after two throws.
- Hub: `npm run check`, a test `test/feedback.mjs` (scratch database): each kind, the picture limit, the error upsert,
  rate limits, admin list/update, a pending install allowed, another install's rows never listed to it (admin only).
