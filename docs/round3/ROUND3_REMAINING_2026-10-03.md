# Round 3: what is left (3 Oct 2026)

This is a re-check of every round-3 finding that `docs/round3/ROUND3_FINDINGS.md` does not mark FIXED: 37 findings
(4 medium, 11 low, 22 info; all 6 high are fixed). Each one was checked against the working trees as they stood on
3 Oct 2026: StitchBench on branch `scheduling-features` (11b229a plus uncommitted work) and StitchHub on branch
`hub-accounts` (a4aeae2 plus uncommitted work). File:line references point into those working trees. Lines in files
that other agents are editing right now (listed below) will move.

Classes used here:

- FIXED-SINCE: the problem is gone; the note says by what.
- MOOT: the code the finding is about is gone or redesigned.
- STILL-OPEN: still a problem today; the note restates it against today's code, with a scenario and a sized fix.
- NEEDS-OWNER: a product decision; the note gives the question and a recommended answer.

"Decided" below means the owner already said yes on 30 Sep 2026 (HANDOFF section 4); those only need building and are
not asked again.

## Counts

| Status      | Medium | Low | Info | Total |
| ----------- | -----: | --: | ---: | ----: |
| STILL-OPEN  |      3 |  10 |   17 |    30 |
| NEEDS-OWNER |      1 |   1 |    0 |     2 |
| MOOT        |      0 |   0 |    1 |     1 |
| FIXED-SINCE |      0 |   0 |    4 |     4 |
| Total       |      4 |  11 |   22 |    37 |

Ten of the 30 still-open findings are decided and only need building: M56, L7, L31, L42, L79, L95, L126, L127, L134
and I27. The four FIXED-SINCE findings (I15, I16, I23, I25) were in fact covered by tests committed on 27 and 30 Sep;
their status lines were never updated. Seventeen of the 30 still-open findings are test gaps (the info ones); the
code findings are M44, M56, M71, L6, L7, L31, L42, L79, L84, L95, L126, L127 and L134.

## Work other agents are doing now

Two agents were editing both repos while this was written. Snapshot of `git status` on 3 Oct:

- Billing package 4 (`hosted-provisioning`), StitchBench, modified: `prisma/schema.prisma`, `src/lib/action.ts`,
  `src/lib/lapse-allow.ts`, `src/lib/hub.ts`, `src/lib/hub-account.ts`, `src/auth.config.ts`,
  `src/app/login/page.tsx`, `src/app/(app)/layout.tsx`, `src/app/(app)/companies/page.tsx`, `desktop/main.mjs`,
  `desktop/links-gate.mjs`. New: migration `20261003180000_hosted_provisioning`, `src/lib/password-reset.ts`,
  `src/lib/platform-mail.ts`, `src/lib/platform-api.ts`, `src/lib/hub-reset-grants.ts`, `src/actions/hub-reset.ts`,
  `src/actions/password-reset.ts`, `src/app/reset/`, `src/app/api/platform/`, `src/components/hub-reset-*.tsx`,
  `src/app/(app)/companies/owner-reset-link.tsx`, `docs/legal/`. Its plan also covers sign-in, sign-up and
  `tests/account.spec.ts`.
- Billing package 4, StitchHub, modified: `src/accounts.mjs`, `src/license.mjs`. New: `src/provisioning.mjs`,
  `migrations/016_hosted_provisioning.sql`. Its plan also covers `src/server.mjs` and `test/provision.mjs`.
- Test-mode extraction: `scripts/library/extract_service_modes.py`. No finding touches `scripts/library/`. If that
  work later adds a reference table, it needs `prisma/schema.prisma` too (see batch A).

Findings that touch those files:

- M44, L42, I20, I22 (batch C): `src/auth.ts` (in package 4's sign-in scope), `src/app/login/page.tsx` and
  `src/app/(app)/layout.tsx` (both modified now). Start batch C only after package 4 is committed.
- L7 and L31 (wave 2): sign-up, sign-in, `src/lib/shops.ts`, `src/lib/platform-api.ts`, `src/lib/password-reset.ts`,
  `src/lib/hub-reset-grants.ts`, the Companies page and the schema, almost all of them package 4's.
- L6 (batch E): the fix goes on `src/app/(app)/companies/page.tsx` (modified now); the code it reads is
  `src/lib/hub.ts` (modified now).
- M56, L79, L127 (batch A): `prisma/schema.prisma` (modified now). Batch A's migration must be named after package 4's
  `20261003180000_hosted_provisioning`, so batch A starts after package 4 is committed.
- L127 (batch A): `removePayment` is named in `src/lib/lapse-allow.ts` (modified now). Keep the action's name so
  batch A never edits that file.
- L115 (owner question): option (a) would touch `desktop/main.mjs` (modified now).
- L95 (batch B): written to stay inside `src/db.mjs`, so it never needs the hub's `src/server.mjs`.

## Fix batches

Rules that keep the batches apart, so they can run in parallel:

- No two batches edit the same file, in either repo. New test helpers go in a new file under `tests/helpers/` named
  for the batch, never in `tests/helpers.ts`.
- Batch A is the only wave-1 batch that edits `prisma/schema.prisma` (one migration for all three of its findings).
  If batch A adds a model that has a `shopId`, it also adds the model to `MOVE_TABLES` in `src/lib/move/format.ts`
  (`scripts/checks/move-export.check.ts` asserts that), so prefer new columns on existing tables.
- No batch edits `package.json` in either repo. StitchBench checks run as `npm run check scripts/checks/<file>`; new hub
  tests run as `node test/<file>.mjs`, or go into `test/smoke.mjs` or `test/db.mjs` (batch B owns both).
- No batch edits `src/lib/lapse-allow.ts`. New actions (batches A, E and F) are refused while a company's base key has
  lapsed, the default of `safe()`, which is right for all three.
- Docs (`HANDOFF.md`, the status lines in `ROUND3_FINDINGS.md`, `docs/TESTING.md`, `README.md`, `INSTALL.md`) are
  updated once at the merge step, not inside the batches.

Wave 1, in order of severity:

| Batch | Findings | Top severity | Size | Starts after |
| ----- | -------- | ------------ | ---- | ------------ |
| A. Money and stock records | M56, L127, L79 | medium | medium-large | package 4 committed (schema) |
| B. Hub partner storage, single writer, hub tests | M71, L95, M68 (if the owner says yes), I14 (hub half), I24, I26, I28 (hub half) | medium | medium | nothing |
| C. Sign-in and sessions | M44, L42, I20, I22 | medium | medium | package 4 committed |
| D. Redraw a stored figure | L84 | low | small | nothing |
| E. Marketplace rows with no company | L6 | low | small | the owner's query; package 4 committed |
| F. Merge and delete customers and machines | L126 | low | large | nothing |
| G. Partner and repair-job specs | I3, I17, I14 (bench half), I11 (scanner half) | info | medium | batch A merged (consignment returns change) |
| H. Parts, import and cross-reference tests | I9, I10, I11 (cross-reference half), I28 (bench half) | info | medium | batch A merged (cost precision) |
| I. Marketplace on a two-company install | I12, I13 | info | medium | nothing |
| J. Ticket, void and report checks | I4, I21 | info | small-medium | batch A merged (payment reversal) |
| K. Library and figure route tests | I18 (and the optional I7 cases) | info | small-medium | nothing |

"Starts after" is about behaviour, not files: G, H and J test code that batch A changes, so they are written against
batch A's result. No two batches share a file.

### Batch A. Money and stock records (M56, L127, L79)

All three are decided. StitchBench files:

- `prisma/schema.prisma` and one new migration folder, named after `20261003180000_hosted_provisioning`.
- M56: `src/lib/partners.ts`, `src/actions/partner-orders.ts`, `src/app/(app)/partners/[id]/consignment/page.tsx`.
- L127: `src/actions/tickets.ts`, `src/app/(app)/tickets/[id]/page.tsx`.
- L79: `src/lib/format.ts`, `src/lib/format.test.ts`, `src/actions/parts.ts`, `src/actions/scan.ts`,
  `src/lib/inventory-import.ts`, `src/components/part-fields.tsx`, `src/app/(app)/parts/[id]/page.tsx`.
- New: `scripts/checks/money-records.check.ts`.
- Only if a new model with a `shopId` is added: `src/lib/move/format.ts`.

StitchHub: none. Wave-2 item W2 (partner signing) also edits `src/lib/partners.ts`, so it comes after this batch.

### Batch B. Hub: partner storage, single writer, hub tests (M71, L95, M68, I14, I24, I26, I28)

StitchHub files: `src/partners.mjs` (M71), `src/db.mjs` (L95), `src/market.mjs` (M68, only once the owner answers),
`test/smoke.mjs`, `test/db.mjs`. StitchBench: none. It stays out of the hub files package 4 is changing
(`src/accounts.mjs`, `src/license.mjs`, `src/provisioning.mjs`, `src/server.mjs`, the migrations). M71's optional
same-install rule would change the same-install partner step in `test/smoke.mjs` (around line 640), and M68 would
change the rating steps (around lines 291-292); both files are this batch's.

### Batch C. Sign-in and sessions (M44, L42, I20, I22)

StitchBench files: `src/auth.ts`, `src/app/login/page.tsx`, `src/app/(app)/layout.tsx`, `tests/auth.spec.ts`. New:
`src/lib/known-device.ts`, `scripts/checks/signup.check.ts`, `tests/helpers/sign-in.ts`. StitchHub: none. Starts after
package 4 is committed, because that package is editing the login page and the app layout now. Wave-2 item W1
(per-company email) edits the same sign-in files, so it comes after this batch.

### Batch D. Redraw a stored figure (L84)

StitchBench files: `src/components/manual-figure.tsx`, `src/app/api/figures/route.ts` (only if the POST needs an
explicit replace flag). StitchHub: none (the hub already lets the sharing install replace its figure).

### Batch E. Marketplace rows with no company (L6)

First the owner runs the query in the L6 note on both hosted databases. If both counts are 0, close L6 as moot and skip
this batch. Otherwise, StitchBench files: `src/app/(app)/companies/page.tsx`. New: `src/actions/market-assign.ts`,
`src/components/unassigned-market.tsx`. StitchHub: none. Starts after package 4 is committed (it is editing the
Companies page).

### Batch F. Merge and delete customers and machines (L126)

Decided. StitchBench files: `src/app/(app)/customers/[id]/page.tsx`, `src/app/(app)/machines/[id]/page.tsx`. New:
`src/lib/merge.ts`, `src/actions/merge.ts`, `src/components/merge-form.tsx`, `scripts/checks/merge.check.ts`. No schema
change: the merged record keeps the history by moving the rows and gets a note naming what was folded in. If the owner
wants a separate merge log table, this batch moves to wave 2 (it would need the schema). StitchHub: none.

### Batch G. Partner and repair-job specs (I3, I17, I14 bench half, I11 scanner half)

StitchBench files, all new: `tests/partners-edges.spec.ts`, `tests/helpers/partners-edges.ts`. StitchHub: none.

### Batch H. Parts, import and cross-reference tests (I9, I10, I11 cross-reference half, I28 bench half)

StitchBench files: `tests/market.spec.ts`. New: `tests/parts-page.spec.ts`, `scripts/checks/inventory-import.check.ts`.
StitchHub: none.

### Batch I. Marketplace on a two-company install (I12, I13)

StitchBench files, all new: `tests/market-companies.spec.ts`, `tests/helpers/market-companies.ts`. The e2e set-up already
makes a second company and a tech user. StitchHub: none (the hub side is covered by `test/companies.mjs`).

### Batch J. Ticket, void and report checks (I4, I21)

StitchBench files: `tests/roles.spec.ts`. New: `tests/ticket-edits.spec.ts`, `scripts/checks/reports.check.ts`.
StitchHub: none.

### Batch K. Library and figure route tests (I18, optional I7 cases)

StitchBench files: `scripts/checks/manual-downloads.check.ts` (the optional I7 cases). New:
`tests/library-routes.spec.ts`, `tests/helpers/library-server.ts`. StitchHub: none.

### Wave 2: decided features that need a short design first

These two are large, need `prisma/schema.prisma`, and share files with wave-1 batches, so they run one at a time after
wave 1 rather than in parallel with it.

- W1. Email addresses unique per company (L7, L31). StitchBench: `prisma/schema.prisma` and a migration, `src/auth.ts`,
  `src/app/login/page.tsx`, `src/app/signup/page.tsx`, `src/lib/shops.ts`, `src/actions/settings.ts`,
  `src/actions/partners.ts`, `src/lib/platform-api.ts`, `src/lib/password-reset.ts`, `src/lib/hub-reset-grants.ts`,
  `src/app/(app)/companies/page.tsx`, `tests/auth.spec.ts`. StitchHub: none expected. The billing design already names
  it as the later package `hub-email-identity`. After package 4, batch C and batch E.
- W2. Partner invites and messages signed end to end (L134, I27). StitchBench: `prisma/schema.prisma` and a migration,
  `src/lib/partners.ts`, `src/actions/partners.ts`, `src/lib/move/format.ts` (a new per-company table), the partner
  pages. StitchHub: `src/partners.mjs` only if the design needs the hub to carry a new field. After batches A and B.

## Per-finding notes

### Medium

**M44. Login pacing: a full queue refuses the right password.** STILL-OPEN, medium. Batch C.

- Today: `src/auth.ts:60-75`. Once an account has 5 recent wrong tries, tries for it run one at a time with growing
  waits, and at `src/auth.ts:63` a queue of 20 answers `null` (the "wrong password" answer) to every new try, the right
  password included. Parallel bursts and the sliding window were fixed on 30 Sep.
- Scenario: on the hosted service someone sends 25 wrong passwords for owner@shop, then one more every 30 seconds. The
  queue never drains below 20, so the owner's correct password is refused for as long as that goes on. The new
  "Forgot your password?" doesn't help: signing in with the new password goes through the same queue. TRUST_PROXY
  doesn't help either, since the limit is per account.
- Fix (medium): a known-device cookie. On a successful sign-in, set a signed long-lived cookie (an HMAC over the email
  with AUTH_SECRET). A try that carries a valid one for that email skips the per-account queue and its cap and has its
  own small failure count. Only tries without one are paced and capped. Files: `src/auth.ts`, `src/app/login/page.tsx`,
  a new `src/lib/known-device.ts`, plus a case in `tests/auth.spec.ts` (fill the queue, then sign in from a browser
  that signed in before).

**M56. A partner's consignment return moves stock with no confirmation.** STILL-OPEN (decided), medium. Batch A.

- Today: settlement payments wait for "Confirm it arrived" (`Settlement.confirmedAt`, `src/actions/partners.ts:131`).
  `consign.return` is still applied at once: `src/lib/partners.ts:1431-1440` calls `consignReturned`
  (`src/lib/partners.ts:1756`), which puts the stock back on the repair shop's shelf, capped only at what is out on
  consignment.
- Scenario: a sewing shop, by mistake or on purpose, sends a return of 40 units it still has. The repair shop's
  inventory shows 40 more on the shelf and its consignment page shows them returned, with nothing to accept or refuse.
- Fix (medium): hold the claim as pending on `ConsignItem` (for example `pendingReturn Float @default(0)` and
  `pendingAt`), show "Confirm it arrived" and "Not received" on `/partners/[id]/consignment`, and restock only on
  confirm. Same pattern as the settlement confirmation. Add a case to the batch's check script.

**M68. A seller can mark an order paid and rate the buyer alone.** NEEDS-OWNER, medium. Batch B once answered.

- Today: StitchHub `src/market.mjs:571-574` lets the seller move ACCEPTED to PAID without the buyer pressing "Payment
  sent" (`/buyer-paid`, `src/market.mjs:566-569`). `RATE_FROM` (`src/market.mjs:613`) lets the seller rate the buyer
  from PAID. Since 30 Sep the buyer can rate from PAID too and can always answer a rating (`src/market.mjs:628-631`),
  and standing ignores $0 orders and counts the latest rating per rater. The owner kept the seller's "Mark paid"
  (d2a8c46).
- Question: should a seller be able to rate a buyer before the buyer has said they paid, or before the order shipped?
- Recommended answer: keep "Mark paid" for the seller alone (payment happens outside the hub: check, cash, PayPal), but
  let the seller rate the buyer only once the buyer pressed "Payment sent" or the order has shipped. That is a small
  change in `src/market.mjs` and the rating steps of `test/smoke.mjs`. Sockpuppet ratings could later be counted per
  StitchHub account rather than per install, now that accounts exist.

**M71. Hub partner storage: the per-install cap multiplies with minted installs.** STILL-OPEN, medium. Batch B.

- Today: StitchHub `src/partners.mjs:15-21` limits bytes per hour (shop, install, link side), stored bytes per install
  (2 GB) and per link side (512 MB), and the partner-only installs one member's codes can bring on
  (`MAX_MINTED = 50`, `src/partners.mjs:205-228`). But the stored count is per install (`installStored`,
  `src/partners.mjs:61-68`), so a member and the 50 installs it minted can hold about 51 x 2 GB. A link between two
  made-up companies of one install is still allowed (`src/partners.mjs:117` refuses only the same install and the same
  shopRef). That was kept on purpose for hosted installs.
- Scenario: a member mints 50 partner-only installs over five hours (10 an hour) with its own codes, links each to a
  made-up company of its own, and fills each one's 2 GB. That is about 100 GB in the hub's Postgres volume, which takes
  the hub down for everyone.
- Fix (small): count stored bytes per root member (`coalesce(invited_by, id)`) and cap the root, for example 2 to 4 GB
  for a member and every install it brought on. Optionally, refuse a same-install link unless both shopRefs are
  companies that install has claimed (the `shops` table; every joined company claims itself on sync). The second part
  changes the same-install partner step of `test/smoke.mjs`.

### Low

**L6. Listings and orders with no company on multi-company installs.** STILL-OPEN, low. Batch E.

- Today: `saveListing` (`src/lib/hub.ts:759`) and `saveOrder` (`src/lib/hub.ts:818`) give a row the company the hub
  names (shopRef), or the only company. A listing made before the hub carried shopRef, on an install with several
  companies, keeps `shopId` NULL. Nothing reassigns it, there is no screen for it, and a company move leaves it behind.
- Scenario: as in the finding, on a hosted install that had listings before the round-1 upgrade. Company A can't pause
  or remove its old listing, and an order on it is invisible to A.
- Fix (small): first the owner runs, on both hosted databases,
  `SELECT count(*) FROM "Listing" WHERE "shopId" IS NULL;` and the same for `"MarketOrder"`. If both are 0, close L6
  as moot. Otherwise add a "Marketplace rows with no company" list for the StitchBench administrator on Companies, with
  a company picker.

**L7. Email addresses unique across the install.** STILL-OPEN (decided), low. Wave 2, W1.

- Today: `User.email` is `@unique` (`prisma/schema.prisma:204`). `/signup` (`src/app/signup/page.tsx:44`),
  `createShopWithOwner` (`src/lib/shops.ts:62`), `addUser` (`src/actions/settings.ts:184-186`) and `setUpSewingShop`
  (`src/actions/partners.ts:161`) all answer "That email already has an account." for an address used in any company.
  The new provisioning API turns the same message into a 409 (`src/lib/platform-api.ts:102`); that one needs the
  platform token, so it is not a probe. The new "Forgot your password?" gives the same answer either way
  (`src/lib/password-reset.ts:27`).
- Scenario: unchanged. Shop A's admin adds bob@shopB.example as a tech, and shop B can never add Bob.
- Fix (large): `@@unique([shopId, email])`, and sign-in asks which company when one address and password match more
  than one. Sign-up, `addUser` and the partner set-up check only within the company. Password reset and the owner
  reset links pick the company too. This is the billing design's later `hub-email-identity` package.

**L31. Same as L7, from the admin's side.** STILL-OPEN (decided), low. Wave 2, W1. Same code and fix as L7.

**L42. Signing out doesn't end the session elsewhere.** STILL-OPEN (decided), low. Batch C.

- Today: the sign-out form in `src/app/(app)/layout.tsx` (`signOut` at line 116) only clears this browser's cookie.
  `sessionVersion` goes up on a password change, reset, role change or removed access (`src/actions/settings.ts:173`,
  `:208`, `:219`, `:231`, `src/lib/password-reset.ts:150`), never on sign-out. The HTTPS half of the finding is built
  (the Tailscale address, handoff item 11), but plain http on port 3100 still works on the shop network.
- Scenario: a tech signs out on a shared tablet. A copy of the cookie keeps working for up to 30 days.
- Fix (small): in that server action, add 1 to the user's `sessionVersion` before `signOut`. That signs the person out
  on every device, as decided. A shorter session on the Windows program is optional and not decided.

**L79. Supplier costs are rounded to cents.** STILL-OPEN (decided), low. Batch A.

- Today: `toCents` (`src/lib/format.ts:14-20`) refuses ambiguous and out-of-range amounts (fixed 30 Sep), but rounds to
  whole cents. `Part.costCents` (`prisma/schema.prisma:594`) and `PartSource.priceCents` (`:664`) are integer cents.
- Scenario: a supplier sells needles at $0.125 each. The cost is saved as $0.13, and margins and import totals are off
  by 4%.
- Fix (medium): keep the cost with 4 decimals, for example an integer in ten-thousandths of a dollar beside
  `costCents`, which stays rounded for everything that reads it today (register margins, exports). Use a `parseCost()`
  that accepts up to 4 decimals for the cost fields of the part form, scan receive and import. Prices stay in cents.

**L84. A stored figure can't be redrawn from the screen.** STILL-OPEN, low. Batch D.

- Today: the cache is an hour now (`src/app/api/figures/[id]/route.ts:13`). The hub lets the install that shared a
  figure replace it (StitchHub `src/server.mjs:716-726`), and installs fetch a redrawn figure again
  (`src/lib/hub.ts:1061-1065`), so the hub half is done. Left: `src/components/manual-figure.tsx:153` saves only when
  the figure isn't stored yet (`!stored`), and the stored view (`:169-189`) offers only "Show figure" and "Whole page".
- Scenario: a wrong figure was saved. The owner can see it's wrong but has nothing to press to save a correct one.
- Fix (small): a "Redraw from manual" button for the owner and admins on the stored view, when the manual is on this
  PC. It draws the box again and saves it as a replacement.

**L95. Nothing stops a second hub process.** STILL-OPEN (decided), low. Batch B.

- Today: StitchHub `src/db.mjs:42-48` keeps the in-flight writes in process memory. Only migrations take an advisory
  lock (`src/db.mjs:120`). `railway.json` says one replica.
- Scenario: a deploy overlap, or someone raises the replica count. Process 2 serves a feed past a number process 1
  still holds, and a shop's cursor skips that row for good.
- Fix (small-medium, in `src/db.mjs` only): at start, a dedicated connection takes
  `pg_try_advisory_lock(hashtext('stitchhub:writer'))` and keeps it, retrying every second. Until it has the lock,
  `holdFeeds()` and `feedLimit()` throw a 503 ("the hub is restarting, try again in a moment"), while `/health` keeps
  answering so Railway can finish the deploy and stop the old process, which releases the lock. A few seconds of
  errors during a deploy, as the owner accepted.

**L115. Backups are not encrypted and hold the hub key.** NEEDS-OWNER, low.

- Today: `desktop/backup.mjs:16-21` leaves out only reference and hub-cache tables, so `HubState.installKey`
  (`prisma/schema.prisma:914`), password hashes and every customer's details are in each backup in plain form.
  INSTALL.md warns (line 155). The import temp folder is cleaned in a `finally` now. Since 30 Sep the mail password,
  the Twilio secret and the Stripe keys are sealed (`src/lib/messaging/secrets.ts`) under the PC's AUTH_SECRET in
  `secrets.json`, which is not in the backup.
- Question: should backups be encrypted, and with what key?
- Options: (a) seal the hub install key like the mail password (small, but a backup restored on a new PC without the
  old `secrets.json` then can't act on the hub until the shop joins again); (b) encrypt whole backups with a recovery
  phrase the owner keeps (if the phrase is lost, so are the backups); (c) keep local backups as they are and encrypt
  the copies that leave the PC, with the planned off-site backup (handoff 3.6).
- Recommended answer: (c). An off-site copy must be encrypted. For the copy on the shop PC, a lost key is the bigger
  risk for a small shop than a leaked one. Keep the INSTALL.md warning, and say that a synced Documents folder
  (OneDrive) counts as leaving the PC.

**L126. Customers and machines can't be merged or deleted.** STILL-OPEN (decided), low. Batch F.

- Today: there is still no delete or merge for customers or machines (`src/actions/records.ts` and the rest of
  `src/actions`; the only "Merge into" is the cross-reference's). Many more tables point at a customer or machine than
  in September: appointments, class seats, messaging consent and the message queue, campaign recipients, online orders,
  vacuum units, parts a ticket waits for.
- Scenario: unchanged. A duplicate customer from check-in splits that customer's history for good.
- Fix (large): `src/lib/merge.ts` moves every row that points at the duplicate to the kept record in one transaction,
  notes "Merged from <name> on <date>" on it, then deletes the duplicate. Delete is offered only for a record that
  nothing points at. Owner or admin only. The check script reads every relation to Customer and Machine from the Prisma
  model list and fails if the merge misses one (the way `move-export.check.ts` guards the move's table list).

**L127. Removing a ticket payment deletes it.** STILL-OPEN (decided), low. Batch A.

- Today: register voids are fixed (a void comes off the day of the void). `removePayment`
  (`src/actions/tickets.ts:595-603`) still deletes the Payment row (`:600`).
- Scenario: a payment taken in March is removed in May. March's sales log changes, and nothing shows in May.
- Fix (small-medium): keep the action's name (it is on the lapse allow-list) but record a reversing payment instead:
  a negative amount dated today, with `Payment.reversesId` (unique) pointing at the original. The ticket page shows the
  pair and no "Remove" on a reversed payment. Balances don't change, because amounts are summed.

**L134. The hub can create partnerships and forge partner messages.** STILL-OPEN (decided, design first), low.
Wave 2, W2.

- Today: `link.created` from the hub is applied as it comes (`src/lib/partners.ts:1074-1080` to `saveLinkFromHub`,
  `:369`). There is no local record of an invite made or a code entered, and no check that the link's shopRef for this
  side is this company. (The missed-link path, `linkFor` at `:756-766`, does check the shopRef.) Messages carry no MAC.
- Scenario: unchanged. A hostile hub sends `link.created` naming company B of a hosted install, then `settle.paid` and
  `consign.place` on that link.
- Fix (large, in two parts): (1) small: record invites made and codes entered (shopId, code hash, expiry), accept
  `link.created` (and the missed-link path) only for one of them, and require `l[toSide].shopRef === shopId`.
  (2) Signing. Design point: the hub sees the code itself when it is redeemed (it stores its hash), so a key derived from
  today's code is known to the hub. The long code needs a second part that is never sent to the hub; both shops derive
  the link key from it and HMAC each message's type, id and data. A short code typed at a counter would then need that
  second part too (a longer code, or a QR code).

### Info

**I3. Repair-job edge flows untested.** STILL-OPEN, info. Batch G.
`tests/partners.spec.ts:37` covers one intake, one approval and payment at the register. There is still no test of an
estimate declined (`answerEstimate`, `src/actions/repair-jobs.ts:176`), a second estimate after approval, a counter
cancellation (`cancelJob`, `:208`) or a hand-back unrepaired or unpaid (`markPickedUp`, `:193`). Fix (medium): those
four flows in `tests/partners-edges.spec.ts`.

**I4. Ticket lifecycle leftovers untested.** STILL-OPEN, info. Batch J.
`tests/roles.spec.ts:111-150` checks that a tech sees no void button. Nothing replays `voidSale`
(`src/actions/register.ts:258`) as a tech; `requireAdmin` there is the only guard, since `voidSaleAs`
(`src/lib/register-sale.ts:371`) takes any user. Also untested: two people saving `saveTicketText`
(`src/actions/tickets.ts:301`) at once, and the dashboard's storage-fee list (`src/app/(app)/page.tsx:64`, `:102`).
Fix (small): a replayed `voidSale` as the tech (the `expectRefused` helper exists), two browser contexts editing one
ticket, and a ticket ready longer than `abandonedAfterDays` showing on the dashboard.

**I7. The download guards' file naming.** MOOT, info. Optional cases in batch K.
`inboxName` is gone. Manual downloads now name files in `src/lib/manual-downloads.ts` (`linkStem` and `fileSafe`,
`:65-78`), a plain module that `scripts/checks/manual-downloads.check.ts` covers (`:121`, a model with a slash). The
fetch guard has `tests/unit/safe-fetch.test.ts`. Optional: add stems such as `../x`, a backslash name and `CON` to the
check.

**I9. Part page untested.** STILL-OPEN, info. Batch H.
Covered since: a tech's save keeps cost and price (`tests/roles.spec.ts:85`), and another company's part edits are
refused (`tests/tenant.spec.ts:195`). Still untested: Receive stock and Shelf count (`moveStock`,
`src/actions/parts.ts:127`), a negative count refused, a part number that differs only in case from another part's
(`updatePart`, `:102`), and adding, preferring and removing a supplier (`:185-207`). Fix (medium):
`tests/parts-page.spec.ts`, with the cost cases written for batch A's precision.

**I10. Spreadsheet import untested beyond new rows.** STILL-OPEN, info. Batch H.
`tests/inventory.spec.ts:77-92` and `:163-176` only add new rows. `runImport` (`src/lib/inventory-import.ts:61`) is a
plain library function now, so a check script can drive it without the browser. Fix (small-medium):
`scripts/checks/inventory-import.check.ts`, covering a re-import with updateExisting on and off, addQty off, the
"(own)" number beside a consigned item, "2 1/2" yards, and a row that forces a database error (nothing changes).

**I11. Cross-reference merge and remove, and the scanner's consigned guard, untested.** STILL-OPEN, info. Batches H
and G. `mergeCrossRef`, `removeCrossRef`, `restoreCrossRef` and `addPartToCrossRef` (`src/actions/xref.ts:75`, `:90`,
`:100`, `:137`) have no test. `scripts/checks/sharing.check.ts:298` covers "Offer this part" refusing a consigned part,
but not the scan station refusing to receive one. Fix (small-medium): merge, remove and restore in
`tests/market.spec.ts`, with a check that the form `addPartToCrossRef` opens has no notes (batch H); scan a consigned
item in Receive mode on the sewing shop (batch G).

**I12. Marketplace exception paths untested on the bench.** STILL-OPEN, info. Batch I.
`tests/market.spec.ts:33` is still one company on the happy path. The hub side of two companies on one install is
covered since 2 Oct (StitchHub `test/companies.mjs`, and `test/smoke.mjs:460-513`). Still untested on the bench:
decline, cancel and restock, ship before payment, pausing or editing a listing, removing a listing with open orders,
and take-from-stock. Fix (medium): `tests/market-companies.spec.ts`.

**I13. Marketplace on a two-company install untested on the bench.** STILL-OPEN, info. Batch I.
Same spec as I12. It should cover another company's listing refused by `ownListing` and `ownOrder`, an order that
arrives after the listing was removed, and a tech refused when accepting orders or setting the pay instructions.

**I14. Checker, stale edits and outbox recovery.** STILL-OPEN (narrowed), info. Batches B and G.
Covered since: stale listing quantities (`expectedQty`, StitchHub `test/smoke.mjs:479-480`) and stale cross-reference
edits (`baseUpdatedAt`, `:527-542`). Left: the link checker refusing private addresses (`privateAddress`,
`src/checker.mjs:29`, and the connect check at `:34-48`) has no test (batch B, in `test/db.mjs`). The partner outbox
catching up after the hub blocks and then unblocks a member has no test either (batch G).

**I15. Offline spec driver.** FIXED-SINCE, info.
`scripts/local-test/offline_test.ps1` and `blackhole.mjs` (ff0ca07, 27 Sep) run the phases, and `README.md:128-130`
and `scripts/local-test/README.md:12` document them. Caveat: the driver is PowerShell only (`Get-NetTCPConnection`), so
a Linux cloud session can't run it.

**I16. Register returns and register math.** FIXED-SINCE, info.
`tests/register.spec.ts:9` (a cash refund, 27 Sep), `src/lib/register-math.test.ts` (950cd56, 30 Sep: rounding, tax,
whole-sale discounts, "only cash gives change", refunds paid out in full), `src/lib/sale-return.test.ts`, and a tech
refused a refund (`tests/roles.spec.ts:111`). Not covered, optional: an exchange (a sale and a return on one receipt),
which would be one more unit test.

**I17. Partner critical paths untested.** STILL-OPEN, info. Batch G.
Still untested: a terms change proposed and accepted, with the version going up on both sides
(`src/actions/partners.ts:69`, `:80`); a consignment shelf count and return (`src/actions/partner-orders.ts:239`,
`:265`), written for batch A's confirmation step; partner order accept and cancel (`partnerOrderAction`, `:79`); and a
message set aside, then resent or retried (`src/actions/partners.ts:188`, `:198`). Fix (medium): in
`tests/partners-edges.spec.ts`.

**I18. Library and figure routes barely tested.** STILL-OPEN, info. Batch K.
`tests/shop-library.spec.ts` still needs `SHOP_LIBRARY=1` and tries two traversal strings (`:22-23`). Untested:
encoded and backslash traversal, the scan upload (POST `/api/library/file`, `src/app/api/library/file/route.ts:82-104`),
POST `/api/figures` as a tech, the owner and another company, and the image headers. `tests/figure.spec.ts` still
needs `MANUAL_DIR`. Fix (small-medium): `tests/library-routes.spec.ts` against a server started with a temporary
`LIBRARY_DIR` (the helper in `tests/helpers/library-server.ts`).

**I20. Auth leftovers: the per-address limit and SETUP_TOKEN.** STILL-OPEN, info. Batch C.
The per-address limit (`src/auth.ts:89`; `src/lib/client-ip.ts:6-11`) is untested (`tests/auth.spec.ts:104` says so).
It needs no real proxy: a test server started with `TRUST_PROXY=true` takes the last `X-Forwarded-For` hop the test
client writes. SETUP_TOKEN's first-company-only sign-up (`src/lib/shops.ts:70`) can be checked by calling
`createShopWithOwner(..., { firstOnly: true })` on a database that has a company. Fix (small): both, in batch C's
files.

**I21. Reports and exports untested.** STILL-OPEN, info. Batch J.
Nothing asserts the Sales log figures, the Invoices "Still owed" total, trade commission, or the customers, repairs
and payments CSVs (only the inventory, tickets and classes exports are fetched in specs). Fix (medium):
`scripts/checks/reports.check.ts` over `src/lib/sales.ts` and the export builders, written after batch A's payment
reversal.

**I22. Auth, sign-up and settings paths.** STILL-OPEN (narrowed), info. Batch C.
Covered since: removed access and a role change end the session (`tests/auth.spec.ts:61`), `/companies` is 404 for
non-administrators (`:153`), `/signup` is closed (`:143`). Left: a password change ending the other browser's session,
a tech replaying `saveShop`, sign-up with a reserved address, a partner code at sign-up on an install that isn't on a
hub, and a blank or too-low next ticket number refused. Fix (small), in `tests/auth.spec.ts` (batch C) once package 4's
login and sign-up changes are in.

**I23. Hub tests for the last round's fixes.** FIXED-SINCE, info.
StitchHub `test/db.mjs:19-26` (a feed stops below a write in progress) and `:28-39` (the link checker), and
`test/smoke.mjs`: `:121-124` and `:711` (a clientId retry), `:685-720` (a hub move imported into an empty test hub,
again to check it changes nothing, and hostile files refused, when `IMPORT_HUB_URL` is set), and `:132` (a figure id of
its own each run). All in 90ecfc4 (30 Sep).

**I24. Hub admin routes untested.** STILL-OPEN (narrowed), info. Batch B.
Covered since: the hub move (opt-in, `test/smoke.mjs:685-720`), a join-key change (`:69-71`), a link report
(`:111-112`), the Discord guard (`:38`), and a partner-only install refused the community feed (`:601`). Left:
POST `/v1/admin/links/import` with a duplicate skipped (only StitchBench's `tests/hub.spec.ts:55` calls it, without
checking skips), datasets PUT and GET, an admin deleting a note, and a member refused when deleting another member's
note. Fix (small).

**I25. Hub smoke: body limits, blocked sellers, figures, removed photos.** FIXED-SINCE, info.
StitchHub `test/smoke.mjs:139-144` (413 on `/register`, `/figures`, `/posts`, `/listings`), `:496-506` (a blocked
seller's listings paused and its orders declined, 258e9fc), `:135-137` (the first install to share a figure keeps it),
`:733-735` (photos gone with a removed note and listing).

**I26. Hub move, checker and datasets.** STILL-OPEN (narrowed), info. Batch B.
The import is covered when `IMPORT_HUB_URL` is set (not in a default run). `checkLink` is covered for a stale and a dead
result (`test/db.mjs:28-39`). Left: the checker's classify step, redirects and private addresses (shared with I14), and
datasets (shared with I24). Fix (small).

**I27. The hub can forge partner messages, and stores them readable.** STILL-OPEN (decided), info. Wave 2, W2.
The documentation half is done: StitchHub `src/partners.mjs:1-7` now says the hub can read the messages and the apps
take its word for the sender. Left: signing (see L134), and normalising the side the hub sends.
`saveLinkFromHub` stores the side it is given (`src/lib/partners.ts:378`), from the redeem answer (`:317`) and from the
hub's link list (`:765`), without reducing it to repair or retail.

**I28. Cross-reference remove, restore and sources round trip.** STILL-OPEN (narrowed), info. Batches B and H.
Hub, covered since: merge then revert (`test/smoke.mjs:527-542`), two members adding the same number (`:167`), usage
near the cap (`:454-455`). Left on the hub: deleting a cross-reference entry and restoring it (batch B). Left in
StitchBench: saving a source whose vendor or address has a comma, in CAD, and getting it back unchanged, and removing
then restoring an entry from the screen (batch H).

## Outside this list

- L136 is marked FIXED but its status names a leftover: later messages about the same record, marked seen while the
  first one was set aside, are not replayed when "Try again" re-applies it. It was not re-checked here. Worth a line in
  the owner's list.
- Findings marked FIXED were not re-checked.
