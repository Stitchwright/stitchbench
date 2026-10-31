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

## Still to build

The nightly reset (#62), the quilt shop and the embroidery and print shop seeds (#63, #64), the one-click entry for each shop type (#65), the repair shop demo (#38) and the landing page buttons (the StitchFoundry chat, `stitchsite`).

## Simulated customer orders (MakerFoundry)
Decorating › Online orders has "Simulate an order for pickup / to be shipped" in a demo only. It makes the order a customer would place from the shop's own garments and prices and takes it in through the same code a real order goes through; the order's page then lets the visitor pretend to be the customer (approve the proof, ask for changes, cancel) and carry on to production and hand-over. No hub, no MakerFoundry and no network are involved. See `docs/plans/makerfoundry-orders-plan.md`.
