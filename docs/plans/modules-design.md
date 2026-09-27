# StitchBench paid modules: licensing, equipment kinds, Vac Shop, Small Appliance Repair

This is the design for branch `feat/scheduling-messaging` (worktree `/home/user/stitchbench-feat`, base `9ba25a4`). Implementers must follow it, except where a part is marked "suggested". The Scheduling and Marketing features are designed in `design.md`, which is in this folder. This document defines the gating API those features call and lists the gate points they add (section 12). It does not redesign them.

This is revision 2. Three critics reviewed revision 1 (security and licensing, correctness and operations, product fit). The **Review log** at the end lists every point, accepted or rejected, and where it landed.

## Companion files in this folder

- **`modules-schema.prisma`**: the complete `prisma/schema.prisma` after `modules-foundation`. It is formatted (`prisma format` leaves it unchanged) and validated with the worktree's Prisma 7.10.
- **`modules-schema.diff`**: the unified diff of that schema against today's schema (`git show 9ba25a4:prisma/schema.prisma`).
- **`modules-migration.sql`**: the exact SQL for `prisma/migrations/20260926120000_paid_modules/migration.sql`.
  - It is Prisma's output (`prisma migrate diff --from-schema <today> --to-schema modules-schema.prisma --script`) plus one hand-written backfill line.
  - I applied it to `stitchbench_feat` inside a transaction and rolled it back (`scratch/modules-architect/r3/trymig.mjs`). It applies on top of `20260926100000_job_snapshot_at`, and design.md's final `migration.sql` (`20260926150000_scheduling_messaging`, in this folder) then applies on top of it. The two migrations share no table or column names.
  - The same run checked the backfill (storage, rush and diagnosis items become "every kind", the rest sewing), the defaults on existing rows, and the key-merge SQL used by a Windows restore (section 2.4).
- **`modules-license-reference.ts`**: the reference implementation of `src/lib/license.ts`, also printed in Appendix A.
- **`modules-license-check.ts`**: its check, which becomes `scripts/checks/license.check.ts` with the import path changed. Both were type-checked with `tsc --strict` and run with `npx tsx` on Node 22.22.2.
  - The check covers:
    - sign and verify, a key wrapped by an email program, a whole email pasted, and every tamper case;
    - a v2 key and an unknown plan word;
    - retired signing keys, including the leak case;
    - which scopes count where;
    - anchored monthly renewals, trials, and the start and end of a month or year in America/Chicago;
    - on / renew / grace / lapsed, and the monthly 3-day reminder;
    - every sequence of the administrator's switch (off, then a short on; on, then off; off, then "Let keys decide"; two ons; ties);
    - the Windows clock floor;
    - finishing work after a module ends.
  - An earlier survey (`maps`, licensing) confirmed that Ed25519 through `node:crypto` also works in the Windows program's runtime (Electron 44, Node 24, BoringSSL). Passphrase-protected PKCS#8 keys (`aes-256-cbc`) were checked on Node 22 (`scratch/modules-architect/r3/enc.mjs`).

## Build order

1. **`modules-foundation`** goes first and alone. It holds every schema change, the licensing, the gating API, the equipment-kind framework, and every edit to an existing file that more than one module needs.
2. Then two tracks run at the same time. Their files do not overlap.
   - `design.md`'s own `foundation`, alone among the scheduling packages.
   - The modules packages `vac-repair`, `vac-finder`, `vac-sales-warranty` and `appliance-repair`.
3. After `design.md`'s `foundation` lands:
   - `vac-bags-due` and `central-vac-installs` start. They use its message queue and `src/lib/zoned.ts`.
   - They run in parallel with `design.md`'s feature packages. They edit no file those packages own.
4. **`modules-crossover`** runs after every `design.md` feature package, `vac-bags-due` and `central-vac-installs`. It makes sure each cross-module gate point in section 12.4 is in place in the files `design.md`'s packages own, adding any that are missing. Because it runs after their owners, these edits are never concurrent.
5. **`modules-e2e`** goes last.

---

## 0. Scope in one page

**What gets built:**

| Area | What |
|---|---|
| Buying | License keys that the owner signs on his own PC and emails after a sale. The shop pastes the key (or the whole email) in **Settings → Modules**. Keys are verified offline, with the signature checked every time. Every "not on" or "ended" notice carries an "Ask about it" / "Renew" email link with the Company ID filled in. |
| Admin switch | On the hosted app, a platform admin turns a module on, off, or back to "keys decide" for a company from **Companies**, with an optional end date and one-click "Extend 1 month / 1 year". The Windows program ignores the switch. |
| Subscriptions | Every entitlement has a last day. Admins see renewal reminders in the app (yearly: 30 days before; monthly: the last 3 days). A grace period follows the last day. After that the module has **ended**: nothing is deleted, records stay viewable and exportable, work already in can be finished, and new work in that module is blocked. |
| Gating API | One API, `getModules / hasModule / requireModule`, used by pages, actions, route handlers and workers, plus a thin equipment layer for tickets and machines. |
| Equipment kinds | Sewing (the default, unchanged), vacuum, stand mixer, 3D printer (filament), resin 3D printer, "other small appliance", and kinds the shop adds itself (for example espresso machines). Each kind has its own types, brands, accessories, intake questions, checklist, readings, service menu and quick links. |
| Vac Shop | (a) vacuum repair bench; (b) bag/belt/filter finder shared through StitchHub, rung up at the register; (c) vacuums for sale with serial numbers, warranty and warranty registration, trade-ins, and "bags due"; (d) central vac installs on site, shown on the Scheduling calendar when that module is on. |
| Small Appliance Repair | Stand mixers, 3D printers (filament and resin), other appliances, and the shop's own kinds, each with its own intake, checklist, readings, accessories and menu. |

**Not in this build:**
- in-app card checkout;
- any online activation or seat counting;
- revocation lists (only the end date, and the admin's switch on the hosted app, take effect);
- partner take-ins of vacuums or appliances (the StitchShop intake and the partner protocol stay sewing-only);
- factory specs or tension for non-sewing kinds;
- any StitchHub change;
- automatic "bags due" sending (the admin sends the due reminders with one button; section 10.c′);
- changing the built-in kinds' lists, and readings for the shop's own kinds;
- install crews, arrival times and a printed crew sheet;
- a per-kind print layout for the price list;
- new npm dependencies.

**Product rules decided here** (open questions, section 14, lists them again):

- **D1.** A key is bound to the company (`Shop.id`, shown as "Company ID"), not to a PC or to the hub install. The hosted multi-company app shares one install, and a Windows backup restored with the same ids keeps its keys.
- **D2.** The Companies switch writes a key signed on the hosted server with a separate *hosting key*, never the owner's key.
  - A switch row counts only on a server that holds a genuine hosting key itself: one whose public half matches a hosting key compiled into the app.
  - So a shop running its own server, even with `PLATFORM_ADMIN_EMAILS` set, cannot switch modules on through Companies. A copy of the hosted database on another server doesn't carry switched-on modules with it either.
  - The hosted app and the Windows program honour only genuine keys. A shop that builds and runs its own server from the source controls that server (it could edit the code); keys don't try to stop that (section 3.5).
  - The owner's signing key never leaves his PC, and it is stored encrypted with a passphrase.
- **D3.** When a module ends (past grace, or switched off), **new work** in it stops:
  - new check-ins and new machines of its kinds;
  - vacuums received for sale, sold, or taken in trade;
  - new installs;
  - finder look-ups;
  - the shop's own kinds.

  **Work already in** can be finished. A ticket or install opened before the module ended stays fully workable (lines, notes, status, readings, photos, payments) until it reaches Collected, Returned unrepaired or Abandoned. Closing actions (those statuses, payments, ticking returned accessories), returns and voids of earlier vacuum sales, printing and every export always work.
- **D4.** On the Windows program the clock used for modules never counts as earlier than 48 hours before the newest verified key was issued. Setting the PC clock far back doesn't bring an ended key back. Nothing is stored for this, so nothing can lock a paying shop out (section 5.5).
- **D5.** Vacuums for sale are not `Part` rows. Each unit gets one `StockUnit` row, 1:1 with a `Machine`.
- **D6.** The finder uses the existing community cross-reference, with three fixed categories. StitchHub needs no change.
- **D7.** Central vac installs are tickets with `jobType = "SITE"` plus a `TicketSite` row. The installed power unit is the ticket's machine.
- **D8.** "Bags due" messages are a Marketing message kind (`bags_due`, marketing purpose). An admin sends them from the Bags due page, and only when both Vac Shop and Marketing are on. Otherwise "bags due" is a call list.
- **D9.** The admin's "Turn off" ends every key issued before that moment, at that moment, and it keeps doing so until "Let keys decide" is chosen. A later "Turn on" adds its own dates and nothing else. Keys issued after the "off" count as usual.
- **D10.** On the hosted app and the Windows program, no environment variable adds trust. Variables only take it away: `STITCH_DESKTOP` (set by the Windows program itself) and `LICENSE_HOSTED_KEY` (set on the hosted app) both turn development keys off for good. Public keys come only from compiled code. Development keys work only in `next dev`, in check scripts, and in a local test build (section 3.3).

---

## 1. Ground rules for every package

The rules in `design.md` §1 apply unchanged:
- AGENTS.md;
- `safe()` and `UserError`;
- integer cents;
- the Next 16 notes;
- `shopId` on every query;
- reuse of the existing UI classes;
- check scripts run as `npx tsx --conditions=react-server scripts/checks/<name>.check.ts` (or `npm run check <file>` once design.md's foundation has added that script).

**Additions for modules:**

- **Only a verified signature can switch a module on.** A database row can only switch one off (the admin's "off" row on the hosted app). No page, action or worker reads `License` or `ModuleGrant` directly, and no page selects their `key` column. Everything goes through `src/lib/modules.ts`, or `src/lib/equipment/gate.ts` for tickets and machines.
- **Check order in actions:** `requireUser()`/`requireAdmin()` → `requireModule()`/`requireEquipment()` → ownership lookup by `shopId` → input validation → transaction.
- **Tenancy (hosted app):** every lookup and every guarded write of a module row names `shopId`:
  - lookups by id are `findFirst({ where: { id, shopId } })`, never `findUnique({ where: { id } })`;
  - guarded writes are `updateMany({ where: { shopId, id, …state } })` and check `count`;
  - an upsert keyed by a bare id (`VacCare` by `machineId`, `StockUnit` by `machineId`) runs only after `machine.findFirst({ where: { id, shopId } })` has found the machine, and its `create` sets `shopId: user.shopId`;
  - a lookup by serial number is `machine.findFirst({ where: { shopId, equipment, serial: { equals: s, mode: "insensitive" }, modelKey } })`: serials are not unique across companies (or even within one).
- **Action bodies live in lib files.** Every new action is a one-line wrapper: `export const receiveUnit = safe(async (fd: FormData) => receiveUnitFor(await requireAdmin(), fd));`. The body, `receiveUnitFor(user: CurrentUser, …)`, lives in a server lib file of the same package. Page data loaders are lib functions too (`unitDetail(shopId, id)` returns null for another company's id). Check scripts call these with another company's user (section 13.2, tenant checks).
- **Pure files** (no `server-only`, no DB) can be imported by the CLI, check scripts and client components: `src/lib/license.ts`, `src/lib/license-keys.ts`, `src/lib/module-info.ts`, `src/lib/equipment/{types,index,sewing,vacuum,appliances,form,lines}.ts`, `src/lib/vac/types.ts`.
- **Stubs:** foundation creates small stub files (section 13.3) and inserts them where they are used. Ownership then passes to one package. That package replaces the body and keeps the exported names and prop types exactly.
- **Copy:** plain, short, second person, in the app's tone ("Paste the key from your email."). "Module" is the word for what they buy. "What you repair" is the word for equipment kinds in the UI. Techs are never told to do something only an admin can do ("Ask the shop owner to renew it.").

---

## 2. Data model

All of it lands in `modules-foundation`. The exact text is in Appendix B and in `modules-schema.prisma`.

### 2.1 Existing models: fields added, nothing removed or renamed

| Model | Added | Default for existing rows |
|---|---|---|
| `Shop` | `checkInKind String` (the kind `/tickets/new` opens on), `bagReminderDays Int`, `hubWritesOff Boolean` (set by the platform admin); back-relations `licenses, moduleGrants, equipmentKinds, ticketSites, stockUnits, vacCares` | `"sewing"`, `180`, `false` |
| `Machine` | `equipment String` (SEWING / VACUUM / APPLIANCE), `kind String` (kind key), `details Json` (the unit's intake answers); relations `stock StockUnit?`, `vacCare VacCare?`; `@@index([shopId, equipment])` | `"SEWING"`, `"sewing"`, `{}` |
| `Ticket` | `jobType String` (BENCH / SITE), `intake Json` (this visit's answers), `readings Json` (`{ key: { found, left } }`); relation `site TicketSite?` | `"BENCH"`, `{}`, `{}` |
| `ServiceItem` | `equipmentKind String?` (null = offered for every kind) | backfilled by the migration: storage fee, rush and diagnosis items null (every kind), everything else `'sewing'` |
| `SaleLine` | `stockUnitId`, `tradeInUnitId`, `machineId` (plain ids, like `repairJobId`), each indexed | null |

`Machine.machineType` keeps its meaning: the sub-type within the kind (for example "Computerized", "Upright", "Tilt-head"). The word `category` is not reused; six unrelated columns already use it.

### 2.2 New models

| Model | Key | Relations / onDelete | Indexes | Purpose |
|---|---|---|---|---|
| `License` | cuid; `@@unique([shopId, keyId])` | Shop Cascade | - | A pasted key, with who added it (`addedBy` name, `addedById`). Only `key` counts, and it is re-verified on every read. |
| `ModuleGrant` | cuid | Shop Cascade | `[shopId, module, createdAt]` | The admin switch's history: `on` (with a hosting-signed key), `off` or `none`. How the rows combine is `adminPosition` (section 5.1). |
| `ShopEquipmentKind` | cuid; `@@unique([shopId, key])` | Shop Cascade | - | An appliance kind the shop added itself (for example espresso machines). Built-in kinds are never here. |
| `TicketSite` | `ticketId @id` | Ticket Cascade, Shop Cascade | `[shopId, startsAt]` | Where and when a SITE ticket's work happens: address, window, contact, access notes. |
| `StockUnit` | cuid; `machineId @unique` | Shop Cascade; Machine **Restrict** | `[shopId, status]` | One vacuum for sale (or taken in trade), for good. `soldNetCents` caps a return's refund. |
| `VacCare` | `machineId @id` | Machine Cascade, Shop Cascade | `[shopId]` | "Bags due" follow-up per customer vacuum: snooze, stop, last contact. |

**Why these shapes:**
- `StockUnit` keeps brand, model, serial and owner on its `Machine`. A repair intake that finds the serial then shows "Sold here, warranty until …", and a unit traded back in later reuses its row.
- `TicketSite` keeps the bill, payments, status, parts (PART lines plus `StockMove USED`), hours (LABOR lines), the invoice and the sales log on the existing `Ticket`. No money code changes.
- There is no stored clock and no per-vacuum interval: both were cut (Review log).

### 2.3 Migration

- **Folder:** `prisma/migrations/20260926120000_paid_modules/`. The name must sort after every folder present when foundation starts. If it doesn't, use the next free whole hour that is still before `20260926150000`, where design.md's migration sits.
- **File:** `migration.sql` = `modules-migration.sql` verbatim (Appendix C), in this order:
  1. 5 `ALTER TABLE … ADD COLUMN` (Shop, Machine, Ticket, ServiceItem, SaleLine);
  2. 6 `CREATE TABLE`;
  3. the indexes and foreign keys;
  4. one backfill: `UPDATE "ServiceItem" SET "equipmentKind" = CASE WHEN "name" ~* '^(storage fee|rush|diagnosis)' THEN NULL ELSE 'sewing' END;`
- Never edit it after it has been applied anywhere; the Windows program checksums migrations.
- **Existing data is unchanged in meaning:**
  - every machine is SEWING / `sewing`;
  - every ticket is BENCH;
  - every existing menu item is a sewing item, except the storage fee, rush and diagnosis items, which are offered for every kind;
  - no module is on, so nothing new appears.

### 2.4 Seed, new companies, Windows program

- **`src/lib/shops.ts` `createShopWithOwner`:**
  - Starter service items get `equipmentKind` by the same rule as the backfill (`/^(storage fee|rush|diagnosis)/i` → null, else `"sewing"`). The rule is exported from `src/lib/service-menu.ts` as `starterKindFor(name)`, so the migration comment, the seed, new companies and the restore fix-up agree.
  - It refuses an email in `PLATFORM_ADMIN_EMAILS` ("That email is reserved on this StitchBench.") unless `opts.firstOnly` is set (the first company on a new install, behind `SETUP_TOKEN`) or `opts.byPlatformAdmin` is set. `createCompany` (`companies.ts`) and the platform admin's "add company" in `partners.ts:142` pass `byPlatformAdmin: true`. `/signup` passes neither.
- **`prisma/seed.ts`:** the first shop's service items use `starterKindFor` (`seed.ts:162`).
- **`scripts/e2e-setup.ts`:** stays as it is. Its items have `equipmentKind` null, so they show for every kind; the smoke test is unaffected.
- **`desktop/main.mjs`**, env block of `startServer` (`:269-284`): add `STITCH_DESKTOP: "1"`. It comes after `...process.env`, so the PC's own environment cannot change it.
- **`desktop/backup.mjs`:**
  - The new shop tables are backed up and restored with their ids. Keys stay bound to the restored `Shop.id`.
  - **Keys survive a restore.** `restore()` today empties every backed-up table (`TRUNCATE`, `:146`). `License` can't be left out of that `TRUNCATE`: Postgres refuses to truncate `Shop` while another table references it (checked: error 0A000). So restore saves the keys first and merges them back:
    1. Right after `BEGIN` and the version check: ``await client.query(`CREATE TEMP TABLE "_keep_License" ON COMMIT DROP AS SELECT * FROM "License"`)`` (skipped when `License` doesn't exist yet: `here.includes("License")`).
    2. `TRUNCATE` and `COPY` as today.
    3. After the loads, before the fix-ups: ``INSERT INTO "License" SELECT * FROM "_keep_License" WHERE "shopId" IN (SELECT id FROM "Shop") ON CONFLICT DO NOTHING``.

    A key pasted after the backup was made comes back. A backup from before this release keeps the keys the PC has. A key the backup already has is skipped. Keys verify themselves and are bound to their company, so merging them can't add anything that wasn't bought.
  - **Version-gated fix-ups.** `FIXUPS` entries may be `{ before: "<migration folder name>", sql }`. Such an entry runs only when `!manifest.lastMigration || manifest.lastMigration < before`. Plain strings run always, as today. Append:

    ```js
      // 20260926120000_paid_modules: a backup from before modules comes back with every equipmentKind null
      { before: "20260926120000_paid_modules", sql: `UPDATE "ServiceItem" SET "equipmentKind" = CASE WHEN "name" ~* '^(storage fee|rush|diagnosis)' THEN NULL ELSE 'sewing' END` },
    ```

    A backup made after this release is left exactly as it was saved, including a shop whose menu is all "every kind".

### 2.5 Constants

Foundation adds these to `src/lib/constants.ts`; later packages only import them.

```ts
// Central vac installs (Ticket.jobType SITE) use the ticket statuses under these names (like JOB_STATUS_LABEL).
export const SITE_STATUS_ORDER: TicketStatus[] = ["WAITING_CUSTOMER_OK", "AT_SHOP_AWAITING_PICKUP", "WAITING_PARTS", "ON_BENCH", "COLLECTED", "RETURNED_UNREPAIRED"];
export const SITE_STATUS_LABEL: Record<TicketStatus, string> = {
  WAITING_CUSTOMER_OK: "Quote sent", AT_SHOP_AWAITING_PICKUP: "Booked", IN_TRUCK: "Booked", WAITING_PARTS: "Waiting on parts",
  ON_BENCH: "In progress", READY_IN_TRUCK: "In progress", READY_FOR_PICKUP: "In progress", COLLECTED: "Completed",
  ABANDONED: "Cancelled", RETURNED_UNREPAIRED: "Cancelled",
};
/** Statuses that close a ticket: always allowed, even after its module ended (hand the machine back, take payment). */
export const CLOSING_STATUSES: TicketStatus[] = ["COLLECTED", "RETURNED_UNREPAIRED", "ABANDONED"];
export const UNIT_STATUS_LABEL: Record<string, string> = { IN_STOCK: "In stock", SOLD: "Sold", REMOVED: "Off sale" };
export const UNIT_STATUS_TONE: Record<string, "neutral" | "ready" | "done"> = { IN_STOCK: "ready", SOLD: "done", REMOVED: "neutral" };
export const UNIT_CONDITION_LABEL: Record<string, string> = { NEW: "New", OPEN_BOX: "Open box", REFURB: "Refurbished", USED: "Used" };
/** Cross-reference categories the bag / belt / filter finder reads (XPart.category, free text on the hub). */
export const VAC_SUPPLY_CATEGORIES = ["Vacuum bag", "Vacuum belt", "Vacuum filter"] as const;
```

A Booked install with no date shows "Booked · not scheduled" (display only; `startsAt` is null).

`DOC_TYPES` gains `"Firmware"` (after `"Schematic"`), and `DOC_ORDER` in `src/lib/model-info.ts:98` gains it too. The library data and the hub's links already use it.

---

## 3. License keys

### 3.1 Format

```
SB1.<payload>.<signature>
```

- `payload` = base64url of the UTF-8 JSON below.
- `signature` = base64url of the Ed25519 signature of those exact payload bytes (64 bytes, 86 characters).
- A typical key is about 350 characters: fine to email or paste, not meant to be read aloud.
- Pasting: the app removes every space and line break (email programs wrap long lines), then takes the first `SB1.…` key it finds (`extractKey`). So the whole email can be pasted.
- Canonical JSON is not needed; the signature covers the bytes as sent.

### 3.2 Payload

| Field | Meaning | Rule |
|---|---|---|
| `v` | format version | `1`. Checked right after parsing: any other value gives "needs a newer version", never "damaged". |
| `k` | signing key id (kid) | must be in `LICENSE_PUBLIC_KEYS` (section 3.3) |
| `id` | the key's own id, e.g. `H5T75DV6` | 6-20 of `[0-9A-Z]`. The CLI makes 8 Crockford base-32 characters. Shown in Settings and in the owner's sales log. |
| `s` | Company ID the key is for (`Shop.id`) | must equal the company using it |
| `n` | issued-to name | shown only; not checked |
| `m` | modules | non-empty array of strings. This version knows `"vac" \| "appliance" \| "scheduling" \| "marketing"`; unknown names are kept and shown as "needs a newer version of StitchBench". |
| `p` | plan | a short lower-case word: `m` monthly, `y` yearly, `a` administrator switch, `t` trial. Any other word (a plan a newer version knows, e.g. `q`) is accepted and gets a 30-day renewal notice. |
| `f` | first day | `YYYY-MM-DD`; counts from the start of that day in `Shop.timeZone` |
| `u` | last day, inclusive | `YYYY-MM-DD`; counts to the end of that day in `Shop.timeZone`. `2099-12-31` means "no end date" (admin switch only). |
| `g` | grace days after the last day | integer 0-90 (the CLI and the switch default to 14; a trial uses 0) |
| `t` | issued at | ISO instant. On the Windows program the clock never counts as earlier than 48 hours before the newest key's `t` (section 5.5). |

A key bundles several modules with one date range. Different ranges need separate keys.

### 3.3 Signing keys, scopes and rotation

`src/lib/license-keys.ts` (pure) holds the public halves only:

```ts
import type { PublicKeys } from "./license";
// The public halves of StitchBench's signing keys (never the private halves). scripts/license/keygen.ts prints each line.
// any: keys the owner signs and sells (pasted in Settings -> Modules).
// hosted: the hosted app's Companies switch; counts only on a server holding that hosting key (never on the Windows program).
// dev: development and local test builds only (section 3.3); scripts/license/dev-key.json is in the repo on purpose.
// Never delete a line: retire it (section 3.3 of modules-design.md). A deleted kid turns its keys into "needs a newer version".
export const LICENSE_PUBLIC_KEYS: PublicKeys = {
  dev1: { x: "<43-character x printed by keygen --dev>", scope: "dev" },
  // k1: { x: "...", scope: "any" },     <- the owner adds this line from `npm run license:keygen -- --kid k1` before the first release
  // h1: { x: "...", scope: "hosted" },  <- and this one from `npm run license:keygen -- --kid h1 --hosted`
};
```

Public keys come only from the compiled code. They are never read from the environment or the database, because the shop controls both.

**Where each scope counts** (`acceptScope` in `license.ts`, called only by `verifyFor` in `modules.ts`):

| Scope | Pasted key (`License`) | Admin switch (`ModuleGrant.key`) |
|---|---|---|
| `any` | yes | no |
| `hosted` | no: `activateLicense` refuses it ("That key is for the hosted StitchBench's own use. Ask for a key to paste.") | yes, but only when `hostedSigner()` returns a hosted-scope signer, i.e. this server holds a genuine hosting key (never on the Windows program) |
| `dev` | only when `devKeysAllowed()` | only when `devKeysAllowed()` |

`devKeysAllowed()` is defined as:

```ts
export const devKeysAllowed = () => {
  // The Windows program, and any server holding a hosting key (the hosted app): never.
  if (process.env.STITCH_DESKTOP === "1" || process.env.LICENSE_HOSTED_KEY) return false;
  // next dev and check scripts.
  if (process.env.NODE_ENV !== "production") return true;
  // A test build (STITCH_TEST_BUILD=1 at build time, inlined by next.config.ts), run against a database on this machine.
  return process.env.STITCH_TEST_BUILD === "1" && localDatabase();
};
// localDatabase(): the host of DATABASE_URL is localhost, 127.0.0.1 or ::1.
```

- **Built servers.** `next build` writes `process.env.NODE_ENV` into the bundle as `"production"` whatever the build environment says (`node_modules/next/dist/build/define-env.js:77`). A built server therefore needs the explicit test switch.
- **The test switch is fixed when the app is built.** `next.config.ts` gains `env: { STITCH_TEST_BUILD: process.env.STITCH_TEST_BUILD === "1" ? "1" : "" }`, so a normal build can't be put into test mode at run time. design.md's §16.3 test servers (`STITCH_TEST_BUILD=1 npm run build`, then `next start` against a local database) work unchanged.
- **Even a test build is inert where it matters.** It accepts development keys only with no `LICENSE_HOSTED_KEY`, against a database on this machine, and not on the Windows program. The hosted app always has `LICENSE_HOSTED_KEY` (rollout step 3 is required there) and its database isn't on localhost. So a test variable that reaches a Railway build by mistake (Railway passes service variables to builds) changes nothing there.
- **It is loud.** When it is on in a production build, the server logs `TEST BUILD: development license keys are accepted` the first time, and Settings → Modules shows every admin the pill "Test build: test keys work here".
- `modules-foundation` doesn't add it to `.env.example`; INSTALL.md's testing notes describe it (design.md §16.1 lists it with its own test variables).
- `next dev` and check scripts (`tsx`, `NODE_ENV` unset) accept development keys too.

**Retiring a signing key.** Kids are never deleted. A retired entry keeps its public key and gains `retired`:

```ts
k1: { x: "...", scope: "any", retired: { lastDay: "2027-09-30", allow: ["3f9c2a7e1b0d4c55", /* … */] } },
```

- `lastDay`: a key from that kid whose last day (`u`) is later is refused: "This key was replaced. Ask StitchBench for a new key."
- `allow` (optional, after a leak): only keys whose payload hash (first 16 hex characters of SHA-256 of the payload part) is listed still count. Forged keys fail even when they are backdated. `issue.ts --retire-list k1` prints the whole `retired` entry from the sales log.

**Normal rotation** (new PC, or a new key every few years):
1. Run keygen for `k2` and add its line in a release.
2. Keep signing with `k1` for about 12 months, until offline Windows installs have updated.
3. Then sign with `k2`, and retire `k1` with `lastDay` = the latest last day `k1` signed (from the sales log).

**If the owner's private key leaks:**
1. Release with `k2` added and `k1` retired with `lastDay` and `allow` from `issue.ts --retire-list k1`. Customers' current keys keep working to their end dates, and forged keys fail.
2. Issue `k2` keys at each renewal. A PC that hasn't updated yet sees "needs a newer version" on a `k2` key, which tells the shop what to do.

**Hosting key rotation** (or a leak of it):
1. Release with `h2` added (keep `h1`).
2. Set the Railway variables `LICENSE_HOSTED_KEY` and `LICENSE_HOSTED_KID=h2`. Rows signed with `h1` keep counting, because the server still holds a genuine hosting key.
3. Run `railway run npx tsx --conditions=react-server scripts/license/resign-grants.ts`. It re-signs the newest "on" row of every company and module with `h2`, keeping the last day, grace and modules, with the note "re-signed h1→h2" and `byEmail` "system". It is idempotent.
4. In a later release, retire `h1` with `lastDay` = that day.

### 3.4 Verification

`verifyLicense(text, keys)` is in `src/lib/license.ts`; Appendix A has the exact code. In order, it:
1. matches `/^SB1\.([A-Za-z0-9_-]{20,3000})\.([A-Za-z0-9_-]{86})$/` on the whitespace-free text;
2. parses the JSON;
3. checks `v` (not 1 → "needs a newer version");
4. looks up the kid with `Object.hasOwn` (missing → "needs a newer version");
5. runs `crypto.verify(null, payloadBytes, publicKeyFromJwk({kty:"OKP",crv:"Ed25519",x}), sig)`;
6. checks the payload's shape;
7. applies `retired` (→ "This key was replaced. Ask StitchBench for a new key.").

It returns `{ ok: true, payload, scope, kid } | { ok: false, reason }`. The reasons are shown as they are:
- "That doesn't look like a StitchBench license key. Copy the whole key: it starts with SB1."
- "That key is damaged or was changed. Copy the whole key again from the email."
- "This key needs a newer version of StitchBench. Update the program, then paste it again."
- "This key was replaced. Ask StitchBench for a new key."

**On every check.** `src/lib/modules.ts` verifies every stored key string each time it works out a company's modules. It never trusts a stored "enabled" flag, and none exists. Verification is a pure function of the key text and the compiled public keys. It is memoised per process in a `Map` keyed by the exact text (capped at 1000 entries), which is equivalent to verifying again.

**One path.** In the app, `verifyFor(text, use: "pasted" | "grant")` in `modules.ts` is the only caller of `verifyLicense`. It runs the memoised verification, then `acceptScope(scope, use, { devAllowed: devKeysAllowed(), hostedHeld: hostedSigner()?.scope === "hosted" })`. `activateLicense` and `loadModules` both use it, so the scope rules live in one place. The CLI and `scripts/checks/license.check.ts` call `verifyLicense` directly.

### 3.5 What a key does not do

A key has no install or PC binding, no activation counting and no revocation. A copy of the whole company database (same `Shop.id`) keeps its pasted keys; nothing can detect that offline. The key is a deterrent, not DRM. The Settings page and the licensed name make a copied database obvious.

On the Windows program, anyone who can edit the embedded Postgres can also edit the shipped JavaScript. A shop that runs its own server from the source can edit the code, run `next dev`, or make a local test build. This design doesn't try to stop that. It stops copying a key to another company, editing a key, forging one, and using test keys on the hosted app or the Windows program.

---

## 4. The owner's tools (CLI) and rollout

The CLI files are `scripts/license/keygen.ts`, `issue.ts`, `dev.ts` and `resign-grants.ts`, plus `scripts/license/cli.ts` (shared helpers: `~` expansion, the passphrase prompt, the sales log). Each starts with a usage comment and imports `../../src/lib/license` (which is pure). Only `dev.ts --grant` and `resign-grants.ts` need the database.

`package.json` gains two scripts:
- `"license": "tsx scripts/license/issue.ts"`;
- `"license:keygen": "tsx scripts/license/keygen.ts"`.

**Paths.** Every default path is `path.join(os.homedir(), ".stitchbench", …)`. A path argument starting with `~` is expanded in code, because cmd.exe and PowerShell don't expand it. The owner's PC is Windows.

**Passphrase.** The owner's signing key is encrypted.
- It is read from `STITCH_LICENSE_PASSPHRASE` when that is set, otherwise asked for with the input not echoed (`process.stdin.setRawMode(true)`, reading until Enter, printing nothing).
- keygen asks twice and refuses a mismatch or fewer than 10 characters.

### keygen (`npm run license:keygen -- …`)

```bash
npm run license:keygen -- --kid k1             # the owner's signing key -> ~/.stitchbench/license-k1.pem (encrypted)
npm run license:keygen -- --kid h1 --hosted    # the hosting key for the Companies switch (not encrypted: it goes into Railway)
npm run license:keygen -- --dev                # the development key: scripts/license/dev-key.json (committed)
```

- The owner's key uses `crypto.generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase } })` and is written with mode `0600` (a no-op on Windows; the encryption is what protects it).
- The hosting key and the development key are written unencrypted (`type: "pkcs8", format: "pem"`). The hosting key is meant to live only in Railway's variables; after copying the printed value the owner can delete the file.
- It refuses to overwrite a file: "… already exists: keep it, or pick another --out".
- It refuses an `--out` inside the repo, found with `git rev-parse --show-toplevel` or `process.cwd()`: "Keep the private key outside the repo, e.g. ~/.stitchbench/". The `--dev` key is the exception.
- It prints the line to paste into `src/lib/license-keys.ts` (`k1: { x: "…", scope: "any" },`).
- For `--hosted` it also prints the one-line value for `LICENSE_HOSTED_KEY`: base64 of the PEM.
- It ends with: "Back up the .pem file, and keep the passphrase somewhere else (a password manager). Anyone with both can make keys."
- `.gitignore` already ignores `*.pem`. Add `/scripts/license/*.pem`, and do not ignore `dev-key.json`.

### issue (`npm run license -- …`)

**With no arguments it asks, step by step:**
1. "Company ID, or paste the shop's email": a pasted email is searched for `Company ID: <id>` and `Company: <name>`.
2. "Name on the key" (default: the company name found, or the last name used for that Company ID in the log).
3. "Modules": a numbered list from `MODULES` labels; the owner types `1,2`.
4. "Monthly, yearly or trial".
5. "Start date" (default today; `YYYY-MM-DD`).
6. "Customer's email (for your log)" and "Note (invoice #)", both optional.

It then shows a summary and asks "Make this key? (y/n)".

**Flags (for scripting and repeats):**

```bash
npm run license -- --shop <Company ID> --name "Sew & Vac of Springfield" --modules vac,appliance --plan yearly \
  --from 2026-10-01 [--until 2027-09-30] [--grace 14] [--email owner@shop.com] [--note "Invoice 1042"] [--key <pem>] [--log <csv>]
npm run license -- --trial --shop <Company ID> --modules vac        # 14 days from today, grace 0
npm run license -- --renew <keyId or Company ID>   # the next period of that customer's latest key: from = its until + 1, same name, modules, plan, anchor
npm run license -- --renew-due 7                    # --renew for every log row whose last day is within 7 days and has no later key
npm run license -- --resend <keyId>                 # prints that key and its email again, from the log
npm run license -- --due 30                         # rows whose last day is within 30 days and have no later key; each line ends with its --renew command
npm run license -- --check <key>                    # decode, verify against src/lib/license-keys.ts, print everything
npm run license -- --retire-list k1                 # prints the retired entry for k1 (lastDay and allow) from the log
```

**Rules:**
- `--key` defaults to the newest `~/.stitchbench/license-*.pem` whose kid is in `LICENSE_PUBLIC_KEYS` and not retired. The kid is the file name's `license-<kid>.pem` part. Signing with a retired kid is refused: "k1 is retired. Use your newer key."
- `--until` defaults to `planLastDay(from, plan, anchorDay)`: the day before the next period starts, where monthly and yearly periods start on the **anchor day** (the day of the month of the customer's first key, clamped to short months; `--renew` carries it). So Jan 31 → Feb 27, then Feb 28 → Mar 30, then Mar 31 → Apr 29: renewals don't drift. A trial is 14 days.
- It validates everything with the same rules as `verifyLicense`.
- It signs with `newKeyId()`, then verifies the result against the compiled `LICENSE_PUBLIC_KEYS`.
  - A kid missing from the compiled keys prints a warning: "No released StitchBench knows kid k1 yet: add its line to src/lib/license-keys.ts and release first."
  - A public key that doesn't match exits non-zero.
- **Sales log** (`$STITCH_LICENSE_LOG` or `~/.stitchbench/licenses.csv`), one row per key: `issued, keyId, companyId, name, email, modules, plan, from, until, grace, anchor, note, key`. The key text is kept so `--resend` works; it isn't secret (it is bound to that company and emailed anyway).
- It prints the key, and writes `~/.stitchbench/keys/{yyyy-mm-dd}-{keyId}-{name-slug}.txt` holding the ready-to-send email:

  > Subject: Your StitchBench key: {Vac Shop and Small Appliance Repair}
  >
  > Here is your StitchBench key for {Vac Shop and Small Appliance Repair}, good through {Sep 30, 2027}. It is for {Sew & Vac of Springfield} (Company ID {id}).
  >
  > In StitchBench, go to Settings → Modules, paste the key (or this whole email) in the box and press Add key. It works without the internet.
  >
  > {key}

  Module names come from `MODULES[id].label` and dates from `fmtYmd`.

### dev.ts (for check scripts and tests)

It exports:
- `devLicenseKey({ shopId, modules, from?, until?, grace?, plan?, issuedAt? }): string`, signed with `dev-key.json`;
- `grantDevLicense(shopId, modules, opts?)`, which inserts a `License` row through Prisma and returns the key.

design.md's `scripts/checks/lib.ts` `checkShop({ modules })` uses `grantDevLicense`.

When run directly, `npx tsx --conditions=react-server scripts/license/dev.ts --grant <Company ID> --modules vac --from 2025-08-01 --until 2026-09-06 [--grace 14]` inserts such a row. It bypasses `activateLicense`, which refuses keys that have already ended, so Playwright specs can set up an ended key or a key in its grace period. Dev keys count only where `devKeysAllowed()` is true.

### Rollout checklist (in `INSTALL.md`, new section "Paid modules"; foundation writes it)

1. **Sales contact.** Fill `MODULE_SALES.email` (and `url`, if there's a pricing page) in `src/lib/module-info.ts`. With it empty, the app shows no "Ask about it" link, only "Ask StitchBench about it."
2. **Owner key.** The owner runs `npm run license:keygen -- --kid k1` on his PC, commits the printed `k1` line and releases (Railway plus new installers). Until then no pasted key works anywhere except on a development server.
3. **Hosting key** (required on the hosted app before modules are released there: it runs the Companies switch, and its presence turns test keys off). The owner runs `npm run license:keygen -- --kid h1 --hosted`, commits the `h1` line, and sets two Railway variables: `LICENSE_HOSTED_KEY` (the printed base64) and `LICENSE_HOSTED_KID=h1`.
   - The first time a server process needs the hosting key, it logs one line if the key doesn't match the compiled `h1`: "LICENSE_HOSTED_KEY doesn't match kid h1 in license-keys.ts: the Companies switch can't turn modules on." It keeps running either way.
4. **Selling a module.** The shop presses "Ask about Vac Shop" in Settings → Modules, which emails the owner with the Company ID filled in. The owner pastes that email into `npm run license`, then sends the email file it writes.
5. **Self-hosted shops** (their own Railway project, or the Windows program) use pasted keys only. Their Companies screen explains this (section 8).

---

## 5. Entitlements

### 5.1 Sources

A module's entitlement comes from windows. A window is one module on one verified key, from `f` to `u` plus `g` days of grace, worked out in `Shop.timeZone` with `windows(payload, tz, source)`.

- **Pasted keys.** Each `License` row whose key passes `verifyFor(key, "pasted")` and whose `s` equals the company gives one window per module.
- **Admin switch** (not on the Windows program). The company's `ModuleGrant` rows for the module go through `adminPosition(rows)` (Appendix A):
  - Rows are sorted by `createdAt` desc, then `id` desc. Only rows newer than the newest `none` ("Let keys decide") count.
  - **`onKey`:** the newest `on` row among them. Its key adds a window when it passes `verifyFor(key, "grant")`, its `s` is the company and its `m` includes the module. A newer `on` replaces an older one, so the admin can shorten as well as extend.
  - **`offAt`:** the newest `off` row among them, **whatever `on` rows came after it**. It ends every window of a key issued at or before it (D9). A later `on` only adds its own window.
  - **`hadAny`:** any row at all. A company the admin ever switched that has no window now is `lapsed`, not `off`, so its records stay reachable (`resolveStatus`).

  On the Windows program the table is not read.

### 5.2 Status of one module at the effective time `now`

This is `resolveStatus(windows, now, adminPosition)` → `statusAt` in Appendix A.

| Status | When | New work | Work already in | Nav | Module pages | Other signals |
|---|---|---|---|---|---|---|
| `off` | no window has started (never bought, only a future key, or a key that doesn't verify) | no | closing only | hidden | notice only, unless the page has records, then read-only (section 6.4) | Settings: "Not on" or "Starts Oct 1" |
| `on` | inside a window, not near its end | yes | yes | shown | full | - |
| `renew` | inside a window with ≤ `renewNoticeDays(plan)` left (monthly 3, yearly 30, admin 14, trial 3, any other plan 30), no later window already covering the end, not `2099-12-31` | yes | yes | shown | full | admins: sidebar pill "Vac Shop ends Sep 30" |
| `grace` | past the last day, inside grace | yes | yes | shown | full, with the banner | everyone: banner "Vac Shop ended on Sep 30. It keeps working until Oct 14." |
| `lapsed` | a window existed and every one is past its grace; or the admin switched it off; or the admin switched it once and no window is left | no | tickets and installs opened before `endedAt`, until they close | shown with a lock | read-only, finishing allowed | Settings: "Ended Sep 30, 2027", or "Switched off Sep 30, 2027" |

**Admin "off".** Every window of a key issued (`t`) at or before `offAt` ends at `offAt`, with no grace. Keys issued later are not affected.

**`endedAt`** (lapsed only) is the moment new work stopped. It decides which tickets can still be finished (section 6.3). It is the later of:
- the best window's end of grace (cut to the admin's `offAt` when switched off);
- the time the admin last changed the switch. "Let keys decide" after an admin "on" ends the module at that moment, so tickets opened under the admin's window can be finished.

### 5.3 ModuleState

This lives in `src/lib/module-info.ts` (pure).

```ts
export const MODULE_IDS = ["vac", "appliance", "scheduling", "marketing"] as const;   // re-exported from license.ts
export type ModuleId = (typeof MODULE_IDS)[number];
export type ModuleStatus = "off" | "on" | "renew" | "grace" | "lapsed";
export type ModuleState = {
  id: ModuleId;
  label: string;                 // "Vac Shop"
  status: ModuleStatus;
  active: boolean;               // on | renew | grace: new work allowed
  lastDay: string | null;        // "2027-09-30" of the best window (the admin's off day when switched off)
  graceLastDay: string | null;   // "2027-10-14"
  startsOn: string | null;       // a later key that hasn't started: "2026-10-01"
  endedAt: Date | null;          // lapsed: when new work stopped (section 5.2)
  plan: string | null;           // m | y | a | t | a newer plan word
  source: "key" | "admin" | null;
  keyId: string | null;
  switchedOff: boolean;          // lapsed because of the admin's "off"
};
export type KeyView = {
  rowId: string; keyId: string; modules: string[]; plan: string | null; from: string | null; lastDay: string | null;
  graceLastDay: string | null; issuedTo: string | null; addedBy: string | null; addedAt: Date;
  state: "current" | "future" | "ended" | "not-valid" | "other-company"; reason: string | null;
};
export type Modules = { shopId: string; now: Date; clockBehind: boolean; floor: Date | null; states: Record<ModuleId, ModuleState>; keys: KeyView[]; testBuild: boolean };
// testBuild: devKeysAllowed() in a production build (section 3.3), for the Settings pill
export const MODULES: Record<ModuleId, { label: string; blurb: string; href: string }> = {
  vac: { label: "Vac Shop", href: "/vac", blurb: "Vacuum repairs, a bag, belt and filter finder, vacuums for sale with warranties and trade-ins, bags-due reminders and central vac installs." },
  appliance: { label: "Small Appliance Repair", href: "/tickets/new?kind=stand-mixer", blurb: "Repair tickets for stand mixers, 3D printers and other small appliances, each with its own check-in questions, checklist and service menu." },
  scheduling: { label: "Scheduling", href: "/calendar", blurb: "Classes and workshops, appointments, repair pickup runs with partner shops, and staff shifts." },
  marketing: { label: "Marketing", href: "/messages", blurb: "Email and texts: reminders, ready-for-pickup notices, estimate links, service reminders, review requests and campaigns." },
};
/** Who sells modules. The owner fills these in before the first release (INSTALL.md, "Paid modules"). */
export const MODULE_SALES = { email: "", url: "" };
/** mailto: link for "Ask about {label}" / "Renew {label}", or null while MODULE_SALES.email is empty. */
export function salesMailto(kind: "ask" | "renew", label: string, shop: { id: string; name: string }): string | null;
// subject `StitchBench ${label} for ${shop.name}`; body `Company ID: ${id}\nCompany: ${name}\nModule: ${label}\nMonthly or yearly: \n`
// (both encodeURIComponent'd; kind "renew" starts the body with "Please send my renewal key.\n\n")
export type NavGate = "on" | "readonly" | "hidden";
export function toNavGates(m: Modules): Record<ModuleId, NavGate>;   // active -> on, lapsed -> readonly, off -> hidden (pure)
export const SETTINGS_MODULES_HREF = "/settings/modules";
export const MODULE_SALES_NOTE = "Modules are sold by StitchBench, monthly or yearly. After you pay, you get a key by email. Paste it here. It works without the internet.";
export function canWrite(status: ModuleStatus): boolean;             // on | renew | grace
export function blockedMessage(s: ModuleState, admin: boolean): string;   // section 6.6
export function pageGate(s: ModuleState, hasRecords = false): "write" | "read" | "none";
// write when canWrite; read when lapsed, or off with records; none when off without records
export function planLabel(plan: string | null): string;              // m "monthly", y "yearly", a "switched on by StitchBench", t "trial", other: the word
export function fmtYmd(ymd: string): string;                          // "2027-09-30" -> "Sep 30, 2027" (no time zone involved)
```

### 5.4 Renewal reminders (in the app)

- **renew:** admins see a quiet sidebar pill under the nav, "{label} ends {Sep 30}", linking to Settings → Modules. What Settings says depends on the plan:
  - yearly: "Ends Sep 30 (in 12 days)." and a **Renew Vac Shop** email link;
  - monthly: "Your next key comes by email after your monthly payment. Nothing to do until it arrives.";
  - admin switch: "Turned on by StitchBench until Sep 30.";
  - trial: "Your trial ends Sep 30." and an **Ask about Vac Shop** email link.
- **grace:** everyone sees the grace banner at the top of every page (section 6.6). Admins get "Paste your renewal key in Settings → Modules." and the **Renew** link; techs get "Let the shop owner know."
- **lapsed:** there is no global banner, so the app doesn't nag forever. Module pages and read-only tickets say it.
- The owner's side: `npm run license -- --due 30` and `--renew-due 7`; on the hosted app, the Modules column and the "Extend" buttons on Companies (section 8).

### 5.5 The Windows clock floor

- **Effective time:** `effectiveNow(real, issuedAts, isDesktop())` (Appendix A).
  - On the Windows program: `floor = (newest t among the company's verified keys) − 48 h`, and `now = max(real, floor)`. The 48 hours absorb the owner's own PC clock being a little fast.
  - On every other install: `now = real`, and there is no floor.
- **`clockBehind`** is true when `floor − real > 24 h`. Settings → Modules then shows: "This computer's clock says {date}, but your newest key was made on {t date}. Modules count from {floor date}. Check the date and time on this computer."
- **Nothing is stored.** Deleting a key, restoring a backup, or a clock that was once wrong can't move the floor. Only the keys themselves set it, and a new key never makes it later than its own issue time − 48 h. A shop can gain time by setting its PC clock back within a key's dates. That mis-dates every sale it rings up, and it is accepted (section 3.5).
- **Tests:** check scripts pass `loadModules(shopId, { now })`. With an explicit `now` the floor is not applied.

---

## 6. The gating API

### 6.1 `src/lib/modules.ts` (server: `import "server-only"`)

```ts
export const isDesktop: () => boolean;                 // STITCH_DESKTOP === "1"
export const devKeysAllowed: () => boolean;            // section 3.3
/** The only caller of verifyLicense in the app: memoised verification, then acceptScope for this use (section 3.4). */
export function verifyFor(text: string, use: "pasted" | "grant"): Verified;
export async function loadModules(shopId: string, opts?: { now?: Date }): Promise<Modules>;          // = (await loadModulesMany([shopId], opts)).get(shopId)
export async function loadModulesMany(shopIds: string[], opts?: { now?: Date }): Promise<Map<string, Modules>>;
export const getModules: (shopId: string) => Promise<Modules>;  // React cache() per request (calls through outside one)
export async function moduleState(shopId: string, id: ModuleId): Promise<ModuleState>;
export async function hasModule(shopId: string, id: ModuleId): Promise<boolean>;             // canWrite(status)
export type Who = string | { shopId: string; role?: "OWNER" | "ADMIN" | "TECH" };            // a shopId, or the CurrentUser
/** Throws UserError(blockedMessage(state, role !== "TECH")) unless new work is allowed. */
export async function requireModule(who: Who, id: ModuleId): Promise<ModuleState>;
export async function navGates(shopId: string): Promise<Record<ModuleId, NavGate>>;  // toNavGates(await getModules(shopId))
/** Route handlers: a 403 Response with the blocked message, or null to go on. */
export async function moduleResponse(shopId: string, id: ModuleId, admin?: boolean): Promise<Response | null>;
/** Workers: the shops (all on the install, or the given ones) where the module is active now. */
export async function shopsWithModule(id: ModuleId, shopIds?: string[]): Promise<string[]>;
/** Companies page: the newest switch rows with their decoded last day (never the key text). */
export async function grantHistory(limit: number): Promise<{ at: Date; shopId: string; module: string; mode: string; lastDay: string | null; byEmail: string; note: string | null }[]>;
```

**`loadModulesMany` algorithm:**

1. In one `Promise.all`, three queries for all the given companies:
   - `shop.findMany({ where: { id: { in } }, select: { id, timeZone } })`;
   - `license.findMany({ where: { shopId: { in } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })`;
   - `moduleGrant.findMany({ where: { shopId: { in } } })` (skipped when `isDesktop()`).
2. Per company:
   - verify each key with `verifyFor(key, "pasted")`;
   - keep a key when it verifies and `payload.s === shopId`; the rest become `KeyView`s with `state` "not-valid" (with the reason) or "other-company".
3. Work out `now` with `effectiveNow` (section 5.5), unless `opts.now` is given.
4. For each module id:
   - group the grant rows and run `adminPosition`;
   - build the windows (section 5.1);
   - run `resolveStatus`;
   - map the result to a `ModuleState`.
5. Return the map.

`shopsWithModule(id)` with no ids reads every shop id, then runs `loadModulesMany` in chunks of 500.

That is 3 small queries per call whatever the number of companies, plus one Ed25519 verification per new key text; memoised verifications are free. There is no cross-request cache: hosted runs several server processes, and a switch must show on all of them at once.

### 6.2 `src/lib/license-signing.ts` (server)

The file's first line is `import "server-only"`.

```ts
export function hostedSigner(): { kid: string; key: KeyObject; scope: "hosted" | "dev" } | null;
// isDesktop() -> null.
// LICENSE_HOSTED_KEY (base64 of a PKCS#8 PEM; a raw PEM with "\n" escapes also accepted) with LICENSE_HOSTED_KID
// (default "h1"): used only when LICENSE_PUBLIC_KEYS[kid] exists with scope "hosted", isn't retired, and its x equals
// the public half of that private key (createPublicKey(key).export({ format: "jwk" }).x). Otherwise null, and one
// console.error per process: "LICENSE_HOSTED_KEY doesn't match kid {kid} in license-keys.ts: ...".
// Else, when devKeysAllowed(): scripts/license/dev-key.json read with fs from process.cwd() (kid dev1, scope "dev").
// Else null. Memoised per process, keyed by the two variables' values.
export function signGrant(a: { shopId: string; shopName: string; module: ModuleId; lastDay: string; graceDays: number; timeZone: string }): string;
// payload { v:1, k, id: newKeyId(), s, n, m:[module], p:"a", f: today in timeZone, u: lastDay, g, t: now ISO }
```

**Rule:** `src/actions/companies.ts` imports `signGrant` but never exports or re-exports it. No `"use server"` file exports anything from `license-signing.ts`: every export of a `"use server"` file is a public endpoint, and an exported `signGrant` would sign keys for anyone.

### 6.3 Equipment gate (`src/lib/equipment/gate.ts`, server)

Tickets, machines and photos belong to a module through `Machine.equipment`: VACUUM belongs to vac and APPLIANCE to appliance. SEWING is free.

```ts
export type TicketGate = { intakeAt: Date; status: TicketStatus };
export async function equipmentState(shopId: string, equipment: string): Promise<ModuleState | null>;  // null = free (sewing)
/**
 * No ticket: may new work start (sewing, or the module active)? With a ticket: also true when the module has ended
 * (lapsed, endedAt set), the ticket was opened before endedAt, and it isn't in CLOSING_STATUSES. (license.ts workable)
 */
export async function canWorkOn(shopId: string, equipment: string, ticket?: TicketGate | null): Promise<boolean>;
/** UserError(blockedMessage) unless canWorkOn. `closing` adds the "you can still close it out" hint. */
export async function requireEquipment(who: Who, equipment: string, o?: { ticket?: TicketGate | null; closing?: boolean }): Promise<void>;
/** The ticket by { id, shopId } (intakeAt, status, machine.equipment), then canWorkOn with it. False when not found. */
export async function ticketWorkable(shopId: string, ticketId: string): Promise<boolean>;
/** Machine-level edits and photos without a ticket: canWorkOn(equipment), or an open ticket of this machine that is workable. */
export async function machineWorkable(shopId: string, machineId: string): Promise<boolean>;
```

- An unknown `equipment` value (a record written by a newer version) is read-only. `canWorkOn` returns false, and `requireEquipment` throws "This record was made by a newer version of StitchBench. Update the program to change it."
- The message is `blockedMessage(state, admin)`. With `closing`, it adds " You can still mark it picked up, take payment and tick off what went back."
- design.md calls `canWorkOn(shopId, equipment)` with two arguments (service due). That means "may new work start", which is what it needs.

### 6.4 What happens when a module is off or has ended (every surface)

| Surface | `off` (never on) | `on` / `renew` | `grace` | `lapsed` (ended or switched off) |
|---|---|---|---|---|
| Nav item (`/vac` for Vac Shop; design.md's items for S and M) | hidden | shown | shown | shown with a `Lock` icon (size 12, `title="Read only"`) |
| Module page | `ModuleNotice` only; read-only instead if the page's own query found records | full | full, with the banner | read-only: records shown, forms for new work hidden, `ModuleNotice` on top |
| Kinds offered at check-in, on `/machines` and in the kind chips | not offered | offered | offered | not offered (existing records still filter and show) |
| New work: check-in, new machine, a kind change into it, unit received / sold / traded in, new install, finder, shop kinds | `UserError` | ok | ok | `UserError` |
| A ticket or install opened before `endedAt` and not closed | closing only (`off` has no `endedAt`, e.g. a key that stopped verifying) | full | full | **full**: lines, notes, status, checklist, readings, intake, photos, estimate links (D3) |
| Any other ticket or machine of that equipment | closing only | full | full | closing only |
| Closing actions: Collected / Returned unrepaired / Abandoned, payments, returned accessories | allowed | ok | ok | allowed |
| Returns and voids of earlier vacuum sales | allowed | ok | ok | allowed |
| Route handlers (`POST /api/photos`) | 403 with the message unless the ticket or machine is workable | ok | ok | same rule as tickets |
| CSV exports (`/api/export/*`, `/api/sales`) | always (TECH 403 as today) | always | always | always |
| Workers (design.md's message worker and schedulers) | shop skipped | run | run | shop skipped |
| Calendar feed of installs (`siteJobsBetween`) | nothing | items | items | items (read-only view of records) |
| Layout | nothing | renew pill for admins | banner for everyone | nothing global |

`hasModule` is true in `grace`, so grace is fully working.

### 6.5 Patterns (copy these)

**Page:**

```tsx
const user = await requireUser();
const st = (await getModules(user.shopId)).states.vac;
const units = await listUnits(user.shopId, tab, q);              // a lib loader, scoped by shopId
const gate = pageGate(st, units.length > 0);
if (gate === "none") return <ModuleNotice state={st} admin={user.role !== "TECH"} shop={shop} />;
const readOnly = gate === "read";
// render; {readOnly && <ModuleNotice state={st} what="Your vacuums for sale" … />}; forms for new work only when !readOnly
```

**Action** (the body in a lib file, section 1):

```ts
// src/actions/vac-units.ts
export const receiveUnit = safe(async (fd: FormData) => receiveUnitFor(await requireAdmin(), fd));
// src/lib/vac/units.ts
export async function receiveUnitFor(user: CurrentUser, fd: FormData) {
  await requireModule(user, "vac");
  ...
}
```

**Guarded write:**

```ts
const done = await tx.stockUnit.updateMany({ where: { shopId, id, status: "IN_STOCK" }, data: { … } });
if (!done.count) throw new UserError(`${desc} was just sold. Take it off this sale.`);
```

**Route handler:**

```ts
const blocked = await moduleResponse(user.shopId, "vac", user.role !== "TECH"); if (blocked) return blocked;
```

**Worker:**

```ts
for (const shopId of await shopsWithModule("vac", ids)) { ... }
```

Workers never throw because of a module; they skip.

**Partner sync** (`newJobFromPartner` and design.md's `pickup.*`): never gated, never throws. A partner's records are always kept.

### 6.6 UI components and copy

**`src/components/module-notice.tsx`** (server) exports:
- `ModuleNotice({ state, what?, admin?, shop })` renders a `card card-pad text-sm`, or null when active. `shop` is `{ id, name }`, for the email link:
  - **off:** "{label} isn't turned on for this company. {blurb}", then for admins "To add it, see Settings → Modules." and an **Ask about {label}** link (`salesMailto("ask", …)`), for techs "Ask the shop owner about it."
  - **off with `startsOn`:** "{label} starts on {date}."
  - **lapsed:** "{label} ended on {date}." (switched off: "{label} was switched off on {date}.") "{what ?? "Everything here"} stays here to look at and export, and work that came in before then can be finished." Then for admins "To start new work, renew it in Settings → Modules." and a **Renew {label}** link; for techs "Ask the shop owner to renew it."
- `ModuleNoticeFor({ shopId, module, what?, admin? })`: the same, loading its own state and shop. design.md's `src/components/module-off.tsx` wraps this.

**`src/components/module-banner.tsx`** exports:
- `ModulePills({ modules })` (server): the renew pills (`pill tone-wait text-xs`) under the nav, admins only.
- `GraceBanner({ items, admin })` (client, `"use client"`). `items` is `{ label, lastDay, graceLastDay, daysLeft, renewHref: string | null }[]`, built in the layout from the states in `grace`.
  - Renders one `no-print card card-pad text-sm` strip per item at the top of `<main>`, so it never prints on an invoice, receipt, price list or letter.
  - `tone-wait`, or `tone-bad` in the last 3 days of grace.
  - Hidden for techs on `/register…` (`usePathname()`), which faces customers.

**`blockedMessage(state, admin)`** (used by `requireModule` and `requireEquipment`):
- **off:** "{label} isn't turned on for this company." + (admin ? " An owner can add it in Settings → Modules." : " Ask the shop owner about it.")
- **not started:** "{label} starts on {date}."
- **lapsed:** "{label} ended on {date}. You can still look at and export what's there, and finish work that came in before then." + (admin ? " To start new work, renew it in Settings → Modules." : " Ask the shop owner to renew it.")
- **switched off:** "{label} was switched off for this company on {date}. You can still look at and export what's there, and finish work that came in before then."

**`src/components/copy-button.tsx`** (client): `CopyButton({ text, label = "Copy" })`.
- It uses `navigator.clipboard.writeText` and then `toast.success("Copied")` (the `partner-code-form.tsx:58` pattern).
- On a plain-http LAN address `navigator.clipboard` is missing. Then it shows the text in a `readOnly` `input mono` that selects itself on focus, with the hint "Select it and press Ctrl+C."

### 6.7 Nav and layout (foundation)

**`src/components/nav.tsx`:**
- `Item` gains `module?: ModuleId`, and `Nav` gains the prop `gates?: Partial<Record<ModuleId, NavGate>>`. Same name and shape as design.md §6.2, so their foundation only adds their items.
- The filter is the existing rule AND `(!i.module || (gates?.[i.module] ?? "hidden") !== "hidden")`.
- A `readonly` item shows `<Lock size={12} aria-label="Read only" />` after its label.
- New item, inserted after `/machines`: `{ href: "/vac", label: "Vac Shop", icon: Fan, module: "vac" }`. It is shown whatever `doesRepair` and `sellsRetail` say: a StitchShop counter can sell vacuums too.

**`src/app/(app)/layout.tsx`:**
- Add `getModules(user.shopId)` to the existing `Promise.all`, and select `id` on the shop.
- Pass `gates={toNavGates(modules)}`. `toNavGates` is a pure mapping in `module-info.ts`, so the layout doesn't query twice.
- Render `<ModulePills modules={modules} />` under the nav (admins only), next to the offline pill, and `<GraceBanner items={…} admin={user.role !== "TECH"} />` just before `{children}`.
- design.md's foundation then merges its data-based gates for S and M: `gates={{ ...toNavGates(modules), ...(await gates(user.shopId)) }}`.

Per the Next 16 docs (authentication guide), layouts don't re-render on navigation, so the banner may be one navigation stale. The pages and actions are the real gates.

---

## 7. Settings → Modules (`src/app/(app)/settings/modules/page.tsx`, foundation)

`requireUser()`. Anyone can view; `admin = role !== "TECH"`. The page uses `PageHeader title="Modules" back={{ href: "/settings", label: "Settings" }}`.

1. **Section "Your company".**
   - "Company ID" in `mono` with a `CopyButton`. Under it: "Keys are made for this ID. Give it when you buy or renew."
   - "Name on keys: {shop.name}".
   - A test build adds the pill "Test build: test keys work here" (`tone-bad`).
   - When `clockBehind`, the clock warning from section 5.5.
2. **Section "Modules".** Intro: "Extra parts of StitchBench you can add, paid monthly or yearly. When one ends, nothing is deleted: you can still look at and export what's there and finish work already in, but new work in it stops." A `table`, one row per module:
   - **Module:** label, with the blurb under it (muted).
   - **Status pill:**
     - on: "On until Sep 30, 2027" (`tone-ready`);
     - renew: "Ends Sep 30 (in 12 days)" (`tone-wait`), with the plan's line from section 5.4 under it;
     - grace: "Ended Sep 30, working until Oct 14" (`tone-bad`);
     - lapsed: "Ended Sep 30, 2027", or "Switched off Sep 30, 2027" (`tone-neutral`);
     - off: "Not on", or "Starts Oct 1" (`tone-neutral`).
   - **From:** "Key H5T75DV6 (yearly)", "Turned on by StitchBench" or "-".
   - **Admins:** an **Ask about {label}** link when off, and a **Renew {label}** link when renew (yearly or trial), grace or lapsed (`salesMailto`, rendered as `a.btn.btn-sm`). While `MODULE_SALES.email` is empty: the text "Ask StitchBench about it."
   - Unknown module names found on keys get an extra row: "{name}: needs a newer version of StitchBench".
3. **Section "Getting started"** (admins; only for vac and appliance while active). A short checklist; each line is a ✓ or a link:
   - Vac Shop:
     - "Selling vacuums, bags and trade-ins uses the register: turn on 'Sells over the counter'" (`/settings#company`; ✓ when `shop.sellsRetail`);
     - "Price your vacuum services" (`/settings#services`; ✓ when an active item with `equipmentKind` `vacuum` has a price above 0);
     - "Join the community hub to see and share what fits (the finder)" (`/settings#hub`; ✓ when joined);
     - "Vacuums already on file as sewing machines?" (`/vac/convert`).
   - Small Appliance Repair:
     - "Price your appliance services" (✓ when an active item for an appliance kind has a price);
     - "What you repair: add your own kinds, and pick what check-in opens on" (`/settings/equipment`).
4. **Section "Add a license key"** (admins only).
   - `ActionForm action={activateLicense} reset success="Key added"`.
   - `<label for="license-key">Paste the key from your email (or the whole email)</label>`, then `<textarea id="license-key" name="key" rows={4} className="textarea mono" placeholder="SB1.eyJ2Ijox…" required />` and `<Submit>Add key</Submit>`.
   - The hint is `MODULE_SALES_NOTE`.
   - Techs see instead: "The shop owner or an admin adds keys."
5. **Section "Keys on file"**, if any: key id, modules, plan, from–to, "grace until", added by / on, and a state pill (Current / Starts … / Ended / Not valid: {reason} / For another company).
   - Keys are never deleted from the page. Old keys are the history, and removing one can't give anything back.
   - The page renders `KeyView`s only; it never receives the key text.
6. The footer notes: "Moved to a new computer by restoring a backup? Your keys come with it. Started fresh on a new computer, or moved from the hosted StitchBench? Send us the new Company ID for a new key."

**`src/actions/licenses.ts`**: `activateLicense = safe(async (fd) => activateLicenseFor(await requireAdmin(), fd))`. The body is in `src/lib/licenses.ts` (server):
1. `key = extractKey(fd.get("key"))`. None → "That doesn't look like a StitchBench license key. Copy the whole key: it starts with SB1."
2. `v = verifyFor(key, "pasted")`.
   - A failed verification throws `UserError(reason)`.
   - A verified key whose scope isn't accepted: `hosted` → the refusal in section 3.3; `dev` → "This is a test key. It only works on a test copy of StitchBench."
3. `payload.s !== user.shopId` → "This key is for another company (Company ID {s}). Check that you're signed in to the right company, or ask for a key for Company ID {yours}."
4. A duplicate `keyId` → "That key is already added."
5. If every module on the key is already past its grace at the effective time → "This key ended on {date}. Ask for your renewal key."
6. Create `License { shopId: user.shopId, keyId: payload.id, key, addedBy: user.name, addedById: user.id }`.
7. `revalidatePath("/", "layout")`.

The settings page (`settings/page.tsx`) gains a short `<Section title="Modules">` after `#company`, with `id="modules"`. It shows one line per module that isn't off ("Vac Shop: on until Sep 30, 2027") and a link "Modules and license keys" to `/settings/modules`. It is visible to everyone.

---

## 8. Companies: the admin switch (`companies/page.tsx`, `src/actions/companies.ts`, foundation)

**Page** (platform admins, as today):
- The Companies table gains three columns:
  - **Company ID**: `mono`, with a `CopyButton` (the CLI needs it);
  - **Modules**: from one `loadModulesMany(allIds)`, one short pill per module that isn't off: "Vac until Sep 30, 2027", "Scheduling ended Oct 1", "Marketing off (switched)". For a module whose source is the admin switch and that has an end date, two small buttons: **Extend 1 month** and **Extend 1 year** (`setCompanyModule` with `mode=extend`);
  - **Hub**: "Sharing on" / "Sharing off", with a button that flips `Shop.hubWritesOff` (`setHubWrites`). With sharing off, that company can still read the hub, but its links, cross-references and shared posts are refused (section 10.b).
- Below the table, a new `<Section title="Modules for a company">`. It is shown only when `!isDesktop()`. Otherwise the section says: "Modules are switched on from the hosted StitchBench. Here, each company pastes its license key in Settings → Modules."
- Intro text: "Switch a paid module on or off for one company on this server. 'Turn off' stops every key the company had until you choose 'Let keys decide'. 'Let keys decide' removes your switch, so only the company's own keys count."
- The form is `ActionForm action={setCompanyModule}` with these labelled fields (the E2E helpers rely on the labels):
  - "Company": select of every company by name;
  - "Module": select;
  - "On until (blank: no end date)": `type="date"`;
  - "Days of grace": number, default 14;
  - "Note": for example "Invoice 1042".
- It has three submit buttons, all `name="mode"`: "Turn on" (`on`), "Turn off" (`off`), "Let keys decide" (`none`). The success toast is "Saved".
- With no hosting key (`hostedSigner()` null), "Turn on" and "Extend" are disabled and the page says: "This server has no hosting key (LICENSE_HOSTED_KEY), so it can't switch modules on. Send the company a license key instead. Turning off still works."
- Under the form: `grantHistory(20)` (when, company, module, on / off / keys decide / extended, until, by, note). The page never reads key text.

**`setCompanyModule = safe(async (fd) => setCompanyModuleFor(await requirePlatformAdmin(), fd))`**, body in `src/lib/modules-admin.ts` (server):
1. `isDesktop()` → UserError "Switch modules on from the hosted StitchBench."
2. Company must exist ("Company not found."); module in `MODULE_IDS` ("Pick a module.").
3. `mode` in on / off / none / extend.
4. For `on`:
   - `hostedSigner()` is required, else UserError with the no-hosting-key text;
   - `lastDay` must be blank (→ `2099-12-31`) or a valid date on or after today in the company's time zone ("Pick a date from today on, or leave it blank for no end date.");
   - grace must be 0-90 ("Grace is 0 to 90 days.");
   - the key comes from `signGrant(...)`.
5. For `extend` (with `period` m or y): the current admin window's last day from `adminPosition` (none, or already past → "Turn it on first."). The new last day is `planLastDay(start, period)`, where `start` is the day after the current last day, or today if that's later. Grace is kept. It is written as an `on` row with the note "Extended 1 month" / "Extended 1 year".
6. Insert `ModuleGrant { shopId, module, mode: mode === "extend" ? "on" : mode, key, byEmail: admin.email, note }`.
7. Log one line to the server output, so there's a record outside the database: ``console.info(`[modules] ${JSON.stringify({ company: shopId, module, mode, until: lastDay ?? null, by: admin.email })}`)``.
8. `revalidatePath("/companies")` and `revalidatePath("/", "layout")`.

**`setHubWrites = safe(async (shopId: string, off: boolean) => …)`**: `requirePlatformAdmin`, the company must exist, set `hubWritesOff`, log one `[hub]` line the same way.

The `shopId` comes from the form here. That is the one legitimate case: the platform admin acts across companies, as `createCompany` already does.

**Protecting the platform-admin logins** (`src/actions/settings.ts`, foundation), since those logins now control paid access:
- `resetUserPassword` and `setUserActive` refuse when `isPlatformAdmin(target.email) && target.id !== admin.id`: "That login belongs to the StitchBench administrator. Only they can change it."
- `createShopWithOwner` refuses platform-admin addresses except through the platform admin or the first-company setup (section 2.4).

---

## 9. Equipment kinds (the category layer; framework in foundation)

### 9.1 Names

- **`Machine.equipment`** is the gate: `SEWING` (free), `VACUUM` (vac), `APPLIANCE` (appliance).
- **`Machine.kind`** is the content key:
  - built-in keys: `sewing`, `vacuum`, `stand-mixer`, `3d-printer`, `resin-printer`, `other`;
  - a shop kind's key is `[a-z0-9-]{2,40}`, never a built-in key, and always APPLIANCE.
- **`Machine.machineType`** is the sub-type within the kind.

**Changing what a machine is:**
- **Within the same equipment** (a mixer filed as "Other appliance" that should be "Stand mixer", or a shop kind): always allowed through `updateMachine`, when the target kind is usable. Answers under keys the new kind doesn't ask show as "Other details".
- **Across equipment** (a vacuum logged as a sewing machine years ago, or a wrong chip at check-in): only through `convertMachineKind` (admin), section 9.5.

### 9.2 Types (`src/lib/equipment/types.ts`, pure)

```ts
import type { ModuleId } from "@/lib/module-info";
import type { QuickLink } from "@/lib/quick-links";
export type Equipment = "SEWING" | "VACUUM" | "APPLIANCE";
export type FieldDef = {
  key: string;                       // [a-z0-9-]{1,40}, stable: answers are stored under it
  label: string;
  type: "text" | "number" | "select" | "checkbox";
  options?: string[];                // select
  unit?: string;                     // number: shown after the box
  placeholder?: string;
  on: "machine" | "ticket";          // Machine.details (the unit, asked once) or Ticket.intake (this visit)
};
export type ReadingDef = {
  key: string; label: string;
  type: "number" | "text" | "passfail";
  unit?: string; min?: number; max?: number;   // number: "in range" / "out" pill like the tension readings
  foundLeft: boolean;                // true: As found + As left; false: one value (stored as "left")
};
export type ServiceDef = { name: string; description?: string; priceCents?: number };   // priceCents: suggested; absent = 0
export type EquipmentKind = {
  key: string; equipment: Equipment; module: ModuleId | null;
  label: string;                     // "Vacuum"            (chips, section titles)
  plural: string;                    // "Vacuums"           (filters)
  noun: string;                      // "vacuum"            (sentences: "Check in a vacuum")
  types: string[];                   // Machine.machineType choices
  brands: string[];                  // brand suggestions (sewing: the page loads TensionSpec brands as today)
  modelHint: string;                 // model placeholder: "e.g. UH70120"
  accessories: string[]; defaultChecked: string[];
  checklist: string[];               // sewing: see checklistFor
  serviceMenu: ServiceDef[];         // the starter list
  intakeFields: FieldDef[];
  readings: ReadingDef[];            // built-in kinds only; a shop kind has none
  panels: { tension: boolean; timing: boolean };   // sewing only
  links: (brand: string, model: string) => QuickLink[];
  builtIn: boolean;
};
```

### 9.3 Registry and the shop's own kinds

**`src/lib/equipment/index.ts`** (pure):
- `EQUIPMENT_MODULE = { SEWING: null, VACUUM: "vac", APPLIANCE: "appliance" }`.
- `BUILT_IN_KINDS = [SEWING_KIND, VACUUM_KIND, ...APPLIANCE_KINDS]`, from `sewing.ts`, `vacuum.ts` and `appliances.ts`.
- `builtInKind(key)`.
- `genericKind(equipment, key, label?)`: used for a machine whose shop kind was removed, so the record still renders.
- `genericLinks(noun)`, which gives four Google / eBay / YouTube searches (no maker-specific URLs):
  - "eBay parts" (`{bm} parts`);
  - "YouTube: repair" (`{bm} repair`);
  - "Service manual search" (`{bm} service manual pdf`);
  - "{brand} support" (Google `"{brand} {noun} support"`).
- `shopKind(row: ShopEquipmentKind): EquipmentKind`: equipment APPLIANCE, module `appliance`, the row's lists, `cleanFieldDefs(row.intakeFields)`, no readings, `panels` off, `genericLinks(noun)`, empty `serviceMenu`, `builtIn: false`.

**`src/lib/equipment/sewing.ts`** (pure) is exactly today's behaviour:
- key `sewing`, label "Sewing machine", plural "Sewing machines", noun "machine";
- `types: MACHINE_TYPES`, `brands: []`, modelHint "e.g. MC6700P";
- `accessories: ACCESSORIES.filter(a => a !== "Other")`, `defaultChecked: ["Power cord", "Foot control"]`;
- `checklist: DEFAULT_CHECKLIST`, `serviceMenu: DEFAULT_SERVICE_MENU`;
- no intake fields or readings;
- `panels: { tension: true, timing: true }`;
- `links: (b, m) => quickLinks(b, m, null)`.

The sewing check-in page and ticket page keep their current labels, so `tests/smoke.spec.ts` passes unchanged.

**`src/lib/equipment/shop.ts`** (server):

```ts
export async function shopKinds(shopId: string): Promise<{ all: EquipmentKind[]; usable: EquipmentKind[] }>;
// all = built-ins + the shop's ShopEquipmentKind rows (inactive shop kinds stay in `all` so records render)
// usable = sewing + kinds whose module canWrite (getModules) and that are active, in order:
//   sewing, vacuum, stand-mixer, 3d-printer, resin-printer, shop kinds by sortOrder, other
export async function kindOf(shopId: string, m: { equipment: string; kind: string }): Promise<EquipmentKind>; // never throws; genericKind fallback
export async function kindByKey(shopId: string, key: string | null | undefined): Promise<EquipmentKind>;     // a known key in `all`, else sewing
export function checklistFor(kind: EquipmentKind, shop: { checklistItems: string[] }): string[];
// sewing: shop.checklistItems.length ? shop.checklistItems : DEFAULT_CHECKLIST (unchanged); others: kind.checklist
export async function servicesFor(shopId: string, kindKey: string): Promise<ServiceItem[]>;
// active items where equipmentKind is null or kindKey, by sortOrder
```

**`src/lib/equipment/form.ts`** (pure):

```ts
export function readAnswers(defs: FieldDef[], on: "machine" | "ticket", fd: FormData, prev?: Record<string, unknown>, required?: string[]): Record<string, string | number | boolean>;
// inputs named `f:<key>`; text <= 200 chars; number finite; select must be one of options (else UserError "Pick one of the choices for {label}.");
// checkbox "on" -> true; blank -> dropped, unless its key is in `required` (UserError "Answer '{label}'."); unknown keys ignored;
// prev entries for keys no longer defined are kept
export function readReadings(defs: ReadingDef[], fd: FormData): Record<string, { found?: string | number; left?: string | number }>;
// `found:<key>` / `left:<key>`; number >= 0 finite; text <= 80; passfail "pass" | "fail"; unknown keys ignored (a Map, never an object from the browser's keys)
export function cleanFieldDefs(json: unknown): FieldDef[];   // defensive parse of ShopEquipmentKind.intakeFields
export function inRange(def: ReadingDef, v: unknown): boolean | null;
```

### 9.4 Where kinds appear (foundation edits; only `usable` kinds are offered for new work)

| File | Change |
|---|---|
| `tickets/new/page.tsx` | `searchParams` gains `kind`. **The kind shown:** `?kind=` when given; else `shop.checkInKind` when it is usable; else sewing. With more than one usable kind, `KindChips` goes under the header ("Sewing machine", "Vacuum", "Stand mixer", "3D printer", "Resin 3D printer", shop kinds, "Other appliance"), linking to `?kind=` (keeping `customerId`). **An asked kind that isn't usable** shows `ModuleNotice` for its module and a link "Check in a sewing machine instead" (`?kind=sewing`), and no form. A preselected `machineId` fixes the kind to the machine's; if that isn't usable the page shows the notice and no form. **Sewing is unchanged:** title "Check in a machine", section "Machine", TensionSpec brand datalist, `MACHINE_TYPES`, "Power cord" and "Foot control" ticked, "Came in through (quilt shop / dealer)". **Other kinds:** title "Check in a {noun}" (article from the first letter), section `{label}`, brands `kind.brands`, types `kind.types`, the machine intake fields in that section, the ticket intake fields under "Work", services from `servicesFor(kind.key)`, accessories from the kind, "Came in through (dealer / partner shop)". Hidden `<input name="kind">`. |
| `actions/tickets.ts` `createTicket` | See 9.5. |
| `tickets/[id]/page.tsx` | `kind = kindOf(t.machine)` and `canWork = canWorkOn(shopId, t.machine.equipment, { intakeAt: t.intakeAt, status: t.status })`. `specsFor` / `settingsFor` run only when `kind.panels.tension` / `timing`. The checklist comes from `checklistFor`. Non-sewing kinds get the `ReadingsPanel` in place of the tension and timing blocks. A "Details" `Section` (a `KV` list of `machine.details` + `ticket.intake`, labels from the kind, unknown keys as "Other details") with `<details><summary>Change</summary>` and a form to `saveIntake`. "Add service" lists `servicesFor(kind.key)`. The accessories wording uses the noun ("Nothing logged. {Noun} only."). `ModelPanel kind={kind}`. **When `!canWork`:** a `ModuleNotice`, and the work sections (text, checklist, readings, lines, photos, intake) wrapped in `<fieldset disabled>` with their forms hidden. The status select offers only the current status plus `CLOSING_STATUSES`. The payments form and the accessories-returned ticks stay enabled; the "add accessory" box is hidden. **For `t.jobType === "SITE"`:** the header reads "Install #{no} · {address}"; `<SitePanel ticketId user readOnly={!canWork} />` goes first in the left column; the checklist is `INSTALL_CHECKLIST` (from `src/lib/vac/installs.ts`); the accessories, readings and intake sections are hidden; `StatusSelect` gets `order={SITE_STATUS_ORDER} labels={SITE_STATUS_LABEL}`. `<UnitBadge machineId user />` goes under the header for VACUUM machines. |
| `tickets/[id]/invoice/page.tsx` | "Machine" becomes `{kind.label}` for non-sewing kinds and "Installed unit" for SITE. `<SiteInvoiceBlock ticketId shopId />` goes after the customer / machine grid. "Returned with the machine" uses the noun. |
| `tickets/page.tsx` | `where` adds `jobType: "BENCH"`. `KindChips` (all kinds that have tickets or are usable) filter with `machine: { kind }`. |
| `app/(app)/page.tsx` (dashboard) | The open-ticket query adds `jobType: "BENCH"`, so installs are not in custody, the status tiles or the storage-fee list. With only sewing usable, "Check in a machine" stays as it is. With more, it becomes up to three buttons "Check in a {noun}" (`shop.checkInKind` first, then sewing, then the rest in `usable` order), each linking to `/tickets/new?kind=`. |
| `machines/page.tsx` | `KindChips` filter (`?kind=`). The add form gets a "What is it" select (usable kinds) and the kind's types; `createMachine` reads `kind`. |
| `machines/[id]/page.tsx` | Checklist template from `checklistFor(kind)`. The "Tension readings" block is shown for sewing; other kinds get a readings summary of the current ticket. The type select uses `kind.types`, and a "What is it" select offers the usable kinds of the same equipment. The edit form gains the machine intake fields. For admins, a `<details>` "It isn't a {noun}" with a select of usable kinds of the other equipments, posting to `convertMachineKind`. `ModelPanel kind`. `<UnitBadge>` and `<SuppliesThatFit brand model bagType user />` for VACUUM. |
| `models/[brand]/[model]/page.tsx` | `searchParams.kind` goes to `kindByKey` (missing = sewing). `ModelPanel kind`. The sub-header drops "Factory specs," for non-sewing kinds. |
| `components/model-panel.tsx` | Gains the prop `kind?: EquipmentKind`. When `kind && !kind.panels.tension`, it skips `specsFor` and `settingsFor` and the "Factory tension" and "Timing and adjustments" sections, and passes `links={kind.links(brand, model)}` to `MachineInfo`. |
| `components/machine-info.tsx` | Optional `links` prop overrides `quickLinks(...)`. |
| `components/ui.tsx` | `modelHref(brand, model, kind?)` appends `?kind=` for non-sewing kinds (no `kind` means sewing). `StatusPill` gains the optional `site` prop (SITE labels). |
| `components/ticket-controls.tsx` | `StatusSelect` gains the optional `order`, `labels` and `closingOnly` props. |
| `settings/page.tsx` | The service menu section is wrapped in `<div id="services">`. It gets a "For" select per item and on the add form ("Every kind", then each kind in `all` that is usable or already used by an item), saved by `saveServiceItem` as `equipmentKind`. The checklist section is titled "Service checklist (sewing machines)" when another kind is usable, with the line "Checklists for other kinds: What you repair" linking to `/settings/equipment`. For each usable non-sewing kind with no menu item of its own, a button "Add the starter {plural} list" calls `addStarterServices(kindKey)` (section 9.5). The "Modules" section is described in section 7. "Your data" gains Tickets, Machines, and Vacuums for sale (the last only when vac isn't off or units exist). |

**Components** (foundation, server unless noted), all in `src/components/equipment/`:
- `kind-chips.tsx`: `KindChips({ kinds, active, hrefFor })`, `Link.btn.btn-sm` with `btn-primary` when active.
- `intake-fields.tsx`: `IntakeFields({ defs, on, values, required? })`, `grid-form` fields named `f:<key>` with ids `f-<key>`; a key in `required` gets `required` on its input.
- `readings-panel.tsx`: `ReadingsPanel({ ticketId, defs, values, readOnly })`, a table (What | As found | As left | unit | pill) plus `ActionForm action={saveReadings.bind(null, ticketId)} success="Readings saved"`. passfail is a select ("-", "Pass", "Fail").
- `details-list.tsx`: `DetailsList({ kind, details, intake })`.

### 9.5 Actions (foundation)

**`src/actions/tickets.ts`:**

```ts
async function ownTicket(shopId: string, ticketId: string, need: "work" | "close" = "work", role?: CurrentUser["role"]) {
  const t = await db.ticket.findFirst({ where: { id: ticketId, shopId }, include: { shop: true, machine: { select: { equipment: true, kind: true } } } });
  if (!t) throw new UserError("Ticket not found.");
  if (need === "work") await requireEquipment({ shopId, role }, t.machine.equipment, { ticket: t, closing: true });
  return t;
}
```

- The signature keeps design.md's call `ownTicket(user.shopId, ticketId, need)` working; callers in this file pass `user.role` as the fourth argument.
- **"close"** is used by: `setStatus` when the target is in `CLOSING_STATUSES`, `addPayment`, and `saveAccessories`. In `saveAccessories`, when the ticket isn't workable (`canWorkOn` false), the `add` field is ignored: only the returned ticks are saved.
- **"work"** is used by everything else:
  - `setStatus` to any other status;
  - `saveTicketText`, `toggleChecklist`, `saveTension`, `saveMeasurements`, `removeAccessory`, `addLine`;
  - the new `saveReadings` and `saveIntake`.
- `removeLine` finds the line through `ticket: { shopId }` and runs the same "work" check with that ticket.
- `removePayment` stays admin-only with no module check (closing).
- `setStatus` also refuses statuses outside `SITE_STATUS_ORDER` on a SITE ticket ("That status isn't used for installs."). design.md's foundation later replaces the body after `ownTicket` with `changeTicketStatus`; the `ownTicket(…, need)` call and this SITE check stay in front of it.
- **`createTicket`:**
  - Resolves `kind` from the hidden field through `shopKinds().all` ("Pick what you're checking in.").
  - With `machineId`: the machine's own kind applies, with `requireEquipment(user, equipment)` (new work, no ticket). For a new machine: `kind.module && requireModule(user, kind.module)`.
  - Serial reuse adds `equipment: kind.equipment` and `OR: [{ stock: { is: null } }, { stock: { is: { status: "SOLD" } } }]` to its `where`, so a check-in never attaches to a vacuum that is in stock or off sale.
  - A new machine gets `equipment`, `kind: kind.key`, and `details: readAnswers(kind.intakeFields, "machine", fd)`.
  - `serviceItemId` must match `OR: [{ equipmentKind: null }, { equipmentKind: kind.key }]` ("That service isn't on the {label} menu.").
  - `intake: readAnswers(kind.intakeFields, "ticket", fd)`.
  - Ticket numbering moves into `src/lib/ticket-number.ts` `takeTicketNumber(tx, shopId, typed: number | null)` with the same logic and messages; `createTicket` and the installs package use it.
- **New `saveReadings(ticketId, fd)`** and **`saveIntake(ticketId, fd)`**: one-line wrappers; the bodies `saveReadingsFor(user, ticketId, fd)` and `saveIntakeFor(user, ticketId, fd)` are in `src/lib/equipment/ticket-data.ts` (server). Each runs `ownTicket`'s lookup and the "work" check (the lib has its own copy of the lookup, scoped by `shopId`).
  - `saveReadings`: `readReadings(kind.readings, fd)` → `ticket.readings`; `refresh`.
  - `saveIntake`: `readAnswers` for "ticket" → `ticket.intake`, and for "machine" → `machine.details` (merged over the previous values; the machine is the ticket's own, updated with `updateMany({ where: { id, shopId } })`).

**`src/actions/records.ts`:**
- `createMachine` reads `kind` (usable; module required) and sets `equipment`, `kind` and `details`.
- `updateMachine`:
  - requires `machineWorkable(shopId, machineId)`;
  - a `kind` change must stay within the same equipment and name a usable kind ("Pick one of the {equipment label} kinds. To change what it is, use 'It isn't a {noun}'.");
  - it reads the machine intake fields into `details`;
  - when the machine has a `StockUnit`, it refuses any change to customer, brand, model, serial or kind: "This vacuum is in Vac Shop → For sale. Change it there."
- **New `convertMachineKind(machineId, fd)`**, body `convertMachineKindFor(user, machineId, fd)` in `src/lib/equipment/convert.ts`:
  - `requireAdmin`;
  - the machine by `{ id, shopId }` ("Machine not found.");
  - the source must be workable (`machineWorkable`) and the target kind usable (`requireModule` for its module), so a lapsed vacuum can't be turned into a sewing machine to get around the gate;
  - refused when it has a `StockUnit` ("It's in Vac Shop → For sale.");
  - refused when an open ticket (not in `CLOSING_STATUSES`) has lines or payments: "It has work on an open ticket. Close that ticket first, or check it in again as a {noun}."
  - sets `equipment`, `kind`, and `machineType` (blank when not in the new kind's types). Tickets, photos and `details` stay.
  - `revalidatePath` of the machine and its tickets.
- `deletePhoto` and `updatePhoto` (`records.ts:65,74`): after the photo lookup, the "work" check with the photo's ticket when it has one (`ticketWorkable`), else `machineWorkable`.

**Other gates:**
- **`src/app/api/photos/route.ts`:** after the machine lookup (select `equipment`) and the ticket check, `if (!(ticketId ? await ticketWorkable(shopId, ticketId) : await machineWorkable(shopId, machineId))) return new Response(blockedText, { status: 403 })`.
- **`src/actions/scan.ts`**, ticket mode: include `machine: { select: { equipment: true } }`. When `!canWorkOn(shopId, equipment, ticket)`, return `{ ok: false, code, message: "That ticket is read-only: {blockedMessage}" }`.
- **`src/actions/settings.ts`:**
  - `saveServiceItem` saves `equipmentKind` (null or a key in `all`, "Pick what it's for.");
  - new `addStarterServices(kindKey)` (`safe`, `requireAdmin`, `requireModule(user, kind.module)`; refuses a kind that already has items of its own, "{Plural} already have services."). It creates `kind.serviceMenu` with `category: kind.label` and `equipmentKind: key`, and skips names already on the menu for every kind (case-insensitive, e.g. "Diagnosis & estimate"). An item's price is its `priceCents` (absent: 0). An item created at $0 is created `active: false`, and the toast then says "Added. Set prices, then switch them on." (otherwise "Added.");
  - the platform-admin protections in section 8.
- `saveChecklist` is unchanged (sewing).
- **Community hub writes** (`src/lib/hub-writes.ts`, new, foundation):
  - `requireHubWrites(user): Promise<string>` throws "Sharing to the community hub is switched off for this company. Ask StitchBench." when `Shop.hubWritesOff`. Otherwise it returns the `byName` to send: `"{user.name} ({shop.name})"` on an install with more than one company, else `user.name`.
  - Foundation calls it in the manual-link actions of `src/actions/hub.ts` (add, edit, revert, remove) and in the share action of `src/actions/shared.ts`. `vac-finder` calls it in `src/actions/xref.ts`.

**Not changed** (partner take-ins stay sewing): `takeInMachine`, `intake-form.tsx`, `newJobFromPartner`, `partner-terms.ts`. Incoming partner jobs create SEWING machines by default.

### 9.6 Exports (foundation, `src/app/api/export/[what]/route.ts`, never module-gated)

- **`tickets`** (new): `number, job_type, kind, status, customer, came_through, brand, model, serial, service, problem, taken_in, ready, closed, total, paid, due, site_address, details, intake, readings`. The last three are JSON text, so every check-in answer and reading stays exportable. It uses `ticketTotals` and includes `site: true`.
- **`machines`** (new): `kind, equipment, brand, model, serial, type, customer, details (JSON text), added`.
- **`vac-units`** (new): `status, condition, brand, model, serial, cost, price, sold_net, warranty_months, warranty_by, sold, sale_number, buyer, warranty_until, registered, registration_ref, traded_in_on_sale`.
- **`register-sales`** (existing) gains a last column `for_machine`: "{brand} {model}" of `SaleLine.machineId`, the vacuum a bag was bought for. Adding it at the end keeps older spreadsheets working.

These are ungated, so "records stay exportable" holds in every state.

---

## 10. Vac Shop module (`vac`)

### 10.0 Home, nav and tabs

- **Nav:** "Vac Shop" goes to `/vac` (section 6.7).
- **`src/components/vac/vac-tabs.tsx`** (foundation, kept): `VacTabs({ active })` renders the tabs Repairs (`/tickets?kind=vacuum`), Finder (`/vac/finder`), For sale (`/vac/units`), Bags due (`/vac/bags-due`) and Installs (`/vac/installs`) as `Link.btn.btn-sm`. Every `/vac/*` page renders it under its header.
- **Selling needs the register.** When the company doesn't sell over the counter (`!shop.sellsRetail`; the Windows program creates repair-only companies), `/vac`, `/vac/units` and `/vac/finder` show a card: "Selling vacuums, bags and trade-ins happens at the Register." Admins get a link "Turn on 'Sells over the counter' in Settings" (`/settings#company`, the existing checkbox), and techs get "Ask the shop owner to turn on the register."
- **`/vac`** (stub by foundation; owner `vac-repair`):
  - `pageGate` first;
  - then the tabs and five short cards with a one-line explanation each, and "Check in a vacuum" (`/tickets/new?kind=vacuum`; only when `shop.doesRepair`);
  - counts (each query scoped by `shopId`): open vacuum tickets, units in stock, bags due (`bagsDueCount(shopId)` from the stub, whose body passes to `vac-bags-due`), installs this week;
  - for admins, when any exist: "{n} vacuums may be filed as sewing machines", linking to `/vac/convert`.
- **`/vac/convert`** (owner `vac-repair`): "Vacuums filed as sewing machines?"
  - It lists SEWING machines whose brand matches a `VACUUM_KIND.brands` entry (`brandMatches`) or whose `machineType` matches `/vac/i`: brand, model, serial, customer, last ticket.
  - The note says: "Kenmore, Singer and Electrolux made sewing machines too. Check the model before you change it."
  - Each row has "It's a vacuum", which posts to `convertMachineKind` with `kind=vacuum` (section 9.5; admin + vac active).
  - Nothing is converted automatically.

### 10.a Vacuum repair bench (package `vac-repair`)

The tickets are ordinary tickets whose machine has `equipment VACUUM, kind vacuum`. All the framework comes from section 9. The package fills in `src/lib/equipment/vacuum.ts`:

- **Identity:**
  - key `vacuum`, equipment `VACUUM`, module `vac`;
  - label "Vacuum", plural "Vacuums", noun "vacuum";
  - modelHint "e.g. UH70120".
- **Types (owner's list, plus two common ones):** Upright, Canister, Central, Backpack, Robot, Commercial, Stick / cordless, Other.
- **Brands:** Aerus, Beam, Bissell, Cana-Vac, Dirt Devil, Dyson, Electrolux, Eureka, Hayden, Hoover, iRobot, Kenmore, Kirby, Lindsay, Miele, Nilfisk, NuTone, Oreck, Panasonic, ProTeam, Rainbow, Riccar, Roborock, Royal, Sanitaire, SEBO, Shark, Simplicity, VacuMaid, Windsor.
- **Accessories:** Power cord, Hose, Wand(s), Power head / floor tool, Crevice tool, Dusting brush, Upholstery tool, Bag (in it), Filter(s), Battery, Charger / dock, Remote, Tool caddy. `defaultChecked: []`: vacuums often come in bare.
- **Intake fields, machine level.** The key names are a contract with the finder, the unit forms and bags-due:
  - `bagged` "Bags or bagless" (select: Bagged, Bagless);
  - `bagType` "Bag type" (text, placeholder "e.g. Hoover Type Y, Miele GN");
  - `power` "Power" (select: Corded, Battery).
- **Intake fields, ticket level:** `smell` "Burning smell reported" (checkbox).
- **Checklist:**
  - Bag / bin emptied and bag chamber cleaned
  - Filters checked (pre-motor, post-motor, HEPA): cleaned or replaced
  - Belt checked or replaced
  - Brush roll: hair and string removed, bearings and end caps checked
  - Hose and air path checked for clogs
  - Cord, plug and strain reliefs checked
  - Switch and wiring checked
  - Motor and carbon brushes checked
  - Suction tested (reading recorded)
  - Cleaned outside, test run done
- **Service menu, starter list** (names; `priceCents` left out unless the owner supplies his prices, so they are created switched off at $0, section 9.5):
  - Vacuum tune-up (clean, belt, brush roll, filters, suction test)
  - Belt replacement
  - Brush roll service or replacement
  - Motor carbon brushes
  - Motor replacement
  - Hose clog removal
  - Hose repair or replacement
  - Bag chamber and air path cleaning
  - Filter replacement
  - Cord replacement
  - Switch replacement
  - Suction test and diagnosis
  - Robot vacuum service (brushes, sensors, battery test)
  - Central vac power unit service
  - Central vac installation
  - Central vac inlet (each)
- **Readings:**
  - `suction` "Suction", number, unit "inH2O", found/left;
  - `amps` "Amp draw", number, unit "A", found/left;
  - `brushroll` "Brush roll spins under load", passfail, found/left.
- **Panels:** tension and timing off.
- **Links:** `genericLinks("vacuum")`.

The package also owns the `/vac` home and `/vac/convert` (10.0), and `scripts/checks/vacuum-kind.check.ts`, which checks:
- the owner's six types are present;
- the intake keys `bagged` and `bagType` exist, and `bagged` offers exactly Bagged and Bagless;
- the reading keys are unique;
- every menu name is ≤ 80 characters;
- `links` returns only `https://www.google.com/`, `https://www.ebay.com/` and `https://www.youtube.com/` URLs.

### 10.b Bag / belt / filter finder (package `vac-finder`)

**Data.** It uses the community cross-reference (`XPart`) with no schema change and no hub change.

- A supply is an entry whose `category` is exactly one of `VAC_SUPPLY_CATEGORIES`.
  - Bags and filters: `kind SUPPLY`; belts: `kind PART`. Both kinds are already in the hub's whitelist.
- `numbers` hold every name the supply goes by, each under its brand:
  - the OEM number under the maker ("Hoover, 4010100Y");
  - the bag "type" under the maker ("Hoover, Type Y");
  - aftermarket numbers under their brand ("EnviroCare, 138SW").
- `fits` are the vacuums, `{ brand, model }`.

**Hub (StitchHub): no change needed.** This was checked against `stitchhub/src/parts.mjs` at 28842a1:
- `cleanPart` keeps `category` as free text up to 80 characters, allows kinds `PART | ACCESSORY | SUPPLY`, and takes up to 3000 fits and 50 numbers.
- `POST /v1/xparts`, `PUT /v1/xparts/:id` and `GET /v1/xparts/:id/history` already exist.
- `/v1/changes` sends whole entries, and `saveXParts` stores `category`.
- The admin can bulk-import maker or EnviroCare fit charts through the existing `POST /admin/xparts/import`, which keeps `category`.

**Older installs** receive these entries in their normal sync:
- they show them in `/xref` and in "Parts that fit" on those vacuum models' pages;
- that is harmless and needs no code on their side;
- they just don't have the finder screen.

**Writing to the hub.** The finder adds no new way to write to the hub. "This fits another model" opens the existing editor at `/xref/{id}`, and "New bag, belt or filter" opens the existing add form at `/xref` with the category and the vacuum filled in. So `src/actions/xref.ts` is the one write path, and this package hardens it (below).

**`src/lib/vac/finder.ts`** (server; stub by foundation, owner `vac-finder`):

```ts
export type VacSupplyCategory = (typeof VAC_SUPPLY_CATEGORIES)[number];
export type Supply = {
  xpartId: string | null; name: string; category: VacSupplyCategory | null;
  numbers: { brand: string; number: string }[]; evidence: "tested" | "maker" | "listed" | null;
  close: string | null;      // found by the model-prefix fallback: the model it lists, e.g. "UH70120PC"
  items: RegisterItem[];     // this shop's stocked parts that ARE this supply (brand-aware), in stock first; [] = not stocked
  source: "hub" | "local";
};
export type FinderQuery = { brand?: string | null; model?: string | null; text?: string | null };  // text: a bag type, a part number or words
export async function suppliesFor(shopId: string, q: FinderQuery): Promise<{ supplies: Supply[]; truncated: boolean }>;  // stub: { supplies: [], truncated: false }
export const VAC_SEARCH_SITES: { label: string; url: (q: string) => string }[];   // eBay and Google "{q} vacuum" only
```

**`suppliesFor`** works like this:
1. **By model** (brand and model given):
   - `key = modelKey(model)`. It runs `db.xPart.findMany({ where: { category: { in: [...VAC_SUPPLY_CATEGORIES] }, fitKeys: { has: key } }, take: 500 })` and keeps entries with a fit where `f.modelKey === key && brandMatches(f.brand, brand)`.
   - **Close matches:** when that finds nothing and `key.length >= 4`, a prefix fallback:

     ```sql
     SELECT id FROM "XPart" WHERE category = ANY(${cats})
       AND EXISTS (SELECT 1 FROM unnest("fitKeys") k WHERE length(k) >= 4 AND (${key} LIKE k || '%' OR k LIKE ${key} || '%'))
     LIMIT 200
     ```

     It runs through `$queryRaw` with parameters, then applies the same brand filter, and sets `close` to the fit's model.
2. **By type or number** (`text` given): `nk = numberKey(text)`. It finds `category in cats AND (numberKeys has nk (when nk.length >= 3) OR name contains text, insensitive)`, `take: 200`.
3. **Evidence** for a supply: "tested" and "maker" rank the same (a maker's chart counts as much as a tech's fitting), above "listed".
4. **This shop's stock.** One query: `part.findMany({ where: { shopId, numberKeys: { hasSome: keys } } })`, where `keys` are the entries' number keys of 3+ characters. A part **is** an entry's supply when one of the entry's numbers `{ brand, number }` has `numberKey(number)` in `part.numberKeys` and either:
   - `brandMatches(brand, part.brand)`; or
   - the part has no brand, or the brand "Generic", and that number key is 5+ characters and contains a digit.

   So an Electrolux "Type C" bag is never offered as a Kenmore "Type C", and a vandal's number "1" matches nothing. Every matching part becomes an item through `view()` (exported from `register.ts`), in stock first. Each has its own price, stock and "Add".
5. **Local, offline and not-joined results:** this shop's Parts whose `fits` list the model (`splitList(fits).some(e => modelKey(e) === key || modelKey(e) === brandKey(brand) + key)`) and that no hub result already holds. The category is guessed from the description (`/\bbags?\b/i`, `/\bbelts?\b/i`, `/\bfilters?\b/i`), else null ("Other"). `source: "local"`, and `items: [view(part)]`.
6. **Sort:** category (bag, belt, filter, other), stocked first, evidence, name. **Then** cap at 60 (`truncated`), so spam can't push real bags out.

**`src/actions/vac-finder.ts`** (`"use server"`; bodies in `finder.ts`):
- `vacSupplies(q: FinderQuery): Promise<{ supplies: Supply[]; truncated: boolean } | { error: string }>`. A data action: `requireUser` + `requireModule(user, "vac")`, then `suppliesFor(user.shopId, q)`.
- `customerVacuums(customerId: string): Promise<{ id; brand; model; bagType: string | null }[] | { error: string }>`. `requireUser` + vac; the customer by `{ id, shopId }` ("Customer not found."); their VACUUM machines, newest first.

**`src/actions/xref.ts`** (this package owns it for the whole build):
- Every hub write calls `const byName = await requireHubWrites(user)` (section 9.5) and sends that `byName`. A company the platform admin cut off can't write, and on a multi-company install every change names the company.
- `removeCrossRef`, `mergeCrossRef` and `revertCrossRef` use `requireAdmin()` instead of `requireUser()`.
- `numberOwner` matches the brand too: `numberKeys hasSome` and then a JS filter with `brandMatches(n.brand, …)`. "Type Y" under Hoover no longer clashes with another brand's "Type Y". This matches the hub's `(brand_key, number_key)` rule.
- `addPartToCrossRef`: when the part's `fits` lines contain a comma ("Hoover, UH70120"), it uses `parseFits` with the given brands instead of the part's own brand. Aftermarket bags then list the vacuum maker.

**`src/components/xref-form.tsx`:** the category input gains a `<datalist>` with `VAC_SUPPLY_CATEGORIES`, so the finder's categories are always spelled the same. `defaults` gains `category` and `kind`.

**`src/app/(app)/xref/page.tsx`:** reads `category`, `kind`, `fits` and `name` search params and passes them as the add form's `defaults`. The add form gets `id="add"`.

**`src/app/(app)/xref/[id]/page.tsx`:** the remove, merge and revert controls show for admins only.

**Screens:**
- **`/vac/finder?brand=&q=`** (`pageGate`; anything but "write" shows the notice, because the finder is a tool, not records):
  - A GET form with "Brand" (datalist of vacuum brands, optional) and one box "Model, bag type or part number". With a brand, the box is tried as a model, and always as a type or number; the results are merged.
  - When the shop has customers with vacuums: "Or pick a customer's vacuum on the register."
  - Results are grouped as Bags / Belts / Filters / Other parts. Each row shows:
    - name, numbers (mono), evidence pill, and "Close match: {model}" when it came from the prefix fallback;
    - one line per stocked item, "{number} · {n} on hand · bin {loc} · {price}", or "Not stocked";
    - "Details" and "This fits another model", both linking to `/xref/{id}`.
  - Under the results: "New bag", "New belt", "New filter" links to `/xref?category=Vacuum%20bag&fits=Hoover,%20UH70120#add` (and so on).
  - Notes:
    - not joined: "Join the community hub (Settings) to see and share what fits. For now this shows your own parts that list this model in their Fits.";
    - offline: "You're offline. Showing what was last synced. To note a fit for now, add the model to your part's Fits list." with each local result linking to `/parts/{id}`;
    - no results: "Nothing listed for {brand} {model} yet. Add what you know fits: it's shared with every shop on the hub."
- **Register:** `src/components/vac/supply-picker.tsx` (client), with the signature below. Foundation mounts it beside "Repair pickup" when vac is active.

  ```tsx
  export function VacSupplyPicker(p: { customerId: string | null; returnMode: boolean; onAdd: (item: RegisterItem, machineId: string | null) => void }): JSX.Element
  ```

  - It is a button "Bags, belts, filters" that opens a `card card-pad`.
  - With a customer picked: their vacuums as buttons, from `customerVacuums`. Otherwise: Brand and "Model, bag type or part number" boxes and "Look up".
  - The results come from `vacSupplies({ brand, model, text: bagType })` (a customer's vacuum sends its bag type too). Each stocked item has its own "Add", which calls `onAdd(item, machineId of the chosen vacuum or null)`.
  - Rows that aren't stocked show their numbers, and "Open the finder" goes to `/vac/finder?...` in a new tab.
- **`src/components/vac/supplies-that-fit.tsx`** (server): `SuppliesThatFit({ brand, model, bagType, user })`. It renders nothing unless vac is active. It shows a compact list of the first 10 supplies with items, and "All in the finder" (`/vac/finder?...`). It is mounted on VACUUM machine pages only.

**Check** (`scripts/checks/vac-finder.check.ts`, database):
1. Upsert these `XPart` rows with `vck-` ids:
   - a bag fitting Hoover UH70120PC (numbers "Hoover, Type Y" and "EnviroCare, 138SW");
   - a belt fitting Hoover UH70120;
   - a sewing part (category "Bobbin case") fitting the same model key;
   - a Kenmore "Type C" bag.
2. In throwaway company A, create Parts: EnviroCare 138SW (brand EnviroCare), Electrolux "Type C" (brand Electrolux), and a brandless part numbered "1".
3. Assert:
   - `suppliesFor(A, { brand: "Hoover", model: "UH70120" })` returns the belt, and the bag as a close match (UH70120PC), but not the sewing part;
   - the bag's items hold the 138SW part;
   - `{ text: "Type Y" }` finds the bag;
   - the Kenmore Type C entry has no items (the Electrolux part doesn't match it);
   - the part numbered "1" is never an item, even after adding "Generic, 1" to an entry's numbers;
   - the local fallback finds a Part whose `fits` says "Hoover, UH70120" and whose description says "bag";
   - the brand-aware `numberOwner` lets "Type Y" exist under two brands;
   - with 70 matching entries the result is capped at 60, in rank order.
4. **Tenant:** company B's `suppliesFor` never lists A's parts as items, and `customerVacuumsFor(B, A's customer)` answers "Customer not found."
5. Clean up.

### 10.c Vacuum sales and warranty (package `vac-sales-warranty`)

**Rules:**
- A unit is a `StockUnit` plus its `Machine` (equipment VACUUM, kind vacuum). The unit is never in `Part.qtyOnHand` or `StockMove`.
- Statuses:
  - `IN_STOCK` → `SOLD` (register sale) → `IN_STOCK` (register return; `soldLineId` is kept until it sells again);
  - `IN_STOCK` ↔ `REMOVED` (taken off sale, or put back).
- A trade-in creates or reuses the machine and unit as `IN_STOCK`, with `costCents` equal to the credit and no price until an admin prices it. Trade-in credit is never taxable.
- While a unit is in stock, `Machine.customerId` is null (the shop owns it). A sale sets it to the buyer, and a return or a trade-in clears it.
- Warranty (`warrantyEnd(at, months, timeZone)` in `src/lib/vac/units.ts`):
  - the last day is the sale's date **in `Shop.timeZone`** plus `warrantyMonths` calendar months (the day clamped to the month's end);
  - `warrantyUntil` is stored as the start, in shop time, of the day after that last day. Pages show "warranty through {last day}";
  - `warrantyBy` is the maker for NEW and OPEN_BOX, and the shop for REFURB and USED;
  - defaults: 12, 12, 6 and 3 months; all editable.
- Registration with the maker is recorded here (`registeredAt`, `registrationRef`). The shop does the registration on the maker's own site.
- The unit and trade-in forms ask the vacuum's machine-level questions (`IntakeFields` with `required={["bagged"]}`), so every unit sold or traded in says whether it takes bags.
- The equipment and kind come from the kind (`VACUUM_KIND`), not hard-coded, so sewing machines sold new could use the same code later.

**Register integration.** Foundation writes the plumbing; this package fills in the hooks. The hook contract (`src/lib/vac/sale-units.ts`, server) is below. The foundation stub's `prepareUnitLines` throws `UserError("Selling vacuums from stock needs the Vac Shop module.")` if any line has a unit or a trade-in. Its other functions do nothing, and `registerUnitHits` returns `[]`.

```ts
import type { Prisma, SaleLine } from "@/generated/prisma/client";
import type { RegisterItem } from "@/actions/register";
import type { TradeInInput } from "@/lib/vac/types";
export type UnitLineIn = { stockUnitId: string | null; tradeIn: TradeInInput | null; qty: number; unitPriceCents: number; taxable: boolean };
export type UnitLineOut = { description: string; qty: number; unitPriceCents: number; taxable: boolean; discountable: boolean; costCents: number | null; stockUnitId: string | null };
/** Before the sale: check every unit and trade-in line (by index) and fix its wording, price, tax and quantity. Throws UserError. */
export async function prepareUnitLines(a: { shopId: string; role: "OWNER" | "ADMIN" | "TECH"; customerId: string | null; lines: UnitLineIn[] }): Promise<Map<number, UnitLineOut>>;
/** Inside the sale's transaction, right after that line was written. discountShareCents: its share of the whole-sale discount. */
export async function applyUnitLine(tx: Prisma.TransactionClient, a: { shopId: string; saleNumber: number; customerId: string | null; at: Date; timeZone: string; line: SaleLine; tradeIn: TradeInInput | null; discountShareCents: number }): Promise<void>;
/** Inside voidSale's transaction, after the sale is marked void. */
export async function voidUnitLines(tx: Prisma.TransactionClient, a: { shopId: string; saleNumber: number; customerId: string | null; lines: SaleLine[]; at: Date }): Promise<void>;
/** Register scan ("code": serial, exact, case-insensitive) and search ("search": brand / model words): in-stock units as items. [] unless vac is active. */
export async function registerUnitHits(a: { shopId: string; q: string; mode: "code" | "search" }): Promise<RegisterItem[]>;
```

`src/lib/vac/types.ts` (foundation, pure):

```ts
export type TradeInInput = { brand: string; model: string; serial: string | null; machineType: string | null;
  condition: "NEW" | "OPEN_BOX" | "REFURB" | "USED"; bagged: "Bagged" | "Bagless" | null; bagType: string | null };
```

**Per-line rules in `prepareUnitLines`:**

| Line | qty | Required state | Price | Tax | Discount | Description (server-built) |
|---|---|---|---|---|---|---|
| Unit sale | 1 ("A vacuum is one line of 1.") | vac active; unit found by `{ id, shopId, status: "IN_STOCK" }` ("{desc} isn't in stock any more."); a customer picked ("Pick the customer first: a warranty needs the buyer.") | client price; `priceCents` null → "Set a price for {desc} first (Vac Shop → For sale)."; TECH can't change a set price (the `register.ts:191` rule) | from the client | allowed | `{brand} {model} ({condition}) S/N {serial}` |
| Unit return | -1 | **any module state** (money already owed); unit `{ id, shopId, status: "SOLD" }` with `soldLineId`; the original line found by `saleLine.findFirst({ where: { id: soldLineId, sale: { shopId, status: "COMPLETED" } } })` | `soldNetCents ?? lineNet(original)`; an admin may lower it, never raise it ("You can refund at most {x}."); a TECH can't change it | original line's | 0 | `Return: {brand} {model} S/N {serial}` |
| Trade-in | -1 | vac active; customer picked ("Pick the customer trading it in."); brand and model ("Enter the trade-in's brand and model."); "Bags or bagless" answered ("Say whether it takes bags."); credit ≥ 0 | `unitPriceCents` = the credit | **never taxable** | 0; `discountable: false` | `Trade-in: {brand} {model}{ S/N serial}` |

Unit sale lines also get `costCents = unit.costCents`, which gives margins. A line can't be both a unit and a part or repair: "A line can only be one thing."

**`applyUnitLine`** (guarded `updateMany`, as with repairs and consignment; every `where` has `shopId`):
- **Sale:**
  - `stockUnit.updateMany({ where: { shopId, id, status: "IN_STOCK" }, data: { status: "SOLD", soldAt: at, soldLineId: line.id, soldNetCents: lineNet(line) - discountShareCents, returnLineId: null, warrantyUntil, registeredAt: null, registrationRef: null } })`. A count of 0 gives "{desc} was just sold. Take it off this sale."
  - `machine.updateMany({ where: { id: unit.machineId, shopId }, data: { customerId } })`.
  - The event "Sold on sale #N" is recorded.
- **Return:**
  - `updateMany({ where: { shopId, id, status: "SOLD", soldLineId } })` sets `status IN_STOCK, returnLineId`. A count of 0 gives "{desc} was just returned."
  - `customerId` becomes null (`updateMany` with `shopId`).
- **Trade-in:**
  1. With a serial: `machine.findFirst({ where: { shopId, equipment: "VACUUM", serial: { equals: serial, mode: "insensitive" }, modelKey }, include: { stock: true } })`. Without one, or not found: a new Machine (VACUUM, kind vacuum, brand, model, `modelKey`, serial, `machineType`, `details { bagged, bagType }`, no customer).
  2. Its unit `IN_STOCK` or `REMOVED` → "That vacuum is already in your stock."
  3. Its unit `SOLD` (the shop sold it before): push `{ at, note: "Traded in on sale #N", line: line.id, prev: { status, soldAt, soldLineId, soldNetCents, returnLineId, warrantyUntil, registeredAt, registrationRef, customerId, condition, costCents, priceCents, tradeInLineId } }` onto `events`. Then a guarded `updateMany({ where: { shopId, id, status: "SOLD" } })` to `IN_STOCK`, clearing the sale fields and setting condition, `costCents` = credit, `priceCents` null and `tradeInLineId`.
  4. No unit yet: create it (`shopId`, `machineId`, `IN_STOCK`, condition, `costCents` = credit, `tradeInLineId`).
  5. Set `line.tradeInUnitId`, clear `machine.customerId`, and merge `bagged` / `bagType` into `machine.details`.

**`voidUnitLines`:**
- **Sold line:** `updateMany({ where: { shopId, status: "SOLD", soldLineId: l.id } })` → `IN_STOCK`, clearing `soldAt`, `soldLineId`, `soldNetCents`, `warrantyUntil` and registration. Otherwise: "{desc} was returned since this sale; void that return first." `customerId` becomes null.
- **Return line:** `updateMany({ where: { shopId, status: "IN_STOCK", returnLineId: l.id } })` → `SOLD`, `returnLineId` null. Otherwise: "{desc} was sold again since; void that sale first." `customerId` goes back to the original sale's customer (found through `sale: { shopId }`).
- **Trade-in line:** the unit by `{ shopId, id: l.tradeInUnitId, status: "IN_STOCK", tradeInLineId: l.id }`. Otherwise: "The traded-in vacuum was sold since; void that sale first."
  - When its newest event with `prev` has `line: l.id`, `prev` is restored exactly (the unit is Sold again, with its warranty, registration and buyer).
  - Otherwise it becomes `REMOVED`, and `customerId` goes back to `sale.customerId`.

**Screens:**
- **`/vac/units?tab=stock|sold|off|register&q=`**, with the tabs "In stock", "Sold", "Off sale" and "Warranty to register" (SOLD, NEW/OPEN_BOX, `registeredAt` null). Data from `listUnits(shopId, tab, q)`.
  - Table: brand and model, serial, condition, price (cost for admins), status pill, sold date and buyer, warranty through.
  - Search box: serial, brand or model.
  - Admins get an "Add vacuums for sale" form:
    - brand (datalist), model;
    - **serial numbers, one per line** (one unit each; required unless condition is Used: "Enter the serial number. It's on the label; the warranty needs it.");
    - type, condition, "Bags or bagless" (required) and "Bag type";
    - cost, price, warranty months, "Warranty from" (maker or shop, prefilled), note.
  - The "Selling needs the register" card (10.0) when it applies.
- **`/vac/units/[id]`** (`unitDetail(shopId, id)`; null → `notFound()`):
  - `KV` details and history events;
  - links to the sale receipt (`/register/sales/{saleId}`) and to the machine page;
  - admins: edit price, condition, warranty, note, and the vacuum's brand, model, serial and type; "Take off sale" / "Put back on sale";
  - anyone: "Record warranty registration" (date, reference).
- Lapsed: the lists and details are read-only (`pageGate`).

**`src/actions/vac-units.ts`** (`"use server"`; stub by foundation with `unitsForSale` → `[]`, `unitsToReturn` → `[]`; bodies in `src/lib/vac/units.ts`):

| Action | Guard | What it does |
|---|---|---|
| `receiveUnits(fd)` | `safe`, `requireAdmin` + vac | up to 50 serials. Per serial: the scoped machine lookup. It refuses a serial of one of **this shop's** customers' vacuums ("{serial} belongs to a customer's vacuum. Take it in as a trade-in instead.") or one already in stock. It creates the Machine (`customerId` null) and the StockUnit (event "Received"). Redirects to the unit (one) or `/vac/units?tab=stock` (several). |
| `updateUnit(id, fd)` | admin + vac | the unit by `{ id, shopId }`; its fields and its machine's brand, model, serial, type and details |
| `setUnitOffSale(id, off: boolean, fd)` | admin + vac | guarded `updateMany` IN_STOCK ↔ REMOVED, with a reason recorded as an event |
| `recordRegistration(id, fd)` | user + vac | the unit by `{ id, shopId, status: "SOLD" }`; date required and not in the future; ref ≤ 80 characters |
| `unitFromAbandoned(machineId)` | admin + vac | the machine by `{ id, shopId, equipment: "VACUUM" }`, with no unit, whose latest ticket is ABANDONED ("Only a vacuum whose ticket was marked Abandoned can go up for sale."). It creates a USED unit, `costCents` = that ticket's unpaid balance (0 or more), no price. It clears `customerId` and records the event "From abandoned ticket #{n}". |
| `unitsForSale(q)` | data action, user + vac active | up to 20 IN_STOCK units: `{ id, description, priceCents, serial, condition }` |
| `unitsToReturn(q)` | data action, user; any module state | SOLD units by serial, brand, model or buyer: `{ id, description, refundCents }` |

**Register UI** (`src/components/vac/unit-tools.tsx`, client):

```tsx
export function VacUnitTools(p: { vac: "on" | "readonly"; returnMode: boolean; customerId: string | null;
  inCart: { stockUnitId?: string }[]; onAdd: (line: VacCartLine) => void; onNeedCustomer: () => void }): JSX.Element
```

- Not in return mode, with vac "on":
  - "Vacuum for sale" (search, then "Add {price}");
  - "Trade-in" (form: brand, model, serial, type, condition, bags or bagless, bag type, credit, then "Add trade-in").
  - Both need a customer first: without one they show "Pick or add the customer first." with a "New customer" button that calls `onNeedCustomer()`.
- In return mode ("on" or "readonly"): "Return a vacuum" (search SOLD units, then "Refund {x}").
- A unit already in the cart is disabled.

Scanning a serial, or typing a vacuum's brand and model in the register's search, also finds in-stock units: `itemByCode` and `findItems` include `registerUnitHits` (foundation plumbing, section 13.4).

**Slots** (server):
- `UnitBadge({ machineId, user })` loads the unit by `{ machineId, shopId: user.shopId }`. It shows "In stock · $499", or "Sold here Oct 3, 2026 · warranty through Oct 3, 2027 (Miele) · registered Oct 5", or "Traded in on sale #1042", linking to the unit. When the machine has no unit and its latest ticket is ABANDONED, admins get **Put up for sale** (`unitFromAbandoned`).
- `SaleUnitNotes({ saleId, shopId })` on the receipt, under the lines. Its query is scoped with `sale: { shopId }`. It shows "{desc}: warranty through {date} from {by}. Keep this receipt." and, for trade-ins, "Trade-in credit: {x}".

**Check** (`scripts/checks/vac-units.check.ts`, database, throwaway company with vac granted through `grantDevLicense`). It calls the hooks inside `db.$transaction` with real `Sale` and `SaleLine` rows:
1. receive a unit (and two more from a two-line serial box);
2. sell it: SOLD, warranty through the same day a year on, buyer set;
3. sell it again: the guard throws;
4. return: IN_STOCK;
5. void the return: SOLD;
6. void the sale: "void that return first";
7. **discount share:** a $500 unit and $20 of bags with a $52 whole-sale discount store `soldNetCents` 45000, and a return refunds at most $450.00;
8. trade-in of a new vacuum creates the machine and an IN_STOCK unit with cost equal to the credit, and the line is not taxable;
9. **trade back:** trading in the unit sold in step 2 puts it IN_STOCK; voiding that trade-in restores SOLD with the same buyer, warranty and registration;
10. void a plain trade-in: REMOVED;
11. **warranty in shop time:** a sale at 8 pm on Jan 31 in America/Chicago (02:00 UTC Feb 1) with 12 months is "through Jan 31" of the next year; with 1 month, through Feb 28 (or 29).

It then checks the module gate:
- with the key switched to a lapsed window, `prepareUnitLines` refuses a sale and a trade-in but allows a return;
- a TECH changing a set price is refused.

**Tenant:** with a second company B:
- `receiveUnitsFor(B, …)` with A's serial creates a new Machine in B;
- `updateUnitFor`, `recordRegistrationFor`, `unitDetail` and `unitFromAbandonedFor` with A's ids answer "not found" (or null);
- `prepareUnitLines` for B with A's unit id answers "isn't in stock any more";
- a trade-in at B whose serial matches A's sold unit leaves A's unit SOLD.

### 10.c′ Bags due (package `vac-bags-due`)

This runs after design.md's foundation, because it sends through Marketing.

**Who's due.** `bagsDue(shopId, now)` in `src/lib/vac/bags-due.ts` considers a vacuum when all of these hold:
- `equipment VACUUM`, with a customer;
- `details.bagged === "Bagged"` (a vacuum nobody said takes bags is never listed);
- no `VacCare.stopped`, and `snoozedUntil` is not in the future.

**Looks like bags:** a line whose part's `numberKeys` meet an `XPart` with category "Vacuum bag", or whose description matches `/\bbags?\b/i`.

**Base date:** the latest of:
- the unit's `soldAt` (a StockUnit SOLD for this machine);
- the newest COMPLETED sale line (qty > 0) with `SaleLine.machineId` = this machine that looks like bags;
- the newest PART line that looks like bags on one of this machine's tickets (bags sold with a repair);
- the newest COMPLETED sale line (qty > 0) that looks like bags on a sale to this customer with no `machineId`, **when the customer has exactly one bagged vacuum**.

A machine with none of these is not listed; bags-due is for buyers.

**Due and listed:**
- due = base + `Shop.bagReminderDays` days;
- listed when due ≤ now + 14 days, and not contacted since due - 14 days;
- "bag to offer" = the first "Vacuum bag" supply with an item, from `suppliesFor(shopId, { brand, model, text: details.bagType })`. `finder.ts` is a foundation stub, so this compiles whichever package lands first.

**`/vac/bags-due`:**
- A table: customer (link), phone, vacuum, bag type, last bags, due (a "due soon" or "overdue" pill), bag to offer.
- Per row: "Called" (records `contactedAt` and `contactedBy` = user name, plus an optional note), "Snooze 30 days", "Stop reminders".
- Settings form (admin): "Days between bags" (30-730) (`Shop.bagReminderDays`).
- **With Marketing active:** "Send reminders to the {n} due now" (admin).
  - It queues through `queueToCustomer`: kind `bags_due`, channels `"one"`, dedupe `bags_due:{machineId}:{due ymd}`, `refType "machine"`, `refId machineId`.
  - It sets `contactedAt` and `contactedBy "message"` **only on rows where something was queued**. The toast says "Queued {q}. {s} have no consent or no address: they stay on the list to call."
- **Without Marketing:** the copy "This is your call list. With the Marketing module, these can go out by email or text."
- Lapsed vac: read-only.

**Exports of `src/lib/vac/bags-due.ts`** (stub by foundation):
- `bagsDue(shopId, now)` and `bagsDueCount(shopId)` (stub: `[]` and 0);
- `runBagsDue(now, shopIds)`: **does nothing in this build** (automatic sending is cut). It stays exported because design.md's `notices` calls it from `runSchedulers`;
- `bagsDueStillWanted(row: { shopId: string; refId: string | null; createdAt: Date }): Promise<string | null>`, for design.md's `stillWanted` (section 12.4). It returns a reason to cancel a queued `bags_due` message: vac not active ("Vac Shop is off"), the machine gone or not this shop's ("The vacuum is gone"), `VacCare.stopped` ("Reminders stopped"), snoozed ("Snoozed"), or a bag purchase for that vacuum after `createdAt` ("They bought bags"). Otherwise null. The stub returns null.

**Actions** (`src/actions/vac-bags-due.ts`; bodies in `bags-due.ts`; each `requireUser` (admin for the settings form and "Send") + `requireModule(user, "vac")`):
- `markCalled(machineId, fd)`, `snoozeBags(machineId)`, `stopBags(machineId)`, `saveBagDays(fd)`, `sendBagReminders()`.
- Each per-machine action first runs `machine.findFirst({ where: { id: machineId, shopId: user.shopId, equipment: "VACUUM" } })` ("Vacuum not found."). Then `vacCare.upsert({ where: { machineId }, create: { machineId, shopId: user.shopId, … }, update: { … } })`, refusing first if an existing row's `shopId` differs.

**`bags_due` message kind.** design.md's `foundation` adds it (the final design.md has it: §3.1, §5, `MESSAGE_KIND_LABEL`). Fields: `[...COMMON_FIELDS, "machine", "months", "bag_line"]`. `bag_line` is " We have {bag} in stock." or "". The default copy is (section 12.4, item 1):
- `bags_due.sms`: `Hi {first_name}, time for new bags for your {machine}?{bag_line} Call {shop_phone} or stop by.`
- `bags_due.subject`: `Time for new bags for your {machine}?`
- `bags_due.email`: `Hi {first_name},\n\nIt's about time for new bags for your {machine}.{bag_line}\n\nCall us at {shop_phone} or stop by.`

**Check** (`scripts/checks/bags-due.check.ts`): a bagged unit sold 200 days ago is due with the 180-day default. Then:
- a bag bought 10 days ago for that vacuum clears it, and so does a bag PART line on its repair ticket;
- a bag bought on a sale with no vacuum picked clears it when the customer has one bagged vacuum, and doesn't when they have two;
- snooze hides it, and stop hides it;
- a unit whose `bagged` is empty or "Bagless" is never listed;
- `sendBagReminders` queues one row per due machine only when vac and Marketing are both active, and marks contacted only the rows that queued;
- a second send queues nothing (dedupe);
- `bagsDueStillWanted` cancels after "Stop reminders" and after vac lapses;
- **tenant:** company B's `markCalledFor`, `snoozeBagsFor` and `stopBagsFor` with A's machine answer "Vacuum not found." and leave A's `VacCare` as it was.

### 10.d Central vac installs (package `central-vac-installs`)

This runs after design.md's foundation, for `src/lib/zoned.ts` (`rangeFromForm`, `fmtRange`).

**Data:**
- A SITE ticket (`jobType "SITE"`) plus `TicketSite`.
- The ticket's machine is the installed power unit: VACUUM, kind vacuum, `machineType "Central"`, `customerId` = the homeowner. That unit is what later service visits, warranty and bags-due attach to.
  - When the power unit isn't chosen yet, the machine is created as brand "Central vac", model "Power unit to be chosen". The Site panel's "Set the power unit" (brand, model, serial) updates it later.
- Money uses the existing lines and payments:
  - hours are LABOR lines;
  - parts used are PART lines, which move stock;
  - the invoice, `/invoices`, `/sales` and CSVs include it as they are.
- Statuses (`SITE_STATUS_ORDER` / `SITE_STATUS_LABEL`):
  - Quote sent → Booked → Waiting on parts → In progress → Completed / Cancelled.
  - A new install starts **Booked** (AT_SHOP_AWAITING_PICKUP), or **Quote sent** (WAITING_CUSTOMER_OK) when "Quote first" is ticked.
  - A Booked install with no date shows "Booked · not scheduled".
  - Completed is COLLECTED: it sets `closedAt` and `warrantyUntil` (`Shop.warrantyDays`) through the normal `setStatus`.
  - An approved estimate moves a SITE ticket to Booked, not In progress (section 12.4, item 4).
- Installs never enter the bench views (the `jobType BENCH` filters in 9.4) or the partner code.
- The ticket gate applies (section 6.3): an install booked before Vac Shop ended can still be completed, with its hours and parts.

**`src/lib/vac/installs.ts`** (server; stub by foundation):

```ts
export const INSTALL_CHECKLIST: string[];   // stub: []; package: the list below
export type SiteCalItem = { id: string; start: Date; end: Date; title: string; sub: string | null; href: string; tone: "work" | "done" | "bad" };
/** Installs with a start inside [from, to) for the Scheduling calendar. Empty when Vac Shop is off (read-only records still show). */
export async function siteJobsBetween(shopId: string, from: Date, to: Date): Promise<SiteCalItem[]>;   // stub: []
export async function createSiteJob(tx: Prisma.TransactionClient, a: { shopId: string; userId: string; customerId: string;
  address: string; startsAt: Date | null; endsAt: Date | null; contactName: string | null; contactPhone: string | null;
  accessNotes: string | null; quoteFirst: boolean; unit: { brand: string; model: string; serial: string | null } | null;
  serviceItemId: string | null; notes: string | null }): Promise<{ ticketId: string; number: number }>;   // stub: throws "Coming in this update."
```

- `INSTALL_CHECKLIST`:
  - Power unit spot agreed with the customer
  - Inlets placed and marked
  - Pipe run planned (attic, basement, crawl space)
  - Pipe glued and strapped, no leaks
  - Low-voltage wire run to every inlet
  - Power unit mounted, on its own outlet
  - Exhaust vented outside
  - Every inlet tested (suction and switch)
  - Hose and tools shown to the customer
  - Site cleaned up
- `SiteCalItem.title` is "Install: {customer}", `sub` is the address, `href` is `/tickets/{id}`, and the end defaults to start + 2 h.
- `createSiteJob` makes the Machine and the Ticket (`takeTicketNumber`, status per `quoteFirst`, `jobType SITE`, `serviceRequested` "Central vac install", a SERVICE line from the item) and the `TicketSite`.

**`src/actions/vac-installs.ts`** (`safe`; bodies in `installs.ts`):

| Action | Rules |
|---|---|
| `createInstall(fd)` | `requireUser` + vac (new work). Customer picked (by `{ id, shopId }`) or new (name plus phone or email: "Enter the customer's name and a phone or email."). Address required ("Enter where the install is."), defaulting to the customer's address. `rangeFromForm(fd, tz)` optional (no date = not scheduled yet). Power unit optional. "Quote first" checkbox. Service item from the vacuum menu (`servicesFor`). Redirects to `/tickets/{id}`. |
| `saveSite(ticketId, fd)` | `requireUser`; the ticket by `{ id, shopId, jobType: "SITE" }` ("Install not found."); the ticket "work" check (section 6.3); the same site fields |
| `setPowerUnit(ticketId, fd)` | same lookup and check; brand and model required; updates the ticket's machine with `updateMany({ where: { id: t.machineId, shopId } })` |

**Screens:**
- **`/vac/installs?tab=upcoming|done|all`** (`listInstalls(shopId, tab)`): a table of when (`fmtRange` in shop time, or "Not scheduled"), customer, address, power unit, status (SITE label); plus a "New install" button (vac active).
- **`/vac/installs/new`:** the form.
- **`SitePanel({ ticketId, user, readOnly })`** on the ticket page. It loads the site by `{ ticketId, shopId: user.shopId }` and shows:
  - the address, with a maps link `https://www.google.com/maps/search/?api=1&query=`;
  - the window (or "Not scheduled"), contact and access notes;
  - `<details>` "Change" (the `saveSite` form) and "Set the power unit" (the `setPowerUnit` form), hidden when `readOnly`.
- **`SiteInvoiceBlock({ ticketId, shopId })`** on the invoice: "Work done at {address}" and the dates.

**Scheduling interplay.** When Scheduling is on, installs with a start appear on `/calendar` (section 12.4, item 3; `appointments` owns the calendar, and `modules-crossover` checks it). Without Scheduling, the install list and each ticket carry the dates.

**Check** (`scripts/checks/vac-installs.check.ts`):
- `createSiteJob` creates a ticket with `jobType SITE`, a TicketSite and a Central machine; with no unit, the placeholder machine;
- `quoteFirst` starts it at WAITING_CUSTOMER_OK;
- the dashboard's open-ticket query (`jobType BENCH`) doesn't return it;
- `siteJobsBetween` returns it for the day, and nothing when vac is off;
- the SITE status rule refuses READY_FOR_PICKUP;
- after vac lapses, `saveSiteFor` on an install booked before the end still works, and `createInstallFor` is refused;
- **tenant:** company B's `saveSiteFor` and `setPowerUnitFor` with A's ticket answer "Install not found."

---

## 11. Small Appliance Repair module (`appliance`, package `appliance-repair`)

### 11.1 Built-in kinds (`src/lib/equipment/appliances.ts` exports `APPLIANCE_KINDS`)

All four kinds share: equipment APPLIANCE, module `appliance`, panels off, `links: genericLinks(noun)`. Their menus carry no prices unless the owner supplies suggested ones (`priceCents`), so they are added switched off at $0 (section 9.5).

**Stand mixer** (`stand-mixer`; label "Stand mixer", plural "Stand mixers", noun "stand mixer"; modelHint "e.g. KSM150PS"):
- **Types:** Tilt-head, Bowl-lift, Center-drive (Bosch), Open-bowl (Ankarsrum), Other.
- **Brands:** KitchenAid, Bosch, Kenwood, Ankarsrum, Cuisinart, Hamilton Beach, Sunbeam, Breville, Smeg.
- **Accessories:** Bowl, Flat beater, Dough hook, Wire whip, Pouring shield, Bowl cover, Attachments. `defaultChecked: ["Bowl"]`.
- **Machine fields:** `bowl` "Bowl size" (select: 3.5 qt, 4.5 qt, 5 qt, 5.5 qt, 6 qt, 7 qt, Other), `color` "Color" (text).
- **Ticket fields:** `grease` "Leaking grease" (checkbox), `noise` "Noise or grinding" (checkbox).
- **Checklist:**
  - Old grease removed, gearbox cleaned
  - Worm gear and worm follower gear checked (replaced if worn)
  - Regreased with food-grade grease
  - Planetary height set (dime test, planetary mixers)
  - Speed control checked and adjusted
  - Motor brushes checked
  - Attachment hub checked
  - Cord and switch checked
  - Test run at every speed
  - Cleaned outside
- **Menu:**
  - Mixer service: grease repack and adjust
  - Worm gear / worm follower gear replacement
  - Planetary height adjustment (dime test)
  - Speed control repair
  - Motor brushes
  - Motor replacement
  - Diagnosis & estimate
- **Readings:**
  - `dime` "Dime test (planetary mixers)", passfail, found/left;
  - `speeds` "Runs smoothly at every speed", passfail, found/left.

**3D printer** (`3d-printer`; label "3D printer", plural "3D printers", noun "3D printer"; modelHint "e.g. MK4, X1C, Ender-3 V3"): filament (FDM) printers.
- **Types:** Bed-slinger, CoreXY, Other.
- **Brands:** Prusa, Bambu Lab, Creality, Anycubic, Elegoo, Voron, Ultimaker, Flashforge, Sovol, Qidi.
- **Accessories:** Power cord / brick, Build plate, Spool holder, AMS / MMU unit, Filament, SD card / USB stick, Tool kit, Enclosure. `defaultChecked: ["Power cord / brick", "Build plate"]`.
- **Machine fields:** `mods` "Changes from stock (mods)" (text), `nozzle` "Nozzle size" (select: 0.2, 0.4, 0.6, 0.8, Other).
- **Ticket field:** `filament` "Filament in use" (select: PLA, PETG, ABS / ASA, TPU, Nylon, Other).
- **Checklist:**
  - Nozzle and hotend checked (clog, wear, leaks)
  - PTFE tube checked or replaced
  - Extruder gears cleaned, tension set
  - Belts tension checked
  - Bed levelled / mesh calibrated, Z offset set
  - Rails, rods and wheels cleaned and lubricated
  - Fans checked (hotend and part cooling)
  - Wiring and connectors checked
  - Firmware version recorded (updated if agreed)
  - Test print done
- **Menu:**
  - Printer tune-up (clean, belts, level, test print)
  - Nozzle / hotend replacement
  - Clogged hotend service
  - PTFE tube replacement
  - Bed levelling and calibration
  - Belt replacement or tensioning
  - Extruder gear service
  - Firmware update
  - Mainboard / wiring diagnosis
- **Readings:**
  - `firmware` "Firmware version", text, found/left;
  - `testprint` "Test print", passfail, found/left.

**Resin 3D printer** (`resin-printer`; label "Resin 3D printer", plural "Resin 3D printers", noun "resin printer"; modelHint "e.g. Mars 4, Photon Mono"):
- **Types:** MSLA, DLP, Other.
- **Brands:** Elegoo, Anycubic, Phrozen, Formlabs, Creality, Uniformation.
- **Accessories:** Power cord / brick, Build plate, Resin vat, Wash & cure station, FEP film (spare). `defaultChecked: ["Power cord / brick", "Build plate", "Resin vat"]`.
- **Ticket field:** `resin` "Resin in use" (select: Standard, ABS-like, Water-washable, Tough, Other).
- **Checklist:**
  - FEP / release film checked or replaced
  - LCD exposure test done
  - UV light source checked
  - Build plate levelled
  - Z-axis lead screw cleaned and lubricated
  - Vat checked for leaks
  - Firmware version recorded
  - Test print done
- **Menu:**
  - FEP film replacement
  - LCD screen replacement
  - UV light board replacement
  - Build plate levelling
  - Z-axis service
  - Firmware update
  - Diagnosis & estimate
- **Readings:**
  - `firmware` "Firmware version", text, found/left;
  - `exposure` "LCD exposure test", passfail, found/left;
  - `testprint` "Test print", passfail, found/left.

**Other small appliance** (`other`; label "Other appliance", plural "Other appliances", noun "appliance"; modelHint "Model number from the label"):
- **Types:** Espresso machine, Blender, Stand fan, Food processor, Coffee grinder, Toaster oven, Air fryer, Other.
- **Brands:** none. **Accessories:** Power cord, Parts in the box.
- **Checklist:**
  - Safety check: cord, plug, switch
  - Fault found and fixed
  - Cleaned inside and out
  - Test run
- **Menu:** Diagnosis & estimate, Small appliance repair.
- No intake fields or readings.

### 11.2 "What you repair" (`/settings/equipment`; stub by foundation, owner `appliance-repair`)

**Access.** The page is shown when vac or appliance is not off (otherwise the notice). Admins edit. Techs, and a lapsed appliance module, get a read-only view.

**Page.** Header "What you repair", sub "The kinds of things you check in, and what each one asks for."
1. **"Check-in opens on"**: a select of the usable kinds (`Shop.checkInKind`), with the hint "The check-in page starts on this. You can still pick another kind there."
2. **Built-in kinds** (the usable ones): one `<details>` each, read-only: types, accessories (ticked ones marked), check-in questions, checklist, readings, and the starter menu. The line under them: "These lists are built in. Add your own kind below if you need something different."
3. **Your own kinds** (appliance active to add or change; otherwise read-only). Each kind is a `<details>` with a form:
   - Label; "Word used in sentences" (the noun).
   - Types, one per line. Brands, one per line.
   - Accessories, one per line: "start a line with * to tick it at check-in".
   - Checklist, one per line.
   - **Check-in questions**, as rows (no client JavaScript; the server reads the `q.*` arrays by index):
     - Question (`q.label`, text);
     - Answer type (`q.type`, select: Text, Number, Choice, Yes / no);
     - Choices (`q.options`, text, "separate with commas", for Choice);
     - Asked (`q.on`, select: Once per unit, Every visit);
     - Remove (`q.remove`, checkbox).

     Existing questions carry a hidden `q.key`, so relabelling keeps their answers. Three blank rows follow; saving with all three filled shows three more.
   - Active.
4. **"Add your own kind"** (appliance active): a label and a noun plus the same boxes. The key is the slug of the label, unique ("You already have a kind called {label}.") and never a built-in key.

**`src/lib/equipment/lines.ts`** (pure):

```ts
export function readListBox(text: string, max = 100): string[];                 // one per line, trimmed, <= 120 chars each, de-duplicated
export function readAccessoryBox(text: string): { accessories: string[]; defaultChecked: string[] };   // "*" prefix = ticked
export function accessoryBoxText(k: { accessories: string[]; defaultChecked: string[] }): string;
export function readQuestionRows(fd: FormData, prev: FieldDef[]): FieldDef[];
// rows by index from q.label / q.type / q.options / q.on / q.remove / q.key; blank label = skipped; key = q.key when it is in prev,
// else slug(label) made unique; UserError "Question {n}: {problem}" (a choice question with no choices, more than 20 choices,
// a label over 120 characters); at most 30 questions
```

**`src/actions/equipment.ts`** (`safe`; bodies in `src/lib/equipment/shop-kinds.ts`):
- `saveEquipmentKind(key: string | null, fd)`: `requireAdmin` + `requireModule(user, "appliance")`. The row by `{ shopId, key }`; a new key creates a row for this shop only.
- `setKindActive(key, active)`: same guard. A kind with open tickets can be made inactive: it disappears from check-in, and existing tickets keep rendering.
- `saveCheckInKind(fd)`: `requireAdmin`; the kind must be usable ("Pick one of the kinds you can check in.").

After a save: `revalidatePath("/settings/equipment")`, `revalidatePath("/tickets/new")` and `revalidatePath("/")`.

**Check** (`scripts/checks/equipment-lines.check.ts`, pure plus one database section):
- `readListBox` and the accessory box round trip;
- `readQuestionRows` keeps a question's key when it is relabelled, gives new rows unique keys, and reports the row number of a bad row;
- `shopKind(row)` uses only its own lists and has no readings;
- **tenant:** `saveEquipmentKindFor(B, "espresso-machine", …)` when A has that key creates B's own row and leaves A's row as it was.

### 11.3 Behaviour

- Appliance tickets are ordinary tickets: kind chips, check-in, the ticket page with its readings, the invoice, model pages with generic quick links, manuals by brand and model (local manuals and hub links work as they are), gotchas and photos.
- `DOC_TYPES` "Firmware" helps 3D printers.
- Module ended: the kinds disappear from check-in; appliance tickets opened before the end can be finished; the rest are closing-only (D3).

---

## 12. Scheduling and Marketing: how they use the gate

`design.md` was finalized after revision 1 of this document. It already carries most of revision 1's section 12.4 (noted below). This section is written against that final version.

### 12.1 Their adapter maps onto this API unchanged

`design.md` §6.1 `src/lib/module-gate.ts` maps as follows:

| Their call | Maps to |
|---|---|
| `moduleOn(shopId, key)` | `hasModule(shopId, key)` |
| `requireOn(user, key)` | `requireModule(user, key)` (accepts the `CurrentUser`; the thrown message is `blockedMessage(state, user.role !== "TECH")`) |
| `shopsWith(key, shopIds?)` | `shopsWithModule(key, shopIds)` (three queries whatever the number of companies) |
| `gates(shopId)` | may use `navGates(shopId)` for the status part and add their data check |

- **`ModuleOff`** (their `src/components/module-off.tsx`) renders `<ModuleNoticeFor shopId={user.shopId} module={module} what={what} admin={user.role !== "TECH"} />`.
- **The Settings href** is `SETTINGS_MODULES_HREF` (`/settings/modules`).
- **Tests:** their `scripts/checks/lib.ts` switches modules on with `grantDevLicense(shopId, [...])` from `scripts/license/dev.ts`. Their `tests/helpers/modules.ts` `setModule(page, company, key, on)` drives the Companies form through the labels in section 8, which are unchanged.
- **Their test servers work as written** (design.md §16.3: `STITCH_TEST_BUILD=1 npm run build`, then `next start` against a local database). Section 3.3 keeps that working, and makes it inert on the hosted app and the Windows program.

### 12.2 Nav and layout

Foundation already provides `Item.module`, the `gates` prop, the lock icon and `getModules` in the layout (section 6.7). design.md's foundation adds its items (`/calendar`, `/classes`, `/shifts`, `/messages`, `/campaigns`) and merges its gates as shown in section 6.7.

### 12.3 Gate points: design.md §6.3 is authoritative for their packages

The table in design.md §6.3 matches the behaviour matrix in section 6.4. Their bookings follow "money already owed: always allowed", the same rule as vacuum returns here. "Work already in can be finished" (D3) applies to tickets and installs; they need nothing new for it, because `ownTicket` does it.

### 12.4 Cross-module gate points

Each item names its file and that file's owner in design.md. "In design.md" means the final design.md already has it; `modules-crossover` only checks it. "Missing" means `modules-crossover` adds it (section 13.2), after every design.md feature package has landed.

1. **`bags_due` message kind** (design.md `foundation`: `messaging/types.ts`, `messaging/templates.ts`, `MESSAGE_KIND_LABEL`). **In design.md**, except the default copy. design.md still has "it's been about {months} months since you got bags", which is wrong right after a vacuum sale.
   - **Missing:** in `src/lib/messaging/templates.ts` `DEFAULT_TEMPLATES`, replace `bags_due.sms` and `bags_due.email` with the text in section 10.c′. `bags_due.subject` is already right.
2. **Scheduler hook** (`notices`, `src/lib/notices/scheduler.ts`): `await runBagsDue(now, shopIds);`. **In design.md.** It does nothing in this build (automatic sending is cut), and nothing needs to change.
3. **Calendar** (`appointments`, `src/lib/calendar.ts` and the week and day views): `CalItem["kind"]` includes `"install"`, and the last push in `calendarItems` is `items.push(...(await siteJobsBetween(shopId, from, to)).map((s) => ({ kind: "install" as const, ...s })));`. **In design.md.** `siteJobsBetween` applies the vac gate itself, so the calendar adds no module check.
4. **Estimate approval of an install, and of a ticket whose module has ended** (design.md `foundation`, `src/lib/estimate-answer.ts` `answerTicketEstimate`). **Missing.** In the APPROVED branch:

   - Before the existing `changeTicketStatus(tx, …, "ON_BENCH", …)` call, load `const site = (await tx.ticket.findFirst({ where: { id: <ticket id>, shopId: <its shopId> }, select: { jobType: true } }))?.jobType === "SITE";` (the ids the function already has).
   - Wrap that call in `if (await ticketWorkable(<its shopId>, <ticket id>)) { … }`, and replace its `"ON_BENCH"` with `site ? "AT_SHOP_AWAITING_PICKUP" : "ON_BENCH"`. Keep every other argument as it is.
   - The answer, `approvedCents` and the notes line are written either way.

   An approved install quote becomes "Booked", not "In progress". A ticket that can no longer be worked on records the answer, and its status stays for staff to decide.
5. **Sending an estimate** (`estimate-links`, `src/actions/estimate-links.ts` `sendEstimate`). **Missing.** For target `"ticket"`, right after `requireOn(user, "marketing")`:

   ```ts
   const g = await db.ticket.findFirst({ where: { id, shopId: user.shopId }, select: { intakeAt: true, status: true, machine: { select: { equipment: true } } } });
   if (g) await requireEquipment(user, g.machine.equipment, { ticket: g, closing: true });
   ```

6. **`{machine}` on installs** (`notices`, `src/lib/notices/vars.ts` `ticketVars`). **Missing.** `machine` is "central vac install" when the ticket's `jobType` is `"SITE"` (not "Central vac Power unit to be chosen").
7. **Queued bags-due messages** (`notices`, `src/lib/notices/hooks.ts` `stillWanted`). **Missing.** First statement: `if (row.kind === "bags_due") return bagsDueStillWanted(row);` with `import { bagsDueStillWanted } from "@/lib/vac/bags-due";`.
8. **Service due** (design.md `foundation` `src/lib/messaging/service-due.ts`, and `notices`): `machinesDue` returns `equipment` and reads BENCH tickets only; `notices` skips machines whose equipment isn't workable (`canWorkOn(shopId, equipment)`) and SITE tickets. **In design.md.** The `service_due.email` text already says "running smoothly".
9. **`setStatus` / `createTicket` refactor** (design.md §7.2). **In design.md:** `ownTicket(user.shopId, ticketId, CLOSING_STATUSES.includes(status) ? "close" : "work")` and the SITE status check stay in front of `changeTicketStatus`, and the kind gating in `createTicket` stays. `modules-crossover`'s check confirms it.
10. **Register** (`register-bookings`, design.md §12.3). **In design.md:** it keeps the unit fields and the hook calls. Its client `discountable` expression becomes `!l.repairJobId && !l.tradeIn && !l.enrollmentId && !l.appointmentId`. Revision 2 adds `discountShareCents`, `timeZone`, `registerUnitHits` and `quickAddCustomer` to foundation's plumbing (section 13.4); `register-bookings` edits on top of it and keeps them.
11. **Ready, abandon and review notices** skip SITE tickets. **In design.md.**

---

## 13. Packages

### 13.1 Order

```
modules-foundation
   ├── design.md foundation ──┬── notices, estimate-links, campaigns, classes, appointments, register-bookings, shifts, partner-runs
   │                          ├── vac-bags-due
   │                          └── central-vac-installs
   ├── vac-repair
   ├── vac-finder
   ├── vac-sales-warranty
   └── appliance-repair
modules-crossover   (after every design.md feature package, vac-bags-due and central-vac-installs)
modules-e2e         (after everything, including design.md's e2e-docs)
```

**Every package:**
- runs `npx prisma generate` after pulling foundation;
- keeps `npx tsc --noEmit` and `npx eslint <its files>` clean;
- keeps `tests/smoke.spec.ts` passing unchanged;
- edits no file outside its own, except its listed shared edits;
- adds a **tenant section** to its own check script, using `scripts/checks/tenant.ts` (foundation). Company B calls each of the package's new lib bodies and page loaders with company A's ids, and every call answers "not found" (or returns null / `[]`) and leaves A's rows unchanged.

The feature server for Playwright is a **test build** on port 3500: `STITCH_TEST_BUILD=1 npm run build && npx next start -p 3500`, with `DATABASE_URL` on localhost, as in design.md §16.3. `next dev -p 3500` also works. Never use ports 3100, 3400, 8080, 6733 or 7975.

### 13.2 Packages: what each owns, shared edits, acceptance

"Owns" lists every file the package creates or edits. A stub from section 13.3 counts as the owner's file.

#### `modules-foundation`

**Depends:** nothing. It goes first and alone.

**Owns:**
- **Schema and data:** `prisma/schema.prisma` (edit), `prisma/migrations/20260926120000_paid_modules/migration.sql`, `prisma/seed.ts` (edit), `src/lib/shops.ts` (edit), `src/lib/service-menu.ts` (edit: `starterKindFor`).
- **Licensing:**
  - `src/lib/license.ts`, `src/lib/license-keys.ts`, `src/lib/license-signing.ts`, `src/lib/module-info.ts`, `src/lib/modules.ts`, `src/lib/modules-admin.ts`, `src/lib/licenses.ts`;
  - `src/actions/licenses.ts`, `src/actions/companies.ts` (edit);
  - `src/app/(app)/companies/page.tsx` (edit), `src/app/(app)/settings/modules/page.tsx`;
  - `src/components/module-notice.tsx`, `src/components/module-banner.tsx`, `src/components/copy-button.tsx`, `src/components/nav.tsx` (edit), `src/app/(app)/layout.tsx` (edit).
- **Hub writes and platform-admin protection:** `src/lib/hub-writes.ts`, `src/actions/hub.ts` (edit), `src/actions/shared.ts` (edit), `src/actions/partners.ts` (edit: `byPlatformAdmin: true` on its `createShopWithOwner` call).
- **CLI:** `scripts/license/cli.ts`, `keygen.ts`, `issue.ts`, `dev.ts`, `resign-grants.ts`, `scripts/license/dev-key.json`, `.gitignore` (edit), `package.json` (edit: the `license` and `license:keygen` scripts).
- **Config and docs:** `next.config.ts` (edit: `env.STITCH_TEST_BUILD`), `.env.example` (edit: `LICENSE_HOSTED_KEY`, `LICENSE_HOSTED_KID`, one comment each), `INSTALL.md` (edit: "Paid modules" section, including the rollout checklist and the test-build note).
- **Windows program:** `desktop/main.mjs` (edit), `desktop/backup.mjs` (edit).
- **Equipment framework:**
  - `src/lib/equipment/types.ts`, `index.ts`, `sewing.ts`, `shop.ts`, `gate.ts`, `form.ts`, `ticket-data.ts`, `convert.ts`;
  - `src/lib/ticket-number.ts`, `src/lib/vac/types.ts`;
  - `src/components/equipment/kind-chips.tsx`, `intake-fields.tsx`, `readings-panel.tsx`, `details-list.tsx`;
  - `src/components/vac/vac-tabs.tsx`.
- **Existing code (edits):**
  - actions and routes: `src/actions/tickets.ts`, `records.ts`, `scan.ts`, `settings.ts`, `src/app/api/photos/route.ts`, `src/app/api/export/[what]/route.ts`;
  - pages under `src/app/(app)/`: `tickets/new/page.tsx`, `tickets/[id]/page.tsx`, `tickets/[id]/invoice/page.tsx`, `tickets/page.tsx`, `page.tsx`, `machines/page.tsx`, `machines/[id]/page.tsx`, `models/[brand]/[model]/page.tsx`, `settings/page.tsx`;
  - components: `src/components/model-panel.tsx`, `machine-info.tsx`, `ticket-controls.tsx`, `ui.tsx`;
  - lib: `src/lib/constants.ts`, `src/lib/model-info.ts`.
- **Register plumbing (edits):** `src/actions/register.ts`, `src/lib/register-math.ts`, `src/components/register.tsx`, `src/app/(app)/register/page.tsx`, `register/sales/page.tsx`, `register/sales/[id]/page.tsx`.
- **Stubs:** every file in 13.3 (created as stubs; ownership passes on).
- **Checks and tests:** `scripts/checks/license.check.ts` (= `modules-license-check.ts`), `scripts/checks/modules.check.ts`, `scripts/checks/equipment.check.ts`, `scripts/checks/modules-tenant.check.ts`, `scripts/checks/tenant.ts`, `tests/helpers/license-keys.ts` (exports `devKey(opts)` = `devLicenseKey`, and `pasteKey(page, key)`), `tests/modules-basics.spec.ts`.

**Shared edits:** none. It lands first; later edits to these files are listed in 13.4.

**Acceptance:**
1. **Schema and migration.**
   - After `npx prisma format`, `prisma/schema.prisma` is identical to `modules-schema.prisma`, and `migration.sql` is identical to `modules-migration.sql`.
   - `npx prisma migrate deploy` applies it on `stitchbench_feat`.
   - Afterwards `SELECT count(*) FROM "Machine" WHERE equipment <> 'SEWING'` returns 0, and `SELECT count(*) FROM "ServiceItem" WHERE "equipmentKind" IS DISTINCT FROM (CASE WHEN name ~* '^(storage fee|rush|diagnosis)' THEN NULL ELSE 'sewing' END)` returns 0.
2. **Builds.** `npx tsc --noEmit`, `npm run build` and `STITCH_TEST_BUILD=1 npm run build` pass.
3. **`npx tsx scripts/checks/license.check.ts` passes.** It is `modules-license-check.ts` with its import path changed (every case listed under "Companion files").
4. **`npx tsx --conditions=react-server scripts/checks/modules.check.ts` passes**, using a throwaway company "Check {run}". It writes nothing that outlives its cleanup:
   - a yearly dev key gives `on`/`renew`/`grace`/`lapsed` at fixed `now`s, and `endedAt` is the end of grace;
   - editing the stored key text with SQL makes it "not-valid" and the module `off`;
   - a key for another company is shown as "other-company" and ignored;
   - a `ModuleGrant` "on" signed with `signGrant` counts, and is ignored after `process.env.STITCH_DESKTOP = "1"`;
   - with real `ModuleGrant` rows: off, then a short "on", gives `on` inside the short window and `lapsed` after it; then "Let keys decide" gives `on` again (the yearly key);
   - `devKeysAllowed()` truth table:
     - `NODE_ENV` unset → true;
     - `NODE_ENV=production` → false;
     - production with `STITCH_TEST_BUILD=1` and a localhost `DATABASE_URL` → true;
     - the same with `LICENSE_HOSTED_KEY` set, with `DATABASE_URL` on `db.example.com`, or with `STITCH_DESKTOP=1` → false;
   - `hostedSigner()` with a `LICENSE_HOSTED_KEY` whose public half matches no compiled hosted key → null;
   - `verifyFor`: an "any" key used as a grant is refused; a dev key is refused when `devKeysAllowed()` is false;
   - with `STITCH_DESKTOP=1`, a key whose `t` is 5 days after the real `now` gives `clockBehind: true`;
   - `requireModule` throws a `UserError` whose message starts "Vac Shop ended on" and ends with "renew it in Settings → Modules." for an admin and "Ask the shop owner to renew it." for a tech;
   - `canWorkOn` after the lapse: an open ticket opened before `endedAt` → true; one opened after → false; a Collected one → false; equipment "ROBOT" → false;
   - `shopsWithModule("vac", [id])` returns `[id]` only while active, and `loadModulesMany` of three companies equals three `loadModules` calls;
   - cleanup.
5. **`npx tsx --conditions=react-server scripts/checks/equipment.check.ts` passes:**
   - the sewing kind equals today's lists (`MACHINE_TYPES`, accessories with Power cord and Foot control ticked, `DEFAULT_CHECKLIST`);
   - `readAnswers` and `readReadings` refuse a bad choice, refuse a missing required answer, and ignore unknown and `__proto__` keys;
   - `kindOf` falls back to `genericKind`; `kindByKey(null)` is sewing;
   - `servicesFor("vacuum")` returns null- and `vacuum`-kind items only;
   - `starterKindFor("Storage fee (after 60 days)")` is null and `starterKindFor("Hook timing only")` is `"sewing"`.
6. **`npx tsx --conditions=react-server scripts/checks/modules-tenant.check.ts` passes.** With two companies A and B (vac and appliance on both), B calls with A's ids and gets "not found", false or null, with A's rows unchanged:
   - `saveReadingsFor`, `saveIntakeFor`, `convertMachineKindFor`;
   - `ticketWorkable`, `machineWorkable`;
   - `unitDetail`, `listUnits`, `listInstalls` (the stubs);
   - `activateLicenseFor(B, A's key)` → "This key is for another company".
7. **CLI** (with `STITCH_LICENSE_PASSPHRASE=correct-horse-9`):
   - `npm run license:keygen -- --kid t9 --out /tmp/lk/license-t9.pem` writes a file starting `-----BEGIN ENCRYPTED PRIVATE KEY-----` and prints `t9: { x: "…", scope: "any" },`;
   - running it again refuses to overwrite, and `--out ./license-t9.pem` inside the repo is refused;
   - `npm run license -- --key /tmp/lk/license-t9.pem --shop X --name Y --modules vac --plan monthly --from 2026-10-01 --log /tmp/lk/log.csv` prints an `SB1.` key:
     - `--check` of it shows last day 2026-10-31;
     - it warns that kid t9 isn't in `license-keys.ts`;
     - it appends one 13-column log row and writes one file under `~/.stitchbench/keys/` (with `HOME=/tmp/lk`);
   - `--due 40` lists it with its `--renew` command, and `--renew <keyId>` issues 2026-11-01 to 2026-11-30;
   - `--trial --shop X --modules vac` issues 14 days with grace 0;
   - `--retire-list t9` prints a `retired` entry whose `allow` holds both keys' hashes;
   - a wrong passphrase exits non-zero with "Wrong passphrase for /tmp/lk/license-t9.pem".
8. **Playwright `tests/modules-basics.spec.ts`** passes on the test build at `E2E_BASE_URL=http://localhost:3500`, using the `npm run e2e:setup` user, who is in `PLATFORM_ADMIN_EMAILS`:
   - `/settings/modules` shows a Company ID and the "Test build" pill; the nav has no "Vac Shop"; `/vac` says "Vac Shop isn't turned on"; `/tickets/new` shows no kind chips.
   - A key for another Company ID gives "This key is for another company". A key with one changed character gives "damaged".
   - A valid dev key (vac + appliance, one year), pasted inside a made-up email text, gives "Key added", with rows "On until …". The nav shows "Vac Shop".
   - `/tickets/new` shows the chips Vacuum, Stand mixer, 3D printer, Resin 3D printer and Other appliance.
   - `/tickets/new?kind=vacuum` has the heading "Check in a vacuum" and the question "Bags or bagless". The ticket created from it shows "Suction" readings and no "Factory tension". Saving readings gives "Readings saved".
   - On Companies: create company "B {run}", then "Turn on" Scheduling with an end date; the Modules column shows it, and "Extend 1 month" moves its date. "Turn off" shows "off (switched)". The Company ID column copies.
   - Company "C {run}", signed in as its owner, pastes a vac key and checks in vacuum ticket T1. The admin switches vac off for C. Then:
     - T1 still accepts a new line and a status change to Ready (work already in);
     - `/tickets/new?kind=vacuum` shows "was switched off" and "Check in a sewing machine instead", with no form;
     - T1 is marked Collected; then its status select offers only the closing statuses, a payment can still be added, and `page.request.post("/api/photos", …)` for T1 returns 403.
9. **`tests/smoke.spec.ts`** passes unchanged on the same server. With `HUB_URL` set, `tests/partners.spec.ts` also passes; it covers register repair pickups. `tests/modules-basics.spec.ts` also:
   - rings up a plain part sale at `/register` for a company that repairs and sells, checks the receipt, and voids the sale;
   - adds a customer with the register's "New customer" form, and the sale carries that customer.

   No other spec covers the register without a hub, so this checks that non-vacuum lines behave as before.

#### `vac-repair`

**Depends:** modules-foundation.

**Owns:** `src/lib/equipment/vacuum.ts`, `src/app/(app)/vac/page.tsx`, `src/app/(app)/vac/convert/page.tsx`, `scripts/checks/vacuum-kind.check.ts`.

**Shared edits:** none.

**Acceptance:**
1. `npx tsc --noEmit` passes, and `npx tsx scripts/checks/vacuum-kind.check.ts` passes.
2. With vac on, `/tickets/new?kind=vacuum`:
   - offers the types Upright, Canister, Central, Backpack, Robot, Commercial (plus Stick / cordless and Other);
   - offers the vacuum accessories with none ticked, and the questions "Bags or bagless", "Bag type" and "Power".
3. Settings → "Add the starter Vacuums list" creates 16 services with `equipmentKind = 'vacuum'`, switched off at $0 with the toast "Added. Set prices, then switch them on." Once priced and switched on, they appear under "Add service" on a vacuum ticket only.
4. `/vac` shows the five tabs and the counts. With vac off it shows the notice. For a repair-only company it shows the "Selling vacuums … happens at the Register" card.
5. A Hoover vacuum's machine page quick links include "Hoover support" (a Google search).
6. `/vac/convert` lists a SEWING machine with brand Hoover. "It's a vacuum" converts it and keeps its old closed ticket. A machine with an open ticket that has a line is refused: "It has work on an open ticket."

#### `vac-finder`

**Depends:** modules-foundation. **Hub:** none.

**Owns:** `src/app/(app)/vac/finder/page.tsx`, `src/lib/vac/finder.ts`, `src/actions/vac-finder.ts`, `src/components/vac/supply-picker.tsx`, `src/components/vac/supplies-that-fit.tsx`, `src/actions/xref.ts`, `src/components/xref-form.tsx`, `src/app/(app)/xref/page.tsx`, `src/app/(app)/xref/[id]/page.tsx`, `scripts/checks/vac-finder.check.ts`.

**Shared edits:** none. The register mount point is foundation's.

**Acceptance:**
1. `npx tsc --noEmit` passes, and `npx tsx --conditions=react-server scripts/checks/vac-finder.check.ts` passes (10.b, with its tenant section).
2. With the check's seeded rows:
   - `/vac/finder?brand=Hoover&q=UH70120` lists the belt under "Belts" and the bag under "Bags" with "Close match: UH70120PC" and "on hand"; the sewing part is absent;
   - `/vac/finder?q=Type%20Y` lists the bag.
3. On `/register`, with a customer who owns a Hoover UH70120 vacuum: "Bags, belts, filters", then the vacuum, then "Add" on the 138SW item puts that part on the sale. After the sale, `/api/export/register-sales` shows that line with `for_machine` "Hoover UH70120".
4. Without a hub join, the finder shows the "Join the community hub" note and the local-parts results.
5. Signed in as a TECH, `/xref/{id}` shows no Remove, Merge or Revert, and calling `removeCrossRef` directly gives the admin message. With `hubWritesOff` set for the company, saving a cross-reference gives "Sharing to the community hub is switched off for this company."
6. `git -C /home/user/stitchhub status --short` is empty: the hub is not changed.

#### `vac-sales-warranty`

**Depends:** modules-foundation.

**Owns:** `src/app/(app)/vac/units/page.tsx`, `src/app/(app)/vac/units/[id]/page.tsx`, `src/lib/vac/sale-units.ts`, `src/lib/vac/units.ts`, `src/actions/vac-units.ts`, `src/components/vac/unit-tools.tsx`, `src/components/vac/unit-badge.tsx`, `src/components/vac/sale-unit-notes.tsx`, `scripts/checks/vac-units.check.ts`.

**Shared edits:** none. The register plumbing is foundation's; this package fills the hooks.

**Acceptance:**
1. `npx tsc --noEmit` passes, and `npx tsx --conditions=react-server scripts/checks/vac-units.check.ts` passes (10.c, with its tenant section).
2. UI walk-through on the test build:
   - add two vacuums for sale from one form (NEW, $499, 12 months, two serials);
   - on `/register`, scanning the first serial puts it on the sale; with no customer picked, paying gives "Pick the customer first"; "New customer" adds one; paying then works, and the receipt shows "warranty through {date one year on}";
   - `/vac/units/{id}` shows Sold with the buyer, and the "Warranty to register" tab lists it;
   - "Record warranty registration" clears it from that tab;
   - voiding the sale puts the unit back In stock;
   - a trade-in line with a $50 credit creates an In-stock unit with cost $50 and no price;
   - a vacuum whose ticket was marked Abandoned shows "Put up for sale" on its machine page, which creates a Used unit.
3. After vac is switched off for the company, "Return a vacuum" at the register still refunds a unit sold earlier.
4. `/api/export/vac-units` lists the units.
5. The plain register sale in `tests/modules-basics.spec.ts` still passes.

#### `vac-bags-due`

**Depends:** modules-foundation, and design.md `foundation` (message queue and the `bags_due` kind).

**Owns:** `src/app/(app)/vac/bags-due/page.tsx`, `src/lib/vac/bags-due.ts`, `src/actions/vac-bags-due.ts`, `scripts/checks/bags-due.check.ts`.

**Shared edits:** none expected. The final design.md's foundation has the `bags_due` kind, label and templates. Only if it doesn't when this package starts, add them exactly as design.md §3.1 and §5 list them. design.md's feature packages don't edit those three files, so this can't collide:
- `src/lib/messaging/types.ts`: `| "bags_due"` in `MessageKind` and `bags_due: "marketing"` in `KIND_PURPOSE`;
- `src/lib/constants.ts`: `bags_due: "Bags due reminder"` in `MESSAGE_KIND_LABEL`;
- `src/lib/messaging/templates.ts`: `FIELDS.bags_due`, the three `DEFAULT_TEMPLATES` entries (section 10.c′ text) and `"bags_due"` in the automatic kinds list.

**Acceptance:**
1. `npx tsc --noEmit` passes, and `npx tsx --conditions=react-server scripts/checks/bags-due.check.ts` passes (10.c′, with its tenant section).
2. `/vac/bags-due` lists a bagged vacuum sold 200 days ago to a customer:
   - with Marketing off, it shows the call-list copy and no send button;
   - after "Called", the row is gone;
   - with Marketing on (Companies switch), "Send reminders to the 1 due now" creates an `OutMessage` of kind `bags_due` that shows on `/messages`.
3. A customer with no text or email consent stays on the list after "Send reminders", and the toast says so.

#### `central-vac-installs`

**Depends:** modules-foundation, and design.md `foundation` (`src/lib/zoned.ts`).

**Owns:** `src/app/(app)/vac/installs/page.tsx`, `src/app/(app)/vac/installs/new/page.tsx`, `src/lib/vac/installs.ts`, `src/actions/vac-installs.ts`, `src/components/vac/site-panel.tsx`, `src/components/vac/site-invoice.tsx`, `scripts/checks/vac-installs.check.ts`.

**Shared edits:** none. The calendar line is `appointments`' (12.4, item 3).

**Acceptance:**
1. `npx tsc --noEmit` passes, and `npx tsx --conditions=react-server scripts/checks/vac-installs.check.ts` passes (10.d, with its tenant section).
2. `/vac/installs/new` with no power unit and no date creates an install and opens `/tickets/{id}` with:
   - "Install #…" and the address;
   - the Site panel with "Not scheduled" and "Set the power unit";
   - a status select offering exactly Quote sent / Booked / Waiting on parts / In progress / Completed / Cancelled, on Booked;
   - the install checklist.
3. With "Quote first" ticked, it starts on "Quote sent".
4. The install is not counted on the dashboard (`/`) or listed on `/tickets`. It is listed on `/vac/installs`.
5. A LABOR line and a PART line add to the bill and stock as on any ticket. "Completed" sets the ticket closed, and the invoice shows "Work done at {address}".

#### `appliance-repair`

**Depends:** modules-foundation.

**Owns:** `src/lib/equipment/appliances.ts`, `src/lib/equipment/lines.ts`, `src/lib/equipment/shop-kinds.ts`, `src/app/(app)/settings/equipment/page.tsx`, `src/actions/equipment.ts`, `scripts/checks/equipment-lines.check.ts`.

**Shared edits:** none.

**Acceptance:**
1. `npx tsc --noEmit` passes, and `npx tsx --conditions=react-server scripts/checks/equipment-lines.check.ts` passes (11.2, with its tenant section).
2. With appliance on:
   - `/tickets/new?kind=stand-mixer` offers Tilt-head / Bowl-lift and "Bowl size", and its ticket shows the "Dime test (planetary mixers)" reading and the mixer checklist;
   - `/tickets/new?kind=3d-printer` asks "Filament in use" (no Resin) and "Nozzle size", and its ticket has "Firmware version" (text, found and left);
   - `/tickets/new?kind=resin-printer` asks "Resin in use", and its checklist starts with "FEP / release film checked or replaced".
3. In "What you repair", add "Espresso machine" with a question row "Boiler type", Choice, "Single, Dual", Once per unit:
   - the chip "Espresso machine" appears on `/tickets/new`;
   - check-in asks "Boiler type";
   - the ticket's Details shows the answer;
   - relabelling the question to "Boiler" keeps the answer.
4. "Check-in opens on" set to Stand mixer makes `/tickets/new` open on the mixer form, and the dashboard shows "Check in a stand mixer" first.
5. With appliance switched off: the appliance chips disappear; an appliance ticket opened before the switch-off still accepts a line; after it is Collected it is closing-only.

#### `modules-crossover`

**Depends:** every design.md feature package (`notices`, `estimate-links`, `campaigns`, `classes`, `appointments`, `register-bookings`, `shifts`, `partner-runs`), `vac-bags-due` and `central-vac-installs`.

**Owns:** `scripts/checks/modules-crossover.check.ts`.

**Shared edits** (all after their owners have landed, so none is concurrent; each is skipped when the owner already made it):
1. `src/lib/messaging/templates.ts` (owner: design.md `foundation`): the `bags_due.sms` and `bags_due.email` defaults become the section 10.c′ text (12.4, item 1).
2. `src/lib/estimate-answer.ts` (owner: design.md `foundation`): the APPROVED branch of `answerTicketEstimate` as in 12.4, item 4, plus `import { ticketWorkable } from "@/lib/equipment/gate";`.
3. `src/actions/estimate-links.ts` (owner: `estimate-links`): the two lines of 12.4, item 5, plus `import { requireEquipment } from "@/lib/equipment/gate";`.
4. `src/lib/notices/vars.ts` (owner: `notices`): in `ticketVars`, `machine: t.jobType === "SITE" ? "central vac install" : <what it is today>` (12.4, item 6).
5. `src/lib/notices/hooks.ts` (owner: `notices`): the first statement of `stillWanted` and its import (12.4, item 7).
6. Only if missing: `src/lib/calendar.ts` and the calendar view (owner: `appointments`), the install items of 12.4, item 3; `src/lib/messaging/service-due.ts` (owner: design.md `foundation`) and `src/lib/notices/scheduler.ts` (owner: `notices`), the service-due rules of 12.4, item 8.

**Acceptance:**
1. `npx tsc --noEmit` passes.
2. `npx tsx --conditions=react-server scripts/checks/modules-crossover.check.ts` passes, with a throwaway company that has vac and Marketing on:
   - a `bags_due` default text doesn't contain "months since";
   - a queued `bags_due` message is cancelled by the worker's `stillWanted` after "Stop reminders";
   - approving a SITE ticket's estimate by link moves it to AT_SHOP_AWAITING_PICKUP;
   - after vac lapses:
     - approving a pre-lapse vacuum ticket's estimate moves it to ON_BENCH;
     - `sendEstimate` on a vacuum ticket that is already Collected is refused;
     - `setStatus` to COLLECTED on it succeeds, and a new vacuum check-in is refused;
   - `ticketVars` of an install gives `machine` "central vac install";
   - `calendarItems` for the install's day includes an `install` item;
   - `machinesDue` skips a vacuum when vac is off.
3. design.md's `tests/estimate-links.spec.ts` and `tests/messaging.spec.ts` still pass on the test build.

#### `modules-e2e`

**Depends:** `modules-crossover`, `vac-repair`, `vac-finder`, `vac-sales-warranty`, `appliance-repair`, and design.md `e2e-docs`.

**Owns:** `tests/vac-shop.spec.ts`, `tests/appliances.spec.ts`, `tests/modules-lapse.spec.ts`.

**Shared edits:** none.

**Acceptance:** on the test build at :3500, after `npm run e2e:setup`:
1. `tests/vac-shop.spec.ts` walks all of Vac Shop:
   - check in a vacuum, fill the checklist and readings, bill and collect it;
   - use the finder with a local part, and ring up a bag through the register picker;
   - receive a unit, sell it with a warranty, take a trade-in, void the trade-in sale;
   - create a central vac install, run its site panel, complete it, see it on the invoice with "Work done at";
   - with Scheduling on, see "Install: {customer}" on `/calendar?view=day&date={that day}`;
   - see bags due for a unit sold (via the check helper) 200 days ago.
2. `tests/appliances.spec.ts`: a mixer, a 3D printer, a resin printer, and the shop's own espresso kind.
3. `tests/modules-lapse.spec.ts`. Set-up:
   - Company D gets a vac key that ended 20 days ago with 14 days' grace, through `dev.ts --grant`.
   - The admin "Turn on"s vac for D, and D checks in vacuum ticket T1 and sells a unit.
   - The admin chooses "Let keys decide".

   Then, for company D:
   - `/vac/units` is read-only and says "ended on";
   - `/tickets/new?kind=vacuum` shows the notice and "Check in a sewing machine instead", with no form;
   - T1 (opened before the end) still accepts a new line and "Ready for pickup", and then "Collected by customer" and a payment;
   - after Collected, a direct `addLine` call on T1 returns the blocked message;
   - "Return a vacuum" at the register still refunds the unit;
   - `/api/export/tickets` still includes T1, with its readings.

   Company E gets a key that ended 10 days ago with 14 days' grace. It sees the banner "keeps working until" (not on its printed invoice), and can check in a vacuum.
4. `tests/smoke.spec.ts`, `tests/modules-basics.spec.ts` and design.md's `tests/messaging.spec.ts` pass together on the same server.

### 13.3 Stubs foundation creates (ownership passes to the named package)

| File | Stub body | Owner |
|---|---|---|
| `src/lib/equipment/vacuum.ts` | `VACUUM_KIND` with the owner's six types plus Other, the `bagged` (Bagged, Bagless) and `bagType` fields, the `suction` reading, empty checklist and menu | vac-repair |
| `src/app/(app)/vac/page.tsx` | `pageGate`, then `VacTabs` and "More in this update." | vac-repair |
| `src/app/(app)/vac/finder/page.tsx`; `src/lib/vac/finder.ts` (`suppliesFor` → `{ supplies: [], truncated: false }`); `src/components/vac/supply-picker.tsx` (returns `null`); `src/components/vac/supplies-that-fit.tsx` (returns `null`) | - | vac-finder |
| `src/app/(app)/vac/units/page.tsx`; `src/lib/vac/sale-units.ts` (section 10.c stub); `src/lib/vac/units.ts` (`listUnits` → `[]`, `unitDetail` → null); `src/actions/vac-units.ts` (`unitsForSale` → `[]`, `unitsToReturn` → `[]`); `src/components/vac/unit-tools.tsx` (returns `null`), `unit-badge.tsx` (`null`), `sale-unit-notes.tsx` (`null`) | - | vac-sales-warranty |
| `src/app/(app)/vac/bags-due/page.tsx`; `src/lib/vac/bags-due.ts` (`bagsDue` → `[]`, `bagsDueCount` → 0, `runBagsDue` does nothing, `bagsDueStillWanted` → null) | - | vac-bags-due |
| `src/app/(app)/vac/installs/page.tsx`; `src/lib/vac/installs.ts` (`INSTALL_CHECKLIST = []`, `siteJobsBetween` → `[]`, `listInstalls` → `[]`, `createSiteJob` throws "Coming in this update."); `src/components/vac/site-panel.tsx` (`null`), `site-invoice.tsx` (`null`) | - | central-vac-installs |
| `src/lib/equipment/appliances.ts` | `APPLIANCE_KINDS` with the four kinds' identity, types and brands, empty lists | appliance-repair |
| `src/app/(app)/settings/equipment/page.tsx` | `pageGate`, then "Coming in this update." | appliance-repair |

Each stub page is `requireUser()` plus the gate plus `PageHeader`, then `<Empty>Coming in this update.</Empty>`.

### 13.4 Files two packages edit

All of these are sequential: the first owner's edit lands before the next one starts.

| File | First edit | Later edit |
|---|---|---|
| `src/actions/register.ts`, `src/lib/register-math.ts`, `src/components/register.tsx`, `register/page.tsx`, `register/sales/page.tsx`, `register/sales/[id]/page.tsx` | modules-foundation: vac plumbing (below) | design.md `foundation` (1 slot on the page) and `register-bookings` (12.4, item 10) |
| `src/actions/tickets.ts`, `tickets/new/page.tsx`, `tickets/[id]/page.tsx`, `app/(app)/page.tsx` | modules-foundation: kinds, gates, SITE | design.md `foundation` (setStatus refactor, `NotifyByField`, slots) |
| `src/components/nav.tsx`, `src/app/(app)/layout.tsx`, `settings/page.tsx`, `src/lib/constants.ts`, export route, `desktop/backup.mjs`, `.env.example`, `next.config.ts`, `INSTALL.md`, `package.json`, `src/lib/shops.ts`, `src/actions/settings.ts` | modules-foundation | design.md `foundation` (its own edits) |
| `src/lib/messaging/templates.ts`, `src/lib/estimate-answer.ts` | design.md `foundation` | modules-crossover (12.4, items 1 and 4) |
| `src/actions/estimate-links.ts` | `estimate-links` | modules-crossover (12.4, item 5) |
| `src/lib/notices/vars.ts`, `src/lib/notices/hooks.ts` | `notices` | modules-crossover (12.4, items 6 and 7) |
| `src/lib/calendar.ts`, `src/lib/messaging/service-due.ts`, `src/lib/notices/scheduler.ts` | their design.md owners (they already carry the modules lines) | modules-crossover only if a line is missing |

**Register plumbing in foundation** (exact):

`src/lib/register-math.ts` gains:

```ts
/** Each line's share of the whole-sale discount (the split saleTotals uses for tax): 0 for lines it doesn't come off. */
export function discountShares(lines: Line[], orderDiscountCents: number): number[] {
  const base = discountBase(lines);
  const d = Math.max(0, Math.min(Math.round(orderDiscountCents), base));
  return lines.map((l) => (base > 0 && l.discountable !== false && lineNet(l) > 0 ? Math.round((d * lineNet(l)) / base) : 0));
}
```

`src/actions/register.ts`:
1. `export` on `view`. `RegisterItem` gains `stockUnitId?: string | null` (set only on unit hits).
2. `SaleLineInput` gains `machineId?: string | null; stockUnitId?: string | null; tradeIn?: TradeInInput | null`.
3. After the jobs preload, check machine ids: `const machineIds = [...new Set(input.lines.map((l) => l.machineId).filter(Boolean) as string[])]; if (machineIds.length && (await db.machine.count({ where: { shopId, id: { in: machineIds }, equipment: "VACUUM" } })) !== machineIds.length) throw new UserError("That vacuum isn't one of this shop's.");`
4. `const units = await prepareUnitLines({ shopId, role: user.role, customerId: input.customerId ?? null, lines: input.lines.map((l) => ({ stockUnitId: l.stockUnitId ?? null, tradeIn: l.tradeIn ?? null, qty: Number(l.qty), unitPriceCents: Math.round(Number(l.unitPriceCents)), taxable: Boolean(l.taxable) })) });`
5. The lines map takes `(l, i)`:
   - A line with `stockUnitId` or `tradeIn` plus `partId` or `repairJobId` is refused ("A line can only be one thing.").
   - When `units.get(i)` exists, return the row built from it, plus `partId: null, repairJobId: null, pickedUp: false, partNumber: null, unit: null, consignLinkId: null, consignItemKey: null, machineId: null, tradeIn: l.tradeIn ?? null`, with the discount clamped as today (0 when `!discountable`).
   - Otherwise the existing row plus `machineId: l.machineId ?? null, stockUnitId: null, tradeIn: null`.
6. After `totals`: `const shares = discountShares(lines, totals.orderDiscount);`.
7. In the transaction, the loop becomes `for (const [i, l] of lines.entries())` with `const { pickedUp, discountable, tradeIn, ...row } = l;`. After `saleLine.create`: `if (l.stockUnitId || tradeIn) await applyUnitLine(tx, { shopId, saleNumber: number, customerId: input.customerId || null, at, timeZone: shop.timeZone, line, tradeIn, discountShareCents: shares[i] });`.
8. `revalidatePath("/vac", "layout")`.
9. `voidSale`: after the `done.count` check, `await voidUnitLines(tx, { shopId, saleNumber: sale.number, customerId: sale.customerId, lines: sale.lines, at });`.
10. `itemByCode`: `return matches[0] ? view(matches[0]) : ((await registerUnitHits({ shopId: user.shopId, q: c, mode: "code" }))[0] ?? null);`.
11. `findItems`: `return [...parts.map(view), ...(await registerUnitHits({ shopId: user.shopId, q: t, mode: "search" }))];`.
12. New data action `quickAddCustomer(fd: FormData): Promise<CustomerHit | { error: string }>`:
    - `requireUser`;
    - name required, plus a phone or an email ("Enter a name and a phone or email.");
    - creates a RETAIL customer (name, phone, email, address) in the user's shop.

`src/components/register.tsx`:
- `CartLine` gains `machineId?`, `stockUnitId?` and `tradeIn?`.
- `discountable: !l.repairJobId && !l.tradeIn`.
- `addItem(it, machineId: string | null = null)`:
  - an item with `stockUnitId` becomes a unit line (qty 1, `unitPriceCents: it.priceCents ?? 0`, taxable, the item's description), unless that unit is already on the sale ("That vacuum is already on this sale.");
  - otherwise, as today. Repeat scans merge only when `machineId` matches too.
- `addLine(line: VacCartLine)` appends `{ key: newKey(), discountPct: 0, ...line }`.
- The quantity input is disabled for unit and trade-in lines, like repair lines.
- `finish()` passes `machineId`, `stockUnitId` and `tradeIn`.
- **The customer box** gains "New customer": a small form (name, phone, email, address) that calls `quickAddCustomer` and picks the result. The cart is client state and stays as it is.
- The "Nothing matches" card gains "A vacuum for sale? Add it under Vac Shop → For sale." when `vac === "on"`.
- `Register` gains the prop `vac?: "on" | "readonly" | "off"`. Beside "Repair pickup":
  - `{vac === "on" && <VacSupplyPicker customerId={customer?.id ?? null} returnMode={returnMode} onAdd={(it, m) => addItem(it, m)} />}`;
  - `{vac && vac !== "off" && <VacUnitTools vac={vac} returnMode={returnMode} customerId={customer?.id ?? null} inCart={cart} onAdd={addLine} onNeedCustomer={() => setNewCustomer(true)} />}`.

`src/lib/vac/types.ts` defines `VacCartLine = { description: string; qty: number; unitPriceCents: number; taxable: boolean; unit: null; stockUnitId?: string; tradeIn?: TradeInInput }`.

The other register files:
- **`register/page.tsx`:** `const vacState = (await getModules(user.shopId)).states.vac;` then `vac = vacState.active ? "on" : (await db.stockUnit.count({ where: { shopId: user.shopId } })) > 0 ? "readonly" : "off"`. Returns stay possible whatever the module state.
- **`register/sales/page.tsx`:** `const k = l.repairJobId ? "Repairs" : l.stockUnitId ? "Vacuums" : l.tradeInUnitId ? "Trade-ins" : l.part ? … : "Misc";`
- **`register/sales/[id]/page.tsx`:** `<SaleUnitNotes saleId={sale.id} shopId={user.shopId} />` directly after the lines `<ul>`.

---

## 14. Open questions

Each is decided as stated unless the owner says otherwise.

1. **D3, finishing work after a module ends.** New work stops. Tickets and installs opened before the end stay fully workable until they close, and closing, returns and exports always work. Is that the right line?
2. **D2, the hosting key.** The Companies switch signs with a separate hosting key kept in Railway's variables. Its keys count only on a server holding that key, never on the Windows program. The alternative is an unsigned database switch, which any self-hosted server could flip, so it was rejected. Is keeping a second (weaker) key on Railway acceptable? The owner's own key stays on his PC, encrypted, either way.
3. **D9, the admin's "Turn off".** It ends every key the company had at that moment, including a paid one (for a refund or chargeback), until "Let keys decide" is chosen. A later "Turn on" adds only its own dates. OK?
4. **Grace and reminders.** Grace defaults to 14 days per key. Reminders start 30 days before the end for yearly keys and 3 days before for monthly ones, whose next key comes by email after each payment (`npm run license -- --renew-due 7`). Would the owner rather issue 3-month keys to monthly payers?
5. **Sales contact.** `MODULE_SALES.email` (and an optional pricing `url`) must be filled in before the first release. Which address?
6. **Starter prices for vacuums and appliances.** None are shipped, so starter items arrive switched off at $0 until the shop prices them. The owner can supply suggested prices from his price sheet (`ServiceDef.priceCents`), as `DEFAULT_SERVICE_MENU` has for sewing.
7. **Partner take-ins stay sewing.** Should a StitchShop counter be able to take in a vacuum for its repair partner? That needs a `PartnerTerms.repairs` list and an optional `equipment` field in `job.new`. It would be backward compatible, but it is not in this build.
8. **Hub link category for vacuums.** The hub's manual links file Oreck under "Appliances". Should vacuums get their own "Vacuums" category? The app doesn't use link categories today, so this is cosmetic.
9. **Model keys with suffixes.** The finder's close-match fallback covers model variants (UH70120 and UH70120PC). Manuals and model pages still match exactly; a per-kind model-key normaliser is a later option.
10. **Trade-in tax.** Trade-in credit is never taxable in this build, so tax is on the full sale price. Some states let a trade-in lower the taxable amount; a per-state setting can come later.
11. **Bags due for repair customers.** Buyers are listed: a unit sold here, bags bought for that vacuum, or bags sold on its repair ticket. Repair customers who never bought bags here aren't. Should they be?
12. **Automatic bags-due sending** is cut for now; an admin presses "Send reminders". `runBagsDue` is already called by design.md's scheduler, so turning it on later needs no change there.
13. **The test build** (`STITCH_TEST_BUILD`) stays, guarded (section 3.3), because design.md's test plan runs on production test builds. If the owner prefers, every Playwright run can move to `next dev` and the switch can be removed later.
14. **Hub hardening, later and optional:** an append-only `POST /v1/xparts/:id/fits`, and a per-install "revert everything since" for the hub admin. Neither is needed for this build.
15. **Built-in kinds are fixed** in this build: a shop can add its own kinds but not change the vacuum, mixer or printer lists. Is that acceptable for now?

---

## Appendix A. `src/lib/license.ts` (reference implementation, verified)

This is `modules-license-reference.ts` verbatim. Its check is `modules-license-check.ts` (in this folder), which becomes `scripts/checks/license.check.ts` with its import path changed. Both pass `tsc --strict` and run clean with `npx tsx` on Node 22.22.2. Keep the behaviour exactly; comments may be trimmed. `src/lib/module-info.ts` re-exports `MODULE_IDS` and `ModuleId` from here.

```ts
// Reference implementation of src/lib/license.ts (pure: no "server-only", no database). Checked by license-check.ts.
import crypto from "node:crypto";

export const MODULE_IDS = ["vac", "appliance", "scheduling", "marketing"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
export type KeyScope = "any" | "hosted" | "dev";
/** A retired signing key: its keys count only up to `lastDay`, and (after a leak) only the genuine ones listed in `allow`. */
export type Retired = { lastDay: string; allow?: string[] };
export type PublicKeys = Record<string, { x: string; scope: KeyScope; retired?: Retired }>;
/** m monthly, y yearly, a administrator switch, t trial; any other short word is a plan a newer version knows. */
export type Plan = string;
export type LicensePayload = { v: 1; k: string; id: string; s: string; n: string; m: string[]; p: Plan; f: string; u: string; g: number; t: string };
export type Verified = { ok: true; payload: LicensePayload; scope: KeyScope; kid: string } | { ok: false; reason: string };

export const NO_END = "2099-12-31";
export const TRIAL_DAYS = 14;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const validYmd = (s: unknown): s is string => typeof s === "string" && YMD.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Email programs wrap long lines: every space and line break goes. */
export const cleanKeyText = (text: string) => String(text ?? "").replace(/\s+/g, "");
/** The key inside whatever was pasted (the whole email is fine): the first SB1 key in the text without its spaces. */
export function extractKey(text: string): string | null {
  return /SB1\.[A-Za-z0-9_-]{20,3000}\.[A-Za-z0-9_-]{86}/.exec(cleanKeyText(text))?.[0] ?? null;
}
/** What a retired kid's `allow` list holds for one genuine key: the first 16 hex characters of sha256(payload part). */
export const payloadHash = (payloadPart: string) => crypto.createHash("sha256").update(payloadPart).digest("hex").slice(0, 16);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newKeyId() {
  return [...crypto.randomBytes(8)].map((b) => CROCKFORD[b % 32]).join("");
}

export function encodeLicense(payload: LicensePayload, privateKey: crypto.KeyObject) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return `SB1.${bytes.toString("base64url")}.${crypto.sign(null, bytes, privateKey).toString("base64url")}`;
}

const pubCache = new Map<string, crypto.KeyObject>();
function publicKey(x: string) {
  let k = pubCache.get(x);
  if (!k) pubCache.set(x, (k = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" })));
  return k;
}

const NOT_A_KEY = "That doesn't look like a StitchBench license key. Copy the whole key: it starts with SB1.";
const DAMAGED = "That key is damaged or was changed. Copy the whole key again from the email.";
const NEWER = "This key needs a newer version of StitchBench. Update the program, then paste it again.";
const REPLACED = "This key was replaced. Ask StitchBench for a new key.";

export function verifyLicense(text: string, keys: PublicKeys): Verified {
  const m = /^SB1\.([A-Za-z0-9_-]{20,3000})\.([A-Za-z0-9_-]{86})$/.exec(cleanKeyText(text));
  if (!m) return { ok: false, reason: NOT_A_KEY };
  const bytes = Buffer.from(m[1], "base64url");
  let p: LicensePayload;
  try {
    p = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: DAMAGED };
  }
  if (!p || typeof p !== "object") return { ok: false, reason: DAMAGED };
  // A later format: say so before anything else (only the message depends on this unsigned field).
  if (p.v !== 1) return { ok: false, reason: NEWER };
  const pk = typeof p.k === "string" && Object.hasOwn(keys, p.k) ? keys[p.k] : undefined;
  if (!pk) return { ok: false, reason: NEWER };
  let good = false;
  try {
    good = crypto.verify(null, bytes, publicKey(pk.x), Buffer.from(m[2], "base64url"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: DAMAGED };
  const shapeOk =
    typeof p.id === "string" && /^[0-9A-Z]{6,20}$/.test(p.id) && typeof p.s === "string" && p.s.length > 0 && p.s.length <= 64 &&
    typeof p.n === "string" && Array.isArray(p.m) && p.m.length > 0 && p.m.every((x) => typeof x === "string") &&
    typeof p.p === "string" && /^[a-z]{1,8}$/.test(p.p) && validYmd(p.f) && validYmd(p.u) && p.u >= p.f &&
    Number.isInteger(p.g) && p.g >= 0 && p.g <= 90 && typeof p.t === "string" && !Number.isNaN(Date.parse(p.t));
  if (!shapeOk) return { ok: false, reason: DAMAGED };
  if (pk.retired && (p.u > pk.retired.lastDay || (pk.retired.allow && !pk.retired.allow.includes(payloadHash(m[1]))))) {
    return { ok: false, reason: REPLACED };
  }
  return { ok: true, payload: p, scope: pk.scope, kid: p.k };
}

/**
 * Which verified keys count where. Pasted keys: "any" (and "dev" on a development server). Admin switch rows: "hosted",
 * only on a server that holds a genuine hosting key itself (hostedSigner() matched its compiled public half), so a copy
 * of the hosted database on any other server switches nothing on; "dev" on a development server.
 */
export function acceptScope(scope: KeyScope, use: "pasted" | "grant", ctx: { devAllowed: boolean; hostedHeld: boolean }) {
  if (scope === "dev") return ctx.devAllowed;
  if (scope === "hosted") return use === "grant" && ctx.hostedHeld;
  return use === "pasted";
}

/** The instant a calendar day starts in `timeZone` (same method as zonedMidnight in src/lib/partners.ts). */
export function dayStartIn(ymd: string, timeZone: string) {
  const [y, mo, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(t));
    const get = (k: string) => Number(parts.find((x) => x.type === k)?.value);
    t = guess - (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - t);
  }
  return new Date(t);
}
export const addDaysYmd = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/**
 * Last day of a plan that starts on `from`: the day before the next period starts. Monthly and yearly periods start on
 * the anchor day (the first key's day of the month; clamped to short months), so renewals don't drift. Trial: 14 days.
 */
export function planLastDay(from: string, plan: "m" | "y" | "t", anchorDay?: number) {
  if (plan === "t") return addDaysYmd(from, TRIAL_DAYS - 1);
  const [y, m, d] = from.split("-").map(Number);
  const months = plan === "y" ? 12 : 1;
  const days = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  const next = new Date(Date.UTC(y, m - 1 + months, Math.min(anchorDay ?? d, days))).toISOString().slice(0, 10);
  return addDaysYmd(next, -1);
}

export type Window = { module: string; from: Date; until: Date; graceUntil: Date; plan: Plan; keyId: string; issuedAt: Date; lastDay: string; graceLastDay: string; source: "key" | "admin" };
/** One window per module on a verified key: the start of `f` to the end of `u` in shop time, then `g` days of grace. */
export function windows(p: LicensePayload, timeZone: string, source: "key" | "admin"): Window[] {
  const from = dayStartIn(p.f, timeZone);
  const until = dayStartIn(addDaysYmd(p.u, 1), timeZone);
  const graceUntil = dayStartIn(addDaysYmd(p.u, 1 + p.g), timeZone);
  const w = { from, until, graceUntil, plan: p.p, keyId: p.id, issuedAt: new Date(p.t), lastDay: p.u, graceLastDay: addDaysYmd(p.u, p.g), source };
  return p.m.map((module) => ({ module, ...w }));
}

export type ModuleStatus = "off" | "on" | "renew" | "grace" | "lapsed";
/** Days before the last day that the renewal reminder shows. Monthly payers get their next key by email: 3 days. */
export const RENEW_NOTICE_DAYS: Record<string, number> = { m: 3, y: 30, a: 14, t: 3 };
export const renewNoticeDays = (plan: Plan) => (Object.hasOwn(RENEW_NOTICE_DAYS, plan) ? RENEW_NOTICE_DAYS[plan] : 30);

/**
 * Where one module stands at `now`. `adminOffAt`: the administrator switched it off then, which ends (with no grace)
 * every window of a key issued before that moment; keys issued later count as usual. `endedAt` (lapsed only): when the
 * last window's grace ran out, or the switch-off; tickets opened before it can still be finished.
 */
export function statusAt(ws: Window[], now: Date, adminOffAt: Date | null = null): { status: ModuleStatus; best: Window | null; startsAt: Date | null; endedAt: Date | null } {
  const all = ws
    .map((w) => (adminOffAt && w.issuedAt <= adminOffAt && w.graceUntil > adminOffAt ? { ...w, until: new Date(Math.min(+w.until, +adminOffAt)), graceUntil: adminOffAt } : w))
    .filter((w) => w.graceUntil > w.from);
  const started = all.filter((w) => w.from <= now);
  const future = all.filter((w) => w.from > now).sort((a, b) => +a.from - +b.from);
  const startsAt = future[0]?.from ?? null;
  const active = started.filter((w) => now < w.until).sort((a, b) => +b.until - +a.until)[0];
  if (active) {
    const daysLeft = (+active.until - +now) / 86_400_000;
    const renewed = all.some((w) => w !== active && w.from <= active.until && w.until > active.until);
    const endless = active.lastDay >= NO_END;
    return { status: !endless && !renewed && daysLeft <= renewNoticeDays(active.plan) ? "renew" : "on", best: active, startsAt: null, endedAt: null };
  }
  const grace = started.filter((w) => now < w.graceUntil).sort((a, b) => +b.graceUntil - +a.graceUntil)[0];
  if (grace) return { status: "grace", best: grace, startsAt, endedAt: null };
  const last = started.sort((a, b) => +b.graceUntil - +a.graceUntil)[0];
  if (last) return { status: "lapsed", best: last, startsAt, endedAt: last.graceUntil };
  return { status: "off", best: null, startsAt, endedAt: null };
}

export type GrantRow = { id: string; mode: string; key: string | null; createdAt: Date };
export type AdminPosition = { onKey: string | null; offAt: Date | null; hadAny: boolean; lastAt: Date | null };
/**
 * The administrator's switch for one company and module, from its ModuleGrant rows (any order; ties broken by id).
 * Only rows newer than the newest "none" (Let keys decide) count. The newest "on" among them supplies the admin window
 * (a newer "on" replaces an older one, so it can shorten as well as extend); the newest "off" among them ends every key
 * issued before it, whatever "on" rows came after (a later "on" only adds its own window).
 */
export function adminPosition(rows: GrantRow[]): AdminPosition {
  const sorted = [...rows].sort((a, b) => +b.createdAt - +a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const none = sorted.findIndex((r) => r.mode === "none");
  const live = none === -1 ? sorted : sorted.slice(0, none);
  return {
    onKey: live.find((r) => r.mode === "on" && r.key)?.key ?? null,
    offAt: live.find((r) => r.mode === "off")?.createdAt ?? null,
    hadAny: rows.length > 0,
    lastAt: sorted[0]?.createdAt ?? null,
  };
}

/**
 * statusAt plus the switch. A company the administrator ever switched (on or off) that has no window now is "lapsed"
 * rather than "off", so its records stay reachable. When it lapsed, new work stopped at the later of the last window's
 * end and the switch's last change: "Let keys decide" after an admin "on" ends the module at that moment, so tickets
 * opened under the admin's window can still be finished.
 */
export function resolveStatus(ws: Window[], now: Date, pos: AdminPosition | null) {
  const r = statusAt(ws, now, pos?.offAt ?? null);
  if (r.status === "off" && pos?.hadAny) return { ...r, status: "lapsed" as const, endedAt: pos.lastAt };
  if (r.status === "lapsed" && pos?.lastAt && r.endedAt && pos.lastAt > r.endedAt && pos.lastAt <= now) return { ...r, endedAt: pos.lastAt };
  return r;
}

/**
 * The time modules are judged at. On the Windows program the clock never counts as earlier than 48 hours before the
 * newest verified key was issued (a PC clock set far back); the hosted app uses the server's own clock.
 */
export function effectiveNow(real: Date, issuedAts: Date[], desktop: boolean): { now: Date; floor: Date | null; clockBehind: boolean } {
  if (!desktop || !issuedAts.length) return { now: real, floor: null, clockBehind: false };
  const floor = new Date(Math.max(...issuedAts.map((d) => +d)) - 48 * 3_600_000);
  return { now: floor > real ? floor : real, floor, clockBehind: +floor - +real > 24 * 3_600_000 };
}

/**
 * Whether a ticket (or install) of a module's equipment can still be worked on: always while the module is on (or in
 * grace); once it has ended, only tickets opened before it ended (src/lib/equipment/gate.ts adds: and not closed yet).
 * New check-ins, machines, units and installs need the module on.
 */
export function workable(s: { status: ModuleStatus; endedAt: Date | null }, openedAt: Date) {
  if (s.status === "on" || s.status === "renew" || s.status === "grace") return true;
  return s.status === "lapsed" && s.endedAt != null && openedAt < s.endedAt;
}
```

## Appendix B. Schema text (exact; also in `modules-schema.prisma`)

### B.1 Lines added to existing models (from `modules-schema.diff`, after `prisma format`)

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -53,26 +53,39 @@
   receiptNote        String?
   // The shop's own time zone: where days and months start for reports and statements
   timeZone           String   @default("America/New_York")
+  // The kind /tickets/new opens on (sewing, vacuum, stand-mixer, 3d-printer, resin-printer, other, or a shop kind's key)
+  checkInKind        String   @default("sewing")
+  // Vac Shop "bags due": days between bag purchases
+  bagReminderDays    Int      @default(180)
+  // Set by the StitchBench administrator (Companies): this company can't write to the community hub
+  hubWritesOff       Boolean  @default(false)
   createdAt          DateTime @default(now())
 
-  users         User[]
-  customers     Customer[]
-  machines      Machine[]
-  tickets       Ticket[]
-  parts         Part[]
-  stockMoves    StockMove[]
-  notes         ModelNote[]
-  serviceItems  ServiceItem[]
-  photos        MachinePhoto[]
-  sharedPosts   SharedPost[]
-  sales         Sale[]
-  partnerLinks  PartnerLink[]
-  repairJobs    RepairJob[]
-  partnerOrders PartnerOrder[]
-  consignItems  ConsignItem[]
-  consignSales  ConsignSale[]
-  settlements   Settlement[]
-  outbox        PartnerOutbox[]
+  users          User[]
+  customers      Customer[]
+  machines       Machine[]
+  tickets        Ticket[]
+  parts          Part[]
+  stockMoves     StockMove[]
+  notes          ModelNote[]
+  serviceItems   ServiceItem[]
+  photos         MachinePhoto[]
+  sharedPosts    SharedPost[]
+  sales          Sale[]
+  partnerLinks   PartnerLink[]
+  repairJobs     RepairJob[]
+  partnerOrders  PartnerOrder[]
+  consignItems   ConsignItem[]
+  consignSales   ConsignSale[]
+  settlements    Settlement[]
+  outbox         PartnerOutbox[]
+  // Paid modules
+  licenses       License[]
+  moduleGrants   ModuleGrant[]
+  equipmentKinds ShopEquipmentKind[]
+  ticketSites    TicketSite[]
+  stockUnits     StockUnit[]
+  vacCares       VacCare[]
 }
 
 model User {
@@ -146,14 +159,23 @@
   customerId  String?
   customer    Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)
   notes       String?
+  // What it is (src/lib/equipment): SEWING (free) | VACUUM (Vac Shop module) | APPLIANCE (Small Appliance Repair module)
+  equipment   String    @default("SEWING")
+  // Its kind: sewing | vacuum | stand-mixer | 3d-printer | resin-printer | other | a shop kind's key (ShopEquipmentKind)
+  kind        String    @default("sewing")
+  // This unit's answers to its kind's intake fields that belong to the machine: { "<field key>": value }
+  details     Json      @default("{}")
   createdAt   DateTime  @default(now())
 
   tickets    Ticket[]
   photos     MachinePhoto[]
   repairJobs RepairJob[]
+  stock      StockUnit?
+  vacCare    VacCare?
 
   @@index([shopId, serial])
   @@index([shopId, brand, modelKey])
+  @@index([shopId, equipment])
 }
 
 // Important facts and gotchas, attached to a brand + model (not to one machine),
@@ -315,10 +337,16 @@
   notes               String?
   createdAt           DateTime     @default(now())
   updatedAt           DateTime     @updatedAt
+  // BENCH: brought to the shop (every ticket before modules). SITE: work at the customer's (central vac install)
+  jobType             String       @default("BENCH")
+  // The kind's intake answers for this visit { "<field key>": value }, and its readings { "<key>": { "found": x, "left": y } }
+  intake              Json         @default("{}")
+  readings            Json         @default("{}")
 
   lines    TicketLine[]
   payments Payment[]
   photos   MachinePhoto[]
+  site     TicketSite?
 
   @@unique([shopId, number])
   @@index([shopId, status])
@@ -367,16 +395,18 @@
 
 // Menu of standard services with a set price (clean/oil/time/adjust etc.)
 model ServiceItem {
-  id          String  @id @default(cuid())
-  shopId      String
-  shop        Shop    @relation(fields: [shopId], references: [id], onDelete: Cascade)
-  name        String
-  priceCents  Int
-  active      Boolean @default(true)
-  sortOrder   Int     @default(0)
+  id            String  @id @default(cuid())
+  shopId        String
+  shop          Shop    @relation(fields: [shopId], references: [id], onDelete: Cascade)
+  name          String
+  priceCents    Int
+  active        Boolean @default(true)
+  sortOrder     Int     @default(0)
   // Price list grouping and the line under the name, e.g. "Domestic sewing" / "Clean, oil, adjust timing and tension"
-  category    String?
-  description String?
+  category      String?
+  description   String?
+  // The kind it's offered for (sewing, vacuum, stand-mixer, 3d-printer, resin-printer, other, or a shop kind's key); null = every kind
+  equipmentKind String?
 }
 
 // ============================================================
@@ -799,6 +829,15 @@
   consignItemKey String?
   // A customer paying for a machine the partner repair shop fixed
   repairJobId    String?
+  // Vac Shop (plain ids, like repairJobId): a unit sold from stock (qty 1) or taken back (qty -1); a trade-in taken as
+  // credit (qty -1); the customer's vacuum a bag, belt or filter was bought for ("bags due")
+  stockUnitId    String?
+  tradeInUnitId  String?
+  machineId      String?
+
+  @@index([stockUnitId])
+  @@index([tradeInUnitId])
+  @@index([machineId])
 }
 
 // A partnership with another shop, from this shop's side (the id is the hub's link id).
```

### B.2 New models (appended at the end of `prisma/schema.prisma`)

```prisma
// ============================================================
// Paid modules (src/lib/modules.ts): Vac Shop, Small Appliance Repair, Scheduling, Marketing. A module is on while a
// license key the company pasted (its signature checked again on every look) or the administrator's switch on the
// hosted app says so. Switching off never deletes anything: records stay to look at and export; new work stops.
// ============================================================

// A license key pasted in Settings -> Modules. Only `key` counts: it is verified from its text every time it is read.
model License {
  id        String   @id @default(cuid())
  shopId    String
  shop      Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  keyId     String // the key's own id (payload "id"), as in the StitchBench owner's sales log
  key       String // the whole key as pasted: SB1.<payload>.<signature>
  addedBy   String? // name of the person who pasted it
  addedById String? // their User id
  createdAt DateTime @default(now())

  @@unique([shopId, keyId])
}

// The StitchBench administrator's switch for one company's module (Companies screen, hosted app only). Rows are history;
// only rows newer than the newest "none" (keys decide) count: the newest "on" (a key signed with the hosting key) adds
// its dates, the newest "off" ends every key issued before it (src/lib/license.ts adminPosition). Ignored by the Windows
// program.
model ModuleGrant {
  id        String   @id @default(cuid())
  shopId    String
  shop      Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  module    String // vac | appliance | scheduling | marketing
  mode      String // on | off | none
  key       String? // mode on: SB1 key for this company and module, signed with the hosting key
  byEmail   String
  note      String?
  createdAt DateTime @default(now())

  @@index([shopId, module, createdAt])
}

// A kind of appliance the shop added itself ("What you repair"), e.g. espresso machines. Built-in kinds are never here.
model ShopEquipmentKind {
  id             String   @id @default(cuid())
  shopId         String
  shop           Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  equipment      String   @default("APPLIANCE") // APPLIANCE (the only one this version makes)
  key            String // lower-case letters, digits and dashes, e.g. espresso-machine (never a built-in key)
  label          String // "Espresso machine"
  noun           String? // "espresso machine" (in sentences)
  types          String[]
  brands         String[]
  accessories    String[]
  defaultChecked String[]
  checklist      String[]
  intakeFields   Json     @default("[]") // FieldDef[] (src/lib/equipment/types.ts)
  active         Boolean  @default(true)
  sortOrder      Int      @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([shopId, key])
}

// Where and when a SITE ticket's work happens (central vac installs). The ticket keeps the bill, status and power unit.
model TicketSite {
  ticketId     String    @id
  ticket       Ticket    @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  shopId       String
  shop         Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  address      String
  startsAt     DateTime?
  endsAt       DateTime?
  contactName  String?
  contactPhone String?
  accessNotes  String? // gate code, pets, where to park
  updatedAt    DateTime  @updatedAt

  @@index([shopId, startsAt])
}

// A vacuum the shop sells (new or used; a trade-in). One row per physical unit for good; brand, model, serial and
// owner stay on its Machine. Never deleted: taking one off sale sets REMOVED.
model StockUnit {
  id              String    @id @default(cuid())
  shopId          String
  shop            Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  machineId       String    @unique
  machine         Machine   @relation(fields: [machineId], references: [id], onDelete: Restrict)
  status          String    @default("IN_STOCK") // IN_STOCK | SOLD | REMOVED
  condition       String    @default("NEW") // NEW | OPEN_BOX | REFURB | USED
  costCents       Int? // what it cost the shop (a trade-in: the credit given)
  priceCents      Int? // asking price
  warrantyMonths  Int?
  warrantyBy      String? // who stands behind it: the maker's name, or the shop
  soldLineId      String? // SaleLine that sold it (kept after a return, until it sells again)
  soldAt          DateTime?
  soldNetCents    Int? // what the buyer paid for it before tax (its share of a whole-sale discount taken off): the most a return refunds
  returnLineId    String? // SaleLine that took it back from the buyer
  tradeInLineId   String? // SaleLine that took it in as a trade-in
  warrantyUntil   DateTime?
  registeredAt    DateTime? // warranty registered with the maker
  registrationRef String?
  note            String?
  events          Json      @default("[]") // [{ at, note, prev? }] (prev: the sale fields a trade-in cleared, put back if it is voided)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([shopId, status])
}

// "Bags due" for a customer's vacuum: when someone last got in touch, snoozes and stops. Due dates come from sales.
// Always written after checking the machine is this shop's (the id alone is the key).
model VacCare {
  machineId    String    @id
  machine      Machine   @relation(fields: [machineId], references: [id], onDelete: Cascade)
  shopId       String
  shop         Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  contactedAt  DateTime?
  contactedBy  String? // email | text | the name of whoever called
  contactNote  String?
  snoozedUntil DateTime?
  stopped      Boolean   @default(false)
  updatedAt    DateTime  @updatedAt

  @@index([shopId])
}
```

## Appendix C. `prisma/migrations/20260926120000_paid_modules/migration.sql` (verbatim; also `modules-migration.sql`)

```sql
-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "bagReminderDays" INTEGER NOT NULL DEFAULT 180,
ADD COLUMN     "checkInKind" TEXT NOT NULL DEFAULT 'sewing',
ADD COLUMN     "hubWritesOff" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "details" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "equipment" TEXT NOT NULL DEFAULT 'SEWING',
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'sewing';

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "intake" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "jobType" TEXT NOT NULL DEFAULT 'BENCH',
ADD COLUMN     "readings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "ServiceItem" ADD COLUMN     "equipmentKind" TEXT;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "machineId" TEXT,
ADD COLUMN     "stockUnitId" TEXT,
ADD COLUMN     "tradeInUnitId" TEXT;

-- CreateTable
CREATE TABLE "License" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "addedBy" TEXT,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleGrant" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "key" TEXT,
    "byEmail" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModuleGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopEquipmentKind" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "equipment" TEXT NOT NULL DEFAULT 'APPLIANCE',
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "noun" TEXT,
    "types" TEXT[],
    "brands" TEXT[],
    "accessories" TEXT[],
    "defaultChecked" TEXT[],
    "checklist" TEXT[],
    "intakeFields" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopEquipmentKind_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketSite" (
    "ticketId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "contactName" TEXT,
    "contactPhone" TEXT,
    "accessNotes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketSite_pkey" PRIMARY KEY ("ticketId")
);

-- CreateTable
CREATE TABLE "StockUnit" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_STOCK',
    "condition" TEXT NOT NULL DEFAULT 'NEW',
    "costCents" INTEGER,
    "priceCents" INTEGER,
    "warrantyMonths" INTEGER,
    "warrantyBy" TEXT,
    "soldLineId" TEXT,
    "soldAt" TIMESTAMP(3),
    "soldNetCents" INTEGER,
    "returnLineId" TEXT,
    "tradeInLineId" TEXT,
    "warrantyUntil" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3),
    "registrationRef" TEXT,
    "note" TEXT,
    "events" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VacCare" (
    "machineId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "contactedAt" TIMESTAMP(3),
    "contactedBy" TEXT,
    "contactNote" TEXT,
    "snoozedUntil" TIMESTAMP(3),
    "stopped" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VacCare_pkey" PRIMARY KEY ("machineId")
);

-- CreateIndex
CREATE UNIQUE INDEX "License_shopId_keyId_key" ON "License"("shopId", "keyId");

-- CreateIndex
CREATE INDEX "ModuleGrant_shopId_module_createdAt_idx" ON "ModuleGrant"("shopId", "module", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopEquipmentKind_shopId_key_key" ON "ShopEquipmentKind"("shopId", "key");

-- CreateIndex
CREATE INDEX "TicketSite_shopId_startsAt_idx" ON "TicketSite"("shopId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockUnit_machineId_key" ON "StockUnit"("machineId");

-- CreateIndex
CREATE INDEX "StockUnit_shopId_status_idx" ON "StockUnit"("shopId", "status");

-- CreateIndex
CREATE INDEX "VacCare_shopId_idx" ON "VacCare"("shopId");

-- CreateIndex
CREATE INDEX "Machine_shopId_equipment_idx" ON "Machine"("shopId", "equipment");

-- CreateIndex
CREATE INDEX "SaleLine_stockUnitId_idx" ON "SaleLine"("stockUnitId");

-- CreateIndex
CREATE INDEX "SaleLine_tradeInUnitId_idx" ON "SaleLine"("tradeInUnitId");

-- CreateIndex
CREATE INDEX "SaleLine_machineId_idx" ON "SaleLine"("machineId");

-- AddForeignKey
ALTER TABLE "License" ADD CONSTRAINT "License_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleGrant" ADD CONSTRAINT "ModuleGrant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopEquipmentKind" ADD CONSTRAINT "ShopEquipmentKind_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSite" ADD CONSTRAINT "TicketSite_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSite" ADD CONSTRAINT "TicketSite_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VacCare" ADD CONSTRAINT "VacCare_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VacCare" ADD CONSTRAINT "VacCare_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing service menus are for sewing machines, except the fees that apply to anything brought in (storage, rush, diagnosis)
UPDATE "ServiceItem" SET "equipmentKind" = CASE WHEN "name" ~* '^(storage fee|rush|diagnosis)' THEN NULL ELSE 'sewing' END;
```

---

## Review log

Three critics reviewed revision 1: **S** security and licensing, **O** correctness and operations, **U** product fit. **A** marks what I found myself while revising. "Where" names the section of this revision.

### Security and licensing (S)

| # | Point | Decision | Where |
|---|---|---|---|
| S1 | Lookups and writes without `shopId`; unit, trade-in and VacCare paths could touch another company's rows | Accepted. The tenancy rules are written into §1. Every lookup by id or serial names `shopId`, and guarded writes use `updateMany` with `shopId`. Action bodies live in lib files taking `CurrentUser`. The tenant checks live in each package's own check file plus foundation's `modules-tenant.check.ts`, not one shared file, to keep file ownership disjoint. | 1, 9.5, 10.b–10.d, 13.2 |
| S2 | `STITCH_TEST_BUILD` + the committed dev key make free modules on any self-built server, and a copied variable exposes the hosted app | Partly accepted. The switch stays (build-time). Test keys are now refused whenever `LICENSE_HOSTED_KEY` is set, against a non-local database, or on the Windows program, and the switch is loud and absent from `.env.example`. D2 and D10 are reworded honestly. **Rejected: removing it.** `next dev` gives a self-hoster the same power, so removing it closes nothing, and design.md's finalized §16.3 runs its E2E on production test builds. | D2, D10, 3.3, 3.5 |
| S3 | A later "Turn on" revives a key the admin switched off | Accepted. `adminPosition`: the newest "off" after the newest "none" persists, a newer "on" only adds its window, and rows are ordered by `createdAt` then `id`. Every sequence is in the check. | 5.1, App. A |
| S4.1 | Finder filters categories after `take`, and caps before ranking | Accepted. The category and brand are in the query, and the cap (60) comes after the sort. | 10.b |
| S4.2 | Stock match ignores the brand; short numbers match anything | Accepted. A (brand, number) pair must match. A brandless or Generic part needs a 5+ character number with a digit. Keys under 3 characters never match. | 10.b step 4 |
| S4.3 | Every hosted company writes to the hub as one identity | Accepted. `byName` is "{user} ({company})" on multi-company installs. | 9.5 (`requireHubWrites`) |
| S4.4 | Any tech can remove, merge or revert a community entry | Accepted. `requireAdmin` on those three, and the controls are hidden for techs. | 10.b |
| S4.5 | "tested" on any click outranks the maker; the whole-entry PUT drops others' fits | Accepted. `addVacFit` is cut, and "maker" ranks with "tested" for supplies. | 10.b |
| S4.6 | No way to cut off one hosted company's hub writes | Accepted. `Shop.hubWritesOff` with a switch on Companies, checked by link, cross-reference and shared-post writes. | 2.1, 8, 9.5 |
| S4.7 | Hub `revert-since` and append-only fits endpoints | Rejected for this build. They're optional, and not needed once the finder writes only through `/xref`. | 14 (Q14) |
| S5 | Platform-admin logins can be reset or taken over from inside a company, or claimed at sign-up | Accepted. Reset and switch-off refuse a platform-admin target other than yourself, and `createShopWithOwner` refuses those addresses outside the platform admin and first-company setup. Added a `[modules]` log line and `License.addedById`. | 2.4, 8 |
| S6 | The owner's private key is stored unencrypted and meant to be backed up | Accepted. Passphrase-encrypted PKCS#8 (tested on Node 22), with the passphrase prompted or taken from `STITCH_LICENSE_PASSPHRASE`. "Never imported by a `"use server"` file" became "never exported from one", since `companies.ts` must call `signGrant`. | 4, 6.2 |
| S7 | Removing a leaked kid switches off paying customers; nothing re-signs hosted switches | Accepted. Kids are retired (`lastDay`, `allow` payload hashes), never removed. `resign-grants.ts` and the rotation steps are written out. | 3.3 |
| S8 | A clock set ahead freezes module time; a new key can't undo it | Superseded. `ModuleClock` is cut (O3, U15). The floor is derived from the keys alone, on the Windows program only, so there's nothing to get stuck. | 5.5 |
| S9a | `saveAccessories` still adds accessories in close mode | Accepted. `add` is ignored when the ticket isn't workable. | 9.5 |
| S9b | `deletePhoto` / `updatePhoto` ungated | Accepted. The ticket or machine gate applies. | 9.5 |
| S9c | Estimate links work on lapsed tickets and move them to ON_BENCH | Accepted. `sendEstimate` runs the ticket gate, and an approval moves the status only when workable. Added to design.md's files by `modules-crossover`. | 12.4 items 4–5 |
| S9d | Queued bags-due messages still send after the module lapses | Accepted. `bagsDueStillWanted` is hooked into `stillWanted` by `modules-crossover`. | 10.c′, 12.4 item 7 |
| S9e | Scope checks in two places | Accepted. `verifyFor(text, use)` is the only app caller of `verifyLicense`. | 3.4, 6.1 |
| S9f | Pages must not select key text | Accepted. Only `modules.ts` reads keys; Companies uses `grantHistory`. | 1, 7, 8 |
| S-cut 1 | Cut `STITCH_TEST_BUILD` | See S2. | 3.3 |
| S-cut 2 | Cut `addVacFit` / `saveVacSupply` | Accepted. The finder links to the existing `/xref` editor and add form, prefilled. | 10.b |

### Correctness and operations (O)

| # | Point | Decision | Where |
|---|---|---|---|
| O1 | A lapsed module freezes open work: no lines, notes or Ready; unit returns refused | Accepted. D3 is rewritten: tickets and installs opened before `endedAt` stay workable until closed, and returns are ungated. | D3, 5.2, 6.3, 6.4, 10.c |
| O2 | Cross-design edits are orphaned or collide (scheduler, calendar, service-due, stillWanted, setStatus, test commands) | Accepted, differently. design.md, finalized during this review, now carries the scheduler, calendar, service-due, `bags_due` kind and `setStatus` items. The rest go to a new last package, `modules-crossover`, which runs after their owners, so nothing is orphaned or concurrent. **Rejected: editing design.md directly.** It is another architect's finalized document. | 12.4, 13.1, 13.2 |
| O3 | Clock floor: no cap, 216 h per hour, owner's clock leaks in, check pollutes the shared row | Accepted, by cutting `ModuleClock` (O-cut 2). The keys-only floor is t − 48 h, on Windows only, and nothing is stored. | 5.5 |
| O4 | Turn on after Turn off revives the key | Accepted (= S3). | 5.1 |
| O5 | Restore wipes pasted keys; the fix-up turns "every kind" menus into sewing | Accepted. Keys are saved before `TRUNCATE` and merged back, and fix-ups can be version-gated. The SQL was tested; truncating `Shop` alone is refused by Postgres, so the merge is the only way. | 2.4 |
| O6 | Unit refunds ignore the whole-sale discount; trade-in tax can go negative | Accepted. `soldNetCents` comes from `discountShares` and caps refunds. Trade-ins are never taxable, and `tradeInReducesTax` is cut. | 10.c, 13.4 |
| O7 | Brand-blind stock match rings up the wrong bag | Accepted (= S4.2). | 10.b |
| O8 | Key format and rotation break old installs; hosted grants travel with a DB copy | Accepted. `v` is checked first, any short plan word is allowed, kids are retired, and `resign-grants.ts` exists. Hosted rows count only on a server holding a *genuine* hosting key (its public half checked), not "the same kid", so a rotation causes no lapse and a copied `LICENSE_HOSTED_KID` proves nothing. | 3.2–3.4, 6.2 |
| O9 | Vacuums on file as sewing machines can't be converted | Accepted. `convertMachineKind`, plus the `/vac/convert` review list under Vac Shop (not `/settings/equipment`, which `appliance-repair` owns). | 9.1, 9.5, 10.0 |
| O10 | Machine edits bypass the unit; trading back a sold unit loses its history | Accepted. `updateMachine` refuses those edits, serial reuse skips units in stock, and a trade-back keeps a `prev` snapshot that a void restores. | 9.5, 10.c |
| O11 | Repair-only companies can't sell what they bought | Accepted. A card links the existing "Sells over the counter" setting. | 10.0 |
| O12 | Old installs' whole-entry saves overwrite fits | Rejected for this build. That is today's `/xref` behaviour, unchanged; the finder no longer adds a write path, and the append endpoint is a later option. | 14 (Q14) |
| O13 | Per-company module loads multiply queries | Accepted. `loadModulesMany` uses 3 queries, and so do `shopsWithModule` and Companies. | 6.1, 8 |
| O14a | Backfill makes storage, rush and diagnosis sewing-only | Accepted. The backfill `CASE` and `starterKindFor` share one rule. | 2.3, 2.4 |
| O14b | "Send reminders" marks skipped customers contacted | Accepted. Only queued rows are marked. | 10.c′ |
| O14c | Install estimate approval jumps to In progress | Accepted. Approval moves a SITE ticket to Booked. | 12.4 item 4 |
| O14d | Monthly end dates drift | Accepted. Anchor day, `--renew`, `--renew-due`. | 4, App. A |
| O14e | "Most common kind" can show a sewing model as a vacuum | Accepted. The guess is removed; `kindByKey` treats a missing kind as sewing. | 9.3, 9.4 |
| O14f | Warranty dated in UTC | Accepted. `warrantyEnd` uses shop time (in the check). | 10.c |
| O-cut 1 | `tradeInReducesTax` | Accepted. | 2.1, 10.c |
| O-cut 2 | Clock-floor enforcement | Accepted. The keys-only floor is kept on Windows, with the warning. | 5.5 |
| O-cut 3 | Automatic bags-due sending | Accepted. `runBagsDue` is kept as a no-op, since design.md calls it. | 10.c′ |
| O-cut 4 | Shop changes to built-in kinds | Accepted. Built-ins are shown read-only, and shop kinds stay. | 11.2 |
| O-cut 5 | `addVacFit` | Accepted. | 10.b |
| O-cut 6 | Install crew, Arrived / Finished, crew sheet | Accepted. | 10.d, App. B |
| O-cut 7 | `VacCare.intervalDays`; `SuppliesThatFit` | Accepted for `intervalDays`. `SuppliesThatFit` is kept on vacuum machine pages only (U-cut 5 keeps it there) and dropped from model pages. | 10.b, 10.c′ |
| O-cut 8 | `kindForModel` guess | Accepted. | 9.3 |

### Product fit (U)

| # | Point | Decision | Where |
|---|---|---|---|
| U1 | Lapse freezes repairs already on the bench | Accepted (= O1). | D3, 6.3 |
| U2 | No way to find out how to buy from inside the app; techs told to do admin things | Accepted. `MODULE_SALES` and "Ask about / Renew {label}" mailto links with the Company ID, and messages that depend on the role. | 5.3, 6.6, 7 |
| U3 | Repair-only shops have no register; the register can't add a customer | Accepted. A card linking the existing setting (no new `turnOnRegister`: the checkbox exists), and "New customer" at the register (`quickAddCustomer`). | 10.0, 13.4 |
| U4 | Scanning a vacuum finds nothing and invites adding it as a Part | Accepted. `registerUnitHits` in `itemByCode` / `findItems`, a "Nothing matches" hint, and serials one per line. | 10.c, 13.4 |
| U5 | Finder: exact model only, ignores bag type, one pack size | Accepted. One search box, type and number search, prefix close matches, the bag type sent from the vacuum, and every stocked item with its own Add. | 10.b |
| U6 | Bags due texts bagless buyers and misses real ones | Accepted. `bagged` is required on unit and trade-in forms, only "Bagged" is listed, and bag PART lines on tickets count. Purchases by a customer with one bagged vacuum are counted when reading, rather than by changing `completeSale`. | 10.c′ |
| U7 | Check-in always opens on sewing; wrong kinds are permanent | Accepted. `Shop.checkInKind`, dashboard buttons, a kind change within the same equipment, `convertMachineKind` across equipments, and a lapsed kind shows no form. | 9.1, 9.4, 9.5, 11.2 |
| U8 | Resin printers get the FDM checklist | Accepted. A `resin-printer` kind, FDM cleaned up, a nozzle field, and the dime reading relabelled. | 11.1 |
| U9 | CLI needs too many flags and isn't Windows-friendly | Accepted. npm scripts, interactive mode, `~` expansion, default key, `--renew`, `--renew-due`, `--resend`, `--trial`, log columns, and email files. | 4 |
| U10 | Monthly customers nagged; hosted renewals manual | Accepted. A 3-day monthly reminder with its own copy, the Company ID column, and "Extend 1 month / 1 year". | 5.4, 8 |
| U11 | Pipe-delimited question syntax | Accepted. Question rows; the readings editor is cut. | 11.2 |
| U12 | Starter menus at $0; storage fee and rush become sewing-only | Accepted. `ServiceDef.priceCents`, $0 items created switched off, and the backfill rule. No made-up prices are shipped (Q6). | 2.3, 9.5 |
| U13 | No way to sell an abandoned vacuum | Accepted. `unitFromAbandoned` ("Put up for sale"). | 10.c |
| U14 | Install statuses and placeholder don't fit how installs are sold | Accepted. Booked / Quote first / Not scheduled, an optional power unit with "Set the power unit", and "central vac install" in messages. | 2.5, 10.d, 12.4 |
| U15 | Clock floor locks shops out | Accepted (cut). | 5.5 |
| U16 | Grace banner prints and faces customers | Accepted. `no-print`, hidden on `/register` for techs, amber until the last 3 days. | 6.6 |
| U17 | Finder can't save a fit offline | Partly accepted. `addVacFit` is cut. Offline or not joined, local results link to the part so the model can go in its Fits. | 10.b |
| U18 | Getting started list; whole-email paste; LAN copy; export answers; sewing-only wording | Accepted, all five. | 7, 3.1, 6.6, 9.6, 9.4 |
| U-cuts | ModuleClock; auto bags-due and `intervalDays`; readings editor; Arrived / Finished; `SuppliesThatFit` on model pages; unverified maker URLs | Accepted, all six. Quick links are Google, eBay and YouTube searches only. | 5.5, 10.c′, 11.2, 10.d, 10.b, 9.3 |
| U-missing | Warranty repairs billed to the maker; extended plans; serialized sewing sales | Deferred. Unit code takes its equipment from the kind, so sewing units can come later. | 10.c |

### Found while revising (A)

| # | Point | Decision | Where |
|---|---|---|---|
| A1 | After "Let keys decide" removed an admin "on", `endedAt` fell back to an old key's grace end, so tickets opened under the admin's window couldn't be finished | Fixed. `endedAt` is the later of the window's end and the switch's last change (in the check). | 5.2, App. A |
| A2 | design.md was finalized during this review: its test servers are production test builds, and it already carries most of section 12.4 | Section 12 is rewritten against it, and the test switch is kept working (S2). | 12, 3.3 |
| A3 | design.md's review-only `schema.prisma` embeds revision 1's modules schema | No action. It is for review only. Its binding `migration.sql` touches none of the changed columns, and it was re-applied on top of this revision's migration (rolled back). | Companion files |
| A4 | `finder.ts` and `vac-units.ts` are imported by other packages (bags due, register) | Made foundation stubs, so every package compiles in any landing order. | 13.3 |
