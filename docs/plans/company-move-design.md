# Moving a company between installs: design (2 Oct 2026, first draft for the owner)

HANDOFF.md section 3 item 10 ("A shop chooses where it runs, and can change its mind") and item 8 (hosted = one
shared instance). Nothing here is built. Where this document says "decided", the owner may still say otherwise;
section 10 lists every question with a recommended answer.

Files relied on: `prisma/schema.prisma` (all of it), `desktop/backup.mjs`, `backup-now.mjs`, `import-from-dev.mjs`,
`main.mjs` (backup, restore, first run), `src/app/api/export/[what]/route.ts`, `src/lib/hub.ts` (join, `formerInstall`,
`claimShop`, `ownCompany`), `src/lib/partners.ts` (link ids, outbox, `PartnerSeen`), `src/lib/license.ts` (payload `s`
= `Shop.id`), `license-signing.ts`, `src/lib/messaging/secrets.ts` (AAD `shopId:field`, key from `SETTINGS_KEY` or
`AUTH_SECRET`), `src/lib/shops.ts` (bcryptjs), `src/lib/session.ts` (`sessionVersion`, `canHostMany`),
`src/app/signup/page.tsx` (`SETUP_TOKEN`), `src/actions/companies.ts`, `next.config` (16 MB body limit),
`scripts/checks/tenant.ts`, `tests/two-servers.spec.ts`, INSTALL.md; hub `src/transfer.mjs`, `accounts.mjs`
(`shops (install_id, shop_ref)`, `/v1/shops/claim`), `partners.mjs` (routing by `*_install_id` + `*_shop_ref`),
`migrations/005_partners.sql`, `012_accounts.sql`; `docs/plans/hub-accounts-billing-design.md` section 2.

## 0. Scope in one page

- One company (one `Shop` row and everything under it) leaves one install for another: the shared hosted instance to
  a Windows PC or its own Railway, or the other way. The three ways to run stay as INSTALL.md describes them.
- **Ids are kept.** Partner records (`PartnerLink`, `RepairJob`, `PartnerOrder`, `ConsignSale`, `Settlement`,
  `PartnerRun`) carry the same id on both shops; the hub knows the company as `shop_ref = Shop.id`; every license key
  names `Shop.id` in its payload (`s`). A move that renumbered anything would break all three.
- **One file**, gzipped JSON lines, one line per row, every table that carries this `shopId` in dependency order,
  pictures as base64 bytes, a header with the schema migration it was taken at and a trailer with the row count.
- **The hub is re-pointed** by a move token minted at export and redeemed at import (`POST /v1/shops/move`): the hub
  rewrites `install_id` on every row keyed by this company, so partner links, listings, orders, ratings, usage and
  shared notes follow. Partner shops are told nothing; nothing they hold changes.
- **Secrets are left out** (mail password, Twilio secret, Stripe keys): the owner enters them again on the new side.
  Logins travel with their bcrypt hashes; everyone signs in again (a different `AUTH_SECRET`).
- **The old copy** goes read-only the moment the export starts, learns from the hub that the move completed, says so
  on every page, and is deleted by hand after 30 days.
- Owner only; https only; the file holds everything the shop holds and the UI says so.

## 1. What exists today

- `desktop/backup.mjs`: a whole-install backup (gzipped `COPY` per table + `manifest.json` with `lastMigration`),
  restored only into a database at or past that migration; skips the shipped reference sets and the hub's cached
  copies; keeps `HubState`, `Listing`, `MarketOrder`. It is the right shape, but it is per install and it replaces.
- `src/app/api/export/[what]/route.ts`: CSV for people, not for a program to read back.
- Hub `src/transfer.mjs`: a whole-hub export as gzipped NDJSON, `{ t: "meta" }` first, tables in parent-first order,
  rows paged by key, bytes as base64, import inside one transaction with `ON CONFLICT`. This design copies its style.
- The hub keys a company as `(install_id, shop_ref)`: `shops` (UNIQUE), `partner_links.repair_/retail_*`, `listings`,
  `orders.seller_/buyer_*`, `order_ratings`, `posts`, `link_revisions`, `xpart_revisions`, `part_usage`,
  `partner_invites`. Partner messages are routed by the link's `*_install_id`; an install never learns a partner's
  address. `figures.install_id` has no `shop_ref` and stays put.
- `hub.ts` already handles an install that comes back under an old key (`formerInstall`, `HubState.former*`) and a
  program that joins through `/v1/partners/redeem` without a key and is given `installId` + `installKey`.
- Sealed values (`secrets.ts`) are AES-GCM under a key derived from `SETTINGS_KEY` (hosted) or `AUTH_SECRET`
  (Windows), with `shopId:field` as the authenticated data: a value copied to another install never opens.

## 2. Every model, by what happens to it

| Goes with the company (has `shopId`, or belongs to a row that does) |
|---|
| `Shop`, `User`, `Customer`, `Machine`, `ModelNote`, `ServiceItem`, `ShopEquipmentKind`, `Part`, `PartSource` (via Part), `Ticket`, `TicketLine`, `Payment`, `TicketSite`, `PartWait`, `StockMove`, `MachinePhoto`, `PartPhoto`, `SharedPost`, `SharedPhoto` (via post), `Sale`, `SaleLine`, `StockUnit`, `VacCare`, `PartnerLink`, `PartnerOutbox`, `RepairJob`, `PartnerOrder`, `ConsignItem`, `ConsignSale`, `Settlement`, `PartnerSeen`, `PartnerFailure`, `PartnerRun`, `License`, `ModuleGrant`, `MessagingSettings`, `Campaign`, `OutMessage`, `Suppression`, `ConsentEvent`, `InboundText`, `EstimateLink`, `ShopClass`, `ClassMeeting`, `Enrollment`, `AppointmentType`, `Appointment`, `Shift`, `BookingLink`, `WebOrder` |

| Per install: not in the file, fetched or rebuilt on the new side | Why |
|---|---|
| `HubState` | one row per install: the new install has its own `installId`/`installKey`; the hub move hands the company over |
| `ManualLink`, `HubPost`, `HubPhoto`, `HubFigure`, `XPart`, `RemovedXPart`, `ListingPhoto` | the hub's, synced again; `HubPost.mine` comes right once the hub has rewritten `posts.install_id` |
| `Listing`, `MarketOrder` (nullable `shopId`) | synced copies; after the move the hub sends them with this company's `shop_ref` and `ownCompany()` files them under it |
| `LibraryDoc` | the index of the PC's `C:\Manuals`; the folder isn't moving (a hosted shop connects a folder per PC). A shop that copies its folder to the new PC gets the index rebuilt at start; sidecars keep dedupe working |
| `ManualDownload` (has `shopId`) | a queue into the install's library: finished rows describe files that stay behind, queued ones a library that isn't there. Dropped, said in the summary |
| `JobLease` | which process holds a background job right now |

| Shared reference data: shipped with the program, never moved |
|---|
| `TensionSpec`, `FactorySetting`, `ModelImage`, `FigureImage` (`reference.mjs`, `scripts/library/upload-media.ts`) |

Notes on the first group: `ModuleGrant` counts only on a server holding the hosting key, so a company leaving the
hosted instance keeps the rows as history but loses switch-granted modules; the export warns and lists the modules
that need a `k1` key (or, once `hub-billing` ships, the hub's key). `License` rows stay valid because `s` is the
`Shop.id`. `PartnerSeen` must travel: it is what stops the new install re-applying partner messages it pulls again.
`PartnerOutbox` rows not yet sent travel and go out from the new install.

## 3. The file

- Name `<company>-<yyyy-mm-dd>.stitchmove.ndjson.gz`. Line 1: `{ t: "meta", format: "stitchbench-company",
  version: 1, program, appVersion, lastMigration, exportedAt, shop: { id, name, kind }, hub: { url, installId,
  moveToken, cursor, orderCursor, partnerCursor } | null, leftOut: ["MessagingSettings.smtpPassSealed", ...],
  warnings: [...] }`. Then `{ t: "<Model>", ...row }` in the order of section 2's first table (parents first; within
  a table paged by primary key, 200 rows a page, 20 for picture tables). `Bytes` as base64, `DateTime` as ISO,
  `Json` as is, enums as their names. Last line `{ t: "end", rows: N, tables: { Model: n } }`: a file without it was
  cut short and is refused.
- One snapshot: the export runs in a `REPEATABLE READ READ ONLY` transaction like the hub's. **Decided:** the company
  is also frozen (section 7) from the moment the owner confirms, so nothing written after the snapshot can be lost.
- Why JSON lines and not a zip of one JSON per table: it streams both ways with flat memory (a photo is one line),
  it is the hub's format already (`transfer.mjs`), and one file is one thing to carry. Limits as the hub's: 64 MB a
  line, 8 GB inflated.
- Secrets left out, set to null in the file: `MessagingSettings.smtpPassSealed`, `twilioTokenSealed` (and their
  `*SavedAt`), `Shop.stripeKeySealed`, `stripeWebhookSealed`, `EstimateLink.tokenSealed`, `WebOrder.linkSealed`.
  `MessagingSettings.testCodeHash`/`testPhonePending` are cleared too. The import sets `emailOn`, `smsOn` and
  `shopOn` false with a message naming what to enter again, and sets `marketingHoldAt` as a restore does.
- Users: `passwordHash` (bcryptjs, a portable string) and `sessionVersion` travel unchanged. Sessions end anyway:
  the cookie is signed with the install's `AUTH_SECRET`.
- Size: a 1600 px photo at quality 0.82 is 250 to 400 KB; 10,000 photos make a 3 to 4 GB file (base64 adds a third;
  gzip does nothing for JPEGs). The progress UI shows rows and bytes; the export job and the import job survive a
  page reload because their state is a row (`CompanyMove`, section 8).

## 4. Import

Refused before any row is written, with the reason in the owner's words:
1. not a `stitchbench-company` file, or a `version` this program doesn't know (update the program);
2. the target's newest `_prisma_migrations` name is older than `meta.lastMigration` (update the target first; a
   newer target is fine: Prisma defaults fill columns the file lacks, and a column the target doesn't know is refused
   by name, as `restore()` does);
3. a `Shop` with that id already exists (a move is never a merge; the old copy must be deleted first if the company
   is coming back);
4. a `User.email` already used on the target (emails are unique per install until HANDOFF 2c L7/L31 is built): the
   list is shown, the owner changes those logins' addresses on the source and exports again;
5. any row whose `shopId` isn't `meta.shop.id`, or a child row whose parent isn't in the file: a tampered file;
6. a missing `end` line or counts that don't match;
7. on the Windows program, a company already present and `platformAdminEmails` unset (one company per PC unless the
   PC is set up to host several, `canHostMany` in `session.ts`).

Then, in one transaction: tables in order, `createMany` in pages (plain inserts: no `ON CONFLICT`, a clash is a
refusal); unique clashes that are expected are handled first: `Shop.bookingSlug` is cleared when taken (the public
address changes with the host anyway, said in the summary); random tokens (`tokenHash`, `optOutToken`,
`stripeSessionId`, `SharedPost.hubId`) can't clash in practice and are refused if they do. `Shop.movedInAt` and
`movedFrom` are set. After commit: the hub step (section 5) and the summary page (what came in, what was left out,
what to enter again, which modules need a key).

A CLI does the same from a file on disk, `npx tsx scripts/move/import.ts <file> [--into DATABASE_URL]`, for the
owner on a server with no browser upload, and for the checks.

## 5. The hub: re-pointing the company

**Decided:** a move token in the file, redeemed by the new install. Alternatives: (a) the new install's `claim` call
with a proof it can't have (its install key differs, and the hub can't tell a thief from a mover); (b) the hub admin
rewrites by hand (kept as the fallback door, plus the account page once `hub-accounts` exists).

1. **Export**, when the source is on a hub: `POST /v1/shops/{ref}/move-token` with the install key. The hub stores
   `shop_moves (id, shop_id, token_hash, from_install_id, expires_at = now() + 14 days, used_at, to_install_id)` and
   answers the token once; it goes into `meta.hub`. The hub down: the export still completes, `meta.hub.moveToken` is
   null, the summary says the hub step must be done later from the hub ("Move this shop" on the admin page now, the
   account's shops page later).
2. **Import**: `POST /v1/shops/move { shopRef, token, shopName, kind, program, version }`. With the new install's key
   when it is already on that hub; without one when it is on no hub yet, in which case the hub makes an install
   (scope copied from the old install's, name = the company's) and answers `installId` + `installKey` exactly as
   `/v1/partners/redeem` does, and the program writes `HubState`. On a different hub: the hub step is refused and
   said; the data import stands.
3. **The hub**, in one transaction: token valid, unused, for this `shop_ref`; `shops.install_id = new`; the same on
   `partner_links` (`repair_*` or `retail_*` where the ref matches), `listings`, `orders` (`seller_*`, `buyer_*`),
   `order_ratings` (`rater_*`, `rated_*`), `posts`, `link_revisions`, `xpart_revisions`, `part_usage` (merge on the
   unique key), unused `partner_invites`; `shop_moves.used_at`, `to_install_id`. Legacy rows with `shop_ref = ''`
   (before per-company identity) are not touched.
4. **Catching up**: `partner_messages.seq` is one global sequence, so the old install's `partnerCursor` is a valid
   place for any install. The import does one partner pull from `meta.hub.partnerCursor` for the moved company's
   links (the existing pull route with an explicit cursor and link filter); `PartnerSeen` drops what was already
   applied. Then the install's own cursor carries on. The same for `cursor`/`orderCursor` on a fresh install.
5. **The old install** asks `GET /v1/shops/{ref}/standing` at its next sync and gets `410 { moved: true, to:
   "<install name>", at }` (the row's `install_id` is no longer the caller's); it sets `Shop.movedOutAt`/`movedTo`.

**Partner shops are told nothing (decided).** Their `PartnerLink` holds a name and terms, never an address; routing
is the hub's. If the new program can do different things, `caps.update` goes out as it does today (`featuresHash`
travels, so an unchanged set sends nothing).

## 6. Per-install things the company depends on

- Manual links are the hub's: synced on the new install's first sync. The model page shows "link only" until the
  shop downloads again (item 12's job) or copies its `C:\Manuals` folder to the new PC.
- The library stays on the PC. Hosted → PC: nothing to do beyond pointing `libraryDir` at the folder. PC → hosted:
  each tech connects the folder in the browser as INSTALL.md says. `Shop.libraryRoot` travels.
- The cross-reference and the marketplace are the hub's copies; nothing is in the file.
- Figures and machine pictures come with the program or from the hub.

## 7. The old copy

**Decided:** read-only from the export, then deleted by hand after 30 days. Alternatives: delete at once (no way back
if the import fails), or automatic deletion (never on a shop PC).

- From "Prepare the move file": `Shop.movingAt` set; the lapse machinery of `base-license` (`lapse-allow.ts`,
  modules-design 6.4) makes the company read-only with the same allow-list, plus: no partner sends, no hub writes
  (`hubWritesOff`), no booking or online shop. Banner: "This company is being moved. Cancel the move to carry on
  here." Cancel (owner) clears it and deletes the file and the token (`DELETE /v1/shops/{ref}/move-token`).
- Once the hub says moved (5.5): banner "This company moved to <name> on <date>. This copy is read-only; delete it
  after <date + 30 days>." Hosted: the Companies page lists it greyed with a Delete button enabled from that day
  (platform admin, types the company name; a cascade delete of the `Shop`). Windows (one company): the tray item
  "Remove the moved company..." with the same confirmation, or uninstall. Nothing deletes by itself.
- An install never on a hub (or whose token wasn't redeemed) has no 5.5: the owner confirms the import on the old side
  ("The move is done") to get the same banner.

## 8. UI, data, security

- **Settings → Company → "Move this company"** (owner only; on hosted also the platform admin from Companies):
  what the file holds, that it holds everything, what is left out, which modules will need a key, the freeze; then
  a progress card (table, rows, MB) and one Download button. **Windows first run**: `/signup` (with `SETUP_TOKEN`)
  gains "Restore a company from a move file"; the tray's file dialog picks the file and the server reads it from disk
  (no upload, no size limit beyond the disk); progress in the window; then sign in. Also the tray item "Import a
  company..." when `platformAdminEmails` is set. **Hosted Companies page**: "Import a company" uploads in 8 MB chunks
  to `/api/move/upload/{id}/{n}` (the 16 MB body limit stays; the browser shows upload progress and can resume),
  then a progress card.
- **Table** `CompanyMove (id, shopId, direction export|import, status, table, rowsDone, rowsTotal, bytes, filePath,
  error, startedAt, finishedAt, downloadedAt, byUserId)`; `Shop` gains `movingAt`, `movedOutAt`, `movedTo`,
  `movedInAt`, `movedFrom`. Migration `20261003140000_company_move` (after `base-license`'s `20261003130000_hub_accounts`; rename if later).
- The file is written to the program's data directory (Windows) or the server's temp directory (hosted) and deleted
  after the download finishes or 24 hours; the download URL is for the owner's session only, https only (same rule
  as the camera scanner: plain http other than localhost gets the page that says what to open instead).
- The file is the shop: customers, every login's hash (crackable offline), the consent record, the license keys and
  the move token. The UI says so in the words INSTALL.md uses for backups, and INSTALL.md's "Moving a company"
  section repeats it. The move token is hashed at rest on the hub, one use, 14 days.
- Importing runs as the platform admin on hosted (the company's owner has no login there yet) and as the PC's
  operator on Windows. Every row's `shopId` is checked against the header (section 4.5); Json columns go in as the
  program's own shapes, validated no further than the schema (the file came from this program; a forged one fails
  on tenancy, counts and types).

## 9. Packages, in build order, with gates

Each package in its own worktree and database, a check script run with `npm run check <file>` (tenant section where
there are shop rows), a Playwright spec on a test build; each touches only its files.

1. **`move-export`** (this repo). Migration 8; `src/lib/move/format.ts` (the table list in order, encode/decode,
   the left-out fields); `src/lib/move/export.ts` (the job, the freeze, the warnings); `/api/move/download/[id]`;
   Settings → Company section; the hub token call (a no-op against a hub without the route). Check
   `scripts/checks/move-export.check.ts`: a company seeded with a row in every table of section 2 (reuse
   `checks/lib.ts`, `seed-marketing.ts`, `linkPair`) → export → every table's count matches, ids as before, no row of
   company B, sealed fields null, `end` present; the frozen company refuses `createTicket` and allows a payment;
   tenant: B cannot start, read or download A's move. Gate: tsc, eslint, the check, every existing check.
2. **`move-import`** (this repo). `src/lib/move/import.ts` (refusals 1 to 7, the transaction, slug clearing, the
   holds), chunked upload route, Companies import, the Windows first-run choice (`desktop/main.mjs`, `signup`),
   `scripts/move/import.ts`. Check `move-import.check.ts`: export A, delete A, import → `rowsOf()` per table equals
   the pre-export JSON minus the left-out fields; import again → refused (Shop exists); a header edited to a newer
   `lastMigration` → refused; a file with B's email → refused and named; a row with B's `shopId` → refused, nothing
   written; a truncated file → refused. Spec `tests/move.spec.ts` on the two-server setup of `two-servers.spec.ts`:
   export from :3300, import into the second server, sign in there, the ticket list and a photo are the same, the
   source shows the moving banner. Gate: tsc, eslint, both checks, `smoke`, `tenant`, `auth`, `two-servers` specs.
3. **`move-hub`** (hub repo, then this repo). Hub: migration `013_shop_moves.sql`, `/v1/shops/:ref/move-token`
   (POST, DELETE), `/v1/shops/move` (with and without a key), `standing` answering 410 moved, the rewrite of 5.3,
   admin page "Moves" with "Move this shop" by hand, `transfer.mjs` carries `shop_moves`. Check `test/move.mjs`: two
   installs, a partner link, listings, orders, ratings, usage, a note → move → every `install_id` rewritten, the
   token one-use and expiring, a wrong ref refused, the old install told moved, the new install pulls the partner
   backlog from the old cursor once. This repo: the import's hub step, the catch-up pull, 5.5 and section 7's
   banners, Companies delete after 30 days, the tray item, INSTALL.md "Moving a company". Check `move-hub.check.ts`
   against the local test hub (:3200). Spec: `tests/move.spec.ts` grows the partner half: repair shop on server 1,
   retail on server 2, retail moves to server 3, a `job.update` sent after the move reaches server 3 and not server
   2; server 2 shows the moved banner and refuses a sale. Gate: hub `npm test` and `npm run test:db`; this repo's
   `partners`, `hub`, `two-servers`, `smoke` specs; the hub deployed before the program release (new routes only;
   old programs unaffected).

## 10. Open questions, each with the recommended answer

1. **Secrets.** Recommended: left out and entered again (four values, two minutes; the Stripe webhook secret must
   change anyway because the endpoint address changes; and a file that will be emailed about should not carry the
   shop's mail password under a passphrase people pick badly). Alternative: re-sealed under a passphrase typed at
   export and again at import.
2. **How the hub is re-pointed.** Recommended: the move token in the file (section 5), with the admin page as the
   fallback. Alternatives: claim with proof (no proof exists), or by hand only.
3. **Partner shops.** Recommended: told nothing; nothing of theirs changes. Alternative: a `link.moved` message shown
   on their Partners page (information only).
4. **The old copy.** Recommended: read-only from the export, deleted by hand after 30 days. Alternatives: delete at
   once; delete automatically.
5. **Freeze the source during the export.** Recommended: yes, with Cancel. Alternative: snapshot only and accept that
   an afternoon's entries can be lost between export and import.
6. **File format.** Recommended: one gzipped NDJSON file as the hub's. Alternative: a zip of JSON per table.
7. **Login email clashes on the target.** Recommended: refuse and list, and build L7/L31 (emails unique per company)
   when it comes up in practice. Alternative: build L7/L31 first.
8. **Hosted upload.** Recommended: 8 MB chunks with resume. Alternative: one streamed request (Railway's proxy limit
   is unknown; test with a 2 GB file before relying on it).
9. **`ManualDownload` rows.** Recommended: dropped and said. Alternative: carry finished rows as history.
10. **`Listing` and `MarketOrder` copies.** Recommended: not in the file; the hub sends them after the move.
    Alternative: carry them with `shopId` and let the sync overwrite.
11. **Who imports.** Recommended: hosted, the platform admin; Windows, whoever runs the PC at first run (the file is
    the credential). Alternative: an owner login created from the file's `User` rows first, then the owner imports.
12. **Modules switched on by the hosted administrator.** Recommended: warn at export and have the owner issue `k1`
    keys first; `hub-billing` later makes the hub's key cover it. Alternative: the hosted side signs keys at export
    with the hosting key (a key that then leaves the server inside a file).
13. **A Windows program that already has a company.** Recommended: import allowed only when `platformAdminEmails` is
    set, else refused. Alternative: always allowed (two companies on a PC that nobody meant to host).
14. **Token validity.** Recommended: 14 days, one use. Alternative: 48 hours.
15. **Order of work.** Recommended: after `base-license` (its lapse allow-list is what makes the old copy read-only)
    and before `hosted-provisioning`, so a shop started on the hub can later leave. Alternative: before both, with a
    simple "no writes for this shop" switch instead of the allow-list.
