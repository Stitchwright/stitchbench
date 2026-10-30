# The public demo

A demo is a StitchBench or StitchShop server of its own, with its own database, full of invented people and shops, shown to the public so they can try the software without any customer's data being involved. It is reset every night. Plan and issues: #38, #39, #61 to #65.

**Never turn `DEMO_MODE` on for a server that holds a real shop.** It is meant for the extra Railway service made for the demo, nothing else.

## `DEMO_MODE=on` (`src/lib/demo-mode.ts`)

| What | How |
|---|---|
| Banner across the top: "Demo shop with invented people, resets every night. Like it? Join the beta" | `src/components/demo-banner.tsx`; the link is `DEMO_SIGNUP_URL` (default `https://stitchbench.app/signup/`) |
| Passwords, adding or changing people, StitchHub and Foundry Account links, licences, creating or moving a company, backups, mail and text provider settings, card reader, shipping labels, payment links and the Assistant's settings are refused with "That isn't available in the demo" | `DEMO_BLOCKED` in `demo-mode.ts`, enforced in `safe()` (`src/lib/action.ts`). A unit test fails if a name in the list is not a real action |
| No email or text is sent | `messagesSwitchedOff()` is true (the same switch as `MESSAGES=off`); queued messages stay unsent |
| The Assistant (AI) is off, so it can never spend credits | `assistantSwitchedOff()` is true. It is off rather than canned |
| Uploads are limited to 1 MB | `next.config.ts` (read when the server is built and started: set `DEMO_MODE` as a service variable for both) |
| At most 90 changes a minute from one visitor address (HTTP 429 beyond that) | `src/proxy.ts` |
| The sign-up page is closed | `src/app/signup/page.tsx` |

Everything else works, so visitors can sell, book a class, create a ticket and so on; the nightly reset undoes it.

## Variables for the demo server (names only)

`DEMO_MODE=on`, `DATABASE_URL` (the demo's own database), `AUTH_SECRET`, `PUBLIC_URL`, optional `DEMO_SIGNUP_URL`. Leave `ALLOW_SIGNUP`, `MESSAGES` and any hub or Foundry settings unset. `PROGRAM_FREE` stays at its default (on).

## The nightly reset (`npm run demo:reset`)

`scripts/demo/reset.ts` removes the demo companies and everything in them (uploads are stored in the database, so they go too) and makes them again from the seed scripts in `SEED_SCRIPTS` (`src/lib/demo-reset.ts`), so every visitor starts from the same shops. Schedule it in Railway as a cron job on the demo service at about 3:30 a.m. Eastern (the schedule is set in Railway).

It **refuses and changes nothing** (exit code 1) unless `DEMO_MODE=on` and the database holds only known demo companies (`DEMO_COMPANIES`) whose people all have invented email domains (`.test`, `example.com`, `.org`, `.net`). One real shop in the same database stops it. `npm run demo:reset -- --check` only says whether it would be allowed. When the database is not on this PC the seed scripts also need `DEMO_ALLOW_REMOTE=yes` and `DEMO_PASSWORD`.

Add a new demo company in three places: its seed script, `SEED_SCRIPTS`, and `DEMO_COMPANIES`.

Checked: `src/lib/demo-reset.test.ts` (the guard), `scripts/checks/demo-reset.check.ts` (the real script refuses on a non-demo server and beside a real company, and deletes nothing), and one real reset on a scratch database: a change made as a visitor was gone afterwards and the company was rebuilt with a new id.

## The quilt shop: Maple Street Quilt Co. (`scripts/demo/seed-demo.ts`)

An invented quilt and sewing shop in a made-up town ("Maple Hollow, WI"; every phone is 555-01xx and every email is example.com). `npx tsx scripts/demo/seed-demo.ts` makes it (running it again resets it; `--remove` deletes it). Sign in as `demo@stitchshop.test` (password from `DEMO_PASSWORD`, default `demo-password-1`; set it on a real demo server). It has: about 146 fabric items (prints, solids, batiks, flannels, wide backing, holiday, precuts; 29 items running low), kits and patterns, 12 machines for sale (real makes and models as data, invented prices), 19 customers (a guild, a beginner, a church banner committee and others), 7 classes with sign-ups (including Beginner Log Cabin, Free-Motion Quilting Night and Bag-Making Saturday), three weeks of register sales, repair tickets, appointments and online booking, gift cards, special orders and marketing. Public pages: `/book/maple-street` and `/shop/maple-street`. All dates are worked out from today. Checked by `scripts/checks/demo-quilt-seed.check.ts` (takes about two minutes: it runs the seed twice and then removes it).

**Not in the seed yet:** layaways and holds (the money on a layaway is register lines, which the seed does not make), and loyalty points.

## Still to build

The embroidery and print shop seed (#64), the one-click entry for each shop type (#65), the repair shop demo (#38) and the landing page buttons (the StitchFoundry chat, `stitchsite`).
