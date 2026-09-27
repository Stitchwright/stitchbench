# StitchBench data model and record flows for scheduling and messaging (read-only survey of `/home/user/stitchbench-feat`)

The branch `feat/scheduling-messaging` is clean and at `9ba25a4`. No email or SMS library is installed: `nodemailer`, `twilio` and any SMTP code are absent from `package.json` and `src`. `zod` is installed but only `src/auth.ts` uses it. Paths below are relative to `/home/user/stitchbench-feat`. Anything marked **Suggested** is a design proposal, not existing code.

---

## 1. Schema conventions (`prisma/schema.prisma`, 1013 lines)

- **Generator:** `provider = "prisma-client"`, output `../src/generated/prisma`. Code imports enums from `@/generated/prisma/enums` and `Prisma` from `@/generated/prisma/client`. The Postgres URL lives in `prisma.config.ts`, not in the schema.
- **Local-only row ids:** `id String @id @default(cuid())`.
- **Ids shared with a partner** (same id on both shops): `id String` plus `@@id([shopId, id])`. The originating shop makes the id with `crypto.randomUUID()` (`src/actions/repair-jobs.ts:80`, `src/actions/partner-orders.ts:45`, `src/actions/partners.ts:103`). Compound-key lookups look like `where: { shopId_id: { shopId, id } }`.
- **Tenancy:** every business row has `shopId String` and `shop Shop @relation(fields:[shopId], references:[id], onDelete: Cascade)`. Each model is also added to the back-relation list on `Shop` (`schema.prisma:58-75`).
- **Optional foreign keys** to Customer, Machine or User use `onDelete: SetNull`. The one exception is `Ticket.machine`, which is `onDelete: Restrict` (`:284`).
- **Timestamps:** `createdAt DateTime @default(now())`. Mutable shared records also have `updatedAt DateTime @updatedAt` (Ticket, PartnerLink, RepairJob, PartnerOrder, ConsignItem). **`Customer` has no `updatedAt`.**
- **Naming:** money is `Int` with a `…Cents` suffix; percentages are `Float` with `…Pct`; instants are `…At`.
- **Statuses:** the older core uses Prisma enums (`TicketStatus`, `CustomerKind`, `Role`, `PaymentMethod`, …). The newer StitchShop models use a plain `String` with the allowed values in a comment, for example `status String @default("PLACED") // PLACED | ACCEPTED | …` (PartnerOrder `:914`), `Sale.status // COMPLETED | VOIDED` (`:772`), and `RepairJob.status // TicketStatus names` (`:862`). Labels live in `src/lib/constants.ts` as `Record<…, string>` (for example `ORDER_STATUS_LABEL: Record<string,string>`).
- **History:** `events Json @default("[]")` holding `[{ at, status?, note? }]` (`JobEvent`, `src/lib/partners.ts:112`), capped at 200 by `withEvent()` (`partners.ts:85-88`, not exported).
- **Per-shop numbering:** `@@unique([shopId, number])` plus a counter on `Shop` (`nextTicketNumber`, `nextSaleNumber`, `nextTagNumber`, `nextOrderNumber`), incremented atomically inside a transaction:
  ```ts
  const sh = await tx.shop.update({ where: { id: shopId }, data: { nextSaleNumber: { increment: 1 } }, select: { nextSaleNumber: true } });
  const number = sh.nextSaleNumber - 1;   // register.ts:233-234
  ```
- **Index patterns:** `@@index([shopId, status])`, `@@index([shopId, createdAt])`, `@@index([shopId, linkId])`, `@@index([shopId, name])`.
- **Secrets at rest:** there is no encryption helper anywhere in `src` (no `createCipheriv`). The only precedent is `HubState.installKey`, stored as plaintext (`:656`). `AUTH_SECRET` exists in both deployments: `.env.example:4`, and the desktop build generates it into `secrets.json` and passes it as an environment variable (`desktop/main.mjs:147,276`).

### Migrations
- Folder naming is `YYYYMMDDHHMMSS_snake_name/migration.sql`. The newest are hand-rounded timestamps: `20260926090000_review_fixes`, `20260926090100_session_version`, `20260926100000_job_snapshot_at`. **The next one must sort after `20260926100000`**; `20260926110000_scheduling_messaging` would fit (**Suggested**).
- The SQL is Prisma-generated style:
  - Comment headers `-- AlterTable`, `-- CreateTable`, `-- CreateIndex`, `-- AddForeignKey`.
  - `ALTER TABLE "X" ADD COLUMN     "y" INTEGER;` (five spaces after `ADD COLUMN`).
  - Constraint names `"X_pkey"`, `"X_shopId_fkey"`, index `"X_shopId_status_idx"`, unique `"X_a_b_key"`.
  - Foreign keys end `ON DELETE CASCADE ON UPDATE CASCADE` (or `SET NULL`).
  - Hand-written backfills go at the end, after a comment (`20260926090000_review_fixes` ends with `UPDATE "Listing" SET "shopId" = …`).
- Excerpt from the newest migration:
  ```sql
  -- AlterTable
  ALTER TABLE "RepairJob" ADD COLUMN     "snapshotAt" TIMESTAMP(3);
  ```
- **The desktop app applies migrations itself** (`desktop/migrate.mjs:25-45`):
  - each `migration.sql` runs in its own `BEGIN`/`COMMIT`;
  - it records a sha256 checksum in `_prisma_migrations`;
  - so an applied migration must never be edited.
  - Postgres is 17 on both the desktop (`embedded-postgres 17.10.0`) and docker-compose (`postgres:17`). `ALTER TYPE … ADD VALUE` therefore works inside the transaction, but the new value cannot be used in the same migration.
- The hosted app runs `npm start` → `release` → `prisma migrate deploy && tsx prisma/seed.ts --if-empty`.

---

## 2. The models these features touch (exact fields)

**`Shop`** (`:25-76`): `id, name, phone?, email?, address?` (a single free-text string; nothing requires it to be set), `laborRateCents, taxRatePct, partsMarkupPct, warrantyDays, abandonedAfterDays, storageFeeCents, nextTicketNumber, libraryRoot, checklistItems String[], priceListNote?, payInstructions?, doesRepair Boolean @default(true), sellsRetail Boolean @default(false), nextSaleNumber, nextTagNumber, nextOrderNumber, receiptNote?, timeZone String @default("America/New_York"), createdAt`.
- It has no SMTP, Twilio, reminder or quiet-hours fields.
- `saveShop` (`src/actions/settings.ts:23-50`, `requireAdmin()`) writes the fields one by one and validates the time zone with `validTimeZone()` (`:13-21`).

**`User`** (`:78-97`): `id, shopId, email @unique, name, passwordHash, role Role(OWNER|ADMIN|TECH) @default(TECH), active, sessionVersion, createdAt`. It has **no phone** and no shift or availability data. Staff shifts would reference `User.id` (**Suggested**: `onDelete: SetNull` or `Cascade`).

**`Customer`** (`:103-131`):
```prisma
enum CustomerKind { RETAIL  TRADE }
model Customer {
  id String @id @default(cuid());  shopId String;  kind CustomerKind @default(RETAIL)
  name String;  phone String?;  email String?;  address String?
  // Trade accounts only
  code String? // short code printed on route sheets, e.g. QS1
  commissionPct Float?;  routeDay String?;  notes String?;  createdAt DateTime @default(now())
  machines Machine[]; tickets Ticket[] @relation("TicketCustomer"); viaTickets Ticket[] @relation("TicketViaAccount")
  sales Sale[]; repairJobs RepairJob[]
  @@index([shopId, name])
}
```
- There is no consent, opt-out, preference, normalized phone, time zone or `updatedAt` field.
- **No code path deletes a customer** (grep finds no `customer.delete`), so consent records on the row persist unless the whole Shop is deleted (cascade).

**`Machine`** (`:137-157`): `brand, model, modelKey, serial?, machineType?, customerId? → Customer onDelete SetNull, notes?`. Indexes are `[shopId, serial]` and `[shopId, brand, modelKey]`.

**`Ticket`** (`:264-325`):
- `status TicketStatus @default(ON_BENCH)`
- `machineId` (Restrict)
- `customerId?` via relation "TicketCustomer" (SetNull)
- `viaAccountId?` via relation "TicketViaAccount": the TRADE customer the machine came through
- `intakeAt, readyAt?, closedAt?, warrantyUntil?, openedById?, techId?, notes?, createdAt, updatedAt`
- `@@unique([shopId, number])`, `@@index([shopId, status])`

`TicketStatus` values, in order: `AT_SHOP_AWAITING_PICKUP, IN_TRUCK, ON_BENCH, WAITING_CUSTOMER_OK, WAITING_PARTS, READY_IN_TRUCK, READY_FOR_PICKUP, COLLECTED, ABANDONED, RETURNED_UNREPAIRED`.

**`Sale` / `SaleLine`** (`:755-802`): `Sale.customerId?` (SetNull), `tenders Json`, `status String "COMPLETED"|"VOIDED"`, `@@unique([shopId, number])`. On `SaleLine`, `partId?` is a real foreign key, but `repairJobId String?` (`:801`) and `consignLinkId`/`consignItemKey` are **plain strings with no relation**, because RepairJob has a compound primary key. That is the pattern to copy for a class-fee line (**Suggested**: `classSeatId String?` or `bookingId String?`).

**`PartnerLink`** (`:805-831`):
- `id` is the hub's link id; `@@id([shopId, id])`
- `side "repair"|"retail"`, `partnerName`, `status "ACTIVE"|"ENDED"`
- `terms Json` (`PartnerTerms`), `termsVersion`, `accepted`, `proposedTerms`, `proposedBy`
- `accountId?`: on the repair side, the TRADE Customer id; it is a plain string with no foreign key
- `catalog?`, `catalogAt?`, `catalogHash?`, `endedAt?`

**`PartnerOutbox`** (`:834-851`): `shopId, linkId, type, data Json, createdAt, sentAt?, tries, error?, nextTryAt?, deadAt?`. **`PartnerSeen`** and **`PartnerFailure`** (`:991-1013`) handle de-duplication and set-aside messages.

**`RepairJob`** (`:855-904`) is shared by both shops under the same id, with `@@id([shopId, id])`, `@@index([shopId, status])` and `@@index([shopId, linkId])`:
- `linkId`
- `side String // retail (we took it in) | repair (we fix it)`
- `tag` (the sewing shop's claim-tag number)
- `status String @default("AT_SHOP_AWAITING_PICKUP") // TicketStatus names`
- `customerId? → Customer` (SetNull), **set on the retail side only**: "the customer's details never leave the sewing shop"
- `machineId? → Machine` (SetNull)
- `customerName` (what the repair shop sees: "Mary S.", from `shortName()` at `repair-jobs.ts:23-26`)
- `brand, model, serial?, machineType?, problem?, serviceRequested?, accessories[], preApprovedCents?`
- `ticketId? @unique`: global unique index; the repair side sets it
- `ticketNumber?, totalCents?, taxCents?, lines Json?, commissionPct, commissionCents?, repairNote?`
- `approval? ("APPROVED"|"DECLINED"), approvedCents?`
- `paidCents?, paidAt?, paidWhere? ("shop"|"repair"|"split"), repairPaidCents?, pickedUpAt?`
- `events Json`, `sentHash?` (repair side), `snapshotAt?` (retail side: time of the last applied `job.update`), `createdAt, updatedAt`

**RepairJob has no `readyAt`**: the `job.update` message carries `readyAt` (`partners.ts:376`), but the retail side never stores it.

**`PartnerTerms`** (`src/lib/partner-terms.ts:4-23`) includes `pickupDay: string|null` and `turnaroundDays`. No other pickup or route schedule data exists anywhere.

---

## 3. `src/lib/constants.ts` (151 lines)
- `STATUS_LABEL` (`:4-15`). Note that `READY_FOR_PICKUP` is labelled **"Ready - customer called"** and `READY_IN_TRUCK` is "Ready - in truck".
- `STATUS_ORDER` (`:17-28`).
- `IN_CUSTODY` (`:31`): `IN_TRUCK, ON_BENCH, WAITING_CUSTOMER_OK, WAITING_PARTS, READY_IN_TRUCK`.
- `OPEN_STATUSES` (`:32-34`): everything except `COLLECTED`, `ABANDONED`, `RETURNED_UNREPAIRED`.
- `STATUS_TONE` (`:36-47`): both READY statuses are "ready".
- `PAYMENT_LABEL`, `LINE_LABEL`, `NOTE_LABEL`, `PHOTO_KIND_LABEL`, `MACHINE_TYPES`, `ACCESSORIES`, `DOC_TYPES`.
- `JOB_STATUS_LABEL` (`:132-143`), the retail-side wording: `READY_IN_TRUCK: "Fixed, on its way back"`, `READY_FOR_PICKUP: "Ready for the customer"`.
- `ORDER_STATUS_LABEL` (`:145-151`).

Following AGENTS.md, new status or label lists (booking, class, run, message statuses) should be added here in the same `Record` style.

Related constants in `src/lib/partners.ts:26-28`: `FINAL = [COLLECTED, ABANDONED, RETURNED_UNREPAIRED]`, `READY = [READY_IN_TRUCK, READY_FOR_PICKUP, RETURNED_UNREPAIRED]`, and `STATUSES` (all ten).

---

## 4. Where customers are created or edited, and how phone and email are captured

| Path | File:line | Phone / email handling |
|---|---|---|
| Customer form (create/edit, RETAIL or TRADE) | `src/actions/records.ts:91-119` `saveCustomer(customerId\|null, fd)`; UI `src/components/customer-form.tsx:19-89`, used at `customers/page.tsx:78` (Add) and `customers/[id]/page.tsx:98` (Details) | `phone: str(fd.get("phone"))`, `email: str(fd.get("email"))`. Only trimming; no server-side validation. The inputs are `type="tel"` and `type="email"` (`customer-form.tsx:42,48`), so the browser checks email only. |
| Repair intake, new customer typed in (StitchBench) | `src/actions/tickets.ts:36-47` in `createTicket`; UI `app/(app)/tickets/new/page.tsx:42-59` (`customerName`, `customerPhone`, `customerEmail`) | Phone and email are optional. **When an existing `customerId` is picked, typed phone/email are ignored.** |
| Sewing-shop take-in, new customer (StitchShop) | `src/actions/repair-jobs.ts:45-58` in `takeInMachine`; UI `src/components/intake-form.tsx:73-112` | **Phone is required** for a new customer (`:54`: "so you can call them when it's ready"); email is optional. Typed values are ignored when an existing customer is picked. |
| Partner trade account created automatically (repair side) | `src/lib/partners.ts:239-253` `tradeAccountFor` | `kind: "TRADE"`, `commissionPct = terms.repairCommissionPct`, `routeDay = terms.pickupDay`. No phone or email. |
| Register | `src/actions/register.ts:113-130` `findCustomers` (RETAIL only; name, last 4 phone digits, or email); the sale sets `Sale.customerId` at `:239` | **The register never creates or edits a customer**, only selects one (UI `src/components/register.tsx:386-420`). |

Other facts:
- Phone numbers are never normalized. Searches use `phone: { contains: term }` (`customers/page.tsx:19`) and a last-4-digits `contains` match (`register.ts:119-124`). Sending texts through Twilio will need E.164 numbers.
- **Pitfall in `saveCustomer`:** it builds one full `data` object from the form and writes it on both create and update (`records.ts:97-111`). Any field missing from the form is overwritten, for example `code: kind === "TRADE" ? … : null`. Consent fields must be written by their own actions, or explicitly left out of this object; otherwise every profile save would wipe them.
- The customer CSV export (`src/app/api/export/[what]/route.ts:12-17`) has columns `name, kind, phone, email, address, code, commission_pct, notes, created`. Consent columns belong here for record keeping (**Suggested**).

**Suggested places for consent and preferences** (none of this exists yet):
- On `Customer`:
  - `phoneE164 String?` with `@@index([shopId, phoneE164])`, for matching inbound STOP/HELP;
  - `emailOptInAt DateTime?`, `emailOptInSource String?`, `emailOptOutAt DateTime?`;
  - `smsOptInAt DateTime?`, `smsOptInSource String?`, `smsOptInText String?`, `smsOptOutAt DateTime?` (a STOP blocks transactional texts too);
  - `notifyBy String @default("")` for reminders and pickup notices (`email | sms | both | none`).
- An append-only consent log, `ConsentEvent { id cuid, shopId, customerId? (SetNull), channel "email"|"sms", action "optin"|"optout"|"help", source, detail, byUserId?, at }`, because the fields on `Customer` get overwritten over time.
- Shop-level settings go on `Shop` (or a 1:1 `ShopMessaging` table): SMTP host, port, secure, user, password, from; Twilio account SID, token, from number or messaging service SID; reminder toggles. They would be saved by a new `requireAdmin()` action shaped like `saveShop`.

---

## 5. Every code path that changes a Ticket's status (StitchBench side)

| # | File:line | Transition | Notes |
|---|---|---|---|
| T1 | `src/actions/tickets.ts:115` (`createTicket`, transaction at `:96-131`) | create with `str(fd.get("status")) ?? (viaAccountId ? "AT_SHOP_AWAITING_PICKUP" : "ON_BENCH")` | The form has no status field, but **the value is cast without checking it against `STATUS_ORDER`**, so a crafted request could create a ticket already in `READY_*`. |
| **T2** | **`src/actions/tickets.ts:140-155` `setStatus(ticketId, status)`** | **any → any status in `STATUS_ORDER`.** `readyAt` is set at `:146` only on the first move into `READY_IN_TRUCK`/`READY_FOR_PICKUP`; `closedAt`/`warrantyUntil` at `:147-152`; `db.ticket.update` at `:153` (no transaction); `refresh()` → `kickPartnerSync()` at `:154`/`:21-27` | **This is the only path that puts a ticket into `READY_IN_TRUCK` or `READY_FOR_PICKUP`.** It does not check whether the status actually changed. Called only from `StatusSelect` (`src/components/ticket-controls.tsx:9-38`, `onChange`). |
| T3 | `src/lib/partners.ts:804-811` (`job.reply` from the sewing shop) | `WAITING_CUSTOMER_OK → ON_BENCH` when approved (`:808`) | Runs in the background sync. |
| T4 | `src/lib/partners.ts:833-851` (`job.pickedup`) | `READY_* → COLLECTED` (`:843`); leaves `RETURNED_UNREPAIRED` as it is | Only if `READY.includes(t.status)` (`:838`). |
| T5 | `src/lib/partners.ts:853-867` (`job.cancel`) | `AT_SHOP_AWAITING_PICKUP → RETURNED_UNREPAIRED` (`:863`) | |
| T6 | `src/lib/partners.ts:1066-1081` (`newJobFromPartner`) | create with `AT_SHOP_AWAITING_PICKUP` (`:1072`) | `customerId` is **not set**; `viaAccountId = link.accountId`. |

The scanner station (`src/actions/scan.ts:60-73`) and the rest of `tickets.ts` never change status. No bulk "run" status action exists.

**Suggested StitchBench "ready for pickup" hook: `src/actions/tickets.ts` `setStatus`, between `:145` and `:153`.**
- Fire only when `t.status !== status` and `status` is in `["READY_FOR_PICKUP"]`, plus `READY_IN_TRUCK` if the design wants it; that choice is open.
- Insert the queued notice in the **same `db.$transaction`** as the `ticket.update`.
- De-duplicate with a unique key such as `(shopId, kind, ticketId, readyAt-episode)`. `readyAt` is set only once, so a ticket that goes READY → ON_BENCH → READY keeps its first `readyAt`.
- `ownTicket` (`:15-19`) already loads `include: { shop: true }`; add `customer: true` for the recipient.
- **Who receives it:**
  - a direct ticket: `t.customerId`;
  - a partner ticket: `t.customerId` is null (T6), so nothing goes out from the bench, and the sewing shop sends it (section 6);
  - a non-partner trade ticket: it has `viaAccountId` and may also have `customerId`. Whether the end customer or the quilt shop gets the notice is a product decision the code does not settle. The Machine Log label "Ready - customer called" suggests the shop currently makes the call.

---

## 6. StitchShop `RepairJob` statuses, and how the sewing shop learns the machine is ready

**Retail-side status writes:**
- `repair-jobs.ts:89-110`: `takeInMachine` creates the job; status comes from the schema default `AT_SHOP_AWAITING_PICKUP`, with an event at `:108`. It sends `job.new` at `:115-136`.
- `repair-jobs.ts:165-177`: `markPickedUp` sets `COLLECTED` (`:173`). Allowed from `READY_IN_TRUCK | READY_FOR_PICKUP | RETURNED_UNREPAIRED` (`:169`). Sends `job.pickedup`.
- `repair-jobs.ts:180-195`: `cancelJob`, only from `AT_SHOP_AWAITING_PICKUP`, sets `RETURNED_UNREPAIRED` (`:190`). Sends `job.cancel`.
- `register.ts:287-305`: `completeSale` does `updateMany … paidAt, and if pickedUp { pickedUpAt, status: "COLLECTED" }` (`:292-301`). Sends `job.paid` and `job.pickedup`.
- **`partners.ts:754-792`: applying `job.update` from the repair shop.** This is the only way `READY_*` reaches the retail copy.

**Repair-side copy:** created at `partners.ts:1082-1105`; its status mirrors the ticket through `pushJobUpdates` (`partners.ts:383-418`, status at `:401`).

**The whole flow:**
1. A tech changes the status → `setStatus` (T2) → `kickPartnerSync()` (1.5 s debounce, `partners.ts:127-133`).
2. `doPartnerSync` (`:591-618`) → `pushJobUpdates` (`:383-418`). It builds `jobSnapshot` (`:351-378`: `status, ticketNumber, lines, totalCents, taxCents, commission…, repairNote, repairPaidCents, paidAt, readyAt`), compares a sha1 hash with `sentHash`, updates the repair-side job, and inserts a `PartnerOutbox` row `type:"job.update"`.
3. `pushOutbox` (`:467-509`) sends `POST /v1/partners/links/:id/messages` to the hub. If the hub is down it backs off, and it keeps messages in order per link.
4. On the sewing shop's install: a timer (`src/instrumentation.ts:13-14`, every `PARTNER_SYNC_SECONDS` seconds, default 60) → `pullMessages` (`:528-575`) → `applyMessage` (`:658`) → `case "job.update"`:
   ```ts
   const job = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id: idOf(d.id, "job") } } });
   if (!job || job.side !== "retail" || job.linkId !== link.id) return;
   if (job.snapshotAt && at <= job.snapshotAt) return;          // :758 older snapshot ignored
   const status = STATUSES.includes(String(d.status)) ? String(d.status) : job.status;  // :759
   ...
   await db.repairJob.update({ where: { shopId_id: { shopId, id: job.id } }, data: { status, …, events, snapshotAt: at } });  // :773-790
   ```
5. Where the sewing shop's screens show it:
   - `/repairs` puts `READY_FOR_PICKUP` and `READY_IN_TRUCK` together under "Ready for the customer" (`app/(app)/repairs/page.tsx:9`);
   - `/repairs/[id]` shows a "Handing it back" section when `ready` (`repairs/[id]/page.tsx:25,90-110`);
   - `pickupJobs` at the register (`register.ts:94-111`).
   - The partner to-do list (`src/components/partner-todo.tsx:14,28`) covers only `WAITING_CUSTOMER_OK` ("call the customer about the estimate"); it has no item for ready jobs.

**Suggested StitchShop "ready for pickup" hook: `src/lib/partners.ts`, `case "job.update"`, at `:773-790`.**
- Fire when `status !== job.status` and `status === "READY_FOR_PICKUP"` (and perhaps `RETURNED_UNREPAIRED`, with a different template).
- Recipient: `job.customerId` → Customer (retail side only).
- Wrap the update and the notice insert in one `db.$transaction`. `PartnerSeen` is written only after `applyMessage` returns (`:543-544`), and a re-applied message exits early at `:758`. A notice inserted outside the update's transaction could therefore be lost after a crash.
- This code runs in the background sync with **no user session**: use `shop.id` from `:659-661` and never call `requireUser()`.
- Because a desktop install can be offline for days, several updates may be applied in one pull (for example READY, then COLLECTED). The sender should re-check the job's current status and `pickedUpAt` just before sending.

**Gap to note:**
- The sewing shop has no action to record "the machine arrived back at our counter". Its ready state is purely the repair shop's ticket status.
- `READY_IN_TRUCK` ("Fixed, on its way back") is already treated as ready at the register (`register.ts:97`) and by `markPickedUp` (`:169`).
- If "back and ready" must mean physically on the shelf, one option is a retail action on `/repairs/[id]` ("It's here, tell the customer", in `src/actions/repair-jobs.ts`); another is to trigger only on `READY_FOR_PICKUP`. The e2e test moves `ON_BENCH` straight to `READY_FOR_PICKUP` (`tests/partners.spec.ts:151`).

**Privacy constraint:** customer contact details never go to the repair shop (`schema.prisma:863`, `repair-jobs.ts:22-26`; the e2e test asserts the phone is absent at `tests/partners.spec.ts:124`). Partner messages about runs or notices must not carry the customer's phone or email.

---

## 7. Partner message rules (for partner pickup runs)
- **Allowlist of types and senders:** `FROM` (`partners.ts:634-653`). Types in `NEW_WORK` (`:656`) are refused once the link has ended. **An unknown type is silently ignored (`:663`)**, so an older install ignores new message types.
- **New types need no hub change:** the hub accepts any type matching `TYPE = /^[a-z]{2,20}(\.[a-z]{2,20})?$/` and messages up to 4 MB (`/home/user/stitchhub/src/partners.mjs:12-13,171-186`, read only). Names like `run.new` or `run.update` pass.
- **Sending:** `sendToPartner(shopId, linkId, type, data, tx?)` (`partners.ts:136-139`) inserts into the outbox inside the caller's transaction.
- **Checking what a partner sent:** use the helpers `idOf`, `text`, `need`, `int`, `optInt`, `dateOf`, `arr`, `strings` (`:44-77`) and throw `bad()` / `PartnerDataError` for bad data. Look up the link with `partnerLink(shopId, id)` (`:116-120`).
- **A new shared record** (for example a `PartnerRun`) should copy `RepairJob` and `PartnerOrder`: `id String` (a UUID from the originator), `shopId`, `linkId`, `side`, `status String`, `events Json`, `createdAt`, `updatedAt`, `@@id([shopId, id])`, `@@index([shopId, linkId])`. Add a `case` in `applyMessage` and an entry in `FROM`.

---

## 8. Trade accounts and "route sheets"
- A trade account is `Customer.kind = TRADE` with `code` (for example "QS1"; the schema comment says "printed on route sheets"), `commissionPct` and `routeDay` (free text, for example "Thursday"). It is shown on the customer page (`customers/[id]/page.tsx:43`), on the ticket list as `via {code ?? name}` (`tickets/page.tsx:81`), and chosen at intake as `viaAccountId` (`tickets/new/page.tsx:60-73`, checked as `kind: "TRADE"` at `tickets.ts:83-85`).
- **No route sheet exists in the code.** There is no page, action or print view. "Route sheet" appears only in comments (`schema.prisma:118`, `src/lib/ticket-math.ts:12`).
- For a partner link, `routeDay` is copied from `terms.pickupDay` **only when the account is created** (`partners.ts:248`). Later changes to the terms do not update it; `saveLinkFromHub` and `acceptTerms` never touch the account.
- **Trade commission** = `Customer.commissionPct` × the SERVICE lines (`ticket-math.ts:26`), unless it is a partner job, which uses `RepairJob.commissionCents`.

---

## 9. Machine, Customer and Ticket relations
- `Machine.customerId?` is the machine's owner. `Ticket.customerId?` is set separately and can differ: `createTicket` reuses a machine with a matching serial and model without changing its owner (`tickets.ts:63-78`), and `takeInMachine` does the same (`repair-jobs.ts:79,86`).
- `Ticket.viaAccountId?` points to the TRADE Customer the machine came through.
- `RepairJob.customerId` and `machineId` are filled on the retail side. On the repair side only `machineId` is filled; `customerName` is the short form.
- `Sale.customerId?`. The customer page lists tickets (or via-tickets for TRADE) and machines, but **not** RepairJobs or Sales (`customers/[id]/page.tsx:14-21`).

---

## 10. Other facts relevant to the design
- **Time zone helpers exist:** `zonedParts`, `zonedMidnight` (`partners.ts:1304-1322`), `startOfToday`, `todayIn`, `monthRange` (`src/lib/sales.ts`). These cover "the day before" and 8am–9pm quiet hours in `Shop.timeZone`. Customers have no time zone field.
- **Background timers** all live in `src/instrumentation.ts:3-15`, using a `globalThis` guard and `setInterval`. A reminder or message dispatcher would be added there; the single-runner lease pattern to copy is `withSyncLease` (`partners.ts:580-589`), a lease timestamp column updated with raw SQL.
- **Public routes:** the proxy matcher skips `/api/*` (`src/proxy.ts:10`), so API routes are public and do their own auth checks (for example `sessionUser()` in the export route). An unsubscribe link or Twilio webhook would go under `/api/…`.
  - The desktop app serves only the LAN over http and has **no public URL**, so it cannot receive inbound webhooks or one-click unsubscribe clicks from the internet. It would need Twilio polling or Twilio's Advanced Opt-Out, and `mailto:` List-Unsubscribe.
- **Register class-fee hook:**
  - `completeSale` checks repair jobs at `register.ts:163-171`, prices them per line at `:181-188` (`unit = repairDue(job)`), and after creating the line updates the job with a guarded `updateMany` (`:287-305`).
  - The `SaleLineInput` and `SaleInput` types are at `:132-149`.
  - `voidSale` refuses sales that contain repair lines (`:327-329`). Class-fee lines need their own void rule.
- **Action conventions:** `safe()` / `UserError` / `isUserError` (`src/lib/action.ts`). Actions that must return data do so as `{ id } | { error }` without `safe` (`takeInMachine`, `completeSale`). Every lookup by id is scoped: `findFirst({ where: { id, shopId } })`, or `shopId_id` for compound keys. `requireAdmin()` guards settings.
- **Nav:** `src/components/nav.tsx:33-51` marks each item `repair: true`, `retail: true` or `partners: true`; `/customers` is shown to both products.

**Not found in the code:** route sheets; any scheduling, calendar, class, appointment or shift model; staff phone numbers; phone validation or normalization; a customer delete path; an encryption helper; any messaging library.