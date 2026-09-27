# StitchBench / StitchShop: scheduling and messaging design

Status: design for branch `feat/scheduling-messaging` (worktree `/home/user/stitchbench-feat`, base `9ba25a4`).
Revision 2: revised after the security-compliance, correctness-ops and product-ux reviews. What was accepted or
rejected, and why, is in the **Review log** at the end.

**Build order.** The paid-modules platform (`modules-design.md`, package `modules-foundation`: license keys, the gating
API `getModules / hasModule / requireModule / shopsWithModule`, Vac Shop / appliance schema) lands on this branch
FIRST. Then this design's `foundation` package, alone. Then the feature packages of section 15 in parallel (each in its
own worktree, section 16.3), then `e2e-docs`.

Companion files in this folder:

- `schema-additions.prisma`: the exact text of the 15 new models (append to the end of `prisma/schema.prisma`).
- The field additions to existing models are listed in section 2.1 (exact lines). They are ADDED to whatever
  `prisma/schema.prisma` looks like after `modules-foundation`; do not copy a whole schema file over it.
- `schema.prisma`: the complete proposed schema = `modules-schema.prisma` + this design (formatted and validated with the
  worktree's Prisma 7.10). `schema.diff`: its diff against `modules-schema.prisma`. For review only.
- `migration.sql`: the exact SQL for `prisma/migrations/20260926150000_scheduling_messaging/migration.sql`: the output of
  `prisma migrate diff --from-schema modules-schema.prisma --to-schema schema.prisma --script`, plus ONE hand-written
  backfill statement at the end (section 2.2). Verified: the modules migration and then this one applied to
  `stitchbench_feat` inside a transaction that was rolled back (on top of `20260926100000_job_snapshot_at`); the dedupe
  index, the per-sign-up enrollment rows and the defaults behave as described.
- Migration folder rule: the folder name must sort after every folder already in `prisma/migrations` when foundation
  starts (the modules migration `20260926120000_paid_modules` included). If `20260926150000` does not, use the next free
  whole hour after the newest one (e.g. `20260926160000_scheduling_messaging`); the SQL is unchanged.

Everything below is binding for implementers unless a section says "suggested".

---

## 0. Scope in one page

What gets built (all approved by the owner):

| Area | StitchBench (repair bench) | StitchShop (sewing / quilt counter) |
|---|---|---|
| Classes & workshops (seats, fee, sign-up list, waitlist; fee rung up at the register) | - | yes |
| Appointments (types with bookable hours, capacity per resource; day/week calendar; fee at the register) | yes (with Scheduling) | yes |
| Partner repair pickup runs (both shops see the run, through the existing partner link) | yes (repair side) | yes (retail side) |
| Staff shifts (who works when; print) | yes (with Scheduling) | yes |
| Email through the shop's own SMTP; texts through the shop's own Twilio | yes | yes |
| Bulk marketing campaigns (email or text), importing an existing email list | yes | yes |
| Sign-up / booking confirmations and reminders before a class or appointment | yes (appointments) | yes |
| "Ready for pickup" notice | tickets | partner repair jobs, once recorded back at the counter |
| Estimate approval by link (only where the install has a public address) | tickets | partner repair jobs (retail side, relayed to the repair shop) |
| "Service due" reminders (also a campaign audience) | yes | yes (partner jobs it took in) |
| Review request after pickup (or a register sale) | yes | yes |
| Uncollected-machine notices, recorded on the ticket as proof, printable as a letter | tickets | partner repair jobs (retail side) |

Deliberately NOT in this build: online self-booking or self-sign-up portal; a two-way texting inbox (replies are listed
and can be marked handled, answered by phone); a time clock; Twilio webhooks (replies and delivery results are polled,
one code path for both deployments); IMAP reading of email replies; Twilio Messaging Service SIDs; deposits / partial
payments for classes; recurring appointments; drag-and-drop calendar; campaigns scheduled for later (they go now);
hand-picked campaign audiences; emailing staff their shifts; a per-shop public web address.

Product rules decided here (flagged again in Open questions):

1. Automatic customer notices on StitchBench go only to **direct** tickets: `ticket.customerId` set, `viaAccountId`
   null, and no repair-side `RepairJob` for the ticket. Trade-account and partner tickets are the other shop's customer.
2. StitchBench "ready" = each move into `READY_FOR_PICKUP` ("Ready - customer called"). `Ticket.pickupReadyAt` is set on
   every such move and cleared on leaving it; the notice and the uncollected-machine clock both count from it.
   `READY_IN_TRUCK` sends nothing (the machine is on a route).
3. StitchShop "ready" = the machine is **recorded back at our counter** (`RepairJob.backAt`): a pickup run's hand-off
   lists it as delivered, staff press "It's back at the counter" on the job, or tick it in "These are back: tell the
   customers" on `/repairs`. The repair shop marking the job ready only puts it on the "Is it here?" list.
4. Ready notices wait `READY_NOTICE_DELAY_SECONDS` (default 120 s) so a mistaken status click can be undone; the toast
   after the status change says what will go out and when, or why nothing will.
5. Review requests, service-due and bags-due reminders and campaigns are **marketing** (section 3). Ready, reminders,
   confirmations, estimates, uncollected-machine notices, class and booking messages, the consent confirmation text and
   the HELP reply are **notices** (transactional).
6. Waitlist promotion is by staff ("Move up"), with an optional message. Once anyone is waiting, new sign-ups join the
   waiting list too (an admin can tick "Skip the waiting list").
7. Quiet hours for **all** texts default to 9:00-20:00 shop time (adjustable only inside 8:00-21:00). **Marketing**
   texts must also fall inside that window in every mainland US time zone (and in Alaska / Hawaii time for 907 / 808
   numbers), never go on Sunday (default on), go only to US numbers, and reach one number at most once a day and four
   times in 30 days.
8. Paid modules (section 6): **Scheduling** = classes, appointments + calendar, shifts, and starting or changing
   partner pickup runs. **Marketing** = every email and text (settings, outbox, campaigns, reminders, confirmations,
   ready notices, estimate links, service due, review requests, uncollected-machine notices, class/booking messages).
   Off or expired: records stay viewable and exportable, new work is blocked, queued messages are held (never sent,
   never deleted). Never gated: compliance paths (unsubscribe links, reading STOP replies, recording an opt-out),
   custody records (OK-ing, cancelling or recording the hand-off of a partner run; "It's back at the counter"), paying
   for bookings already made.
9. Partner jobs' uncollected-machine notices use the partnership's agreed `terms.abandonedAfterDays` (what the signed
   agreement says); direct tickets use `Shop.abandonedAfterDays`. Both use the sending shop's `Shop.storageFeeCents`.
10. Marketing texts need prior express **written** consent: recorded only as "signed our paper form" (with the date and
    the wording's code printed on it) or "signed on the counter tablet" (the customer types their name under the exact
    wording). A tick box ticked by staff alone is not accepted as consent. A confirmation text follows every consent.
11. Public links (estimate approval, one-click unsubscribe) exist only where the **install** has a public address:
    `PUBLIC_URL` on the hosted app; on the Windows program, `publicUrl` in the program's settings file (`config.json`),
    which also locks that address to the public pages only. Without one: "call or reply to approve", and unsubscribe by
    replying UNSUBSCRIBE.

---

## 1. Ground rules for every package

- Read `AGENTS.md`. Every business query filters by the signed-in user's `shopId`; look rows up by `findFirst({ where:
  { id, shopId } })` or the compound key `shopId_id`. Never trust ids from `.bind()`, form fields or partner messages
  (partner lookups also filter by `linkId`).
- Server actions live in `src/actions/*.ts` with `"use server"`, wrapped in `safe()`; throw `UserError` with a
  plain-language message for anything the user can fix. An action that must return data does NOT use `safe()`: it
  returns `{ ...data } | { error: string }` from its own `try/catch` with `isUserError` (the `completeSale` pattern).
- Money: integer cents (`toCents`, `money`). Times: `DateTime` instants; display and wall-clock input through
  `src/lib/zoned.ts` with `Shop.timeZone` (never `toLocaleString()` without a zone in new code).
- Labels and status lists go in `src/lib/constants.ts` (foundation adds all of them; section 2.4). Status columns are
  plain `String` with the allowed values in a schema comment (newer-model style).
- Next.js 16: `params` / `searchParams` are Promises; the middleware file is `src/proxy.ts` and runs on the Node.js
  runtime (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`, "Runtime"); `revalidateTag`
  needs two arguments (not used here); `revalidatePath(path, "layout")` works in actions and route handlers (from a route
  handler it takes effect on the next visit). Route handler signature:
  `export async function POST(req: Request, { params }: { params: Promise<{ token: string }> })`. A segment can't have
  both `page.tsx` and `route.ts`. Read `node_modules/next/dist/docs/01-app/...` before using any other API.
- Background state shared across module copies lives on `globalThis` (pages, actions and timers each bundle their own
  copy of a module).
- Raw SQL: never compare a Prisma-written column with `now()`; pass `${new Date()}` as a parameter (the Windows
  program's Postgres may run in the PC's local zone; Prisma writes UTC wall-clock). The same for values written by
  `desktop/backup.mjs` fix-ups.
- `src/generated/prisma` is git-ignored: every worktree runs `npx prisma generate` after pulling foundation.
- tsx check scripts that import server modules run with the react-server condition (verified: it makes
  `import "server-only"` a no-op and the Prisma client works): `npm run check scripts/checks/<name>.check.ts`
  (= `tsx --conditions=react-server`). Use `node:assert/strict`; exit non-zero on failure; create throwaway companies
  named `Check <run>` through `scripts/checks/lib.ts` and clean up. Check scripts start the SMTP sink and Twilio mock
  in-process on **ephemeral ports** and must run with no server using the same database, or with that server started
  with `MESSAGES=off` (section 16.3).
- UI: reuse `PageHeader`, `Section`, `Empty`, `KV`, pills (`pill tone-*`), `ActionForm` / `Submit` / `ActionButton`,
  `grid-form`, `table`, `scroll-x`, tabs as `Link.btn.btn-sm` (+`btn-primary` when active), print views with `no-print`
  headers and `PrintButton`. Copy tone: short, plain, second person ("Texts go out from your Twilio number.").
- Message bodies, customer replies, answer notes and anything a partner sent are plain text: rendered as React text,
  never with `dangerouslySetInnerHTML`.
- Role rule of thumb: counter work (sign-ups, bookings, sending an estimate, recording an opt-out, "It's back",
  stopping a queued ready notice) = any signed-in user; prices, class/type setup, shifts, campaigns, messaging settings,
  removing an opt-out, retrying failed messages, sending or cancelling uncollected-machine notices, backdating a
  by-hand notice more than 14 days = OWNER/ADMIN (`requireAdmin()`).
- Paid modules: pages, actions and workers never call the modules package directly; they use the adapter
  `src/lib/module-gate.ts` (section 6.1). Every new action that creates or changes scheduling or messaging work calls
  `await requireOn(user, "scheduling" | "marketing")` right after `requireUser()` / `requireAdmin()`; the exceptions are
  listed in the gate table (6.3).
- Order of checks in every action: `requireUser()`/`requireAdmin()` -> `requireOn()` -> ownership lookup by `shopId` ->
  input validation -> transaction.
- Hooks that run inside a transaction never open a second connection: callers compute
  `hookContext(shopId)` (module state, messaging view, time zone) BEFORE `db.$transaction` and pass it in (7.1).
- Client addresses come only from `clientAddress()` in `src/lib/client-ip.ts` (the last `X-Forwarded-For` hop, and only
  when `TRUST_PROXY=true`; null otherwise). Never read `x-forwarded-for` anywhere else.
- `MESSAGES=off` stops every send path (timer, kick, "Send now", test sends), not only the timer.
- "Hosted rules" = `!isDesktop()` (from `src/lib/modules.ts`, `STITCH_DESKTOP === "1"` on the Windows program). They
  apply to the hosted app and to dev/test servers alike; tests loosen them only through `SMTP_ALLOW_HOSTS`.

---

## 2. Data model

### 2.1 Schema changes (all in foundation; new models' exact text in `schema-additions.prisma` / Appendix B)

Existing models (fields added; nothing removed or renamed). Add these lines inside each model (back-relation lines go
after the model's existing back-relations; field lines after its last scalar field unless placed as shown), then run
`npx prisma format`:

```prisma
model Shop {            // back-relations only, after `vacCares VacCare[]`
  // Scheduling and messages
  partnerRuns    PartnerRun[]
  messaging      MessagingSettings?
  outMessages    OutMessage[]
  suppressions   Suppression[]
  consentEvents  ConsentEvent[]
  inboundTexts   InboundText[]
  campaigns      Campaign[]
  estimateLinks  EstimateLink[]
  classes        ShopClass[]
  classMeetings  ClassMeeting[]
  enrollments    Enrollment[]
  apptTypes      AppointmentType[]
  appointments   Appointment[]
  shifts         Shift[]
}
model User {            // back-relations only
  shifts        Shift[]
  appointments  Appointment[]
}
model Customer {        // before createdAt
  // How they want reminders and "it's ready" notices: email | sms | both | none; "" = not asked yet (email if we have one)
  notifyBy         String    @default("")
  // Marketing texts (TCPA): they agreed in writing - when, for which number, how, and the words they agreed to
  smsConsentAt     DateTime?
  smsConsentPhone  String?
  smsConsentSource String?
  smsConsentText   String?
  // Review requests: when we last asked (at most one every Settings -> Messages "reviewEveryDays")
  lastReviewAskAt  DateTime?
  // back-relations
  outMessages   OutMessage[]
  consentEvents ConsentEvent[]
  enrollments   Enrollment[]
  appointments  Appointment[]
}
model Machine {         // before createdAt
  // The completed service a "service due" reminder was last sent about (never twice for the same one)
  serviceNoticeFor DateTime?
}
model Ticket {          // pickupReadyAt directly after readyAt
  // Since when it has been waiting on the pickup shelf: set on every move into READY_FOR_PICKUP, cleared on leaving it
  // (uncollected-machine notices count from here)
  pickupReadyAt       DateTime?
  @@index([shopId, machineId, intakeAt])
}
model SaleLine {        // after machineId
  // A class seat or an appointment paid (qty 1) or refunded (qty -1) on this line (plain ids)
  enrollmentId   String?
  appointmentId  String?
  @@index([enrollmentId])
  @@index([appointmentId])
}
model PartnerLink {     // after catalogHash
  // What the partner's program says it can do (caps.update: ["pickup"]), and what we last told it (hash)
  features      String[]  @default([])
  featuresHash  String?
}
model RepairJob {       // after snapshotAt
  // Retail side: when staff recorded it back at our counter (a run's hand-off or "It's back"); cleared if it leaves again
  backAt           DateTime?
  @@index([shopId, machineId])
}
```

New models (exact text in Appendix B; summary of keys, relations and delete rules):

| Model | Key | Relations / onDelete | Indexes | Purpose |
|---|---|---|---|---|
| `PartnerRun` | `@@id([shopId, id])` (UUID from the scheduling shop) | Shop Cascade; `linkId` plain | `[shopId, linkId, startsAt]`, `[shopId, startsAt]` | pickup / drop-off run, same id both sides |
| `MessagingSettings` | `shopId @id` (1:1) | Shop Cascade | - | SMTP, Twilio (sealed secrets), rules, holds, automatic-message switches, wording |
| `OutMessage` | cuid | Shop Cascade; Customer SetNull; Campaign SetNull; ticket/job/ref plain ids | `@@unique([shopId, dedupeKey])`, `[status, sendAfter]`, `[shopId, status, sendAfter]`, `[shopId, createdAt]`, `[shopId, customerId]`, `[shopId, ticketId]`, `[shopId, repairJobId]`, `[shopId, address, sentAt]`, `[campaignId, status]`; `optOutToken @unique` | every email/text: queue, log, proof of notice |
| `Suppression` | `@@id([shopId, channel, address])` | Shop Cascade | - | do-not-send by address (STOP = all texts; unsubscribe = marketing email) |
| `ConsentEvent` | cuid | Shop Cascade; Customer SetNull | `[shopId, customerId, at]`, `[shopId, at]` | append-only consent record |
| `InboundText` | `@@id([shopId, sid])` | Shop Cascade; `customerId` plain | `[shopId, receivedAt]`, `[shopId, fromNumber, receivedAt]` | texts customers sent (polled) |
| `Campaign` | cuid | Shop Cascade; OutMessage back-relation | `[shopId, createdAt]`, `[status]` | marketing campaign (members snapshot, built in batches) |
| `EstimateLink` | cuid; `tokenHash @unique` | Shop Cascade; ticket/job/customer plain ids | `[shopId, ticketId]`, `[shopId, repairJobId]`, `[shopId, answeredAt]` | estimate approval link |
| `JobLease` | `name @id` | - | - | one background job at a time per install |
| `ShopClass` | cuid | Shop Cascade | `[shopId, firstAt]` | class / workshop / club |
| `ClassMeeting` | cuid | Shop Cascade; ShopClass Cascade (field `shopClass`) | `[shopId, startsAt]`, `[classId, startsAt]` | each meeting of a class |
| `Enrollment` | cuid (one row per sign-up) | Shop Cascade; ShopClass Cascade; Customer SetNull | `[classId, customerId]`, `[shopId, customerId]`, `[classId, status, createdAt]` | sign-up / waitlist + payment state |
| `AppointmentType` | cuid | Shop Cascade | `[shopId, sortOrder]` | bookable thing, hours JSON, capacity, resource |
| `Appointment` | cuid | Shop Cascade; AppointmentType SetNull; Customer SetNull; User (staff) SetNull | `[shopId, startsAt]`, `[shopId, customerId]`, `[typeId, startsAt]`, `[shopId, resource, startsAt]` | a booking (or a block) + payment state |
| `Shift` | cuid | Shop Cascade; User SetNull | `[shopId, startsAt]`, `[userId, startsAt]` | staff shift (the person may have no login) |

Notes on choices:

- `ShopClass` (not `Class`) and relation field `shopClass` avoid the JS reserved word.
- Snapshot names (`Enrollment.name`, `Appointment.name/title/resource`, `Shift.name`) keep rosters, calendars and
  schedules readable if a customer, type or user row goes away (SetNull).
- `Enrollment` has no unique key: every sign-up is a new row (a refunded person who signs up again starts clean, and a
  parent can sign up two children with `attendee`). The "already signed up" rule is enforced under the class lock.
- Booking payment state (`paidCents/paidAt/paidLineId/refundedCents/refundedAt/refundLineId`) is separate from seat
  status: cancelling frees the seat; money moves only through the register. Paid bookings are cancelled, never deleted
  (a class can only be deleted while nobody ever signed up; otherwise it is cancelled and stays as the record).
- `OutMessage.optOutToken` stores the random token raw (not hashed) because the worker must re-emit it in the
  `List-Unsubscribe` header and the `mailto:` subject; its only power is to unsubscribe that one address from that
  shop's marketing email.
- Estimate tokens carry approval power: looked up only by `EstimateLink.tokenHash` (sha256). The raw token exists only
  sealed in `EstimateLink.tokenSealed` until the messages carrying it have gone out (then cleared); message bodies
  store the link masked (`EstimateLink.maskedUrl`), so the outbox page, CSV exports and backups never hold a live link.
- The phone is **not** stored normalized. `toE164(customer.phone)` is computed where needed (queue, audiences, reply
  matching); `Suppression`, `smsConsentPhone`, `InboundText.fromNumber` and `OutMessage.address` hold E.164.
- Postgres unique index on `(shopId, dedupeKey)` treats NULL keys as distinct: messages without a key never collide
  (checked).
- `OutMessage.channel` is `email | sms` for anything the worker sends, plus `letter | certified_mail | phone` for a notice
  given by hand and recorded as proof (always inserted with status `SENT`; `providerId` holds the certified-mail
  tracking number). A notice sent by hand by email or text (from the shop's own mailbox or phone) is recorded with
  channel `email` / `sms`, status `SENT`, `byUserId` set and `claimedAt` null; the worker only ever touches `QUEUED`
  and `SENDING` rows, so it never re-sends one.
- `ConsentEvent.channel` is `email` or `sms`, and `any` for `notify_pref` events. A `notify_pref` event's `detail` is
  exactly the new `notifyBy` value (`"" | email | sms | both | none`), so a restore can re-apply it (2.3).
- "Held" needs no status: `QUEUED` rows of a shop whose Marketing module is off (the worker skips the shop); marketing
  rows while `marketingHoldAt` is set (after a restore) or marketing texts while `textHoldAt` is set (replies couldn't
  all be read); marketing rows whose `sendAfter` is more than 48 h old (a PC that was off). All are listed on
  `/messages` with what to do.
- No `*Hint` columns for secrets: the page shows "Saved Oct 7, 2026" from `smtpPassSavedAt` / `twilioTokenSavedAt`.

### 2.2 Migration

Folder `prisma/migrations/20260926150000_scheduling_messaging/` (see the folder rule at the top), file `migration.sql` =
the companion `migration.sql` verbatim (Appendix A). It contains, in order: 6 `ALTER TABLE ... ADD COLUMN` (Customer,
Machine, Ticket, SaleLine, PartnerLink, RepairJob); 15 `CREATE TABLE`; 39 indexes; 24 foreign keys; and, last, the
one hand-written backfill:

```sql
-- Backfill (hand-written): machines already on the pickup shelf count from when they became ready
UPDATE "Ticket" SET "pickupReadyAt" = "readyAt" WHERE "status" = 'READY_FOR_PICKUP' AND "pickupReadyAt" IS NULL;
```

Existing partner jobs that are ready get no `backAt` (nobody has confirmed they're at the counter): they appear on the
"Is it here?" list. Never edit the migration after it is applied anywhere (the Windows program checksums applied
migrations).

### 2.3 Windows program (`desktop/backup.mjs`, `desktop/main.mjs`, foundation)

`desktop/backup.mjs`:

- Add `"JobLease"` to `SKIP`.
- `FIXUPS` entries may now be a string or `{ sql, params: (manifest) => unknown[] }`; `restore()` runs
  `client.query(f.sql ?? f, f.params ? f.params(manifest) : [])`.
- **Opt-outs and consent survive a restore.** Inside `restore()`, in the same transaction, BEFORE the `TRUNCATE` (only
  when both tables exist in the current database):
  `const keepSup = (await client.query('SELECT * FROM "Suppression"')).rows;`
  `const keepEv = (await client.query('SELECT * FROM "ConsentEvent" WHERE "at" > $1', [new Date(manifest.created)])).rows;`
  AFTER the COPY loop and before the fix-ups:
  - re-insert `keepSup` with `INSERT ... ON CONFLICT ("shopId","channel","address") DO UPDATE SET scope = CASE WHEN
    EXCLUDED.scope = 'all' THEN 'all' ELSE "Suppression".scope END` (never downgrades);
  - re-insert `keepEv` with `ON CONFLICT (id) DO NOTHING`, `customerId` set to NULL when that customer isn't in the
    restored data, `shopId` rows skipped when the shop isn't;
  - `UPDATE "Customer" c SET "smsConsentAt" = NULL, "smsConsentPhone" = NULL, "smsConsentSource" = NULL,
    "smsConsentText" = NULL WHERE EXISTS (SELECT 1 FROM "Suppression" s WHERE s."shopId" = c."shopId" AND s.channel =
    'sms' AND s.address = c."smsConsentPhone") OR EXISTS (SELECT 1 FROM "ConsentEvent" e WHERE e."customerId" = c.id
    AND e.event = 'marketing_no' AND e."at" > $1)` with `$1 = new Date(manifest.created)`;
  - re-apply preferences changed since the backup: for the newest `notify_pref` event per customer in `keepEv`,
    `UPDATE "Customer" SET "notifyBy" = $detail WHERE id = $customerId` (skipped when the customer isn't in the
    restored data or `detail` isn't one of the five values). A customer who said "No messages" after the backup stays
    that way.
- Append to `FIXUPS` (they run after every restore; safe to repeat):

```js
  // 20260926150000_scheduling_messaging
  // A restored backup's unsent marketing may have gone out after the backup was taken: never sent again.
  `UPDATE "OutMessage" SET status = 'CANCELLED', error = 'Not sent: restored from a backup (it may have gone out already)'
     WHERE status IN ('QUEUED', 'SENDING') AND purpose = 'marketing'`,
  // Notices go back to the queue; the worker's stillWanted() drops the ones that no longer apply.
  `UPDATE "OutMessage" SET status = 'QUEUED', "claimedAt" = NULL, "nextTryAt" = NULL WHERE status = 'SENDING' AND purpose = 'notice'`,
  { sql: `UPDATE "Campaign" SET status = 'CANCELLED', "finishedAt" = $1 WHERE status IN ('QUEUING', 'SENDING')`, params: () => [new Date()] },
  // Re-read every text reply since the newest one in the backup, and hold marketing until an admin has checked opt-outs.
  { sql: `UPDATE "MessagingSettings" SET "inboundAt" = NULL, "inboundIncomplete" = 0, "marketingHoldAt" = $1`, params: () => [new Date()] },
  `UPDATE "Ticket" SET "pickupReadyAt" = "readyAt" WHERE status = 'READY_FOR_PICKUP' AND "pickupReadyAt" IS NULL`,
```

`desktop/main.mjs`:

- `cfg.publicUrl` (new optional key in `config.json`, written as `""` in the first-run defaults with the comment key
  `"_publicUrl": "Optional https:// address customers can open (a tunnel you set up, pointed at the links port). Leave
  empty if unsure."`) and `cfg.linksPort` (default `cfg.port + 1`): when `publicUrl` is a valid `https://` URL with no
  path, user, query or hash, pass `PUBLIC_URL: cfg.publicUrl` and `PUBLIC_LINKS_ONLY: "true"` in the server's env and
  start the links gate; otherwise pass neither and log "publicUrl ignored: ...".
- **Links gate** (`desktop/links-gate.mjs`, new, foundation): `export function startLinksGate({ listenPort, targetPort,
  publicHost }): http.Server`. A plain `node:http` server bound to `127.0.0.1:{linksPort}` only (the tunnel agent runs
  on the PC; nothing on the LAN or internet reaches it directly). It forwards to `127.0.0.1:{cfg.port}` ONLY `GET` /
  `HEAD` of `/e/`, `/u/`, `/api/e/`, `/api/u/`, `/_next/static/`, `/favicon.ico` and `POST` of `/api/e/`, `/api/u/`
  (body at most 16 KB), never a request with a `next-action` header; everything else gets `404`. It sets `Host` to
  `publicHost` (so the server's own lock, 14.2, applies whatever Host the tunnel sends) and drops any incoming
  `x-forwarded-*`, `forwarded`, `cf-connecting-ip` and `x-real-ip` headers. The Windows program never sets
  `TRUST_PROXY`, so customers' addresses are not recorded there (`answerFrom` says "address not known"). INSTALL.md:
  "Point the tunnel at http://127.0.0.1:{linksPort}, never at the program's main port."
- After a successful restore the dialog adds: "Marketing messages are on hold until an owner or admin checks Messages ->
  Opt-outs and presses Resume."

(A restore runs while the server is stopped, so no worker sees the rows in between. Leases are cleaned at start, 4.1
`lease.ts`.)

### 2.4 Constants (foundation adds to `src/lib/constants.ts`; later packages only import)

```ts
export const MESSAGE_KIND_LABEL: Record<string, string> = {
  ready: "Ready for pickup", reminder: "Reminder", estimate: "Estimate", abandon: "Not picked up notice",
  service_due: "Service reminder", review: "Review request", campaign: "Campaign", class_notice: "Class message",
  booking_notice: "Appointment message", consent_confirm: "Text sign-up confirmation", help_reply: "Reply to HELP",
  bags_due: "Bags due reminder", test: "Test",
};
export const ABANDON_STAGE_LABEL: Record<string, string> = { first: "First notice", second: "Second notice", third: "Third notice", fourth: "Fourth notice", final: "Final notice" };
export const MESSAGE_STATUS_LABEL: Record<string, string> = {
  QUEUED: "Waiting", SENDING: "Sending", SENT: "Sent", FAILED: "Not sent", SKIPPED: "Skipped", CANCELLED: "Cancelled", EXPIRED: "Too late",
};
export const MESSAGE_STATUS_TONE: Record<string, "neutral" | "work" | "wait" | "ready" | "done" | "bad"> = {
  QUEUED: "wait", SENDING: "work", SENT: "done", FAILED: "bad", SKIPPED: "neutral", CANCELLED: "neutral", EXPIRED: "neutral",
};
export const CHANNEL_LABEL: Record<string, string> = {
  email: "Email", sms: "Text", letter: "Letter (by hand)", certified_mail: "Certified mail (by hand)", phone: "Phone call (by hand)",
};
export const NOTIFY_BY_LABEL: Record<string, string> = {
  "": "Not asked yet (email if we have one)", email: "Email", sms: "Text", both: "Email and text", none: "No messages (call them)",
};
export const SKIP_REASON_LABEL: Record<string, string> = {
  channel_off: "Email or texts aren't set up", no_address: "No email or mobile number on file", opted_out: "Opted out",
  unsubscribed: "Unsubscribed from marketing email", no_text_consent: "Hasn't agreed to marketing texts",
  not_asked: "Not asked if texts are OK", prefers_other: "Prefers the other way", no_messages: "Asked for no messages",
  changed: "Their details changed after it was queued", not_wanted: "No longer needed", trade: "Trade account (no marketing)",
  not_us: "Not a US number (no marketing texts)", too_often: "Had 4 marketing texts in the last 30 days",
  unread_reply: "They texted you back: read it first", staff_cap: "Already 3 messages today",
};
export const CONSENT_EVENT_LABEL: Record<string, string> = {
  marketing_yes: "Agreed to marketing texts", marketing_no: "Marketing texts withdrawn", notify_pref: "Changed how to be told",
  optout: "Opted out", optin: "Opted back in", help: "Asked for help (HELP)",
};
export const CONSENT_SOURCE_LABEL: Record<string, string> = {
  counter: "At the counter", intake: "At check-in", customer_page: "Customer page", paper_form: "Signed paper form",
  tablet: "Signed on the counter tablet", unsubscribe_link: "Unsubscribe link", reply: "Text reply",
  carrier: "Carrier (an earlier STOP)", email_reply: "Replied UNSUBSCRIBE", staff: "Recorded by staff", import: "Imported list",
  ticket: "Told us at pickup time",
};
export const CLASS_STATUS_LABEL: Record<string, string> = { OPEN: "Open", CLOSED: "Sign-ups closed", CANCELLED: "Cancelled" };
export const CLASS_REMIND_LABEL: Record<string, string> = { every: "Before every meeting", first: "Before the first meeting only", never: "No reminders" };
export const ENROLLMENT_STATUS_LABEL: Record<string, string> = { ENROLLED: "Signed up", WAITLIST: "Waiting list", CANCELLED: "Cancelled" };
export const APPOINTMENT_STATUS_LABEL: Record<string, string> = { BOOKED: "Booked", DONE: "Done", NO_SHOW: "Didn't come", CANCELLED: "Cancelled" };
export const RUN_STATUS_LABEL: Record<string, string> = { SCHEDULED: "Scheduled", CANCELLED: "Cancelled", DONE: "Done" };
export const CAMPAIGN_STATUS_LABEL: Record<string, string> = { DRAFT: "Draft", QUEUING: "Getting ready", SENDING: "Sending", SENT: "Sent", CANCELLED: "Cancelled" };
```

---

## 3. Message classification and compliance (code-level rules)

### 3.1 Kinds

`src/lib/messaging/types.ts`:

```ts
export type Channel = "email" | "sms";
export type Purpose = "notice" | "marketing";
export type MessageKind = "ready" | "reminder" | "estimate" | "abandon" | "service_due" | "review" | "campaign"
  | "class_notice" | "booking_notice" | "consent_confirm" | "help_reply" | "bags_due" | "test";
export const KIND_PURPOSE: Record<MessageKind, Purpose> = {
  ready: "notice", reminder: "notice", estimate: "notice", abandon: "notice", class_notice: "notice", booking_notice: "notice",
  consent_confirm: "notice", help_reply: "notice", test: "notice",
  service_due: "marketing", review: "marketing", campaign: "marketing", bags_due: "marketing",
};
/** Texts of these kinds end with " Reply STOP to opt out." (marketing always; these notices are typed by staff). */
export const STOP_LINE_KINDS: MessageKind[] = ["class_notice", "booking_notice"];
/** Sent to an explicit address: only suppression is checked (queue and worker), even when customerId is set for the record. */
export const EXPLICIT_KINDS: MessageKind[] = ["consent_confirm", "help_reply", "test"];
export type ChannelMode = "preferred" | "every" | "one" | Channel[];
export type SkipReason = keyof typeof SKIP_REASON_LABEL; // from constants
```

| Kind | Purpose | Channels (`ChannelMode`) | Text needs | Email needs | Why this classification |
|---|---|---|---|---|---|
| ready | notice | preferred | `notifyBy` sms/both, no STOP | not `none`/`sms`, no "all" opt-out | information about a transaction the customer started (TCPA "prior express consent" given with the number for the repair; CAN-SPAM transactional) |
| reminder, class_notice (sign-up confirmation, changes), booking_notice | notice | preferred | same | same | confirms / updates something the customer signed up for or booked; never promotional (UI copy and a required checkbox on "Message everyone" say so) |
| estimate | notice | staff-chosen list | same | same | completes the repair transaction |
| abandon | notice | every allowed | same | same | notice about the customer's own property and fees under the shop's policy |
| consent_confirm, help_reply | notice | explicit number | not suppressed | - | CTIA: confirm an opt-in; answer HELP naming the shop |
| test | notice | explicit address (the admin's own) | confirmed test number | the signed-in user's or the shop's own address | staff only |
| service_due, bags_due | **marketing** | one | written consent for this number, US number, caps | no unsubscribe, not `none` | encourages buying a service or goods: "telephone solicitation" under TCPA (needs prior express written consent for automated texts); CAN-SPAM "commercial" (primary purpose promotes) |
| review | **marketing** | one | same | same | promotes the business, not part of the completed transaction; treated as commercial / telemarketing to be safe |
| campaign | **marketing** | the campaign's channel | same | same | advertising |

`preferred`: `notifyBy` email -> email; sms -> text; both -> both; "" -> email only; none -> nothing.
`every`: every channel `allowed()` passes. `one`: text if allowed and `notifyBy` is sms/both, else email.

### 3.2 `allowed()`: the single consent gate (foundation, `src/lib/messaging/consent.ts`)

Pure function, called when queueing AND again by the worker right before sending:

```ts
export type ConsentCustomer = { id: string; kind: "RETAIL" | "TRADE"; phone: string | null; email: string | null;
  notifyBy: string; smsConsentAt: Date | null; smsConsentPhone: string | null };
export type SupMap = Map<string, "marketing" | "all">; // key `${channel}:${address}`
export type Allowed = { ok: true; address: string } | { ok: false; reason: SkipReason };

export function allowed(c: ConsentCustomer | null, channel: Channel, purpose: Purpose, ms: MessagingView, sup: SupMap, explicit?: string): Allowed {
  if (channel === "email" ? !ms.emailReady : !ms.smsReady) return no("channel_off");
  const address = explicit ?? (channel === "email" ? validEmail(c?.email) : toE164(c?.phone));
  if (!address) return no("no_address");
  const s = sup.get(`${channel}:${address}`);
  if (channel === "sms" && s) return no("opted_out");                 // STOP stops every text, reminders included
  if (channel === "email" && s === "all") return no("opted_out");
  if (channel === "email" && s === "marketing" && purpose === "marketing") return no("unsubscribed");
  if (!c) return ok(address);                                         // explicit address (tests, confirmations): suppression only
  if (c.notifyBy === "none") return no("no_messages");                // "No messages (call them)" blocks marketing too
  if (purpose === "notice") {
    if (channel === "sms" && c.notifyBy !== "sms" && c.notifyBy !== "both") return no(c.notifyBy === "" ? "not_asked" : "prefers_other");
    if (channel === "email" && c.notifyBy === "sms") return no("prefers_other");
    return ok(address);
  }
  if (c.kind === "TRADE") return no("trade");
  if (channel === "sms" && !usMarketingNumber(address)) return no("not_us");
  if (channel === "sms" && !(c.smsConsentAt && c.smsConsentPhone === address)) return no("no_text_consent");
  return ok(address);
}
```

A changed phone number voids marketing text consent automatically (`smsConsentPhone` no longer matches). The worker adds
three send-time checks for marketing texts that need the database (4.3): unread replies from that number
(`unread_reply`), at most one marketing text per number per 24 h (deferred, not skipped) and four per 30 days
(`too_often`).

### 3.3 Compliance checks, as code

| Rule | Where | Check |
|---|---|---|
| CAN-SPAM: working unsubscribe, honoured promptly | `queue.ts` finalize + worker + `/u/[token]` + `/api/u/[token]` + Opt-outs form | every marketing email gets a footer and a `List-Unsubscribe` header; the send-time `allowed()` re-check blocks mail queued before an unsubscribe; a link unsubscribe takes effect at once. **Hosted**: link first, `mailto:` second, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. **Windows program**: the reply is the mechanism (the PC may be off): footer "reply with the word UNSUBSCRIBE", `mailto:` first, a link only as an extra when `PUBLIC_URL` is set, never `List-Unsubscribe-Post`. The `mailto:` subject is `unsubscribe {token}` and the Opt-outs form accepts that subject or token and resolves it to the exact address |
| CAN-SPAM: someone reads the replies | `saveEmailSettings`, `queueCampaign`, automatic marketing | without a public link (every Windows program without `PUBLIC_URL`) marketing email needs `replyTo` and the admin's tick "Someone reads this mailbox at least once a week" (`replyWatchedAt/By`): `UserError("Marketing email needs a reply-to address someone reads every week (unsubscribes arrive there). Set it in Settings -> Messages.")`; automatic marketing is skipped with error "No watched reply-to address". `/messages` shows a weekly banner "Check {replyTo} for UNSUBSCRIBE replies and record them under Opt-outs" while marketing email went out in the last 30 days |
| CAN-SPAM: postal address in every marketing email | `queue.ts` finalize; `queueCampaign` | `postalAddress ?? shop.address` required, else `UserError("Add the shop's postal address in Settings -> Messages. Marketing email must show it.")`; automatic marketing is skipped with error "No postal address set" |
| CAN-SPAM: identify as advertisement | finalize | footer always says "This is an advertisement from {shop}" |
| CAN-SPAM: honest From / Subject | settings save; `saveCampaign`; `queue.ts` | From = `fromName` (default `Shop.name`) + `fromEmail` fixed in settings, not per campaign; subject required, <= 150 chars, must not start with `RE:`/`FW:`/`FWD:` (`UserError("Don't start the subject with RE: or FW: unless it's a real reply.")`); AFTER merge fields are filled every subject goes through `subject.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 150)` |
| CAN-SPAM: opt-out works 30+ days | `optOutToken` never expires; OutMessage rows and suppressions are not deleted in this build | - |
| TCPA: prior express written consent for marketing texts | `allowed()`; `recordTextConsent` | `smsConsentAt` set for this exact number; recorded with source, the exact wording (and its code for paper forms), staff id, a ConsentEvent; custom wording must name the shop and contain "STOP" and "not a condition" |
| CTIA: confirm the opt-in | `recordTextConsent` | queues `consent_confirm` to the consent number (explicit address) |
| TCPA/CTIA: identify the shop | finalize | every text starts `"{Shop.name}: "` (skipped if the body already starts with it) |
| TCPA/CTIA: STOP / START / HELP | finalize; `inbound.ts`; worker | marketing texts and staff-typed notices end `" Reply STOP to opt out."`; STOP-type replies -> `Suppression(sms, all)` + ConsentEvent + cancel queued texts + clear marketing consent; only START / UNSTOP lift a text suppression; YES lifts one only when its source is `reply` or `carrier`; HELP -> ConsentEvent + a `help_reply` naming the shop and its phone (once per number per shop-day); Twilio error 21610 at send -> same as STOP (source `carrier`) |
| FCC 2024 revocation "by any reasonable means" | `inbound.ts`; worker | every reply is scanned (no length limit); exact keywords plus `LOOKS_LIKE_STOP` are treated as STOP (over-honour); any other reply not yet marked handled holds marketing texts to that number (`unread_reply`) until staff mark it handled; staff can record an opt-out from any channel (`recordOptOut`); replies are read for every shop with Twilio set up, whatever the module, switch or pause (4.3 step 3) |
| Reading replies can't silently miss any | `inbound.ts` | the read watermark advances only after a complete read; 3 incomplete runs in a row, or an unreadable token, set `textHoldAt` (marketing texts held until an admin releases them) |
| Quiet hours | worker (texts only), `quiet.ts` | all texts: inside `[quietStart, quietEnd)` shop time (clamped to 08:00-21:00 on save); marketing texts: also inside that window in every zone of `recipientZones(number)` (mainland US: Eastern, Central, Mountain, Arizona, Pacific; 907 Alaska; 808 Hawaii), and not on Sunday in any of them when `noSundayMarketing`; outside -> `sendAfter` moves to the next allowed quarter hour |
| Time zone is right | `saveTextSettings` | texts can't be switched on until an admin confirms `Shop.timeZone` ("It's 3:14 pm in America/New_York. Is that your shop's time?"; on the Windows program the PC's zone is offered when they differ) |
| Transactional texts respect a text opt-out | `allowed()` | any text suppression blocks every kind |
| Per-recipient volume | worker; queue | marketing texts: at most 1 per number per 24 h (later rows wait) and 4 per 30 days (`too_often`); staff-triggered messages (estimate, class / booking messages, "send now") at most 3 per address per 24 h (`staff_cap`, or `UserError("They've had 3 messages from you today. Call them instead.")` for a single send) |
| Volume caps | worker, campaign action | per shop per run `MESSAGE_BATCH` per channel (default 20); marketing email `emailDailyCap` and marketing texts `smsDailyCap` per shop-day (default 300 each, max 5000), counted over SENT and SENDING rows; campaigns <= 5000 recipients, <= 3 started per shop-day, and at most 7 days of sending at the cap |
| Non-US numbers | `allowed()` | no marketing texts to numbers outside +1, or to Canadian / Caribbean area codes (`NON_US_NANP` in `phone.ts`; CASL and other rules) |
| Keep consent / opt-out records | `ConsentEvent` (append-only; no update/delete code), `Suppression`; carried across a restore (2.3); CSV export `consent` | retention minimums in `INSTALL.md` (15.10) |
| Stale marketing | worker | marketing rows whose `sendAfter` is more than 48 h old are not sent without a person pressing "Send them" |
| After a restore | fix-up + worker | every marketing message waits until an admin presses "Resume" on `/messages` (`marketingHoldAt`) |
| A2P 10DLC / toll-free verification | settings copy; worker | the Texts section explains registration ("Registering your number" box); delivery results are read back (4.3 step 3); 5 carrier blocks (30034 / 30007) in one shop-day pause texts with "US carriers are blocking your texts. Your Twilio number must be registered for business texting (A2P 10DLC, or toll-free verification)." |

---

## 4. Messaging core (foundation)

### 4.1 Files and exported signatures

All under `src/lib/` unless noted. "server" = starts with `import "server-only"`; "pure" = no server-only, no DB.

**`zoned.ts` (pure)**: shop-time helpers (independent copy of the `partners.ts` logic so client code can use it).

```ts
export type Wall = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }; // month 1-12, weekday 0 = Sunday
export function wall(d: Date, tz: string): Wall;
export function ymdOf(d: Date, tz: string): string;                    // "2026-10-07"
export function parseYmd(s: string | null | undefined): string | null;   // validates "YYYY-MM-DD"
export function parseHm(s: string | null | undefined): number | null;    // "18:30" -> 1110 (minutes after midnight)
export function hmOf(minutes: number): string;                           // 1110 -> "18:30"
export function zonedTime(ymd: string, minutes: number, tz: string): Date; // wall clock -> instant; a time skipped by DST moves forward
export function dayStart(ymd: string, tz: string): Date;
export function addDays(ymd: string, n: number): string;
export function addMonths(ymd: string, n: number): string | null;        // same date n months later; null when it doesn't exist (Feb 30)
export function nthWeekdayOf(ymd: string): { n: number; weekday: number; last: boolean }; // "3rd Saturday"; last when the next one is in another month
export function nthWeekdayIn(year: number, month: number, n: number, weekday: number, last: boolean): string | null;
export function weekStart(ymd: string): string;                          // the Sunday on or before
export function monthsBetween(a: Date, b: Date, tz: string): number;     // whole calendar months from a to b
export function fmtDay(d: Date, tz: string): string;                     // "Tue, Oct 7"
export function fmtTime(d: Date, tz: string): string;                    // "6:00 pm"
export function fmtWhen(d: Date, tz: string): string;                    // "Tue, Oct 7 at 6:00 pm"
export function fmtRange(a: Date, b: Date, tz: string): string;          // "Tue, Oct 7, 6:00-8:00 pm" (two dates when it spans days)
export function rangeFromForm(fd: FormData, tz: string, p = ""): { startsAt: Date; endsAt: Date };
// reads `${p}date`, `${p}start`, `${p}end`; UserError("Pick a date."), ("Enter a start time like 18:30."),
// ("The end time must be after the start."), ("That's longer than 16 hours. Check the times.")
```

**`phone.ts` (pure)**

```ts
export function toE164(raw: string | null | undefined): string | null; // NANP: 10 digits or 1+10 (area and exchange start 2-9) -> +1..; "+"+8..15 digits kept; else null
export function fmtPhone(e164: string): string;                        // "+15551234567" -> "(555) 123-4567"
export function validEmail(s: string | null | undefined): string | null;
// trimmed, lower-cased, <= 254, and must match /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/ (no commas, quotes, <>, spaces or CR/LF)
export const NON_US_NANP: ReadonlySet<string>;
// Canada: 204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 403 416 418 428 431 437 438 450 460 468 474 506
// 514 519 548 579 581 584 587 600 604 613 622 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902
// 905 942; Caribbean and Bermuda: 242 246 264 268 284 345 441 473 649 658 664 721 758 767 784 809 829 849 868 869 876
// (check NANPA's current list when implementing and add any new overlay codes for these regions)
export function usMarketingNumber(e164: string): boolean;   // "+1" + 10 digits and the area code not in NON_US_NANP
export const MAINLAND_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles"];
export function recipientZones(e164: string): string[];     // 907 -> [America/Anchorage]; 808 -> [Pacific/Honolulu]; other US -> MAINLAND_ZONES; else []
```

**`client-ip.ts` (server)**: `export function clientAddress(req: Request | Headers): string | null` = today's
`clientAddress` from `src/auth.ts` moved here unchanged (null unless `TRUST_PROXY === "true"`; then the LAST
`x-forwarded-for` hop). `src/auth.ts` imports it.

**`lock.ts` (server)**: `lockKeys(tx, keys)`: transaction-scoped advisory locks for seat and capacity checks (12).

**`module-gate.ts` (server)**, **`components/module-off.tsx`**: section 6.1.

**`lease.ts` (server)**: generic lease on `JobLease` (SQL verified).

```ts
export const LEASE_HOLDER: string;   // `${os.hostname()}:${process.pid}`
export async function withLease<T>(name: string, ttlMs: number, run: (renew: () => Promise<boolean>) => Promise<T>): Promise<T | null>;
// INSERT ... ON CONFLICT (name) DO UPDATE ... WHERE "JobLease".until < ${now} OR "JobLease".holder = EXCLUDED.holder RETURNING holder;
// release: DELETE FROM "JobLease" WHERE name = ${name} AND holder = ${me}. All times passed as JS Dates.
export async function clearStaleOwnLeases(): Promise<void>;
// DELETE FROM "JobLease" WHERE holder LIKE ${hostname + ":%"} AND holder <> ${LEASE_HOLDER} (a restarted Windows program's old process)
```

**`rate-limit.ts` (server)**: in-memory sliding window on `globalThis.__rate`, at most 50 000 keys (oldest-first
eviction, the `src/auth.ts` pattern).

```ts
export function allow(key: string, limit: number, windowMs: number): boolean;
export function allowPublic(req: Request, key: string, limit: number, windowMs: number): boolean;
// key + ":" + (clientAddress(req) ?? "anon"); every public POST also counts against allow("public-post", 300, 60_000)
```

**`ticket-status.ts` (server)**: extracted from `setStatus`; the only way code changes a direct ticket's status from now
on (the partner apply paths keep their own updates, plus `pickupReadyAt`, 7.2).

```ts
export type TicketForStatus = { id: string; shopId: string; status: TicketStatus; readyAt: Date | null; pickupReadyAt: Date | null;
  closedAt: Date | null; warrantyUntil: Date | null; customerId: string | null; viaAccountId: string | null };
export function statusData(t: TicketForStatus, status: TicketStatus, at: Date, warrantyDays: number): Prisma.TicketUpdateManyMutationInput;
// readyAt on the first READY_*; pickupReadyAt = at on every move INTO READY_FOR_PICKUP, null on every move out of it;
// closedAt / warrantyUntil exactly as setStatus does today
export async function changeTicketStatus(tx: Prisma.TransactionClient, t: TicketForStatus, status: TicketStatus, at: Date,
  warrantyDays: number, ctx: HookCtx): Promise<{ changed: boolean; note: string | null }>;
// status === t.status -> { changed: false }. Else tx.ticket.updateMany({ where: { id, shopId, status: t.status }, data: statusData(...) });
// count 0 -> re-read: already at `status` -> { changed: false, note: null }; else UserError("The ticket changed meanwhile. Reload the page.").
// count 1 -> note = await onTicketStatus(tx, { ...t, ...written }, status, at, ctx); { changed: true, note }
```

**`estimate-answer.ts` (server)**: the existing approval flows as functions (counter actions, links, text replies).

```ts
export type AnswerVia = "counter" | "link" | "text reply" | "phone";
export async function answerRetailEstimate(tx: Prisma.TransactionClient, a: { shopId: string; job: RepairJob; approval: "APPROVED" | "DECLINED";
  approvedCents: number | null; note: string | null; byName: string; via: AnswerVia; at: Date }): Promise<boolean>;
// guarded: tx.repairJob.updateMany({ where: { shopId, id, approval: null, status: "WAITING_CUSTOMER_OK" }, data: { approval, approvedCents,
// events } }); count 0 -> false (someone answered first; the caller says so). Then sendToPartner "job.reply" {id, approval,
// approvedCents, note, name, at} exactly as answerEstimate does today; the event note gets " (by link)" / " (text reply)" etc.
export async function answerTicketEstimate(tx: Prisma.TransactionClient, a: { ticket: TicketForStatus & { notes: string | null };
  warrantyDays: number; approval: "APPROVED" | "DECLINED"; approvedCents: number | null; note: string | null; via: AnswerVia;
  at: Date; tz: string; ctx: HookCtx }): Promise<void>;
// appends "Oct 7, 2026 2:14 pm: customer approved $145.00 by link. Note: ..." to ticket.notes (capped 20 000, like job.reply);
// APPROVED: approvedCents set; if status is WAITING_CUSTOMER_OK -> changeTicketStatus(..., "ON_BENCH"). DECLINED: note only.
```

**`booking-types.ts` (pure)**: `export type BookingDue = { kind: "enrollment" | "appointment"; id: string; description:
string; dueCents: number; taxable: boolean; customerId: string | null; customerName: string; startsAt: Date }` (used by
the register, the classes package and `bookingsDue`).

**`parse-table.ts` (pure)**: `parseTable(text): string[][]` moved unchanged out of `src/components/import-items.tsx`
(which imports it); the customer import uses it too.

**`notices/context.ts` (server, foundation-owned)**:

```ts
export type HookCtx = { marketing: boolean; ms: MessagingView; tz: string; userName: string | null };
export async function hookContext(shopId: string, userName?: string | null): Promise<HookCtx>; // moduleOn + messagingView + Shop.timeZone, outside any transaction
```

**`messaging/types.ts` (pure)**: section 3.1. **`messaging/errors.ts` (pure)**:

```ts
export type SendErrorKind = "offline" | "retry" | "recipient" | "settings" | "quota" | "ambiguous";
export class SendError extends Error { readonly sendError = true; constructor(msg: string, readonly kind: SendErrorKind, readonly code?: string) }
export function isSendError(e: unknown): e is SendError; // duck-typed like isUserError
```

**`messaging/secrets.ts` (server)**: AES-256-GCM. Key material: `SETTINGS_KEY` (current), `SETTINGS_KEY_PREVIOUS`
(optional, read-only), else `AUTH_SECRET`. Under hosted rules in a production build that isn't a test build
(`NODE_ENV === "production" && !process.env.STITCH_TEST_BUILD && !isDesktop()`), `SETTINGS_KEY` is required: without it
`seal()` throws `UserError("This server needs SETTINGS_KEY set before passwords can be saved. Ask whoever runs it.")`.
Each key: HKDF-SHA256(material, salt "stitchbench", info "settings-secrets:v1", 32 bytes); `kid` = first 8 hex of
sha256(derived key). Format `v1.<kid>.<iv>.<ciphertext>.<tag>` (base64url; 12-byte random IV; tag 16 bytes, the decipher
is created with `{ authTagLength: 16 }` and a tag of any other length is refused). AAD = `${shopId}:${field}`.
Prototype: `scratch/jobs-deploy-tests/seal.mjs` (add the kid and tag-length rules).

```ts
export type SecretField = "smtpPass" | "twilioToken" | `estimateToken:${string}`;
export function seal(plain: string, shopId: string, field: SecretField): string;
export function unseal(sealed: string | null, shopId: string, field: SecretField): { plain: string; stale: boolean } | null;
// null on any failure (unknown kid, other shop, bad tag); stale = opened with SETTINGS_KEY_PREVIOUS / AUTH_SECRET while a
// newer SETTINGS_KEY exists: the caller re-seals and saves (sendConfig does)
```

**`messaging/settings.ts` (server)**

```ts
export type MessagingView = Omit<MessagingSettings, "smtpPassSealed" | "twilioTokenSealed" | "testCodeHash"> & {
  hasSmtpPass: boolean; hasTwilioToken: boolean; secretsUnreadable: boolean;
  emailReady: boolean;  // emailOn && smtpHost && fromEmail && readable pass (hosted rules: user and pass required) && !emailPausedAt
  smsReady: boolean;    // smsOn && twilioSid && readable token && twilioFrom && tzConfirmedAt && !smsPausedAt
  publicUrl: string | null;   // PUBLIC_URL (env only), no trailing slash
  replyWatched: boolean;      // replyTo set && replyWatchedAt
};
export const MESSAGING_DEFAULTS: Omit<MessagingSettings, "shopId" | "updatedAt">;   // same values as the schema defaults
export async function messagingView(shopId: string, tx?: Prisma.TransactionClient | typeof db): Promise<MessagingView>; // row or defaults; never secrets
export type SendConfig = { shopId: string; shop: { name: string; phone: string | null; address: string | null; email: string | null; timeZone: string };
  view: MessagingView; smtpPass: string | null; twilioToken: string | null };
export async function sendConfig(shopId: string): Promise<SendConfig>;   // worker / test sends only; re-seals stale secrets
export function publicBaseUrl(): string | null;                           // PUBLIC_URL, validated (https, or http for localhost in tests)
export const DEFAULT_SMS_CONSENT_TEXT = "I agree to receive recurring automated marketing text messages from {shop_name} at the number above. Consent is not a condition of purchase. Msg frequency varies. Msg & data rates may apply. Reply STOP to cancel, HELP for help.";
export function consentWording(ms: MessagingView, shopName: string): string;  // saved or default, {shop_name} filled
export function consentCode(wording: string): string;                         // sha1(wording) hex, first 6, upper-case
export function isLocalRequest(h: Headers): boolean;
// Host is localhost / 127.0.0.1 / [::1] (any port) AND none of x-forwarded-for, x-forwarded-host, forwarded, cf-connecting-ip,
// x-real-ip is present (a tunnel that rewrites Host to localhost still adds one of these; the program's own window adds none)
```

**`messaging/presets.ts` (pure)**: `SMTP_PRESETS: Record<string, { label: string; host: string; port: number; security:
"starttls" | "tls"; help: string }>` for gmail (smtp.gmail.com 587, "Turn on 2-step sign-in and make an app
password."), outlook (smtp-mail.outlook.com 587), m365 (smtp.office365.com 587, help: "Microsoft is retiring password
sign-in for sending mail: use a relay such as SendGrid, Mailgun, Brevo or SES if it's refused."), yahoo
(smtp.mail.yahoo.com 465 tls, app password), sendgrid (smtp.sendgrid.net 587, user "apikey"), mailgun
(smtp.mailgun.org 587), brevo (smtp-relay.brevo.com 587), ses (email-smtp.us-east-1.amazonaws.com 587, "use your
region's host"), other. **Before shipping, the foundation implementer re-checks every host and the Microsoft note against
the providers' current pages** (Microsoft announced the end of Basic-auth SMTP AUTH for Exchange Online during 2026).

**`messaging/templates.ts` (pure)**: section 5.

**`messaging/quiet.ts` (pure)**

```ts
export function nextTextTime(now: Date, shopTz: string, r: { quietStart: number; quietEnd: number; noSundayMarketing: boolean },
  marketing: boolean, to: string): Date;
// zones = [shopTz, ...(marketing ? recipientZones(to) : [])]; allowed at t when, in every zone, the wall minutes are in
// [quietStart, quietEnd) and (marketing && noSundayMarketing) the weekday isn't Sunday. Returns `now` when allowed, else the
// first allowed quarter hour (search 15-minute steps up to 8 days; mainland overlap with 9-20 is 12:00-20:00 Eastern).
```

**`messaging/consent.ts` (server; `allowed()` itself pure and exported)**

```ts
export { allowed };
export async function consentState(tx: Db, shopId: string, customerIds: string[]): Promise<{ customers: Map<string, ConsentCustomer>; sup: SupMap }>;
export async function suppress(tx: Db, a: { shopId: string; channel: Channel; address: string; scope: "marketing" | "all"; source: string;
  customerId?: string | null; detail?: string | null; byUserId?: string | null }): Promise<void>;
// upsert Suppression (never downgrades "all" to "marketing"), add ConsentEvent(event "optout"), and for sms: cancel QUEUED texts to that
// address (status CANCELLED, error "They opted out") and clear smsConsent* on customers whose smsConsentPhone matches (ConsentEvent "marketing_no")
export async function unsuppress(tx: Db, a: { shopId: string; channel: Channel; address: string; source: string; byUserId?: string | null; detail?: string | null }): Promise<void>;
export async function recordConsent(tx: Db, e: Omit<Prisma.ConsentEventUncheckedCreateInput, "id" | "at">): Promise<void>;
export async function addressForOptOutCode(shopId: string, text: string): Promise<{ channel: "email"; address: string; customerId: string | null } | null>;
// accepts a pasted subject "unsubscribe <token>", a /u/<token> URL or the bare token; looks up OutMessage { shopId, optOutToken }
```

**`messaging/queue.ts` (server)**: the only way anything creates `OutMessage` rows.

```ts
type Db = Prisma.TransactionClient | typeof db;
export type Content = { subject?: string | null; body: string };
export type Target = { ticketId?: string | null; repairJobId?: string | null; campaignId?: string | null; refType?: string | null;
  refId?: string | null; byUserId?: string | null; sendAfter?: Date; notAfter?: Date | null };

export async function queueToCustomer(tx: Db, a: Target & {
  shopId: string; customerId: string; kind: MessageKind; channels: ChannelMode;
  content: (channel: Channel) => Content;   // rendered per channel (templates.renderKind), without prefix/footer
  dedupeKey?: string | null;                // ":email" / ":sms" appended per channel
  recordSkipped?: boolean;                  // default true for notices: a SKIPPED row (dedupeKey + ":" + channel + ":skipped") shows staff why
  staffCap?: boolean;                       // default true when byUserId is set: 3 per address per 24 h -> skipped "staff_cap"
  ms?: MessagingView;                       // pass it when already loaded (hooks), else loaded here
}): Promise<{ queued: { channel: Channel; address: string; sendAfter: Date }[]; skipped: { channel: Channel; reason: SkipReason }[]; duplicate: Channel[] }>;

export async function queueToAddress(tx: Db, a: Target & { shopId: string; kind: MessageKind; channel: Channel; address: string;
  content: Content; dedupeKey?: string | null; status?: "QUEUED" | "SENDING"; customerId?: string | null }): Promise<{ id: string | null; reason?: SkipReason }>;
// explicit address (EXPLICIT_KINDS): suppression only; customerId is stored for the record (consent_confirm, so stillWanted can
// check the consent) but never widens or narrows the check. status "SENDING" (with claimedAt now) is how test sends are
// inserted: the worker never picks them up

export function finalize(channel: Channel, kind: MessageKind, body: string, ctx: { shopName: string; shopPhone: string | null;
  postal: string | null; unsubscribeUrl: string | null; replyWord: boolean }): string;
export function unsubscribeParts(shopId: string, replyTo: string): { token: string; url: string | null; mailto: string };
// token = randomBytes(16) base64url (22 chars); url = `${publicBaseUrl()}/u/${token}` when there is one;
// mailto = `mailto:${replyTo}?subject=${encodeURIComponent("unsubscribe " + token)}`
export function cleanText(v: string | null | undefined, max = 500): string;
// for merge values that came from customers, staff or partners: control characters and CR/LF/tabs -> " ", runs of spaces
// collapsed, any "http://", "https://" or "www." word replaced by "[link removed]", cut to max
```

Rules inside: purpose from `KIND_PURPOSE`; `allowed()` per channel with `consentState`; the subject cleaned (3.3);
body finalized; insert with `createMany({ data: [row], skipDuplicates: true })` (count 0 = duplicate); `sendAfter`
default now; calls `kickMessages()` unless the row was inserted as SENDING.

**`messaging/kick.ts` (server)**: `export function kickMessages(): void`: nothing when `MESSAGES=off`; else 2 s debounce
on `globalThis`, then `import("./worker").then((w) => w.runMessages())` (dynamic import breaks the worker -> hooks ->
queue -> worker cycle).

**`messaging/smtp.ts` (server)**: nodemailer 10, driven at the connection level so the outcome of every send is known.
`SMTPConnection` from `nodemailer/lib/smtp-connection` and `MailComposer` from `nodemailer/lib/mail-composer` (both in
the package's `exports`; types ship with the package).

```ts
export async function checkSmtpHost(host: string, port: number, security: string): Promise<string[]>;
// dns.lookup(host, { all: true }), IPv4 first. Hosted rules: every address must be public (safe-fetch's privateAddress: no
// private, loopback, link-local, CGNAT, multicast), port 465, 587 or 2525, security tls or starttls, unless `host:port` is in
// SMTP_ALLOW_HOSTS: UserError("That mail server is on a private network. Use your provider's public server name.") /
// ("Use port 587 (or 465 for SSL). Other ports aren't allowed here."). Windows program: any address; security "none" only for
// a private or loopback address: UserError("'None' is only for a mail server on this shop's own network.").
export type SmtpSession = { send(m: { to: string; toName?: string | null; subject: string; text: string; html: string; headers: Record<string, string> }): Promise<{ id: string }>; close(): void };
export async function openSmtp(cfg: SendConfig): Promise<SmtpSession>;
// checkSmtpHost (every time), then new SMTPConnection({ host: address (hosted rules: the checked address; tried in order until
// one connects), port, secure: security === "tls", requireTLS: security === "starttls", ignoreTLS: security === "none",
// tls: { servername: host, minVersion: "TLSv1.2" }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
// logger: false, debug: false }) -> connect -> login (when smtpUser). Errors here: SendError offline / settings / retry.
// send(): MailComposer({ from: { name: fromName ?? shop.name, address: fromEmail }, to: { name, address }, replyTo: { name: shop.name,
// address: replyTo ?? fromEmail }, subject, text, html, headers }).compile().build() -> conn.send({ from: fromEmail, to: [to] }, raw).
// After a failure that had a server reply, conn.reset() before the next message; after one without, the session is closed and the
// worker opens a new one for the next row.
export async function verifySmtp(cfg: SendConfig): Promise<void>;  // open + close; used by Settings (rate-limited) and the hourly check
```

Classification (`SendError.kind`), from the stage and the server's reply code and enhanced status (`/\b([245])\.(\d{1,3})\.(\d{1,3})\b/`
in the reply text):

| Stage / reply | Kind |
|---|---|
| connect, greeting, DNS (`ECONNECTION`, `ETIMEDOUT`, `ESOCKET`, `EDNS`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`) before login | offline |
| TLS / certificate (`ETLS`, `CERT_*`, `ERR_TLS_*`) | settings ("The mail server's certificate doesn't match {host}.") |
| login 5xx (`EAUTH`) | settings ("The mail server said the user name or password is wrong. For Gmail or Outlook use an app password, not your normal password.") |
| login 4xx (e.g. 454 4.7.0) | retry |
| during `send`, any 4xx reply | retry, and stop this shop's channel for the rest of the run |
| during `send`, 5xx with 5.1.x, 5.2.1, 5.2.2 (or no enhanced code at RCPT) | recipient |
| during `send`, 5xx with 5.4.5, 5.7.x, 5.2.0, or any 5xx to MAIL FROM | quota (daily limit or policy: pause until the next shop-day 08:00) |
| during `send`, other 5xx | recipient |
| during `send`, an error with no server reply (socket closed, timeout: nodemailer reports these as `CONN`) | ambiguous (the message may have gone) |

Messages are plain words built from codes, never from the transport's config (so no credentials in logs).

**`messaging/twilio.ts` (server)**: `fetch`, no SDK. Base `TWILIO_API_BASE` (default `https://api.twilio.com`, env only).
Basic auth user = `twilioKeySid ?? twilioSid`, password = the token / key secret; URLs always use `twilioSid` (AC...).

```ts
export async function sendText(cfg: SendConfig, to: string, body: string): Promise<{ id: string }>;
// POST /2010-04-01/Accounts/{AC}/Messages.json, form To/From/Body, AbortSignal.timeout(15_000).
// fetch rejects with cause ECONNREFUSED / ENOTFOUND / EAI_AGAIN / ENETUNREACH -> offline; any other rejection or abort after the
// request was sent, or a 5xx -> ambiguous; 401 / 20003 -> settings; 21610 -> recipient (+ caller suppresses); 21211 21214 21612 21614
// 21408 -> recipient; 21606 21659 21212 21608 -> settings (the From number or a trial account); 21611 / 429 -> retry; other 4xx -> recipient.
export async function findSent(cfg: SendConfig, to: string, body: string, since: Date): Promise<string | null>;
// GET Messages.json?To=&From=&DateSent>={UTC day of since}&PageSize=50: the SID of an outbound message with exactly this body created
// at or after since - 60 s (checked before an ambiguous text is retried)
export async function checkTwilio(sid: string, user: string, secret: string): Promise<void>;   // GET /Accounts/{AC}.json
export async function listReplies(cfg: SendConfig, day: string, deadline: number): Promise<{ replies: Reply[]; complete: boolean }>;
// one UTC day: GET Messages.json?To={twilioFrom}&DateSent={day}&PageSize=1000, following next_page_uri until the last page
// (complete) or Date.now() > deadline (incomplete); direction "inbound" only. Reply = { sid, from, body, receivedAt }
export async function messageStatus(cfg: SendConfig, sid: string): Promise<{ status: string; errorCode: number | null }>;
```

`twilioSid` must match `/^AC[0-9a-f]{32}$/i`; `twilioKeySid` `/^SK[0-9a-f]{32}$/i`; `twilioFrom` must pass `toE164`.

**`messaging/inbound.ts` (server)**

```ts
export async function pollReplies(cfg: SendConfig, now: Date, deadline: number): Promise<number>; // new replies stored
// watermark = inboundAt ?? newest InboundText.receivedAt ?? now - 2 days (no upper limit on how far back).
// Reads ONE UTC day at a time, oldest first, from the watermark's day (minus 1 day of overlap) up to today:
// listReplies(cfg, { day }) = GET Messages.json?To={twilioFrom}&DateSent={day}&PageSize=1000 following next_page_uri. A day read
// to its last page is acted on (below) and then inboundAt = the end of that day (today: now), saved at once, so a long backlog
// makes progress run by run. A day cut off by the deadline is not acted on and inboundAt stays (the next run starts there).
// For each reply not in InboundText (by SID): create it with customerId (first customer of the shop with toE164(phone) ===
// from), keyword, and act:
//   STOP or LOOKS_LIKE_STOP -> suppress(sms, all, source "reply", detail body) (keyword "STOP" / "STOPLIKE", handledAt = now)
//   START / UNSTOP          -> unsuppress when suppressed (keyword "START", handledAt = now)
//   YES                     -> unsuppress only when the suppression's source is "reply" or "carrier"; otherwise an ordinary reply
//   HELP / INFO             -> recordConsent(help) + queueToAddress(help_reply, dedupe `help:{from}:{shop-day}`) (handledAt = now)
//   anything else           -> keyword null, handledAt null: listed for staff; holds marketing texts to that number until handled
// Replies are acted on oldest first. A run that reached today: inboundIncomplete = 0. A run cut off before today:
// inboundIncomplete + 1, and at 3 -> textHoldAt = now, textHoldWhy "Some text replies couldn't be read yet" (marketing texts
// wait; the reading goes on each run, and the hold lifts by itself once a run reaches today, or an admin releases it).
const STOP = /^(stop|stopall|stop all|unsubscribe|cancel|end|quit|optout|opt out|revoke)$/i;   // on the trimmed body
const START = /^(start|unstop)$/i;
const YES = /^yes$/i;
const HELP = /^(help|info)$/i;
const LOOKS_LIKE_STOP = /\b(stop|unsubscribe|opt[\s-]?out|revoke|remove me|don'?t (text|message) me|no more (texts|messages))\b/i; // every reply
export async function pollDelivery(cfg: SendConfig, now: Date): Promise<void>;
// texts SENT in the last 48 h with deliveryStatus null, oldest first, up to 100 per shop per run: messageStatus(); final statuses
// (delivered | undelivered | failed) are written with deliveryError = plain words for the code (30003 "phone off or unreachable",
// 30005 "unknown number", 30006 "landline or can't receive texts", 30007 "blocked by the carrier as spam", 30034 "blocked: the
// Twilio number isn't registered for business texting"). 5 x (30007 | 30034) in one shop-day -> pause texts (3.3).
```

**`messaging/service-due.ts` (server)**

```ts
export type DueMachine = { machineId: string; customerId: string; brand: string; model: string; equipment: string;
  lastServiceAt: Date; dueAt: Date; noticedFor: Date | null };
export async function machinesDue(shopId: string, months: number, now: Date, o?: { dueSince?: Date; customerIds?: string[] }): Promise<DueMachine[]>;
// Latest record per machine across Ticket (DISTINCT ON machineId ORDER BY intakeAt DESC; jobType 'BENCH' only) and retail
// RepairJob (DISTINCT ON machineId ORDER BY createdAt DESC). Due when the latest one is completed (Ticket COLLECTED with
// closedAt, customerId set, viaAccountId null; or RepairJob side "retail", status COLLECTED, pickedUpAt set, customerId set) and
// dueAt = completedAt + months (calendar months, shop time) <= now, and dueAt >= o.dueSince when given. A later record (machine
// back in) means not due. Raw SQL with ${now}/${shopId} parameters only; uses the new indexes Ticket(shopId, machineId, intakeAt)
// and RepairJob(shopId, machineId). Recipient: that record's customerId.
```

**`messaging/campaign-build.ts` (server; stub by foundation, owner `campaigns`)**:
`export async function buildCampaigns(now: Date, shopIds: string[]): Promise<void> {}` (4.3 step 6).

**`messaging/worker.ts` (server)**: section 4.3.

**Stubs created by foundation, owned later by feature packages** (section 7): `src/lib/notices/hooks.ts`,
`src/lib/notices/scheduler.ts`, `src/lib/messaging/campaign-build.ts`, `src/actions/class-register.ts`,
`src/components/slots/*.tsx`, placeholder pages.

**Shared UI and helpers (foundation)**

```ts
// src/components/notify-by-field.tsx (server-safe, no hooks)
export function NotifyByField({ id = "notifyBy", defaultValue = "", required = false, label = "How should we tell them it's ready / remind them?" }): JSX.Element;
// required: radio buttons Text / Email / Both / Call them (no message), none pre-selected; else an optional <select name="notifyBy">
// src/components/customer-picker.tsx ("use client")
export function CustomerPicker({ prefix = "", notifyRequired = false }: { prefix?: string; notifyRequired?: boolean }): JSX.Element;
// search box using findCustomers() from "@/actions/register"; picking sets hidden `${prefix}customerId`; otherwise shows
// name / phone / email / NotifyByField inputs named `${prefix}customerName|customerPhone|customerEmail|notifyBy`
// src/lib/customer-input.ts (server)
export async function needNotifyBy(shopId: string): Promise<boolean>;  // Marketing on and (emailReady || smsReady)
export async function customerFromForm(tx: Db, shopId: string, fd: FormData, byUserId: string, source: "counter" | "intake", p = "",
  o?: { notifyRequired?: boolean }): Promise<{ id: string; name: string }>;
// existing (checked with shopId) or new RETAIL customer: UserError("Enter the customer's name and a phone or email.");
// when notifyRequired and the customer's notifyBy is "" and the form has none: UserError("Ask how they'd like to be told (text, email or a call).");
// records ConsentEvent notify_pref when notifyBy is set or changed
// src/components/messages-tabs.tsx (server)
export function MessagesTabs({ active, unhandled }: { active: "outbox" | "replies" | "optouts" | "campaigns"; unhandled?: number }): JSX.Element; // Campaigns -> /campaigns
// src/components/messaging-tabs.tsx (server): Settings -> Messages tabs Setup | Automatic messages | Rules
// src/components/calendar-tabs.tsx (server): CalendarTabs({ active: "day" | "week" | "staff", date }) -> /calendar?view=day|week, /shifts
// src/components/sms-counter.tsx ("use client"): SmsCounter({ name, prefix, suffix, partMills? }): parts, unicode warning, cost hint
// src/components/messaging-settings-forms.tsx ("use client"): EmailSettingsForm, TextSettingsForm, RulesForm, AutoMessagesForm
//   (ActionForm-based; secret inputs always empty; the preset select fills host / port / security)
// src/components/template-editor.tsx ("use client"): TemplateEditor({ templateKey, value, fields, sample }): textarea, field list,
//   live sample (render + finalize with SAMPLE_VARS), plain-character note, "Reset to the default", "Send me a sample"
// src/components/consent-sign.tsx ("use client"): the tablet form of /consent/[customerId] (wording, "I agree", typed name, Sign)
```

### 4.2 Channel and settings behaviour

- `MessagingSettings` row is created on the first save (`upsert`); reads go through `messagingView()` (defaults when
  missing).
- Secrets: the password / token inputs are always rendered empty with placeholder "Saved Oct 7, 2026. Leave blank to keep
  it."; a blank field keeps the stored value; a "Forget the saved password" checkbox clears it. The page never receives
  sealed or plain secrets (`MessagingView` omits them). If `unseal()` fails, the page says "The saved password can't be
  read on this computer (the program's secret changed, for example after moving to a new PC). Enter it again." and the
  channel is not ready.
- On the Windows program a secret field is accepted only when the request's Host is the PC itself (`isLocalRequest`):
  `UserError("Enter passwords on the shop PC itself (in the StitchBench window), not from another device on the network.")`;
  the page shows that line instead of the password inputs on other devices. Everything else can be changed from any
  device.
- Saving a channel's settings clears its `*PausedAt`, `*PausedUntil`, `*CheckAt`, `*Error`.
- A paused channel with no `*PausedUntil` is re-checked by the worker every hour (`verifySmtp` / `checkTwilio`); success
  unpauses it with the status "Working again (checked by itself at 10:00)".
- Status line per channel on `/settings/messages`, `/messages`, and a sidebar pill (`tone-bad`) "Email paused: fix in
  Settings" / "Texts paused: fix in Settings" for everyone: "Working, last sent 10:42", "Paused: the mail server said
  the password is wrong (10:40). Save the settings again to try again.", "Paused until tomorrow 8:00 am: Gmail's daily
  limit", "Waiting for the internet since 9:15 (12 messages waiting)".

### 4.3 Worker (`src/lib/messaging/worker.ts`)

```ts
export type MessageRunResult = { sent: number; failed: number; waiting: number } | { busy: true } | { off: true };
export function runMessages(): Promise<MessageRunResult>;                // globalThis.__messageRun singleton + withLease("messages", 5 min)
export async function messageRun(o?: { now?: Date; shopIds?: string[]; forceSchedulers?: boolean }): Promise<MessageRunResult>; // one run under the lease; checks pass shopIds
export async function sendOneNow(id: string): Promise<{ ok: true; detail: string } | { error: string }>; // test sends (rows inserted as SENDING)
```

`MESSAGES=off` makes `runMessages`, `messageRun`, `sendOneNow` return `{ off: true }` / `{ error: "Messages are
switched off on this server (MESSAGES=off)." }` before touching anything, and `kickMessages` do nothing.

Timer (`src/instrumentation.ts`, inside the existing guarded block):

```ts
const g = globalThis as unknown as { hubTimer?: NodeJS.Timeout; partnerTimer?: NodeJS.Timeout; messageTimer?: NodeJS.Timeout };
...
if (process.env.MESSAGES !== "off") {
  const { clearStaleOwnLeases } = await import("@/lib/lease");
  await clearStaleOwnLeases().catch(() => {});
  const { runMessages } = await import("@/lib/messaging/worker");
  const messages = () => runMessages().catch((e) => console.error("messages:", e instanceof Error ? e.message : e));
  setTimeout(messages, 15_000);
  g.messageTimer = setInterval(messages, Number(process.env.MESSAGE_WORKER_SECONDS ?? 30) * 1000);
}
```

One run, in order (all under the lease; renew between sends; stop claiming after 100 s):

1. **Recover**: `SENDING` rows with `claimedAt < now - 2 min` (the holder died mid-send), except test rows: notices with
   `retryTries = 0` -> `QUEUED`, `retryTries 1`, error "Interrupted; sending once more"; notices already retried ->
   `FAILED` "Interrupted twice; not sent again in case it went out"; marketing -> `FAILED` "Interrupted while sending;
   not sent again in case it went out"; `kind "test"` -> `FAILED` "Test interrupted".
2. **Tidy**: `QUEUED` with `notAfter < now` -> `EXPIRED`; channels whose `*PausedUntil <= now` unpause;
   `EstimateLink.tokenSealed` is cleared for links answered, revoked or expired, or with no `QUEUED`/`SENDING` message
   left. Steps 1-3 run for every shop, module or not.
3. **Replies and delivery** (never gated: reading is not sending): for every shop whose settings have `twilioSid`,
   `twilioFrom` and a token (whatever `smsOn`, pause or module), when `inboundAt` is null or older than 5 min (1 min
   while a text campaign of the shop is `SENDING` or finished less than 24 h ago): `pollReplies()` with a 20 s deadline,
   then `pollDelivery()`. A token that can't be unsealed sets `textHoldAt` ("Text replies can't be read: enter the
   Twilio token again"). Only a 401 stops that shop's reading (error on the status line). Errors are logged into
   `smsError`, never thrown.
4. `live = await shopsWith("marketing")` (module-gate adapter), once per run. Steps 5-8 only touch `live` shops; rows of
   other shops stay `QUEUED` untouched: that is "held".
5. **Paused channels**: for live shops with a pause and `*CheckAt <= now`: `verifySmtp` / `checkTwilio`; ok -> unpause;
   else `*CheckAt = now + 1 h`.
6. **Campaigns**: `buildCampaigns(now, live)` (campaigns package: up to 500 members per campaign per run turned into rows).
7. **Schedulers**: `runSchedulers(now, live)` (auto-notices) at most every 5 min (`globalThis.__schedAt`) or when
   forced by "Send now"; errors caught per shop.
8. **Send**: `groupBy(["shopId"])` over due rows (`status QUEUED, sendAfter <= now, nextTryAt null or <= now`), live shops
   only, starting from a different shop each run (`globalThis.__msgStart`), at most 20 s per shop. Per shop: `sendConfig()`
   once; fetch up to `MESSAGE_BATCH` (default 20) due rows per channel, notices first then marketing, oldest `sendAfter`
   first. Marketing rows are left out entirely while `marketingHoldAt` is set, marketing texts while `textHoldAt` is set,
   and marketing rows whose `sendAfter` is older than 48 h (held for a person: `/messages` shows "N marketing messages
   waited more than 2 days" with "Send them" / "Cancel them"). A channel that isn't ready (switched off, paused, secret
   unreadable) is skipped: its rows stay `QUEUED` (held, with a banner saying why) and are NOT marked skipped;
   `channel_off` only applies at queue time. One SMTP session per shop per run, opened at the first email and closed at
   the end of the shop's turn. For each row:
   1. `stillWanted(row)` (auto-notices hook): a string -> `CANCELLED` with that reason.
   2. Consent: `allowed()` with the customer's current record (suppression only when `customerId` is null or the kind is
      in `EXPLICIT_KINDS`). Not ok -> `SKIPPED` (`error` = the reason label); ok but a different address ->
      `SKIPPED` "changed".
   3. Marketing texts: an `InboundText` from this number with `keyword null` and `handledAt null` -> `SKIPPED`
      `unread_reply`; a marketing text SENT or SENDING to this number in the last 24 h -> `sendAfter` = that time + 24 h,
      continue; 4 in the last 30 days -> `SKIPPED` `too_often`.
   4. Texts: `t = nextTextTime(now, tz, rules, marketing, address)`; `t > now` -> `sendAfter = t`, continue.
   5. Marketing daily caps: SENT + SENDING marketing rows of this channel in this shop-day >= `emailDailyCap` /
      `smsDailyCap` -> one `updateMany` moves every due `QUEUED` marketing row of this shop and channel to the next
      shop-day at `quietStart`; stop this channel for the run.
   6. Claim: `updateMany({ where: { id, status: "QUEUED" }, data: { status: "SENDING", claimedAt: now, tries: { increment: 1 } } })`;
      count 0 -> skip (someone else has it).
   7. Estimate rows (`refType "estimate"`): load the link (`{ id: refId, shopId }`), `unseal(tokenSealed, shopId,
      "estimateToken:" + id)`, replace every `maskedUrl` in the body with `${publicBaseUrl()}/e/${token}` for sending
      only (the stored body keeps the mask). No token -> `FAILED` "The link can't be sent any more; send the estimate
      again".
   8. Send: email with `List-Unsubscribe` (3.3; marketing only) or `sendText`. An `ambiguous` text: `findSent()` first;
      found -> treat as sent with that SID.
   9. Result: SENT (`sentAt`, `providerId`, `error: null`; channel `*OkAt = now`, `*Error = null`). `SendError`:
      - `offline` -> `QUEUED`, `nextTryAt = now + min(10 min, 30 s * 2^min(tries, 5))`, `retryTries` unchanged, never
        fails (until `notAfter`); channel `*Error` "Can't reach ... since HH:MM"; stop that shop's channel this run.
        Under hosted rules, a channel that has been only "offline" for 24 h is paused as `settings` ("Can't reach
        {host} for a day. Check the server name and port; some hosts block outgoing mail (see INSTALL.md).").
      - `retry` -> `QUEUED`, `retryTries + 1`, the same backoff capped at 30 min, `FAILED` at `retryTries` 8; a 4xx also
        stops that shop's channel this run.
      - `recipient` -> `FAILED` with the plain error (Twilio 21610 also `suppress(sms, all, source "carrier")`); 3
        `recipient` failures in a row for one shop and channel in a run -> pause the channel ("The mail server is
        refusing messages: {text}").
      - `settings` -> back to `QUEUED`, channel paused (`*PausedAt`, `*Error`, `*CheckAt = now + 1 h`), stop that
        shop's channel.
      - `quota` -> back to `QUEUED`, channel paused until the next shop-day 08:00 (`*PausedUntil`), stop.
      - `ambiguous` -> marketing: `FAILED` "May have gone out; not sent again"; notices: `QUEUED` with `retryTries + 1`
        once, `FAILED` "May have gone out; not sent again" the second time.
9. **Campaign sweep**: campaigns `SENDING` whose members are all built and that have no `QUEUED`/`SENDING` rows ->
   `SENT`, `finishedAt`.
10. Return counts.

Offline for days (Windows): nothing is lost; notices wait; reminders expire two hours before the start; quiet hours are
applied when the connection comes back (a 23:00 reconnect sends texts at 09:00); replies received meanwhile are read
before anything is sent.

---

## 5. Templates and merge fields

`src/lib/messaging/templates.ts` (pure):

```ts
export const COMMON_FIELDS = ["first_name", "name", "shop_name", "shop_phone"] as const;
export const FIELDS: Record<string, string[]> = {
  ready: [...COMMON_FIELDS, "machine", "ref", "amount_line"],
  reminder: [...COMMON_FIELDS, "what", "when", "location_line", "supplies_line"],
  class_signup: [...COMMON_FIELDS, "what", "when", "location_line", "supplies_line", "fee_line"],
  booking: [...COMMON_FIELDS, "what", "when", "location_line", "fee_line"],
  estimate: [...COMMON_FIELDS, "machine", "ref", "total", "estimate_link", "estimate_lines", "note_line"],
  estimate_nolink: [...COMMON_FIELDS, "machine", "ref", "total", "estimate_lines", "note_line"],
  abandon: [...COMMON_FIELDS, "machine", "ref", "ready_date", "abandon_date", "storage_fee"],
  abandon_final: [...COMMON_FIELDS, "machine", "ref", "ready_date", "abandon_date", "storage_fee"],
  service_due: [...COMMON_FIELDS, "machine", "months"],
  review: [...COMMON_FIELDS, "review_link"],
  bags_due: [...COMMON_FIELDS, "machine", "months", "bag_line"],
  consent_confirm: ["shop_name", "shop_phone"],
  help_reply: ["shop_name", "shop_phone"],
  campaign: [...COMMON_FIELDS, "machine", "upcoming_classes"], // machine: service-due audience only; upcoming_classes: counter shops
  class_notice: [...COMMON_FIELDS, "class_title"],
};
export const TRUSTED_FIELDS = ["shop_name", "shop_phone", "estimate_link", "review_link", "upcoming_classes", "total", "storage_fee"];
export const TEMPLATE_KEYS: string[]; // `${key}.sms`, `${key}.email`, `${key}.subject` for ready, reminder, class_signup, booking,
                                      // estimate, estimate_nolink, abandon, abandon_final, service_due, review, bags_due;
                                      // plus consent_confirm.sms, help_reply.sms
export const DEFAULT_TEMPLATES: Record<string, string>;
export const SAMPLE_VARS: Record<string, string>;                    // "Mary", "Janome MC6700P", ... for previews and "Send me a sample"
export function templateFor(ms: { templates: unknown }, key: string): string;          // saved text or the default
export function render(tpl: string, vars: Record<string, string>): string;
// ONE pass: tpl.replace(/\{([a-z_]+)\}/g, (_, k) => value(k)); a value is never re-scanned, so "{estimate_link}" typed into a
// name stays literal; values of fields not in TRUSTED_FIELDS go through cleanText() first; unknown -> ""; 3+ newlines collapse to 2
export function checkTemplate(tpl: string, allowedFields: readonly string[]): void;    // UserError("Unknown field {x}. You can use: {a}, {b}.")
export function renderKind(ms: MessagingView, key: string, channel: Channel, vars: Record<string, string>): Content;
export function smsParts(text: string): { parts: number; unicode: boolean };           // GSM-7 160/153, UCS-2 70/67
export function plainText(s: string): { text: string; changed: boolean };              // curly quotes, dashes, ellipsis, nbsp -> plain GSM characters
export function textToHtml(text: string): string;                                      // escape all, paragraphs, link http(s) URLs, footer small grey
export function firstName(name: string): string;
// "SMITH, MARY" -> "Mary"; skips Mr / Mrs / Ms / Miss / Dr / Mx (with or without a dot); capitalises an all-caps name; "" -> "there"
```

Field meanings: `first_name` = `firstName(customer.name)`; `machine` = "Janome MC6700P" (service due: "Janome MC6700P
and Singer 401A" when one message covers several); `ref` = "ticket 0123" / "tag 101"; `amount_line` = " Balance:
$145.00." (ticket: total minus payments; retail job: `totalCents - (repairPaidCents ?? 0) - (paidCents ?? 0)`) or ""
when nothing is owed; `total` = `money()` of the estimate (incl. tax); `estimate_lines` = one "description  $x.xx" line
each (email only); `note_line` = the shop's note plus a blank line, or ""; `what` = class title (+ " (meeting 2 of 4)")
or the appointment title; `when` = `fmtWhen` in shop time ("Tue, Oct 7 at 6:00 pm"); `location_line` = " At
{location}." or ""; `supplies_line` = "\n\nBring: {supplies}" or ""; `fee_line` = " Fee: $45.00, paid at the counter."
/ " Paid: $45.00." / ""; `ready_date` / `abandon_date` = `fmtDay` in shop time; `storage_fee` =
`money(Shop.storageFeeCents)`; `months` = whole months since the service (`monthsBetween`); `review_link` =
`reviewUrl`; `bag_line` = " We have {bag} in stock." or ""; `upcoming_classes` = one line per OPEN class with seats left
starting in the next 30 days, "Beginning Quilting · Tue, Oct 7 at 6:00 pm · 3 seats left · $45.00" (empty for companies
without the counter).

Values from customers, staff or partners (names, machine, estimate lines, notes, class titles) can't carry links:
`cleanText` replaces them with "[link removed]" (a partner can't make the sewing shop email a payment link). So
`textToHtml` may link every URL left in the text: they all came from the shop's own templates and trusted fields.

Defaults (texts get "{Shop}: " in front and, for marketing and staff-typed notices, " Reply STOP to opt out." at the
end; emails get the signature or marketing footer from `finalize`):

| Key | Default |
|---|---|
| `ready.sms` | `Hi {first_name}, your {machine} is ready to pick up.{amount_line} Questions? Call {shop_phone}.` |
| `ready.subject` | `Your {machine} is ready` |
| `ready.email` | `Hi {first_name},\n\nYour {machine} ({ref}) is ready to pick up.{amount_line}\n\nQuestions? Call us at {shop_phone}.` |
| `reminder.sms` | `Reminder: {what} on {when}.{location_line} Can't make it? Call {shop_phone}.` |
| `reminder.subject` | `Reminder: {what} on {when}` |
| `reminder.email` | `Hi {first_name},\n\nA reminder: {what} on {when}.{location_line}{supplies_line}\n\nCan't make it? Please call us at {shop_phone}.` |
| `class_signup.sms` | `You're signed up: {what}, starting {when}.{location_line}{fee_line} Questions? Call {shop_phone}.` |
| `class_signup.subject` | `You're signed up: {what}` |
| `class_signup.email` | `Hi {first_name},\n\nYou're signed up for {what}, starting {when}.{location_line}{fee_line}{supplies_line}\n\nQuestions? Call us at {shop_phone}.` |
| `booking.sms` | `Booked: {what} on {when}.{location_line} Can't make it? Call {shop_phone}.` |
| `booking.subject` | `Booked: {what} on {when}` |
| `booking.email` | `Hi {first_name},\n\nYou're booked: {what} on {when}.{location_line}{fee_line}\n\nCan't make it? Please call us at {shop_phone}.` |
| `estimate.sms` | `Hi {first_name}, the estimate for your {machine} is {total}. See it and approve or decline here: {estimate_link}` |
| `estimate.subject` | `Estimate for your {machine}: {total}` |
| `estimate.email` | `Hi {first_name},\n\nWe've looked at your {machine} ({ref}). The estimate is {total}:\n\n{estimate_lines}\n\n{note_line}See it and approve or decline here: {estimate_link}\n\nOr call us at {shop_phone}.` |
| `estimate_nolink.sms` | `Hi {first_name}, the estimate for your {machine} is {total}. Call {shop_phone} or reply to this text to approve or decline.` |
| `estimate_nolink.subject` | `Estimate for your {machine}: {total}` |
| `estimate_nolink.email` | `Hi {first_name},\n\nWe've looked at your {machine} ({ref}). The estimate is {total}:\n\n{estimate_lines}\n\n{note_line}Call us at {shop_phone} or reply to this email to approve or decline.` |
| `abandon.sms` | `Hi {first_name}, your {machine} has been ready since {ready_date}. Please pick it up by {abandon_date}; after that a storage fee of {storage_fee} applies. Call {shop_phone}.` |
| `abandon.subject` | `Please pick up your {machine}` |
| `abandon.email` | `Hi {first_name},\n\nYour {machine} ({ref}) has been ready to pick up since {ready_date}.\n\nPlease pick it up by {abandon_date}. After that a storage fee of {storage_fee} applies and the machine may be treated as abandoned under our policy.\n\nNeed more time? Call us at {shop_phone}.` |
| `abandon_final.sms` | `FINAL NOTICE: {first_name}, your {machine} has been ready since {ready_date}. If it isn't picked up by {abandon_date} it will be treated as abandoned. Call {shop_phone}.` |
| `abandon_final.subject` | `Final notice: your {machine}` |
| `abandon_final.email` | `Hi {first_name},\n\nThis is our final notice. Your {machine} ({ref}) has been ready since {ready_date}.\n\nIf it isn't picked up by {abandon_date}, it will be treated as abandoned under our policy and the storage fee of {storage_fee} applies.\n\nPlease call us at {shop_phone}.` |
| `service_due.sms` | `Hi {first_name}, it's been about {months} months since your {machine} was serviced. Time for a tune-up? Call {shop_phone}.` |
| `service_due.subject` | `Time for a tune-up on your {machine}?` |
| `service_due.email` | `Hi {first_name},\n\nIt's been about {months} months since we serviced your {machine}. A yearly cleaning and tune-up keeps it running smoothly.\n\nCall us at {shop_phone} to bring it in.` |
| `review.sms` | `Thanks for coming in, {first_name}! If you have a minute, a review helps a small shop a lot: {review_link}` |
| `review.subject` | `How did we do?` |
| `review.email` | `Hi {first_name},\n\nThanks for coming in. If you have a minute, a short review helps a small shop a lot:\n\n{review_link}\n\nThank you!` |
| `bags_due.sms` | `Hi {first_name}, it's been about {months} months since you got bags for your {machine}.{bag_line} Call {shop_phone} or stop by.` |
| `bags_due.subject` | `Time for new bags for your {machine}?` |
| `bags_due.email` | `Hi {first_name},\n\nIt's been about {months} months since you picked up bags for your {machine}.{bag_line}\n\nCall us at {shop_phone} or stop by.` |
| `consent_confirm.sms` | `You're signed up for texts from {shop_name}. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel.` |
| `help_reply.sms` | `{shop_name}: for help call {shop_phone}. Msg & data rates may apply. Reply STOP to opt out.` |

`finalize()` adds: texts: `"{Shop.name}: "` prefix (skipped when the body already starts with the shop name); marketing
texts and `STOP_LINE_KINDS` texts `" Reply STOP to opt out."`. Notice emails: `"\n\n{Shop.name}{ · phone}"`. Marketing
emails: `"\n\n--\nThis is an advertisement from {Shop.name}, {postal address}.\n"` then, hosted: `"To stop getting these
emails: {url}\nOr reply with the word UNSUBSCRIBE."`; Windows program: `"To stop getting these emails, reply to this email
with the word UNSUBSCRIBE."` (+ `" Or use {url}"` when `PUBLIC_URL` is set).

Editing: on `/settings/messages/auto` each automatic message's wording sits in a `<details>` next to its switch: a
textarea per text / subject / email, the allowed fields listed, a live sample rendered with `SAMPLE_VARS` ("Hi Mary,
your Janome MC6700P is ready..."), "Reset to the default", and "Send me a sample". Text templates <= 480 characters,
email <= 5000, subject <= 150, `checkTemplate` and `plainText` on save ("We changed curly quotes and dashes to plain
ones so texts stay one part."), a warning when emoji force 70-character parts. The `bags_due` wording is listed only when
`hasModule(shopId, "vac")` (modules-design 12.4 #1); the other kinds are always listed.

---

## 6. Paid modules: the gate adapter and every gate point

The licensing platform (`modules-design.md`) is built first and provides `getModules(shopId)`, `hasModule(shopId, key)`,
`requireModule(user, key)`, `shopsWithModule(key, ids?)`, `navGates(shopId)`, `isDesktop()` and the UI
`ModuleNoticeFor`. This build never imports those directly (except in the adapter and `isDesktop()`), so a naming
difference in the modules package is fixed in one file.

### 6.1 `src/lib/module-gate.ts` (server, foundation)

```ts
import "server-only";
export type ModuleKey = "scheduling" | "marketing";
export type Gate = "on" | "readonly" | "hidden";

export async function moduleOn(shopId: string, key: ModuleKey): Promise<boolean>;      // = hasModule(shopId, key)
export async function gateFor(shopId: string, key: ModuleKey): Promise<Gate>;
// "on" when moduleOn; else "readonly" when the shop has any of the module's records (or navGates says lapsed); else "hidden".
// scheduling records: ShopClass | AppointmentType | Appointment | Shift | PartnerRun (findFirst select id, each);
// marketing records: MessagingSettings | OutMessage | Campaign. The data check is cached per (shopId, key) for 60 s on
// globalThis.__gateCache ("on" is never cached, so a module switched back on shows at once).
export async function gates(shopId: string): Promise<Record<ModuleKey, Gate>>;         // both, for the layout / nav
export async function requireOn(user: CurrentUser, key: ModuleKey): Promise<void>;       // = requireModule(user, key) (throws its UserError)
export async function shopsWith(key: ModuleKey, shopIds?: string[]): Promise<string[]>; // = shopsWithModule(key, shopIds)
```

`src/components/module-off.tsx` (server component, foundation): `ModuleOff({ shopId, module, what })` renders
`<ModuleNoticeFor shopId={shopId} module={module} what={what} />` from the modules package (its copy links to
`SETTINGS_MODULES_HREF`, `/settings/modules`).

Pattern for a module page:

```tsx
const gate = await gateFor(user.shopId, "scheduling");
if (gate === "hidden") return <ModuleOff shopId={user.shopId} module="scheduling" />;   // never licensed: the notice only
// "readonly": the page renders as usual with <ModuleOff .../> at the top and every form/button hidden
// (pass `readOnly = gate !== "on"` down). Actions refuse anyway (requireOn), so a stale open tab gets the UserError.
```

### 6.2 Nav and layout (foundation)

`Item.module` and the `gates` prop already exist (modules-foundation). `AppLayout` merges the data-based gates:
`gates={{ ...toNavGates(modules), ...(await gates(user.shopId)) }}`. New items (inserted in this order after
`/customers`):

| href | label | icon | flags |
|---|---|---|---|
| `/calendar` | Calendar | `CalendarDays` | `module: "scheduling"` (both products; Staff schedule is its "Staff" tab) |
| `/classes` | Classes | `GraduationCap` | `retail: true, module: "scheduling"` |
| `/messages` | Messages | `Send` | `module: "marketing"` (both products; Campaigns is its tab); a count badge of unhandled replies |

The layout also loads (one query each, only when Marketing isn't hidden): unhandled replies count
(`InboundText where { shopId, keyword: null, handledAt: null }`) for the badge, and the channel pause state for the
sidebar pill (4.2). Partner runs have no nav item: they live on `/partners/[id]`, `/repairs`, the Dashboard and the
calendar.

### 6.3 Every gate point

S = Scheduling, M = Marketing. "requireOn" = the action calls `requireOn(user, key)`. "readonly UI" = page renders
records with `<ModuleOff>` and no forms when the gate is not `on`.

| Where | Kind | Gate | Behaviour when off / expired |
|---|---|---|---|
| `/calendar`, `/calendar/new`, `/calendar/appointments/[id]`, `/calendar/types`, `/shifts`, `/shifts/print` | pages | S (any company) | readonly UI (schedules still print); hidden gate -> notice only |
| `/classes`, `/classes/new`, `/classes/[id]`, `/classes/[id]/roster`, `/classes/print` | pages | S + `sellsRetail` | readonly UI (roster and month list still print) |
| `/partners/[id]/runs/new` | page | S | notice; "Schedule a run" hidden |
| `/partners/[id]/runs/[runId]` | page | none | view, OK, cancel, record the hand-off always; "Change it" needs S |
| slots `customer-classes`, `customer-appointments`, `today` | slots | S | nothing when hidden; read-only lists when readonly |
| slots `partner-runs`, `job-run`, `repairs-runs`, `dashboard-runs` | slots | none | always shown (custody); their "Schedule" buttons need S |
| `src/actions/classes.ts`, `appointments.ts`, `shifts.ts` (every action), `class-register.ts` `enrollAtRegister` | actions | S requireOn | UserError |
| `partner-runs.ts` `proposeRun`, `changeRun` | actions | S requireOn | UserError |
| `partner-runs.ts` `okRun`, `cancelRun`, `recordRun` | actions | none | custody records: always allowed |
| `register.ts` `completeSale` with enrollment / appointment lines, `voidSale`, `bookingsDue`, `class-register.ts` `openClassSeats` | actions | none | paying or refunding an existing booking is money owed; the open-classes list is empty when S is off |
| `applyMessage` `pickup.*`, `caps.update` | partner apply | none | always applied and stored (never lose a partner's record) |
| `pushFeatures()` (`caps.update`) | partner sync | none | advertises `["pickup"]` because this version supports runs, whatever the modules |
| `/settings/messages`, `/settings/messages/auto`, `/settings/messages/rules` | pages | M | readonly UI: settings visible, forms hidden (secrets never shown in any state) |
| `/messages`, `/messages/replies`, `/messages/opt-outs` | pages | M | readonly UI, except the opt-out form, "Handled" and the hold banners (below) |
| `/campaigns`, `/campaigns/new`, `/campaigns/[id]`, `/customers/import` | pages | M | readonly UI |
| `src/actions/messaging.ts`: `saveEmailSettings`, `saveTextSettings`, `confirmTimeZone`, `saveMessageRules`, `saveAutoMessages`, `saveTemplate`, `resetTemplate`, `sendTestMessage`, `addTestPhone`, `confirmTestPhone`, `runMessagesNow`, `retryMessage`, `releaseHeld`, `releaseMarketingHold`, `releaseTextHold` | actions | M requireOn | UserError |
| `messaging.ts` `cancelMessage`, `cancelHeld`, `removeTestPhone` | actions | none | allowed (stops or removes, not new work) |
| `src/actions/campaigns.ts` (all but `cancelCampaign`), `customer-import.ts` | actions | M requireOn | UserError; `cancelCampaign` always allowed |
| `src/actions/estimate-links.ts` `sendEstimate` | action | M requireOn | UserError; the slot hides the send form |
| `estimate-links.ts` `revokeEstimateLink`, `recordEstimateAnswer` | actions | none | allowed (counter work) |
| `src/actions/notices.ts` `sendNoticeNow` | action | M requireOn | UserError |
| `notices.ts` `recordManualNotice`, `markBackAtCounter`, `markManyBack` | actions | none | allowed; with M off "It's back" only records `backAt` (no message) and says "Recorded. Messages are off: call the customer." |
| `src/actions/consent.ts` (all, incl. `markReplyHandled`) | actions | none | always allowed: consent and opt-out records are the law's, not the module's |
| `classes.ts` `messageClass`, the `tell` part of `enroll`, `moveUp`, `saveMeeting`, `cancelMeeting`, `setClassStatus`; `appointments.ts` `tell` in `book`, `rescheduleAppt`, `setApptStatus` | actions | M for the message part | the action works (S); the message part is refused with "Messages are off; call them." listed with phone numbers |
| `/u/[token]`, `POST /api/u/[token]` | public | none | always works (CAN-SPAM: opt-out must work 30 days after the last send) |
| `/e/[token]`, `POST /api/e/[token]` | public | none for existing links | an unexpired, unrevoked link still shows and can be answered; new links need M |
| `/consent/[customerId]`, `/customers/consent-form` | pages | none | consent can always be recorded |
| customer page `CustomerMessages` | component | M gate | hidden when M is hidden; readonly shows history + consent + the opt-out form |
| `NotifyByField` in customer form / intake forms | component | M gate | shown unless M is hidden (the preference is kept either way); required only when M is on and a channel is ready |
| `onTicketStatus`, `onJobStatus`, `onJobsBack` (hooks) | hooks | M (`ctx.marketing`) | queue nothing (cancelling queued rows still happens) |
| `runSchedulers` (reminders, uncollected notices, service due, review, bags due), `buildCampaigns` | worker | M (`shopsWith`) | skipped for the shop |
| worker steps 1-3 (recover, tidy, read replies and delivery results) | worker | none | run for every shop |
| worker steps 5-8 (paused checks, campaigns, schedulers, send) | worker | M | shop skipped; its queued rows stay `QUEUED` (held) |
| ticket/job notice slots: uncollected-machine schedule; `TodoLinesSlot` "Is it here?" and "notices to send by hand" lines | slots | none for the dates | always show the dates each notice is (or was) due; with M off each due stage says "Due {date}: send it by hand (Messages is off)" with the manual-record form |
| CSV exports `messages`, `consent`, `campaigns`, `classes`, `appointments`, `shifts` | route | none (TECH 403 as today) | always exportable |

---

## 7. Shared files, hooks and slots: how packages stay disjoint

Foundation makes every edit to an existing shared file that more than one feature needs, and creates small stub files
whose OWNERSHIP then passes to one feature package. A feature package replaces the whole body of the stubs it owns and
must keep the exported names and prop types exactly as below.

### 7.1 Hook stubs (`src/lib/notices/hooks.ts`, owner after foundation: `notices`)

```ts
import "server-only";
import type { Prisma, OutMessage } from "@/generated/prisma/client";
import type { TicketStatus } from "@/generated/prisma/enums";
import type { TicketForStatus } from "@/lib/ticket-status";
import type { HookCtx } from "@/lib/notices/context";
type Tx = Prisma.TransactionClient;
export type JobForHook = { id: string; shopId: string; linkId: string; customerId: string | null; status: string;
  backAt: Date | null; pickedUpAt: Date | null };

/** Inside the transaction that changed a ticket's status (only when it really changed). Returns the line for the
 *  staff toast ("A text goes to Mary Smith at 10:44 am...") or null. Never opens another connection: use tx and ctx. */
export async function onTicketStatus(tx: Tx, t: TicketForStatus, status: TicketStatus, at: Date, ctx: HookCtx): Promise<string | null> { return null; }
/** Retail side, inside the transaction that applied a partner's job.update whose status changed. */
export async function onJobStatus(tx: Tx, job: JobForHook, status: string, at: Date, ctx: HookCtx): Promise<void> {}
/** Retail side: these jobs are back at our counter (a run's delivered list, "It's back"). `backAt` is already set. */
export async function onJobsBack(tx: Tx, shopId: string, jobIds: string[], at: Date, byUserId: string | null, ctx: HookCtx): Promise<string | null> { return null; }
/** Worker, right before sending: a reason to cancel ("The machine was picked up"), or null to send. */
export async function stillWanted(row: OutMessage): Promise<string | null> { return null; }
```

`src/lib/notices/scheduler.ts` (owner: `notices`): `export async function runSchedulers(now: Date, shopIds: string[]):
Promise<void> {}`. `src/lib/messaging/campaign-build.ts` (owner: `campaigns`): `export async function
buildCampaigns(now: Date, shopIds: string[]): Promise<void> {}`. `src/actions/class-register.ts` (owner: `classes`,
`"use server"`): `export async function openClassSeats(): Promise<{ id: string; title: string; firstAt: Date | null;
seatsLeft: number; feeCents: number }[]> { return []; }` and `export async function enrollAtRegister(classId: string, fd:
FormData): Promise<BookingDue | { error: string }> { return { error: "Coming in this update." }; }`.

### 7.2 Where foundation calls them (and the other existing-code edits)

1. `src/lib/ticket-status.ts` `changeTicketStatus()` -> `onTicketStatus` (only when the status changed).
2. `src/actions/tickets.ts` `setStatus` becomes a data action (not `safe`), keeping modules-foundation's
   `ownTicket(user.shopId, ticketId, CLOSING_STATUSES.includes(status) ? "close" : "work")` and SITE status check in
   front:

   ```ts
   export async function setStatus(ticketId: string, status: TicketStatus): Promise<{ ok: true; note?: string } | { error: string }> {
     try {
       const user = await requireUser();
       if (!STATUS_ORDER.includes(status)) throw new UserError("Unknown status.");
       const t = await ownTicket(user.shopId, ticketId, ...);              // + the SITE status rule, as modules-foundation wrote it
       const ctx = await hookContext(user.shopId, user.name);           // before the transaction
       const r = await db.$transaction((tx) => changeTicketStatus(tx, t, status, new Date(), t.shop.warrantyDays, ctx));
       refresh(ticketId);
       return { ok: true, ...(r.note ? { note: r.note } : {}) };
     } catch (e) { if (isUserError(e)) return { error: e.message }; throw e; }
   }
   ```

   `createTicket`: the typed status must be one of `AT_SHOP_AWAITING_PICKUP | IN_TRUCK | ON_BENCH | WAITING_CUSTOMER_OK |
   WAITING_PARTS` (`UserError("A new ticket can't start as {label}.")`); keep modules-foundation's kind gating. When
   `needNotifyBy()` and the customer's `notifyBy` is "" the form must carry one (`customerFromForm` rule).
3. `src/components/ticket-controls.tsx` (`StatusSelect`): after `setStatus`, `r.note` ? `toast.success(r.note, {
   duration: 8000 })` : `toast.success("Status: ...")` as today.
4. `src/lib/partners.ts`, retail `case "job.update"`: `const ctx = await hookContext(shopId)` before, then the single
   `db.repairJob.update` becomes one transaction:

   ```ts
   const READYISH = ["READY_FOR_PICKUP", "READY_IN_TRUCK", "RETURNED_UNREPAIRED"];
   const reopened = status === "WAITING_CUSTOMER_OK" && job.status !== "WAITING_CUSTOMER_OK";   // a new estimate: ask again
   const leftCounter = job.backAt && !READYISH.includes(status) && status !== "COLLECTED";       // went back to the repair shop
   await db.$transaction(async (tx) => {
     await tx.repairJob.update({ where: ..., data: { ...sameDataAsToday,
       ...(reopened ? { approval: null, approvedCents: null } : {}),
       ...(leftCounter ? { backAt: null } : {}),
       events: reopened ? withEvent(events, { at: at.toISOString(), note: "New estimate: waiting for the customer's answer again" }) : events } });
     if (status !== job.status) await onJobStatus(tx, { id: job.id, shopId, linkId: link.id, customerId: job.customerId, status,
       backAt: leftCounter ? null : job.backAt, pickedUpAt: job.pickedUpAt ?? (status === "COLLECTED" ? at : null) }, status, at, ctx);
   });
   ```

   Repair side `case "job.pickedup"`: the ticket update also sets `pickupReadyAt: null`. (Imports `onJobStatus` from
   `@/lib/notices/hooks` and `hookContext` from `@/lib/notices/context`; nothing else in these cases changes.)
5. `src/actions/repair-jobs.ts` `answerEstimate`: body replaced by `answerRetailEstimate(tx, {..., via: "counter"})` in
   the same transaction shape; `false` -> `UserError("The customer's answer is already recorded (maybe by link). Reload
   the page.")`. `takeInMachine` reads `notifyBy` (required under `needNotifyBy()` for a customer not yet asked).
6. `src/auth.ts`: `clientAddress` imported from `@/lib/client-ip` (the local copy removed; behaviour identical).
7. `src/components/import-items.tsx`: `parseTable` imported from `@/lib/parse-table` (moved, unchanged).
8. The worker calls `stillWanted(row)`, `runSchedulers(now, live)` and `buildCampaigns(now, live)`.
9. The partner-runs package (not foundation) calls `onJobsBack` from its DONE handling on the retail side; the notices
   package calls it from `markBackAtCounter` / `markManyBack`.

### 7.3 Slot stubs (`src/components/slots/*.tsx`)

Each is an async server component. Foundation creates it returning `null`, inserts it into the page, and passes the
props shown. `user` is `CurrentUser`. The owning package fills it in (its own queries, all scoped by `shopId`).

| File / export | Props | Inserted by foundation at | Owner |
|---|---|---|---|
| `ticket-estimate.tsx` `TicketEstimateSlot` | `{ ticketId, user }` | `tickets/[id]/page.tsx`, left column, directly before `<Section title="Status and work">` | estimate-links |
| `ticket-notices.tsx` `TicketNoticesSlot` | `{ ticketId, user }` | `tickets/[id]/page.tsx`, right column, directly before `<Section title="Photos">` | notices |
| `job-estimate.tsx` `JobEstimateSlot` | `{ jobId, user }` | `repairs/[id]/page.tsx`, directly after the "The repair shop needs the customer's OK" section (rendered for any status; the slot decides) | estimate-links |
| `job-notices.tsx` `JobNoticesSlot` | `{ jobId, user }` | `repairs/[id]/page.tsx`, directly after the "Handing it back" section | notices |
| `job-run.tsx` `JobRunSlot` | `{ jobId, user }` | `repairs/[id]/page.tsx`, directly after `PageHeader` | partner-runs |
| `repairs-runs.tsx` `RepairsRunsSlot` | `{ user }` | `repairs/page.tsx`, directly after `PageHeader` | partner-runs |
| `repairs-back.tsx` `RepairsBackSlot` | `{ user }` | `repairs/page.tsx`, directly after `<RepairsRunsSlot>` | notices |
| `partner-runs.tsx` `PartnerRunsSlot` | `{ linkId, user }` | `partners/[id]/page.tsx`, directly before `<Section title="Machines"` | partner-runs |
| `dashboard-runs.tsx` `DashboardRunsSlot` | `{ user }` | `app/(app)/page.tsx` (repair Dashboard), directly after `<PartnerTodo .../>` | partner-runs |
| `today.tsx` `TodaySlot` | `{ user, place: "register" \| "dashboard" }` | `register/page.tsx` directly after `<PartnerTodo .../>` (`place="register"`); `app/(app)/page.tsx` after `<DashboardRunsSlot/>` (`place="dashboard"`) | appointments |
| `estimates-todo.tsx` `EstimatesTodoSlot` | `{ user }` | `app/(app)/page.tsx` after `<TodaySlot/>`; `register/page.tsx` after `<TodaySlot/>` | estimate-links |
| `todo-lines.tsx` `TodoLinesSlot` | `{ user }` | `app/(app)/page.tsx` after `<EstimatesTodoSlot/>`; `register/page.tsx` after `<EstimatesTodoSlot/>` | notices |
| `customer-classes.tsx` `CustomerClassesSlot` | `{ customerId, user }` | `customers/[id]/page.tsx`, in the grid after the Machines section | classes |
| `customer-appointments.tsx` `CustomerAppointmentsSlot` | `{ customerId, user }` | `customers/[id]/page.tsx`, after `CustomerClassesSlot` | appointments |

`CustomerMessages` (`src/components/customer-messages.tsx`) is foundation's own component, inserted after the Details
section of `customers/[id]/page.tsx`.

### 7.4 Placeholder pages

Foundation creates `src/app/(app)/calendar/page.tsx`, `classes/page.tsx`, `shifts/page.tsx`, `campaigns/page.tsx`,
`customers/import/page.tsx`, each: `requireUser()`, gate check, `<PageHeader title=.../>` and `<Empty>Coming in this
update.</Empty>`. The owning package overwrites the file.

### 7.5 Files two packages edit (all sequential: foundation first)

| File | foundation's edit | later edit |
|---|---|---|
| `src/lib/partners.ts` | `job.update` transaction, approval reset, `backAt` reset, `onJobStatus`; `job.pickedup` clears `pickupReadyAt` (7.2 #4) | partner-runs: header comment types, `FROM` entries, `applyMessage` cases, new exported functions, one `pushFeatures()` call in `doPartnerSync` (13.4) |
| `src/actions/repair-jobs.ts` | `answerEstimate` -> `answerRetailEstimate`; `takeInMachine` reads `notifyBy` | partner-runs: `cancelJob` guard (13.3) |
| `src/app/(app)/register/page.tsx` | inserts `<TodaySlot>`, `<EstimatesTodoSlot>`, `<TodoLinesSlot>` | register-bookings: `searchParams` preload (12.3) |
| the slot stubs / other stubs / placeholder pages | create | owner replaces the body |

No other existing file is edited by more than one package. `schema.prisma`, `nav.tsx`, `layout.tsx`, `settings`,
`constants.ts`, `auth.config.ts`, `auth.ts`, `proxy.ts`, the export route, `instrumentation.ts`, `desktop/*.mjs`,
`package.json`, `ticket-controls.tsx`, `customer-form.tsx`, `intake-form.tsx`, `import-items.tsx` are foundation's alone.
(`src/lib/notices/scheduler.ts` gets the `runBagsDue` line from its owner `notices`, and `src/lib/calendar.ts` the
`install` items from its owner `appointments`, as `modules-design.md` 12.4 asks; `vac-bags-due` and
`central-vac-installs` then need no shared edits here. The `bags_due` kind, labels and templates are in foundation.)

---

## 8. Foundation screens and actions (settings, consent, outbox)

### 8.1 `src/actions/messaging.ts` (`"use server"`)

All `safe()` unless noted; all `requireAdmin()` + `requireOn(user, "marketing")` unless noted. Checkboxes are
`fd.get(x) === "on"`. After a save: `revalidatePath("/settings/messages", "layout")`, `revalidatePath("/messages")`.

| Action | Inputs | Validation and UserError messages |
|---|---|---|
| `saveEmailSettings(fd)` | `emailOn, smtpPreset, smtpHost, smtpPort, smtpSecurity (starttls\|tls\|none), smtpUser, smtpPass, forgetPass, fromName, fromEmail, replyTo, replyWatched, skipCheck` | when `emailOn`: host required ("Enter your mail server, like smtp.gmail.com."); port 1-65535 ("Check the port: usually 587, or 465 for SSL."); `fromEmail` = `validEmail` ("Enter the address emails come from."); `replyTo` optional valid email; `replyWatched` records `replyWatchedAt/By` (cleared when `replyTo` changes); `fromName` <= 80 chars, no CR/LF ("Use a plain name, one line."); hosted rules: user and password required ("Enter the user name and password your mail provider gave you."); `checkSmtpHost()`; secrets only from the PC itself on the Windows program (4.2); blank `smtpPass` keeps the stored one, `forgetPass` clears it; then unless `skipCheck`: `allow("smtp-verify:" + shopId, 10, 3_600_000)` ("That's a lot of checks. Try again in an hour."), `verifySmtp()`, failure -> UserError with the plain `SendError` message + " Nothing was saved. Tick 'Save without checking' if you're offline." Saving clears the pause fields. Upsert `MessagingSettings`. |
| `saveTextSettings(fd)` | `smsOn, twilioSid, twilioKeySid, twilioToken, forgetToken, twilioFrom, skipCheck` | when `smsOn`: `tzConfirmedAt` set ("Check the shop's time zone first (just below)."); SID `/^AC[0-9a-f]{32}$/i` ("The Account SID starts with AC and is 34 characters. Find it on your Twilio console's front page."); key SID blank or `/^SK[0-9a-f]{32}$/i` ("An API key SID starts with SK."); token/secret required unless saved ("Enter the Auth Token, or the API key's secret."); `twilioFrom` passes `toE164` ("Enter your Twilio number like (555) 123-4567."); secrets only from the PC itself on the Windows program; unless `skipCheck`: `checkTwilio()` (rate-limited like email), 401 -> "Twilio said the SID or the token / secret is wrong." Clears the pause fields. Help text recommends an API key ("Twilio console -> API keys -> Standard key") over the Auth Token. |
| `confirmTimeZone(fd)` | `timeZone` | a valid IANA zone (the check `src/actions/settings.ts` `validTimeZone` does: `new Intl.DateTimeFormat("en-US", { timeZone })` must not throw; same message); updates `Shop.timeZone` when different; sets `tzConfirmedAt`, `tzConfirmedBy`. |
| `saveMessageRules(fd)` | `postalAddress, quietStart, quietEnd, noSundayMarketing, emailDailyCap, smsDailyCap, smsPartMills, smsConsentText` | `parseHm`; both within 08:00-21:00 and start < end ("Texts can only go out between 8:00 am and 9:00 pm."); caps 1-5000; part price 1-1000; consent wording <= 1000 chars, must contain the shop name, "STOP" and "not a condition" ("The wording must name the shop, say consent is not a condition of purchase, and tell people they can reply STOP."). A changed wording pushes the old one onto `consentTexts` as `{ code, text, from, to: now }`. |
| `saveAutoMessages(fd)` | `readyNotice, reminders, reminderHour, abandonNotices, abandonDays, finalNoticeDays, serviceDue, serviceDueMonths, reviewRequest, reviewUrl, reviewDelayHours, reviewEveryDays, reviewAfterSales, estimateLinkDays` | `reminderHour` 8-20; `abandonDays` "7, 30" -> 1-4 ascending whole numbers 1-365 ("List the days after 'ready' like 7, 30."); `finalNoticeDays` 1-60; `serviceDueMonths` 3-60; switching `serviceDue` on sets `serviceDueSince = now` (off -> null); `reviewUrl` required `https://` when `reviewRequest` ("Paste your Google review link (it starts with https://)."); delay 1-168 h; every 30-3650 days; link days 1-30. |
| `saveTemplate(key, fd)` / `resetTemplate(key)` | `text` | key in `TEMPLATE_KEYS` ("Unknown message."); lengths (text 480, email 5000, subject 150); subject no CR/LF; `checkTemplate` with the kind's fields; `plainText`. |
| `sendTestMessage(fd)` | `channel, to, sample?` | NOT `safe`: returns `{ ok: true; detail: string } \| { error: string }`. `to` must be the signed-in user's own login email, `fromEmail` or `replyTo` (email; a select) or one of `testPhones` (text; "Add your mobile number as a test number first."); texts only inside the quiet-hours window ("Texts can only go out between 9:00 am and 8:00 pm."); `allow("test:" + shopId, 10, 3_600_000)` ("That's a lot of tests. Try again in an hour."); `sample` = a template key rendered with `SAMPLE_VARS`, else a fixed test line; `queueToAddress(kind "test", status "SENDING")` then `sendOneNow(id)`; returns "Sent to ... (Message-ID ...)" or the plain error. Works when the channel is paused (it is how the shop checks a fix). |
| `addTestPhone(fd)` / `confirmTestPhone(fd)` / `removeTestPhone(phone)` | `phone` / `code` | add: `toE164`, at most 5 numbers ("Five test numbers at most."), `allow("testcode:" + shopId, 5, 3_600_000)`; texts "{Shop}: your StitchBench test code is 123456" straight through `sendText` (not the queue), stores `testPhonePending`, `testCodeHash` (sha256), `testCodeUntil` (+10 min). confirm: matches and not expired ("That code isn't right, or it's more than 10 minutes old."), appends to `testPhones`. remove: no module check. |
| `runMessagesNow()` | - | admin; `allow("run:" + user.id, 6, 60_000)`; `messageRun({ forceSchedulers: true })`; `{ busy: true }` -> "Messages are being sent right now. Try again in a minute."; `{ off: true }` -> "Messages are switched off on this server (MESSAGES=off)." Shown under a "Troubleshooting" `<details>` on `/messages`. |
| `retryMessage(id)` | - | own row (`findFirst { id, shopId }`, "Message not found."); status FAILED; rows failed as "may have gone out" need `fd.confirm === "on"`; sets QUEUED, `retryTries 0`, `nextTryAt null`, `sendAfter now`, `error null`. |
| `cancelMessage(id)` | - | `requireUser()` (no module check); own QUEUED row; kind `abandon` needs `requireAdmin()` ("Only an owner or admin can stop an uncollected-machine notice: it's your proof of notice."); -> CANCELLED, `cancelledById`, error "Cancelled by {name}". |
| `releaseHeld()` / `cancelHeld()` | - | stale marketing rows (older than 48 h) of this shop -> `sendAfter = now` / CANCELLED. `cancelHeld` has no module check. |
| `releaseMarketingHold(fd)` / `releaseTextHold(fd)` | `checked` | the tick "I've checked Messages -> Opt-outs (and my mailbox) for opt-outs recorded since the backup" / "I've read the latest replies in the Twilio console" required; clears `marketingHoldAt` / `textHoldAt` (+ `inboundIncomplete = 0`). |

### 8.2 `src/actions/consent.ts` (`"use server"`, `safe()`, `requireUser()`, never module-gated)

| Action | Inputs | Rules |
|---|---|---|
| `setNotifyBy(customerId, fd)` | `notifyBy` in `"" email sms both none`, `source` (`customer_page` \| `ticket`) | own customer ("Customer not found."); ConsentEvent `notify_pref`. Used by the ticket / job "They said: ..." buttons (9.5); the customer page edits it only through `CustomerForm`. |
| `recordTextConsent(customerId, fd)` | `source` (`paper_form` \| `tablet`), `signedName` (tablet), `signedOn` + `code` (paper), `agree` | RETAIL only ("Trade accounts get no marketing texts."); `toE164(customer.phone)` required ("Add their mobile number first."); US number ("Marketing texts go only to US numbers."); number not suppressed for sms ("They replied STOP. They must text START to your number first."); tablet: `signedName` 2-80 chars and `agree` ("Tick the box and type your name."); paper: `signedOn` YYYY-MM-DD not in the future, `code` equal to `consentCode` of the current wording or of one in `consentTexts` ("That code isn't on any of your consent forms. It's printed at the bottom of the form."). Writes `smsConsentAt` (tablet: now; paper: `dayStart(signedOn)` + 12 h), `smsConsentPhone`, `smsConsentSource`, `smsConsentText` = that wording + "\nSigned: {name}" / "\nPaper form dated {date}, code {code}", ConsentEvent `marketing_yes` with the same detail, `byUserId`; then `queueToAddress(kind "consent_confirm", channel "sms", address, customerId, dedupe "consent:{customerId}:{at ms}")`. |
| `withdrawTextConsent(customerId, fd)` | `detail` | clears the four fields; ConsentEvent `marketing_no`. |
| `recordOptOut(fd)` | `customerId?`, `channel`, `address?`, `code?`, `scope` (`marketing` \| `all`; sms is always `all`), `source`, `detail` | `code` (a pasted "unsubscribe ..." subject, link or token) -> `addressForOptOutCode` ("That code isn't from one of your emails."); else address from the customer when not typed; `validEmail` / `toE164` ("Enter the email address or mobile number."); `suppress()`. |
| `removeOptOut(fd)` | `channel, address, detail` | `requireAdmin()`; `detail` required ("Say how they asked to get messages again (for the record)."); sms: only if the customer texted START since (an `InboundText` with keyword START after the suppression) or `detail` mentions a signed form ("For texts, they must text START to your number, or sign the form again."); `unsuppress()`. |
| `markReplyHandled(sid)` | - | own `InboundText` (`shopId_sid`); sets `handledAt`, `handledBy`. |

### 8.3 Pages (foundation)

| URL | Who | What's on it |
|---|---|---|
| `/settings` (edit) | admins | a new `Section title="Messages"`: status line per channel and a link "Email and text settings" -> `/settings/messages` (only when M is not hidden). |
| `/settings/messages` (Setup) | everyone views status; admins edit | `PageHeader` "Email and text messages", back to Settings; `MessagingTabs`. **Email**: provider select (`SMTP_PRESETS`, fills host / port / security and shows the provider's help), the SMTP form, "Someone reads this mailbox at least once a week" next to Reply-to, "Save without checking"; **Texts**: time zone check ("It's 3:14 pm in America/New_York. Is that your shop's time? [Yes] / pick another"; the Windows program also offers the PC's zone when different), Twilio form (API key recommended), "Registering your number" box (why, the sample messages built from the current templates and consent wording with copy buttons, "Most US shops pay a one-time brand fee and a small monthly campaign fee; texts cost about {smsPartMills} tenths of a cent per part"), test numbers (add / confirm code / remove); **Try it** (send a test email / text to own addresses right after saving); **Public address** (read-only: "Links customers can open: {PUBLIC_URL}" or "None: estimate links are off and unsubscribes come back by email reply. On the Windows program an address can be set in the program's settings file (see INSTALL.md)."). Status lines (4.2). |
| `/settings/messages/auto` | same | each automatic message: switch, its numbers, one line on who gets it and whether it counts as marketing, the wording `<details>` (section 5). |
| `/settings/messages/rules` | same | postal address (prefilled from `Shop.address` when empty), quiet hours (`type="time"`), no Sunday marketing, daily caps, text part price, consent wording with its code and a preview, earlier wordings with their codes. |
| `/messages` | everyone (M not hidden) | `MessagesTabs`. Filters (GET form): status, kind, channel, text search (address or customer name), date. Banners: module off ("Marketing is off: {n} messages are waiting and won't go out."), paused channels, stale marketing ("{n} marketing messages waited more than 2 days." + Send them / Cancel them, admins), marketing hold after a restore (+ Resume, admins), text hold (+ Release, admins), the weekly "check {replyTo} for UNSUBSCRIBE replies" line. Table (latest 200): when (shop time), to (customer link or address), kind, channel, status pill, error/why, delivery ("Not delivered: phone off or unreachable"); each row's `<details>` shows the body as stored, subject, headers it had, queued / send after / tries / next try / sent / provider id, what it's about (link to ticket / repair / campaign / class / appointment), Retry (admin, FAILED) / Cancel (QUEUED). "Troubleshooting" `<details>`: "Send now" (admin). |
| `/messages/replies` | everyone | `InboundText` latest 200, unhandled first: when, from (customer link or number), text, keyword pill, "Handled" button. Copy: "Replies to your texts. STOP, START and HELP are handled automatically. Call them back about anything else: replies can't be answered from here yet. Until you mark a reply handled, that number gets no marketing texts." |
| `/messages/opt-outs` | everyone | "Record an opt-out" form (any user; always allowed; accepts an unsubscribe code or subject); table of `Suppression` (address, channel, scope label, source, when; admin "Remove" with reason); below, the latest 300 `ConsentEvent`s (when, customer, event label, address, source, detail, by). Export link `consent` CSV. |
| `/customers/[id]` | everyone | `CustomerMessages` (M not hidden): one summary line "Told by Text · Marketing texts: agreed Oct 7, 2026 (tablet) · Email: subscribed" (or "Their number changed since they agreed: ask again", "Opted out of texts Oct 3"), then `<details>`: "Marketing texts" (Sign on the tablet -> `/consent/{id}`, Record a signed paper form (date + code), Withdraw), opt-out pills per address, "Record an opt-out", the latest 20 `OutMessage`s to them with "All messages" -> `/messages?customer=id`. How to tell them is shown read-only ("change under Details"). |
| `/consent/[customerId]` (`src/app/consent/[customerId]/page.tsx`, OUTSIDE `(app)`: no nav, no search) | any signed-in user, on the counter tablet | `requireUser()` + own customer; big type: the shop name, the customer's number `fmtPhone`, the consent wording, "I agree", "Type your name to sign", "Sign". After signing: "Thank you. Please hand the tablet back." and a staff-only "Done" button (a form posting to an action that redirects to `/customers/{id}`); no other links. |
| `/customers/consent-form` | any user | print view (the invoice layout): shop header, the current wording, lines for name, mobile number, signature, date, and "Form {code}" at the bottom; "Keep the signed form. Record it on the customer's page with this code." |
| `/customers` (add form) and `/customers/[id]` (Details) | everyone | `NotifyByField` in `CustomerForm` (create and edit): the only place it is edited. |
| `/tickets/new`, StitchShop take-in (`IntakeForm`) | everyone | `NotifyByField` under the new customer's phone/email (required radios when `needNotifyBy()`), and for an existing customer not yet asked the same required radios; asked before: "Change how we tell them" (optional select, blank = keep). |

`saveCustomer` edit (foundation, `src/actions/records.ts`): `notifyBy` is written only when `formData.has("notifyBy")`,
validated against the five values; a change adds ConsentEvent `notify_pref` (source `customer_page`). No consent field
is written by `saveCustomer`.

`createTicket` / `takeInMachine` edits: after the customer is resolved, `notifyBy` from the form (when present and
valid) is set on the customer with ConsentEvent `notify_pref` (source `intake`, `byUserId`).

### 8.4 CSV exports (foundation, `src/app/api/export/[what]/route.ts`)

New cases (same auth as today: `sessionUser()`, TECH 403, `shopId` filter):

| what | columns |
|---|---|
| `customers` (extended) | `..., notify_by, text_consent_at, text_consent_phone, text_consent_source` |
| `messages` | `created, kind, purpose, channel, to, customer, status, sent, delivery, subject, body (as stored: estimate links masked), error, provider_id, by, cancelled_by, ticket, repair_job, campaign` (latest 20 000) |
| `consent` | `at, customer, channel, event, address, source, detail, by` plus a second block `suppression: channel, address, scope, source, at` (one file, a blank line between) |
| `campaigns` | `created, name, channel, status, queued_at, recipients, sent, failed, skipped` |
| `classes` | one row per enrollment: `class, first_meeting, customer, attendee, phone, email, status, fee, paid, paid_at, refunded` |
| `appointments` | `starts, ends, type, resource, customer, phone, status, staff, fee, paid, paid_at, blocked` |
| `shifts` | `date, start, end, person, role, note` |
| `register-sales` (extended) | `..., for` = `class:<id>` / `appointment:<id>` / `repair:<id>` / "" |

---

## 9. Automatic notices (package `notices`)

### 9.1 Files

```ts
// src/lib/notices/vars.ts (server)
export async function ticketVars(tx: Db, ticketId: string, shopId: string): Promise<{ customerId: string | null; direct: boolean;
  jobType: string; vars: Record<string, string> } | null>;
// direct = customerId set && viaAccountId null && no RepairJob with this ticketId; vars: first_name, name, shop_name, shop_phone,
// machine, ref ("ticket 0123"), amount_line
export async function jobVars(tx: Db, jobId: string, shopId: string): Promise<{ customerId: string | null; vars: Record<string, string> } | null>;
// retail side only; ref = "tag 101"

// src/lib/notices/abandon.ts (pure)
export type AbandonStage = { key: "first" | "second" | "third" | "fourth" | "final"; day: number; due: Date; final: boolean };
export function abandonStages(start: Date, days: number[], abandonedAfterDays: number, finalNoticeDays: number, hour: number, tz: string): AbandonStage[];
// start day = ymdOf(start, tz); regular stage i at addDays(startDay, days[i]) (keys first..fourth), final at
// abandonedAfterDays - finalNoticeDays (dropped when <= 0); regular stages on or after the final day are dropped;
// each due = zonedTime(stageDay, hour * 60, tz)
export function abandonDate(start: Date, abandonedAfterDays: number, tz: string): Date; // start of that shop day
export function stageKey(start: Date, s: AbandonStage): string;                       // `${start.getTime()}:${s.key}` (OutMessage.refId)
export function sendable(stages: AbandonStage[], now: Date, abandonAt: Date): AbandonStage | null;
// the latest stage with due <= now, and only while now < min(due + 7 days, abandonAt); otherwise null (too late to send
// automatically: a "FINAL NOTICE ... by {a date already past}" never goes out)
```

Also owned: `src/lib/notices/hooks.ts` and `src/lib/notices/scheduler.ts` (the stubs, now implemented),
`src/actions/notices.ts`, the slots `ticket-notices.tsx`, `job-notices.tsx`, `repairs-back.tsx`, `todo-lines.tsx`, the
print pages `src/app/(app)/tickets/[id]/notice-letter/page.tsx` and `src/app/(app)/repairs/[id]/notice-letter/page.tsx`,
`src/app/u/[token]/page.tsx`, `src/app/api/u/[token]/route.ts`.

### 9.2 Ready for pickup

- `onTicketStatus(tx, t, status, at, ctx)`:
  - entering `READY_FOR_PICKUP` (then `t.pickupReadyAt === at`), the ticket is direct and not SITE (`ticketVars`),
    `ctx.marketing` and `ctx.ms.readyNotice`: `queueToCustomer(tx, { kind: "ready", channels: "preferred", dedupeKey:
    "ready:t:" + id + ":" + at.getTime(), ticketId, sendAfter: at + READY_NOTICE_DELAY_SECONDS, ms: ctx.ms, content: ch =>
    renderKind(ctx.ms, "ready", ch, vars) })`. Returns the toast line:
    - queued: "Ready. A text goes to Mary Smith at 10:44 am. Change the status back before then to stop it." ("An email",
      "A text and an email");
    - nothing queued: "Ready. No message: {reason label, lower case}. Call Mary at (555) 123-4567.";
    - not direct, SITE, Marketing off or the switch off: null.
  - leaving `READY_FOR_PICKUP` (any other status): `tx.outMessage.updateMany({ where: { shopId, ticketId, status: "QUEUED",
    kind: { in: ["ready", "abandon"] } }, data: { status: "CANCELLED", error: "The ticket moved on before it went out" } })`.
- `onJobStatus(tx, job, status, at, ctx)` (retail side): leaving the ready states or `COLLECTED`: cancel the job's queued
  `ready` / `abandon` rows the same way. Entering a ready state sends nothing (the job shows on "Is it here?").
- `onJobsBack(tx, shopId, jobIds, at, byUserId, ctx)`: for each job (`where { shopId, id: { in: jobIds }, side: "retail" }`,
  customer set, not picked up, `backAt` set): when `ctx.marketing && ctx.ms.readyNotice`, the same queue call with dedupe
  `"ready:j:" + id + ":" + backAt.getTime()`, `repairJobId`, `sendAfter = at` (a person confirmed it is here: no delay).
  Returns "Recorded. Texts go to 2 customers now; 1 has no mobile number or email: call them." or null.
- `markBackAtCounter(jobId)` and `markManyBack(fd)` (`jobIds[]`, at most 100) in `src/actions/notices.ts` (`safe`, any user, no
  module check): own retail jobs (`{ shopId, id, side: "retail" }`), status `READY_FOR_PICKUP`, `READY_IN_TRUCK` or
  `RETURNED_UNREPAIRED`, not picked up ("It isn't back from the repair shop yet."), `backAt` null ("Already recorded.");
  `ctx = hookContext(...)` first, then one transaction: `backAt = now`, a job event "Back at the counter ({name})",
  `onJobsBack`. Buttons: "It's back at the counter: tell the customer" (M on) / "It's back at the counter" (M off).

### 9.3 Scheduler (`runSchedulers(now, shopIds)`)

Per shop, in its own try/catch (an error is logged with `console.error` and the next shop goes on). `ms =
messagingView(shopId)`; `tz = shop.timeZone`; `today = ymdOf(now, tz)`. Every queue call uses the dedupe keys below, so
running twice (two servers, a restart) queues nothing new. Work per shop per run is capped at 200 new rows.

1. **Reminders** (`ms.reminders`). Window: class meetings and appointments starting in `[now + 2 h,
   dayStart(addDays(today, 2)))`. `sendAfter` = `max(now, zonedTime(today, reminderHour * 60))` for tomorrow's items,
   `now` for today's (the day before was missed: PC off, closed on Sunday); `notAfter = startsAt - 2 h`. Skipped when the
   sign-up / booking was made less than 24 h before the start (staff just told them; the confirmation went out).
   - Class meetings (`cancelled = false`, class not CANCELLED; `ShopClass.remind`: `every`, `first` = only the class's
     first non-cancelled meeting, `never`) x enrollments `ENROLLED` with a customer: kind `reminder`, `refType
     "meeting"`, `refId meetingId`, dedupe `remind:m:{meetingId}:{enrollmentId}:{startsAt ms}` (a moved meeting gets a
     fresh reminder); vars `what` = class title (+ " (meeting 2 of 4)" when several; + " for {attendee}" when set),
     `when`, `location_line`, `supplies_line`.
   - Appointments `BOOKED`, not `blocked`, with a customer: `refType "appointment"`, dedupe `remind:a:{id}:{startsAt ms}`;
     `what` = the title.
2. **Uncollected-machine notices** (`ms.abandonNotices`).
   - Tickets: direct, not SITE, `READY_FOR_PICKUP`, `pickupReadyAt` set: `start = pickupReadyAt`,
     `abandonedAfterDays = shop.abandonedAfterDays`.
   - Retail jobs: `side "retail"`, customer set, `pickedUpAt` null, `backAt` set: `start = backAt`, `abandonedAfterDays =
     link.terms.abandonedAfterDays ?? shop.abandonedAfterDays`.
   - `stages = abandonStages(start, ms.abandonDays, abandonedAfterDays, ms.finalNoticeDays, ms.reminderHour, tz)`;
     `s = sendable(stages, now, abandonDate(...))`. Nothing when `s` is null or when any `OutMessage { shopId,
     ticketId | repairJobId, kind: "abandon", refType: "stage", refId: stageKey(start, s) }` exists (any status, sent
     by the worker or recorded by hand). Otherwise queue kind `abandon`, template `abandon_final` when `s.final` else
     `abandon`, channels `"every"`, `recordSkipped: true`, dedupe `abandon:{t|j}:{id}:{stageKey}`, `refType "stage"`,
     `refId stageKey`.
   - Vars: `ready_date` = `fmtDay(start)`, `abandon_date` = `fmtDay(abandonDate(...))`, `storage_fee` =
     `money(shop.storageFeeCents)`.
3. **Service due** (`ms.serviceDue`, once per shop-day: skipped when `ms.serviceDueDay === today`; sets it at the end).
   `machinesDue(shopId, ms.serviceDueMonths, now, { dueSince: max(ms.serviceDueSince, now - 60 days) })`, then drop
   machines whose `noticedFor` equals `lastServiceAt`, machines whose equipment module isn't active (`canWorkOn(shopId,
   equipment)` from the modules package) and SITE tickets. Group by customer: one message per customer listing their
   machines (`machine` = "Janome MC6700P and Singer 401A"; `months` = whole months since the most recent of those
   services). At most 50 customers a day (count today's `service_due` rows with status QUEUED, SENDING or SENT; the rest
   are still due tomorrow). Queue kind `service_due`, channels `"one"`, dedupe `svc:{customerId}:{today}`, `refType
   "machine"`, `refId` = the first machine id; in the same transaction set `Machine.serviceNoticeFor = lastServiceAt`
   for every listed machine (also when every channel was skipped, so a customer without consent isn't re-checked every
   day; machines due before the switch was turned on go through the `service_due` campaign audience instead).
4. **Review requests** (`ms.reviewRequest && ms.reviewUrl`). Candidates with the moment in `[now - delay - 48 h, now -
   delay]` (delay = `reviewDelayHours`): direct BENCH tickets `COLLECTED` by `closedAt`; retail jobs `COLLECTED` by
   `pickedUpAt`; when `reviewAfterSales`, `Sale` `COMPLETED` with `customerId` by `createdAt` (not all-return sales:
   `totalCents > 0`). One per customer per run. Skip customers with `lastReviewAskAt > now - reviewEveryDays`. Queue
   kind `review`, channels `"one"`, dedupe `review:{customerId}:{today}`; when something was queued set
   `Customer.lastReviewAskAt = now` in the same transaction.
5. **Bags due**: last statement of `runSchedulers`: `await runBagsDue(now, shopIds);` (`import { runBagsDue } from
   "@/lib/vac/bags-due";`, modules-design 12.4 #2; the stub exists from modules-foundation).

### 9.4 `stillWanted(row)` (worker, right before sending)

Every re-read uses `{ id, shopId: row.shopId }`.

| kind | cancel reason when |
|---|---|
| ready | ticket not `READY_FOR_PICKUP` or its `pickupReadyAt` isn't the one in the dedupe key / job picked up, or its `backAt` isn't the one in the key: "It was picked up or moved on" |
| abandon | the same, or `sendable()` is no longer this stage: "A later notice replaced it" / "Too late to send: decide by hand" |
| reminder | the appointment isn't `BOOKED` or the meeting / class / enrollment is cancelled or not `ENROLLED`: "The booking changed"; its current `startsAt` differs from the `startsAt` in the dedupe key: "The time changed" |
| estimate | the link answered, revoked or expired, or the ticket / job no longer `WAITING_CUSTOMER_OK`: "The estimate was answered or changed" |
| service_due | any listed machine has a newer ticket or retail job: "The machine came back in" |
| consent_confirm | the customer's consent was withdrawn since: "Consent withdrawn" |
| others | never |

### 9.5 Slots and pages

**`TicketNoticesSlot`** (`Section title="Messages"`; on a non-direct ticket only the list):
- Messages about this ticket (`OutMessage where { shopId, ticketId }`, newest first, 20): kind, channel, when (shop
  time), status pill, reason, delivery ("Not delivered: ..."); "What was sent" `<details>` with the body (plain text). A
  `QUEUED` ready row has "Don't send" (`cancelMessage`, any user). A ready notice skipped as `not_asked` or `no_address`
  shows "They said: [Text] [Email] [Both]" (`setNotifyBy` with source `ticket`, then `sendNoticeNow({ ticketId },
  "ready")`; M on).
- When `READY_FOR_PICKUP`: "If it isn't picked up": one row per stage: label, due date, and one of "Sent by text Oct 3,
  10:02 am" (+ the words) / "Waiting to go out" / "Not sent: {reason}" / "Sent but not delivered: {reason}: send it
  another way" / "Due {date}" / "Due {date}: send it by hand (Messages is off)" (M off) / "Past the notice window:
  decide by hand" / "Not sent (a later notice was due)". Then "Abandoned after {abandon_date}; storage fee {fee}" and the
  copy "Some states require a letter (often certified mail) before you can dispose of a machine. Check yours."
- "Print as a letter" per stage -> `/tickets/{id}/notice-letter?stage={key}` (print view in the invoice layout: shop
  header, date, customer name and postal address, "Re: your {machine} (ticket 0123)", the stage's email wording, ready
  date, abandon date, fee; a `no-print` form "Mailed today" / "Sent by certified mail, tracking number ..." that calls
  `recordManualNotice`).
- "Record a notice given by hand" (`<details>`): stage select, how (Letter, Certified mail + tracking number, Phone call,
  Email, Text), date (default today; not in the future; at most 14 days back, older needs an admin: "Only an owner or
  admin can record a notice more than 14 days back."), what was said / sent (required, <= 5000) ->
  `recordManualNotice`. Rows recorded by hand show "Given {sentAt date} · recorded {createdAt} by {name}" whenever the
  two dates differ.
- "Send the current notice now" (admin, M on) -> `sendNoticeNow({ ticketId }, "abandon")`; "Send the ready notice again"
  (M on) -> `sendNoticeNow({ ticketId }, "ready")`.

**`JobNoticesSlot`**: the same for a retail job (by `repairJobId`; `/repairs/{id}/notice-letter`), plus the "It's back at
the counter" button while `backAt` is null.

**`RepairsBackSlot`** (`/repairs`): "Marked ready by the repair shop. Are they here?": retail jobs of this shop, status
`READY_FOR_PICKUP` / `READY_IN_TRUCK` / `RETURNED_UNREPAIRED`, `backAt` null, not picked up; a checkbox per row (tag,
customer, machine, partner, since) and "These are back: tell the customers" (M on) / "These are back" -> `markManyBack`.
Nothing when the list is empty.

**`TodoLinesSlot`** (Dashboard and register, `PartnerTodo` styling), each line only when it applies:
- "Tag 101: {partner} marked it ready. Is it here? [It's here: tell the customer]" (up to 5, then "and 3 more on
  Repairs");
- "{n} new text replies" -> `/messages/replies` (M not hidden);
- "{n} messages didn't go out this week" -> `/messages?status=FAILED` (M not hidden);
- "Email paused: {reason}" / "Texts paused: {reason}" -> `/settings/messages` (admins);
- "Marketing is on hold since the backup was restored: check Opt-outs, then Resume" -> `/messages` (admins);
- "{n} uncollected-machine notices to send by hand" with a `<details>` list: direct tickets / retail jobs whose latest due
  stage has no SENT (and delivered, for texts) row, whether it was skipped, failed, undelivered, past its window, or
  Marketing is off.

`src/actions/notices.ts` (`safe`, `requireUser()`):
- `recordManualNotice(target: { ticketId?: string; jobId?: string }, fd)`: own ticket/job; creates `OutMessage { channel:
  letter|certified_mail|phone|email|sms, purpose "notice", kind "abandon", status "SENT", sentAt = dayStart(date)+12h,
  address = what the customer's record had for that channel or "by hand", body = text, providerId = tracking number
  (certified mail: required, "Enter the tracking number."), byUserId, dedupeKey = null, ticketId/repairJobId, refType
  "stage", refId = stageKey }`. No module check.
- `sendNoticeNow(target, kind: "ready" | "abandon")`: M requireOn; `abandon` needs `requireAdmin()`; `allow("notice:" +
  target id, 5, 3_600_000)`; the staff cap (3 per address per 24 h); queues now with dedupe `manual:{kind}:{id}:{Date.now()}`,
  `byUserId`, and for abandon `refType "stage"`, `refId` = the current stage key.
- `markBackAtCounter`, `markManyBack`: 9.2.

### 9.6 Unsubscribe (public)

- `src/auth.config.ts` (foundation) lets `/u/` and `/e/` through without a session and without the logged-in redirect:
  `if (path.startsWith("/u/") || path.startsWith("/e/")) return true;`. `/api/*` never went through the proxy's auth.
- `GET /u/[token]` (`src/app/u/[token]/page.tsx`, outside `(app)`, `export const dynamic = "force-dynamic"`; minimal
  centred card, the app's CSS): token must match `/^[A-Za-z0-9_-]{22}$/`; `allowPublic(req-headers, "u", 60, 60_000)`;
  look up `OutMessage { optOutToken }` + its shop. Unknown: "This link isn't valid. To stop getting emails, reply to one
  of them with the word UNSUBSCRIBE." Known: "Stop marketing emails from {shop} to {j•••@gmail.com}?" and a button (a
  plain `<form method="post" action="/api/u/{token}">`). Already suppressed or `?done=1`: "Done. You won't get
  marketing emails from {shop} at {masked} any more. You'll still get messages about your own repairs and bookings."
  Never unsubscribes on GET (link scanners open links).
- `POST /api/u/[token]` (`src/app/api/u/[token]/route.ts`): `allowPublic(req, "u-post", 20, 60_000)` else 429; the same
  lookup; `suppress(tx, { channel: "email", address: row.address, scope: "marketing", source: "unsubscribe_link",
  customerId: row.customerId })` (idempotent). Response: body `List-Unsubscribe=One-Click` (RFC 8058, from a mail
  client) -> `200 "Unsubscribed."`; otherwise `303` to `/u/{token}?done=1`. Unknown token -> `303` to `/u/{token}`.
  `GET /api/u/[token]` -> `303` to `/u/{token}`.
- No module check anywhere here; works while the shop's module is off.

---

## 10. Estimate approval by link (package `estimate-links`)

### 10.1 Rules

- Links only when the install has a public address: `publicBaseUrl()` non-null (hosted `PUBLIC_URL`; on the Windows
  program only when `config.json` has `publicUrl`, 2.3). Without one the slot offers "Text / email the estimate" with the
  `estimate_nolink` wording and creates no link; the customer's text replies then show on the ticket with "They
  approved" / "They declined" buttons (10.5).
- Tickets: direct ticket (`ticketVars().direct`), status `WAITING_CUSTOMER_OK`, bill total > 0. Retail jobs: side
  retail, status `WAITING_CUSTOMER_OK`, `approval` null, `totalCents > 0`, customer set. (A second estimate on a partner
  job works: foundation's `job.update` apply resets `approval` when the job re-enters `WAITING_CUSTOMER_OK`.)
- Token: `randomBytes(32).toString("base64url")` (43 chars, 256 bits). Stored: `tokenHash = sha256 hex` (lookups),
  `tokenSealed = seal(token, shopId, "estimateToken:" + linkId)` (until its messages have gone), `maskedUrl =
  `${base}/e/•••${token.slice(-4)}``. Message bodies are rendered with `estimate_link = maskedUrl`; the worker puts the
  real link in at send time (4.3 step 8.7). Expires `now + ms.estimateLinkDays` days. One live link per ticket/job:
  creating a new one sets `revokedAt` on the older unanswered ones. Revoked automatically (in `stillWanted` and on page
  load) when the ticket or job leaves `WAITING_CUSTOMER_OK`.
- The link pins what the customer saw: `totalCents` and `lines` (description + amount, tax as its own line) are copied
  into `EstimateLink` (descriptions through `cleanText`); the page shows those, never live ticket data. If the bill
  changes, staff send a new link.
- The page shows only: shop name, phone, the machine (brand model), the ref (ticket number / tag), the customer's first
  name, the lines, total, the shop's note, expiry. No address, email, phone of the customer, no other tickets.
- Limits: at most 3 estimate sends per ticket / job per shop-day (count `OutMessage kind "estimate"` rows created today
  for it: "You've sent this estimate 3 times today. Call them instead."), plus the staff cap per address.

### 10.2 `src/lib/estimate-links.ts` (server)

```ts
export type EstimateView = { shopName: string; shopPhone: string | null; firstName: string; machine: string; ref: string;
  lines: { description: string; amountCents: number }[]; totalCents: number; note: string | null; expiresAt: Date;
  state: "open" | "answered" | "expired" | "revoked"; answer: "APPROVED" | "DECLINED" | null; answeredAt: Date | null; tz: string };
export async function createEstimateLink(tx: Db, a: { shopId: string; ticketId?: string; repairJobId?: string; customerId: string;
  totalCents: number; lines: { description: string; amountCents: number }[]; note: string | null; days: number; byUserId: string }):
  Promise<{ id: string; maskedUrl: string }>;
export async function estimateByToken(token: string): Promise<{ link: EstimateLink; view: EstimateView } | null>; // format check first; lookup by hash
export async function answerByToken(token: string, answer: "APPROVED" | "DECLINED", note: string | null, from: string): Promise<"ok" | "gone">;
// `from` = `${clientAddress(req) ?? "address not known"} · ${userAgent.slice(0, 200)}`.
// hookContext(link.shopId) first, then one transaction: guarded tx.estimateLink.updateMany({ where: { id, shopId, answer: null,
// revokedAt: null, expiresAt: { gt: now } }, data: { answer, answerNote, answeredAt, answerFrom, tokenSealed: null } }); count 0 -> "gone". Then:
//   ticket ({ id, shopId }): if still WAITING_CUSTOMER_OK -> answerTicketEstimate(tx, { ..., approvedCents: link.totalCents, via: "link", ctx })
//     (APPROVED moves it to ON_BENCH through changeTicketStatus; DECLINED adds the note only, status stays so staff decide)
//   job ({ id, shopId, side: "retail" }): answerRetailEstimate(tx, { approval, approvedCents: link.totalCents, note, byName: firstName, via: "link" })
//     (guarded: false when the counter answered first) which sends job.reply to the repair shop exactly as the counter does
//   otherwise the answer is kept on the link only and the ticket/job gets an event/note "Answer by link arrived after it moved on".
// Afterwards revalidatePath(`/tickets/${id}`) or (`/repairs/${id}`), and "/", "/register", "/repairs".
export function ticketEstimateLines(t: TicketWithLines): { lines: { description: string; amountCents: number }[]; totalCents: number };
// from ticketTotals: each line's lineTotal, then "Tax" when > 0; total = tot.total
export async function repliesSince(shopId: string, phone: string | null, since: Date): Promise<InboundText[]>; // unhandled, oldest first
```

### 10.3 Actions (`src/actions/estimate-links.ts`, `safe`, `requireUser()`)

- `sendEstimate(target: "ticket" | "job", id: string, fd)`: M requireOn; inputs `email`, `sms` (checkboxes, at least one:
  "Pick email, text or both."), `note` (<= 500). Checks above ("This ticket isn't waiting for the customer's OK." /
  "There's nothing on the bill yet." / "This customer came through another shop; they call their customer." / "No
  customer on this ticket."). `ctx = hookContext()`; one transaction: create the link (when a base URL exists), then
  `queueToCustomer(tx, { kind: "estimate", channels: [chosen], content: ch => renderKind(ms, link ? "estimate" :
  "estimate_nolink", ch, vars), dedupeKey: "estimate:{linkId or Date.now()}", notAfter: link?.expiresAt ?? now + 7 d,
  refType: "estimate", refId: link?.id, ticketId | repairJobId, byUserId })`. Toast "Queued. It goes out in a moment."
  or UserError with the skip reasons joined ("Not sent: no mobile number on file; they asked for no messages.").
- `recordEstimateAnswer(target, id, fd)` (no module check; any user): `answer` APPROVED / DECLINED, `via` ("text reply" |
  "phone"), `note`; tickets -> `answerTicketEstimate`, jobs -> `answerRetailEstimate` (false -> "The answer is already
  recorded. Reload the page."); marks the customer's unhandled replies since the estimate as handled; revokes open links.
- `revokeEstimateLink(linkId)`: own link, unanswered; sets `revokedAt`, clears `tokenSealed`. No module check.

### 10.4 Public page and route

- `GET /e/[token]` (`src/app/e/[token]/page.tsx`, outside `(app)`, `force-dynamic`, `allowPublic(..., "e", 60, 60_000)`):
  unknown/bad format -> "This link isn't valid. Please call the shop." (no shop named). Otherwise the view: header
  "{shop}", "Estimate for your {machine} ({ref})", the lines table, total, the note, "This link works until {date}", the
  shop's phone as a `tel:` link. Open: two links (GET, no side effects) "Approve {total}" (btn-primary) ->
  `?step=approve` and "Decline" -> `?step=decline`. The confirm step shows "Approve {total} for your {machine}?" / "Decline
  the work on your {machine}?" with an optional "Anything to tell us?" textarea (<= 500) and one
  `<form method="post" action="/api/e/{token}">` carrying `answer`, `confirm=1`: "Yes, approve" / "Yes, decline", and
  "Back". Answered: "You approved this on Oct 7 at 2:14 pm. Thank you! We'll get to work." / "You declined. We'll call you
  about picking it up." Expired/revoked: "This link has expired. Please call {shop} at {phone}." Headers:
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` (via `export const metadata = {
  robots: { index: false } }` and the route's headers). No JavaScript needed.
- `POST /api/e/[token]` (`src/app/api/e/[token]/route.ts`): `allowPublic(req, "e-post", 10, 60_000)` else 429; form
  fields `answer` in `APPROVED|DECLINED`, `confirm === "1"` (else `303` back to the view), `note` <= 500 (`cleanText`);
  `answerByToken(token, answer, note, from)`; `303` to `/e/{token}` in every case (the page shows the result). No
  session, no module check for an existing link.

### 10.5 Slots and live refresh

- `TicketEstimateSlot`: shown when the ticket is `WAITING_CUSTOMER_OK` or has any `EstimateLink` or estimate message.
  `Section title="Customer's OK"`: the latest link's state ("Sent Oct 7, 2:10 pm by text · expires Oct 14" / "Approved by
  link Oct 7, 2:14 pm (note: ...)" / "Declined by link ..." / "Expired"), "Stop this link" (revoke); the customer's
  replies since the estimate went out (`repliesSince`) with "They approved" / "They declined" (`recordEstimateAnswer`,
  via "text reply"), and "They told us by phone: [Approved] [Declined]"; the send form: channels pre-ticked from
  `notifyBy`, a channel that can't be used disabled with its reason ("Text: no mobile number on file"), note, and a
  preview of exactly what goes out (rendered server-side with the masked link), submit "Send the estimate" / without a
  public address "Send the estimate (they call or reply)". The send form is hidden when M is off ("Messages are off:
  call {name} at {phone}."). While a link is open and the ticket waits: `<AutoRefresh seconds={20} />`
  (`src/components/auto-refresh.tsx`, `"use client"`, `router.refresh()` on an interval, paused while the tab is
  hidden), so the bench sees a link answer without reloading.
- `JobEstimateSlot`: the same for a retail job, below the existing counter answer form.
- `EstimatesTodoSlot` (Dashboard and register): "Answered by link" (links answered in the last 3 days, newest first:
  ticket number / tag + answer + time), and "Waiting on an answer": estimates sent (link or not) for tickets / jobs
  still `WAITING_CUSTOMER_OK` ("Tag 101: estimate sent by text Oct 7, no answer yet"; after 48 h "no answer in 2 days:
  call Mary at (555) 123-4567"). Nothing when both are empty.

---

## 11. Campaigns (package `campaigns`)

### 11.1 Audiences (`src/lib/messaging/audiences.ts`, server)

```ts
export type Audience =
  | { kind: "all" }                                  // every retail customer
  | { kind: "bought"; days: number }                 // bought at the register in the last N days (1-730)
  | { kind: "repairs"; days: number }                // a repair finished in the last N days (direct tickets COLLECTED, retail jobs COLLECTED)
  | { kind: "service_due"; months: number }           // machines last serviced more than N months ago (3-60): machinesDue() with no dueSince
  | { kind: "class"; classId: string }               // signed up (or waiting) for this class
  | { kind: "classes"; days: number };               // came to any class in the last N days
export function parseAudience(fd: FormData): Audience;          // UserError("Pick who gets it.") etc.
export function describeAudience(a: Audience, names?: { className?: string }): string; // "Everyone who bought something in the last 90 days"
export async function audienceMembers(shopId: string, a: Audience, now: Date): Promise<{ customerId: string; machine?: string }[]>;
// RETAIL customers of this shop only (trade accounts never); de-duplicated by customer; service_due carries the machine names
export async function previewCampaign(shopId: string, c: Campaign, now: Date): Promise<{ members: number; allowed: number;
  skipped: Record<SkipReason | "same_address", number>; parts?: number; days: number; startsAt: Date; sample: { subject?: string; body: string } }>;
// consentState + allowed() for each member, addresses de-duplicated; the sample rendered with SAMPLE_VARS and finalize();
// days = ceil(allowed / cap); startsAt = now, or for texts nextTextTime(now, tz, rules, true, "+12025550100")
```

Available audiences depend on what the shop does: `repairs`/`service_due` need `doesRepair` or retail partner jobs;
`bought`, `class`, `classes` need `sellsRetail`.

`src/lib/messaging/campaign-build.ts` (`buildCampaigns(now, shopIds)`, the stub the worker calls): for each `QUEUING`
campaign of those shops, oldest first: the next up to 500 of `members` (from `built`), `consentState` + `allowed()`
each, render with the member's vars (`first_name`, `name`, `machine`, `upcoming_classes` computed once per batch),
`finalize()` with per-row `unsubscribeParts` for email, and `createMany({ skipDuplicates: true })` rows `{ purpose
"marketing", kind "campaign", campaignId, customerId, address, subject, body, optOutToken, sendAfter: now, dedupeKey:
"campaign:{id}:{channel}:{address}" }` (a couple sharing an address gets it once). Updates `built`, `recipients`
(inserted), `skipped` (merged, duplicates counted as `same_address`); when `built === members.length` -> `SENDING`.
Stops for the run after 10 s. A campaign `CANCELLED` meanwhile is left alone.

### 11.2 Actions (`src/actions/campaigns.ts`, `requireAdmin()` + `requireOn(user, "marketing")` unless noted)

| Action | Rules |
|---|---|
| `saveCampaign(id \| null, fd)` (`safe`) | DRAFT only ("This campaign has already gone out. Copy it to send again."); `name` 1-120; `channel` email\|sms (fixed after the first save); email: `subject` 1-150, no CR/LF, not `^(re\|fw\|fwd):` ("Don't start the subject with RE: or FW: unless it's a real reply."), body 1-5000; sms: body 1-480 through `plainText` and `smsParts(finalized) <= 4` ("That's more than 4 text parts. Shorten it."); `checkTemplate(body, FIELDS.campaign)`; `audience = parseAudience(fd)`; new -> redirect `/campaigns/{id}`. |
| `sendCampaignTest(id, fd)` (data, not `safe`) | `to` = the admin's own addresses / `testPhones` (as `sendTestMessage`); texts only inside quiet hours; `allow("test:" + shopId, 10, 3_600_000)`; always rendered with `SAMPLE_VARS` (never a real customer's details), subject prefixed "[Test] ", `queueToAddress(kind "test", status "SENDING")` + `sendOneNow`. |
| `queueCampaign(id, fd)` (`safe`) | DRAFT; `confirm` must equal the current allowed count ("The list changed: it's now 415 people. Check and tap again."); email needs `postalAddress ?? shop.address` ("Add the shop's postal address in Settings -> Messages. Marketing email must show it."), `emailReady`, and without a public address a watched reply-to (3.3); sms needs `smsReady` ("Texts aren't set up yet."); no `marketingHoldAt` ("Marketing is on hold since the backup was restored. Resume it on Messages first."), no `textHoldAt` for texts; at most 3 campaigns started per shop-day ("You've sent 3 campaigns today. Try again tomorrow."); members <= 5000 ("That's more than 5000 people. Narrow it down."); `days > 7` -> "That would take more than a week at your limit of {cap} a day. Narrow it down, or raise the limit in Settings -> Messages -> Rules."; zero allowed -> "Nobody in that group can get it (see why above)." Stores `members` (customer ids), `built 0`, `status "QUEUING"`, `queuedAt`, `queuedById`; `kickMessages()`. |
| `cancelCampaign(id)` (`safe`, `requireAdmin()` only) | QUEUING/SENDING -> CANCELLED; its QUEUED rows -> CANCELLED ("Campaign cancelled"). |
| `copyCampaign(id)` (`safe`) | new DRAFT with the same name + " (copy)", channel, subject, body, audience. |
| `deleteCampaign(id)` (`safe`) | DRAFT only ("Only drafts can be deleted. Sent campaigns stay as your record."). |

`src/actions/customer-import.ts`: `importCustomers(rows: { name: string; email?: string; phone?: string; unsubscribed?:
string }[])` (data action, `requireAdmin()` + M): at most 5000 rows ("Import at most 5000 at a time."); each row needs a
name and a valid email or phone ("Row {n}: needs a name and an email or phone." collected, not thrown); matches an
existing customer of this shop by `validEmail` or `toE164(phone)` (fills a missing email / phone, never overwrites);
else creates a RETAIL customer; `unsubscribed` in `yes|y|true|1|x` -> `suppress(email, marketing, source "import")`;
never records text consent. Returns `{ added, matched, unsubscribed, problems: string[] }`.

### 11.3 Pages

| URL | Who | What's on it |
|---|---|---|
| `/campaigns` | everyone (M not hidden); admins act | `MessagesTabs` active "campaigns"; "New campaign" and "Bring in your email list" (-> `/customers/import`) for admins; table: name, channel, audience, status pill, when, recipients, sent / not sent counts. |
| `/campaigns/new` | admins | `CampaignForm` (client): name, channel radio, audience picker (kind select + its number / class select), subject, body textarea with the merge fields listed and an insert-field select, live `SmsCounter` for texts ("2 parts. Every text also gets '{Shop}: ' in front and ' Reply STOP to opt out.' at the end."). |
| `/campaigns/[id]` | everyone views; admins act | DRAFT: the form; the check, rendered on every load (`previewCampaign`): "412 people will get it. Not sending to: 37 unsubscribed, 120 haven't agreed to texts, ..."; the sample exactly as it will look; texts: "412 texts x 2 parts ≈ $9.06" (from `smsPartMills`); "Goes out over 2 days (300 a day, your limit)"; texts outside the window: "Texts can't go out now. They start Mon 12:00 pm."; "Send me a test"; "Send now" as a two-tap button (`src/components/two-tap-button.tsx`: first tap turns into "Tap again to send to 412 people", posts `confirm=412`). After queueing: status, progress (getting ready / waiting / sent / not sent / skipped counts by reason), recipients table (latest 500, status and reason), "Cancel what hasn't gone out", "Copy". Copy on the page: "Only send this to people who expect to hear from you. Everyone can unsubscribe; that's the law." |
| `/customers/import` | admins (M) | `CustomerImport` (client): paste cells or open a CSV (`parseTable`), columns name / email / phone / unsubscribed, a preview of the first 20 rows, "Import"; the result counts and problems. Copy: "Only bring in people who bought from you or asked to hear from you. Texts need their own signed consent; importing never gives it." |

---

## 12. Scheduling

All pages below: `requireUser()` and the `gateFor(shopId, "scheduling")` pattern (6.1). The calendar, appointments and
shifts work for any company with Scheduling; classes also need `shop.sellsRetail` (else the register's "Turn it on in
Settings" card). Every action: `requireOn(user, "scheduling")`. Times are entered as shop wall-clock (`type="date"` +
`type="time"` inputs, `rangeFromForm`) and shown with `fmtWhen` / `fmtRange` in `Shop.timeZone`. Concurrency: seat and
capacity checks run inside `db.$transaction` after `pg_advisory_xact_lock(hashtext(key))` on the relevant keys (sorted,
so two locks never deadlock):

```ts
// src/lib/lock.ts (server, foundation)
export async function lockKeys(tx: Prisma.TransactionClient, keys: string[]): Promise<void>;
// for (const k of [...new Set(keys)].sort()) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${k}))::text`;
```

A `tell` option on any scheduling action queues a notice through `queueToCustomer` (kind `class_notice` /
`booking_notice`, channels `preferred`, `byUserId`); it is ticked by default when Marketing is on and the customer has a
channel `allowed()` passes, and needs M (6.3).

### 12.1 Classes (package `classes`)

`src/lib/classes.ts` (server):

```ts
export async function seatCounts(tx: Db, classIds: string[]): Promise<Map<string, { enrolled: number; waiting: number }>>;
export async function syncClassDates(tx: Db, classId: string): Promise<void>; // firstAt/lastAt = min/max of non-cancelled meetings
export function classLine(c: { title: string; firstAt: Date | null }, tz: string): string; // "Class: Beginning Quilting, Tue, Oct 7 at 6:00 pm"
export type Repeat = "once" | "weekly" | "biweekly" | "monthly_weekday" | "monthly_date";
export function meetingDays(firstYmd: string, repeat: Repeat, count: number): string[];
// weekly / biweekly: + 7n / 14n days; monthly_weekday: the same "3rd Saturday" (or "last") each month (nthWeekdayOf / nthWeekdayIn);
// monthly_date: the same date, months without it skipped; wall clock kept, so DST never moves the time
export async function enrollIn(tx: Prisma.TransactionClient, a: { shopId: string; classId: string; customer: { id: string; name: string };
  attendee: string | null; byUserId: string; skipWaitlist: boolean }): Promise<Enrollment>;
// lockKeys(["class:" + classId]); class OPEN ("Sign-ups for this class are closed."), not over (lastAt past: "This class is over.");
// a non-cancelled row with the same customer and attendee (case-insensitive; null = the customer) -> "{name} is already signed up."
// / "{name} is already on the waiting list."; seats free and (nobody waiting or skipWaitlist) -> ENROLLED; else waitlist on ->
// WAITLIST; else "The class is full." Always a NEW row (never reuses a cancelled one). Snapshot name, attendee, feeCents, taxable.
```

`src/actions/classes.ts` (`safe`):

| Action | Role | Rules / UserError |
|---|---|---|
| `saveClass(classId \| null, fd)` | admin | title 1-120 ("Give the class a name."); teacher <= 80; location <= 120; description, supplies <= 4000; fee `toCents` 0-$100,000 ("Check the fee."); taxable; seats 1-500 ("Seats must be 1 to 500."); `remind` in every/first/never; under the class lock: lowering seats below the signed-up count: "{n} people are signed up. Keep at least {n} seats."; a new class also takes the first meeting (`rangeFromForm`), `repeat` and `count` (1-52 weekly / biweekly, 1-24 monthly) -> creates meetings, `syncClassDates`, redirect `/classes/{id}`. A fee change never re-prices existing sign-ups (the page says so). |
| `addMeetings(classId, fd)` | admin | `rangeFromForm` + `repeat` / `count` (`meetingDays`); <= 100 meetings per class ("That's more than 100 meetings."). |
| `saveMeeting(meetingId, fd)` | admin | new time; `tell` -> class_notice "{class}: the meeting on {old day} is now {new when}." |
| `cancelMeeting(meetingId, fd)` | admin | `cancelled = true`, `note`; `tell` -> class_notice "{class} on {when} is cancelled. {note}". |
| `deleteMeeting(meetingId)` | admin | only while nobody is signed up ("People are signed up. Cancel the meeting instead."). |
| `setClassStatus(classId, status, fd)` | admin | under the class lock; OPEN / CLOSED / CANCELLED; CANCELLED also cancels future meetings; `tell` -> class_notice. Page then lists who paid ("Refund at the register"). |
| `deleteClass(classId)` | admin | only with no enrollments at all ("People signed up for this class. Cancel it instead; the record stays."). |
| `enroll(classId, fd)` | any user | `customerFromForm(tx, ..., "counter", "", { notifyRequired: needNotifyBy })`; `attendee` <= 80 ("Who's coming (if not them)"); `skipWaitlist` (admin only); `enrollIn`; `tell` -> class_notice with the `class_signup` template (skipped silently when the class starts within 24 h and staff are talking to them anyway: still sent if ticked). |
| `cancelEnrollment(enrollmentId, fd)` | any user | CANCELLED, `cancelledAt`, `note`; paid and not refunded: allowed, the roster then shows "Paid {x}: refund it at the register". |
| `moveUp(enrollmentId, fd)` | any user | WAITLIST -> ENROLLED under the lock; full -> "The class is full. Add a seat or cancel someone first."; `tell` -> class_notice "Good news: a seat opened up for you in {class}, starting {when}." |
| `setEnrollmentFee(enrollmentId, fd)` | admin | unpaid rows only ("It's already paid. Refund and ring it up again."); `fee` 0-$100,000: "Price for this person". |
| `messageClass(classId, fd)` | admin, also M | `subject` (email), `body` 1-2000 (`cleanText` keeps it plain; `plainText` for texts), `waitlist` checkbox, `onlyAboutClass` required ("Tick the box to confirm it's only about this class. Promotions go in Campaigns."); `queueToCustomer` per person, kind `class_notice`, channels `preferred`, `notAfter = lastAt`, dedupe `class:{classId}:{now ms}:{enrollmentId}`, staff cap applies (those people are listed as skipped "Already 3 messages today"). |

`src/actions/class-register.ts` (the stub, now implemented, `"use server"`): `openClassSeats()` (any user; S on, else
`[]`): OPEN classes of the shop not over, with seats left, soonest first (limit 30). `enrollAtRegister(classId, fd)`
(S requireOn): `customerId` or `customerName` + `customerPhone`; `enrollIn` (never waitlisted from the register: a
full class -> "The class is full."), returns the new enrollment as a `BookingDue`.

Pages:

| URL | Who | What's on it |
|---|---|---|
| `/classes` | everyone | tabs Upcoming / Past / Cancelled (`Link.btn.btn-sm`); table: title, next meeting, meetings, teacher, seats "8 of 12 (2 waiting)", fee, status pill. "New class" (admin), "Print this month" (-> `/classes/print`). |
| `/classes/new` | admin | `ClassForm` (client): the class fields + first meeting date/start/end + repeat (once / every week / every 2 weeks / monthly on the same weekday, e.g. "3rd Saturday" / monthly on the same date) and how many times + reminders (every meeting / first only / none). |
| `/classes/[id]` | everyone; admins edit | header: title, status pill, fee, seats; actions: Edit (details), Print roster, Close / reopen sign-ups, Cancel class, Message everyone (M). Sections: **Sign someone up** (`CustomerPicker` + "Who's coming (if not them)" + tell + submit; the fee shown; "Skip the waiting list" for admins when someone waits); **Roster** (name / attendee -> customer page, phone, sign-up date, payment: "Paid, sale #1234" (link) / "Owes {fee}" + "Ring up" -> `/register?booking=enrollment:{id}` + "Price for this person" (admin) / "Refunded"; Cancel); **Waiting list** (in order; "Move up" + tell); **Meetings** (each with time, cancelled pill, edit/cancel; add form); **About** (description, supplies, teacher, location). |
| `/classes/[id]/roster` | everyone | print view: class title, teacher, meetings, table of names (attendee when set), phone, paid, and one blank attendance box per meeting. |
| `/classes/print?month=YYYY-MM` | everyone | print view for the shop window / newsletter: every OPEN class meeting in the month (title, dates, time, teacher, fee, seats left). |

Slot `CustomerClassesSlot`: the customer's enrollments (class link, next meeting, status, paid, "Ring up" when owed)
and "Sign up for a class" (select of OPEN classes with their seats left; posts `enroll` with a hidden `customerId`).

### 12.2 Appointments and the calendar (package `appointments`)

`src/lib/appointments.ts`:

```ts
export type Hours = { day: number; from: string; to: string }[];     // stored in AppointmentType.hours (one window per day)
export function hoursFromForm(fd: FormData): Hours;                    // 7 rows: `day{d}` checkbox, `from{d}`, `to{d}`
// UserError("{Tuesday}: the closing time must be after the opening time.")
export function hoursText(h: Hours): string;                           // "Tue-Sat 10:00-17:00" ("any time" when empty), for lists
export function withinHours(h: Hours, start: Date, end: Date, tz: string): boolean; // same shop day, inside that day's window; [] = true
export function freeSlots(t: { minutes: number; capacity: number; hours: Hours }, ymd: string, tz: string,
  booked: { startsAt: Date; endsAt: Date }[], step = 30): { start: Date; free: number }[];
export async function freeWeek(tx: Db, shopId: string, type: AppointmentType, fromYmd: string, tz: string, days = 7):
  Promise<{ ymd: string; starts: { start: Date; free: number }[] }[]>;   // the next 7 days' free start times
export function poolKey(shopId: string, t: { id: string; resource: string | null }): string;
// t.resource ? `res:${shopId}:${t.resource.trim().toLowerCase()}` : `appt-type:${t.id}`
export async function overlapCount(tx: Db, w: { shopId: string; resource?: string | null; typeId?: string; staffId?: string },
  start: Date, end: Date, exceptId?: string): Promise<number>;
// status BOOKED and startsAt < end and endsAt > start; by resource (case-insensitive) when the type has one, else by typeId
```

`src/lib/calendar.ts` (server):

```ts
export type CalItem = { kind: "appointment" | "class" | "run" | "shift" | "install"; id: string; start: Date; end: Date; title: string;
  sub: string | null; href: string; tone: "neutral" | "work" | "wait" | "ready" | "done" | "bad"; typeId?: string | null; struck?: boolean };
export async function calendarItems(shopId: string, from: Date, to: Date, o: { shifts: boolean }): Promise<CalItem[]>;
// appointments (not CANCELLED; blocks titled "Blocked: ...") -> /calendar/appointments/{id}; class meetings (cancelled ones struck)
// -> /classes/{classId}; PartnerRun not CANCELLED (end = endsAt ?? start + 1 h) -> /partners/{linkId}/runs/{id}; shifts when
// o.shifts -> /shifts?week=; and last: items.push(...(await siteJobsBetween(shopId, from, to)).map((s) => ({ kind: "install" as const, ...s })))
// (import { siteJobsBetween } from "@/lib/vac/installs"; modules-design 12.4 #3; it applies the vac gate itself)
```

`src/actions/appointments.ts` (`safe`):

| Action | Role | Rules / UserError |
|---|---|---|
| `saveApptType(typeId \| null, fd)` | admin | name 1-80; minutes 5-720; fee; taxable; capacity 1-20 ("How many can be booked at the same time: 1 to 20."); `resource` <= 40 (optional: "What it uses up, like Longarm"); other active types with the same resource must have the same capacity ("Other types using Longarm allow 2 at once. Use the same number."); `hoursFromForm`; location <= 120; active; sortOrder. |
| `book(fd)` | any user | type: own, active ("Pick what they're booking."); `rangeFromForm` (end defaults to start + minutes); customer via `customerFromForm` ("Pick or add the customer.") unless `block` (admin: "Block this time": `title` required "Say why, like 'Longarm maintenance'.", no customer, fee 0, `blocked true`); `staffId` optional (own active user); `ticketNo` / `tag` optional -> own ticket / retail job ("No ticket {n}."); note <= 1000; start not more than a day ago ("That time has passed."); `withinHours` unless an admin ticks "Outside the usual hours" ("{type} can be booked {hoursText}. Pick another time."); `lockKeys([poolKey(type), staffId && "staff:" + staffId])`; `overlapCount(pool) >= capacity` -> "{resource or type} is already booked then ({n} of {capacity}). Pick another time."; staff overlap -> "{staff} already has an appointment then." Snapshots `name`, `title`, `resource`, `feeCents`, `taxable`. `tell` -> booking_notice with the `booking` template. Redirect `/calendar?date={ymd}`. |
| `rescheduleAppt(id, fd)` | any user | BOOKED only ("Only booked appointments can move."); same checks excluding itself; `tell` -> booking_notice "Your {title} is now {when}." |
| `setApptStatus(id, status, fd)` | any user | BOOKED -> DONE / NO_SHOW / CANCELLED; DONE / NO_SHOW -> BOOKED (a mistake); CANCELLED is final ("Book it again instead."); cancel `tell` -> booking_notice "Your {title} on {when} is cancelled." Paid: the page shows "Paid {x}: refund it at the register". |

Pages:

| URL | Who | What's on it |
|---|---|---|
| `/calendar?view=day\|week&date=YYYY-MM-DD` | everyone | default: Day, today. `CalendarTabs` (Day / Week / Staff); date nav Previous / Today / Next as `btn` (not `btn-sm`) and a date input; "Book" (btn-primary); "Types" (admin); "Show staff" toggle. **Day**: hour rows from the earliest opening or item to the latest (default 9:00-18:00), each item a card with time range, title, customer, status pill, paid pill; one "+" per empty hour (-> `/calendar/new?date=&start=`, the form then asks the type); a "Working today" line from shifts. **Week**: 7 columns only from the `xl` width; below that one list per day; week items are one line "10:00 Longarm · Mary S." with the tone as a left border. Big tap targets, no drag and drop. |
| `/calendar/new?type=&date=&start=&customer=` | everyone | booking form: type; once a type is picked, the next 7 days' free start times as buttons ("Tue 10:00 · 12:00 · 2:00", from `freeWeek`) that fill the date and time; date and time inputs for "Another time"; `CustomerPicker`; staff; "Ticket # or tag #"; note; tell. Admin: "Block this time" (title instead of customer). |
| `/calendar/appointments/[id]` | everyone | details, status buttons, reschedule form (+ tell), fee and payment ("Paid, sale #N" / "Owes $x" + "Ring up" -> `/register?booking=appointment:{id}`), linked ticket/job, reminder and confirmation status (its `OutMessage` rows). |
| `/calendar/types` | admin (others see the list) | types table and form: name, length, fee, taxable, how many at once, what it uses up (resource), bookable hours as 7 rows (day tick + from + to), location, active, order. |

Slots: `CustomerAppointmentsSlot` (upcoming and the last 10, "Book" -> `/calendar/new?customer={id}`). `TodaySlot`:
`place="register"`: one line above the cart "Today: 2 appointments · Quilting 6 pm (8, 2 owe) · Working: Sue, Ann"
that opens (`<details>`) into the list; "owe" links to Ring up; `place="dashboard"` (repair Dashboard): a small "Today"
card (appointments such as drop-offs, runs, installs, who's working). Nothing when the gate is hidden or the day is empty.

### 12.3 Class and appointment fees at the register (package `register-bookings`)

Copies the partner-repair pattern (`completeSale`), with symmetric refunds and voids, on top of modules-foundation's
register edits (keep `const { pickedUp, discountable, tradeIn, ...row } = l;`, the `prepareUnitLines` /
`applyUnitLine` / `voidUnitLines` calls and the unit fields; modules-design 12.4 #7):

- `SaleLineInput` (`register.ts`) gains `enrollmentId?: string; appointmentId?: string`; a line with more than one of
  part / repair job / unit / trade-in / enrollment / appointment is refused ("A line can only be one thing.").
- Preload next to the repair jobs: `db.enrollment.findMany({ where: { shopId, id: { in } }, include: { shopClass: true } })`,
  `db.appointment.findMany({ where: { shopId, id: { in } } })`; missing -> "That class sign-up isn't in this shop." /
  "That appointment isn't in this shop."; the same booking twice in one sale -> "{description} is on this sale twice."
- Per line: `Math.abs(qty) === 1` ("A class or appointment is one at a time."); discount 0 (line discounts refused:
  "Change the price for this person on the class instead."); `taxable` from the booking; `description` built on the
  server (`classLine()` (+ " for {attendee}") / "{title}, {fmtWhen(startsAt)}"); `discountable: false` (outside the
  whole-sale discount, like repairs).
  - qty 1 (pay): enrollment ENROLLED ("{name} is on the waiting list or cancelled. Sign them up first.") and its class
    not CANCELLED ("{class} was cancelled. Nothing to pay."); appointment BOOKED / DONE / NO_SHOW and not blocked ("That
    appointment was cancelled."); `paidAt` null ("{description} is already paid."); `unit = feeCents`; `feeCents === 0`
    -> "Nothing to pay for {description}."
  - qty -1 (refund): `paidAt` set and `refundedAt` null ("{description} hasn't been paid here, or was refunded.");
    `unit = paidCents`; an OWNER/ADMIN may lower it (keep a cancellation fee), never raise it ("You can refund at most
    {paid}."); TECH always gets `paidCents`.
  - No module check (money already owed or paid).
- In the transaction, after `tx.saleLine.create`: the guarded `updateMany` (pay: `where { shopId, id, paidAt: null }` ->
  `paidCents = lineNet, paidAt, paidLineId`; refund: `where { shopId, id, paidAt: { not: null }, refundedAt: null }` ->
  `refundedCents = -lineNet, refundedAt, refundLineId`); count 0 -> "{description} was just {paid|refunded}. Take it off
  this sale."
- If the sale has no customer, it takes the first booking's customer.
- `voidSale`: for booking lines, inside the transaction: pay line -> `updateMany({ where: { shopId, paidLineId: l.id,
  refundedAt: null }, data: { paidAt: null, paidCents: null, paidLineId: null } })`, count 0 -> "{description} was
  refunded since this sale; void that refund first."; refund line -> `where { shopId, refundLineId: l.id }` clears the
  refund fields. Repair-line sales stay unvoidable as today.
- `bookingsDue(customerId?: string, refunds = false)` (data action, `requireUser()`, scoped): pay mode: ENROLLED
  enrollments of classes not CANCELLED and BOOKED/DONE/NO_SHOW non-blocked appointments with `paidAt` null and fee > 0,
  soonest first (limit 100); refund mode: paid, not refunded. Returns `BookingDue[]`.
- `src/components/register.tsx`: `CartLine` gains the two ids; `discountable: !l.repairJobId && !l.tradeIn &&
  !l.enrollmentId && !l.appointmentId`; a "Classes & appointments" button beside "Repair pickup" opening a picker with
  two parts: **Owed** (`bookingsDue`; return mode shows "Refund {x}") and **Sign up for a class** (`openClassSeats`:
  "Beginning Quilting · Tue Oct 7 · 3 seats left · $45"; needs the register's customer: when none is picked it says
  "Pick the customer first" and focuses the customer box, or offers name + phone fields; calls `enrollAtRegister` and
  adds the returned line); quantity, price and discount inputs disabled for these lines (an admin's refund amount is the
  one exception: price input enabled on a refund line for non-TECH); `finish()` passes the ids. Accepts a `preload?:
  BookingDue` prop: added to the cart once on mount, then `router.replace("/register")` so the next sale doesn't carry
  it.
- `src/app/(app)/register/page.tsx` (shared edit): `searchParams: Promise<{ booking?: string }>`; `booking` must match
  `/^(enrollment|appointment):[a-z0-9]{20,40}$/`; loads that one booking (scoped, unpaid) and passes `preload`.
- `src/app/(app)/register/sales/page.tsx`: by-type buckets "Classes" (`enrollmentId`) and "Appointments"
  (`appointmentId`), inserted before modules-foundation's unit buckets.

### 12.4 Staff shifts (package `shifts`)

`src/lib/shifts.ts`: `weekShifts(shopId, weekYmd, tz)`, `minutesByName(list)` (weekly totals grouped by `name`,
case-insensitive).

`src/actions/shifts.ts` (`safe`, `requireAdmin()` + S):

| Action | Rules / UserError |
|---|---|
| `saveShift(shiftId \| null, fd)` | "Who": `userId` (own active user; `name` = the user's name) or `name` 1-60 for someone without a login ("Pick someone or type a name."); `rangeFromForm` (no overnight shifts: "The end time must be after the start."); `role` <= 40; `note` <= 200; the same person (same `userId`, or the same name case-insensitive) overlapping -> "{name} already works {range} then." |
| `deleteShift(id)` | own shift. |
| `copyWeek(fd)` | `from`, `to` week starts (Sundays); target must be empty unless `replace` ("That week already has shifts. Tick 'Replace them' to copy over them."); copied by wall clock (same weekday, same times; DST safe). |

Pages: `/shifts?week=YYYY-MM-DD` (everyone views; admins edit; `CalendarTabs` active "staff"): week nav; grid people x
days (phones: one list per day), each shift "9:00-1:00 Counter", weekly hours per person, the signed-in person's row
highlighted; admin: add form ("Who" = a select of users plus "Someone else: [name]" with a datalist of names used
before), edit/delete per shift (`<details>`), "Copy last week", "Print". `/shifts/print?week=`: the grid as a print view.

---

## 13. Partner pickup runs (package `partner-runs`)

A run = one trip between a sewing shop and its partner repair shop: machines going to the repair shop (`collect`) and
fixed ones coming back (`deliver`). Same id on both sides (`PartnerRun @@id([shopId, id])`, UUID from the shop that
schedules it). **One writer per part**: the scheduling side (`ownerSide`) owns the plan (time, driver, machines, note);
the other side can OK it or cancel it; each side records only what it received (repair: `collected`, what the driver
took; retail: `delivered`, what reached its counter). So no two edits can cross. The hub needs no change: the new message
types pass its `TYPE` regex and size limit.

### 13.1 Messages

| type | from | data |
|---|---|---|
| `pickup.plan` | the run's `ownerSide` only | the whole plan `{ id, rev, ownerSide, startsAt, endsAt, driver, collect[], deliver[], note, name, at }` (creates the run or replaces the plan) |
| `pickup.ok` | the other side | `{ id, rev, name, at }` |
| `pickup.cancel` | either | `{ id, note, name, at }` |
| `pickup.done` | either | `{ id, side, list[], name, at }`: `side` must equal the sender's side; `list` = `collected` (repair) or `delivered` (retail) |
| `caps.update` | either | `{ features: string[] }`: what this install can do (`["pickup"]`) |

`FROM`: all five `"either"` (the side rules above are checked in `applyRun`). Not in `NEW_WORK`: machines in flight must
still come home after a partnership ends (actions refuse a non-empty `collect` on an ENDED link: "The partnership has
ended. Only machines coming back can go on a run.").

### 13.2 Rules (`src/lib/partner-runs.ts`, pure, safe on the client)

```ts
export type RunStatus = "SCHEDULED" | "CANCELLED" | "DONE";
export type Side = "repair" | "retail";
export type RunState = { status: RunStatus; ownerSide: Side; rev: number; okRev: number | null; collectedAt: string | null; deliveredAt: string | null };
export type RunPlan = { id: string; rev: number; ownerSide: Side; startsAt: string; endsAt: string | null; driver: Side;
  collect: string[]; deliver: string[]; note: string | null; name: string; at: string };
export type RunAction = "change" | "ok" | "cancel" | "record";
export function canDo(run: RunState | null, side: Side, action: RunAction): string | null; // null = allowed, else the UserError text
// change: side === ownerSide and SCHEDULED ("Only {the partner}, who scheduled it, can change this run. Cancel it with a note instead.")
// ok: side !== ownerSide, SCHEDULED, okRev !== rev ("You've OK'd it already.")
// cancel: SCHEDULED ("This run is {done|cancelled}.")
// record: not CANCELLED, and this side's list not yet recorded ("You've recorded this run already.")
export function planOutcome(local: RunState | null, p: RunPlan, from: Side): "create" | "update" | "ignore";
// ignore when from !== p.ownerSide, or local exists and (local.ownerSide !== p.ownerSide, or status isn't SCHEDULED, or p.rev <= local.rev)
export function receivedList(side: Side): "collected" | "delivered";   // repair -> collected, retail -> delivered
```

Apply (`applyRun` in `partners.ts`), always idempotent (replays are no-ops):
- `pickup.plan`: `planOutcome`; create or replace the plan fields and `rev`; an event "Plan changed by {name}".
- `pickup.ok`: when SCHEDULED and `rev === local.rev`: `okRev = rev`, `okAt = at` (an OK of an older plan is ignored; the
  page then shows "Changed since {partner} OK'd it").
- `pickup.cancel`: SCHEDULED -> CANCELLED (`cancelledAt`, event with the note); ignored when DONE.
- `pickup.done`: the sender's list and time are written when not yet set (the first record stands); status DONE (also
  from CANCELLED: the machines physically moved); then `runEffects` for this side (13.3).
- Limits, checked against the message's own `at` (not the time it is applied, so a replay after a restore or a long
  offline spell still applies): `startsAt` within `at - 60 days ... at + 366 days`; `endsAt >= startsAt` and `< startsAt
  + 24 h`; note <= 1000; name <= 80; lists <= 200 ids (`idOf`). Job ids are stored as a plan without checking; every
  EFFECT looks rows up with `{ shopId, linkId: link.id, side, id: { in: ids } }` (a partner can't touch another
  partnership's jobs, the `job.update` guard's rule).

Local actions write the plan with an optimistic lock (`updateMany where { shopId, id, rev: cur.rev }`, count 0 -> "The run
changed meanwhile. Reload the page.").

### 13.3 Which jobs ride, and what the hand-off does

- Collect: this link's jobs AT_SHOP_AWAITING_PICKUP (retail: `RepairJob.status`; repair: the ticket's status via
  `ticketId`). Deliver: READY_IN_TRUCK or RETURNED_UNREPAIRED not yet handed back. Default plan: every eligible job not on
  another SCHEDULED run in the same direction. One job on at most one SCHEDULED run per direction (actions: "Tag {tag}
  is already on the run on {day}."; apply only adds an event).
- Default start: the next date matching `terms.pickupDay` if it parses as a weekday name, else tomorrow, 10:00 shop time.
- `runEffects(tx, shopId, link, side, list, at, byUserId, ctx)` (in the same transaction as the run write; `ctx` from
  `hookContext()` before it):
  - the repair side's `collected`, on the repair side (recorded there): for those jobs' tickets (`{ id: job.ticketId,
    shopId }`) still AT_SHOP_AWAITING_PICKUP -> `changeTicketStatus(..., "IN_TRUCK")`. On the retail side (applied):
    nothing is written to `RepairJob.status` (the repair shop's `job.update` does that); the job shows "Handed to the
    driver {day}".
  - the retail side's `delivered`, on the retail side (recorded there): jobs with `backAt` null and not picked up ->
    `backAt = at`, event "Back at the counter (run {day})", then `onJobsBack(tx, shopId, ids, at, byUserId, ctx)` (the
    ready notice when Marketing is on). On the repair side (applied): those jobs' tickets still READY_IN_TRUCK ->
    `changeTicketStatus(..., "READY_FOR_PICKUP")`; the next `pushJobUpdates` tells the sewing shop.
- `cancelJob` (`src/actions/repair-jobs.ts`, shared edit): refuse when the job is in a run's `collected` for this link ("It
  went to the repair shop on the run of {day}. Ask them to send it back unrepaired."). Runs aren't rewritten when a job
  is cancelled: the run page shows the job's current status and it isn't offered in the hand-off list.

### 13.4 `src/lib/partners.ts` edits (this package)

- Header comment: add the five types. `FROM`: `"pickup.plan" | "pickup.ok" | "pickup.cancel" | "pickup.done" |
  "caps.update"`: `"either"`.
- `applyMessage` switch: `case "pickup.plan": case "pickup.ok": case "pickup.cancel": case "pickup.done": return
  applyRun(shopId, link, m.fromSide as Side, m.type, d, at);` and `case "caps.update":` -> `partnerLink.update({ features:
  strings(d.features).slice(0, 20) })`; when `"pickup"` is newly present, re-send every SCHEDULED run of the link that
  we own as `pickup.plan` at its current rev (an upgraded partner gets them).
- New exported functions in the file (they need the private validators and `PartnerDataError`): `applyRun`,
  `runPlan(run, name)`, `sendRun(tx, shopId, linkId, type, data)` (wraps `sendToPartner`), `runEffects(...)` (13.3),
  `pushFeatures()`.
- `pushFeatures()`: per ACTIVE link, `features = ["pickup"]` (this version supports runs, whatever the modules); send
  `caps.update` when `sha1(JSON.stringify(features)) !== link.featuresHash`, then store the hash. One line `await
  pushFeatures();` in `doPartnerSync` right after `await pushCatalogs();`.

### 13.5 Actions (`src/actions/partner-runs.ts`, `safe`, `requireUser()`, link via `partnerLink(user.shopId, linkId)`)

| Action | Gate | Rules |
|---|---|---|
| `proposeRun(linkId, fd)` | S | link ACTIVE unless collect is empty; the partner's program supports runs (`link.features.includes("pickup")`, else "{partner}'s program is an older version that can't take runs yet. Ask them to update."); `rangeFromForm`; `driver`; `collect` / `deliver` checkboxes (own eligible jobs of this link); note <= 1000; creates rev 1, SCHEDULED, `ownerSide` = our side, id `crypto.randomUUID()`; sends `pickup.plan`; redirect to the run page. |
| `changeRun(linkId, runId, fd)` | S | `canDo(change)`; same fields; rev + 1; sends `pickup.plan`. |
| `okRun(linkId, runId)` | none | `canDo(ok)`; `okRev = rev`, `okAt`; sends `pickup.ok`. |
| `cancelRun(linkId, runId, fd)` | none | `canDo(cancel)`; note (required when we aren't the owner: "Say why, so {partner} knows."); sends `pickup.cancel`. |
| `recordRun(linkId, runId, fd)` | none | `canDo(record)`; checkboxes of what we received (repair: "What the driver took", default = the collect plan; retail: "What arrived here", default = the deliver plan; only this link's jobs); writes our list, time, status DONE, event; `runEffects`; sends `pickup.done`. |

Each: `hookContext()` first, one transaction (the rev lock where it applies + `sendRun`), then `revalidatePath("/partners/"
+ linkId, "layout")`, `revalidatePath("/repairs")`, `revalidatePath("/calendar")`, `revalidatePath("/")`,
`kickPartnerSync()`.

### 13.6 UI

- `PartnerRunsSlot` (on `/partners/[id]`): `Section title="Pickup runs"`: upcoming and the last 5 runs (day, time, status
  pill `RUN_STATUS_LABEL`, going / coming back counts, who drives, "OK'd by {partner}" / "Not OK'd yet" / "Changed since
  they OK'd it"), "Schedule a run" (S on and the partner supports runs).
- `/partners/[id]/runs/new` (S) and `/partners/[id]/runs/[runId]` (both sides, no module needed to view): `RunForm`
  (client) for the owner: date, from/to times, who drives, checklists of machines going and coming back (tag, customer
  short name / ticket #, brand model), note. The run page: status, the plan with each job's current status ("not
  received yet" for unknown ids), what each side recorded, history (events), buttons per `canDo`: OK it / Change it (S) /
  Cancel / Record what the driver took / Record what arrived here.
- `partner-todo.tsx`: "Run on {day}: OK it" (not the owner, not OK'd at this rev), "Today's run: record what arrived"
  (our list not recorded), "{partner} cancelled the run on {day}: {note}" (last 3 days).
- `JobRunSlot` (`/repairs/[id]`): "Going on the run {day}" / "Coming back on the run {day}" / "Handed to the driver
  {day}". `RepairsRunsSlot` (`/repairs`): "Next run {day} {time}: {n} going, {m} coming back" + link.
  `DashboardRunsSlot` (repair Dashboard): the next 3 runs across partners.
- The calendar shows runs (12.2).

---

## 14. Hosted app vs Windows program; security

### 14.1 How each feature behaves

| Feature | Hosted (Railway, public URL, maybe several server copies) | Windows program (LAN http, no public URL, offline for days) |
|---|---|---|
| Sending email / texts | the worker every `MESSAGE_WORKER_SECONDS` (30), plus a kick 2 s after anything is queued | same; while offline rows stay QUEUED with backoff (max 10 min between tries), status "Waiting for the internet since 9:15 (12 waiting)"; nothing fails for being offline |
| Several copies | `withLease("messages")` + the per-row claim + dedupe keys: each message goes once (checked by `worker.check.ts` with two runs at once and by the two-server e2e) | one process; the same code; a restarted program clears its old lease at start |
| A send cut off mid-way (restart, PC off, flaky line) | recover step and "ambiguous" results: notices sent once more at most, marketing never resent ("may have gone out") | same |
| Mail server rules | public servers only, ports 465 / 587 / 2525, login required, the checked address pinned per connection | any server, including one on the shop's network |
| Some hosts block outgoing mail | INSTALL.md: check the Railway plan (outgoing SMTP may be blocked on lower plans; check Railway's current docs); symptom "Can't reach ... for a day" | - |
| Quiet hours | shop time zone (confirmed by an admin) + the recipient's zones for marketing | same; a 23:00 reconnect sends texts at 09:00 (marketing at noon Eastern for mainland numbers) |
| Unsubscribe from marketing email | footer link `/u/{token}` + `List-Unsubscribe: <https://.../api/u/{token}>, <mailto:...>` + `List-Unsubscribe-Post` (one click) | the reply is the mechanism: footer "reply with the word UNSUBSCRIBE", `List-Unsubscribe: <mailto:{replyTo}?subject=unsubscribe%20{token}>` (plus the link second when `publicUrl` is set), no one-click header; the reply-to mailbox must be watched weekly and staff record replies on Opt-outs (paste the subject) |
| STOP / START / HELP | polled from Twilio every 5 minutes (every minute during a text campaign), whatever the module or pause; delivery results read back | same while online; offline, Twilio's own STOP block still applies, and every reply received meanwhile is read before anything is sent |
| Estimate links | on (`PUBLIC_URL`) | off unless `config.json` has `publicUrl` (a tunnel the shop set up, pointed at the links gate on `127.0.0.1:{linksPort}`); that address then serves ONLY `/e/`, `/u/`, `/api/e/`, `/api/u/` and static files (the gate, then the server's own lock); texts/emails otherwise say "call or reply to approve" and replies show on the ticket |
| Reminders | queued from `reminderHour` the day before; a missed day-before reminder still goes up to 2 h before the start | same |
| Uncollected-machine notices | due dates in shop time; a stage not sent within 7 days of its due date (or before the abandon date) isn't sent late: "decide by hand" | same |
| Secrets key | `SETTINGS_KEY` required (production, not a test build); `SETTINGS_KEY_PREVIOUS` for rotation | `AUTH_SECRET` from `secrets.json`; restoring onto a new PC without `secrets.json` -> "Enter the password again"; passwords can be typed only on the PC itself |
| Restore from a backup | - | opt-outs and consent recorded after the backup are carried over; marketing held until an admin resumes; notices re-checked (2.3) |
| Partner runs | through the hub | same; either shop can record what it received, so an offline repair PC catches up from `pickup.done` |
| Paid modules | per company (admin switch or key) | key only (as the modules design says) |
| Dev / check server | `MESSAGES=off` stops every send path so a dev copy never mails real customers | - |

### 14.2 Security

- **Tenancy**: every query in new code filters by `shopId` (lookups `findFirst({ where: { id, shopId } })` or
  `shopId_id`); ids from `.bind()`, forms and partner messages are never trusted (partner effects also filter by
  `linkId`). Check scripts create two companies and assert that an action given the other company's id gets "... not
  found." (`classes.check.ts`, `appointments.check.ts`, `estimate-links.check.ts`, `partner-runs.check.ts`).
- **Roles**: messaging settings, campaigns, templates, retries, releasing held messages and holds, removing an opt-out,
  class / type / shift setup, sending or cancelling uncollected-machine notices: `requireAdmin()`. Counter work: any
  signed-in user. Pages hide admin forms (`user.role !== "TECH"`), actions enforce.
- **Secrets at rest**: `seal()` AES-256-GCM with a versioned key id (`v1.<kid>.`), HKDF from `SETTINGS_KEY` (required on
  the hosted app) with `SETTINGS_KEY_PREVIOUS` accepted and re-sealed on use, `AUTH_SECRET` on the Windows program;
  random 12-byte IV; 16-byte tag enforced; AAD = `shopId:field` (a sealed value copied to another shop's row or field
  doesn't open). Never sent to the browser: `MessagingView` omits them; the forms never prefill them; only "Saved {date}"
  is shown. Not logged: nodemailer `logger: false, debug: false`; `SendError` messages are built from codes. Backups
  contain only sealed values. On the Windows program secrets are accepted only from the PC itself (plain http on shop
  Wi-Fi). Twilio: an API key (SK...) is recommended over the account's Auth Token.
- **Public address lock** (`src/lib/links-host.ts`, pure, and `src/proxy.ts`, foundation):

  ```ts
  // src/lib/links-host.ts (the same lists as desktop/links-gate.mjs)
  export const PUBLIC_GET = ["/e/", "/u/", "/api/e/", "/api/u/", "/_next/static/", "/favicon.ico"];
  export const PUBLIC_POST = ["/api/e/", "/api/u/"];
  export function linksHostDecision(method: string, path: string, headers: Headers): "pass" | "404";
  // Server actions can be invoked with a Next-Action header on ANY page path (Next forwards them to the worker that owns the
  // action, e.g. the login form's): a request carrying `next-action` is "404". GET / HEAD -> "pass" only for PUBLIC_GET
  // prefixes, POST only for PUBLIC_POST prefixes, any other method "404".

  // src/proxy.ts
  const { auth } = NextAuth(authConfig);
  const authProxy = auth as unknown as (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined>; // check next-auth's types
  const linksHost = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).host.toLowerCase() : null;
  export default async function proxy(req: NextRequest, ev: NextFetchEvent) {
    const host = (req.headers.get("host") ?? "").toLowerCase();
    if (process.env.PUBLIC_LINKS_ONLY === "true" && linksHost && host === linksHost) {
      return linksHostDecision(req.method, req.nextUrl.pathname, req.headers) === "pass"
        ? NextResponse.next() : new NextResponse("Not found", { status: 404 });
    }
    if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next(); // API routes check their own session, as before
    return authProxy(req, ev);
  }
  export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp|ico|woff2?|mjs)$).*)"] };
  ```

  The Windows program always sets `PUBLIC_LINKS_ONLY=true` with its `publicUrl` and puts the links gate (2.3) in front,
  so a tunnel never reaches `/login`, the sign-in and sign-up server actions, `/api/auth/*`, the app or
  `/api/library/file` (manuals stay local), whatever Host header the tunnel sends. The matcher now includes `/api` (for
  this host check only; other hosts pass `/api` straight through as before). Paths the matcher leaves out by extension
  (`*.png` etc.) are static files or routes that check a session, which can't exist on the links address because
  `/api/auth/*` and `/login` answer 404 there. On the hosted app the lock is optional: a separate links domain (e.g.
  `links.example.com` pointing at the same service, set as `PUBLIC_URL`) with `PUBLIC_LINKS_ONLY=true` also keeps one
  tenant's spam from getting the login domain onto blocklists (INSTALL.md recommends it).
- **SMTP host abuse (hosted rules)**: `checkSmtpHost` resolves the name and refuses private, loopback, link-local, CGNAT
  and multicast addresses (reusing `safe-fetch.ts`'s address check, exported as `privateAddress`) on every connection,
  connects to the checked address with `tls.servername` = the name (no second lookup, so no DNS rebinding); ports 465 /
  587 / 2525 only and login required (no direct-to-MX delivery from the platform's IP); `verify` rate-limited 10 an hour
  per shop; errors reported in fixed words (no port-scan oracle beyond "can't reach").
- **Header / content injection**: strict `validEmail` (no commas, quotes, angle brackets); addresses passed to nodemailer
  as `{ name, address }` objects; subjects cleaned after merge; merge values cleaned (`cleanText`: control characters,
  CR/LF, links); templates plain text; `render` is single-pass; `textToHtml` escapes everything. Message bodies, replies
  and notes are never rendered with `dangerouslySetInnerHTML`.
- **Unsubscribe tokens**: 128-bit random, stored as-is (their only power: unsubscribe that one address from that shop's
  marketing email); not derived from ids, so they can't be forged or enumerated; format-checked before the lookup;
  unsubscribe needs a POST (no GET side effects).
- **Estimate tokens**: 256-bit random, looked up by sha256 only; the raw token sealed only until its messages are out;
  stored bodies, the outbox page, CSV exports and backups hold the masked link; one ticket/job; expire (default 7 days);
  revoked when a newer link is sent or the ticket moves on; single answer (guarded `updateMany`); approval needs a
  confirm step (a link scanner that follows GET links can't approve); the page shows only the pinned estimate and the
  customer's first name; `no-store`, `no-referrer`, `noindex`. `answerFrom` records `clientAddress()` (only a trusted
  proxy's value) and the browser.
- **Rate limits** (`rate-limit.ts`, in memory per process, at most 50 000 keys; enough to stop hammering, not a quota):
  public GET 60/min/address, public POST 10-20/min/address and 300/min across all public POSTs (the "anon" bucket when no
  trusted address is known), test sends 10/h/shop, test codes 5/h/shop, SMTP / Twilio checks 10/h/shop, "Send now"
  6/min/user, manual notice sends 5/h/ticket. Volume caps (DB-counted): estimate sends 3/day/ticket, staff-triggered
  messages 3/day/address, marketing texts 1/day and 4/30 days per number, campaigns 3/day/shop, 5000 recipients,
  7 days of sending, marketing email and texts per shop-day, service-due 50/day/shop.
- **Twilio webhooks**: none in this build (replies and delivery results are polled), so there is nothing to validate. If
  one is added later it must check `X-Twilio-Signature` (HMAC-SHA1 of the full URL + sorted POST params with the auth
  token, `timingSafeEqual`) before reading the body.
- **CSRF**: server actions get Next's Origin check (`node_modules/next/dist/docs/01-app/02-guides/data-security.md`);
  the two public POST routes act only through their unguessable token.
- **Retention**: `OutMessage`, `ConsentEvent`, `Suppression`, `InboundText` are kept (no delete code in this build).
  INSTALL.md states the minimums: `ConsentEvent` and `Suppression` never purged (TCPA's limitation period is 4 years);
  uncollected-machine notice rows kept at least 4 years after the ticket closes; marketing message bodies may be purged
  after 2 years (a later build). The CSV exports give the shop a copy.

---

## 15. Implementation packages

Order: `modules-foundation` (the other design; merged on `feat/scheduling-messaging` first) -> **`foundation`** (alone)
-> in parallel: `notices`, `estimate-links`, `campaigns`, `classes`, `appointments`, `register-bookings`, `shifts`,
`partner-runs` (each in its own git worktree and database, 16.3) -> `e2e-docs` (alone, after all are merged).

Rules for every package:

- Start from foundation's merge commit; run `npm ci` and `npx prisma generate` in the package's worktree.
- Touch only the files listed under "Owns" plus the exact "Shared edits". A stub or placeholder foundation created is
  owned by the package named in 7.3 / 7.4 / 15.x: replace its body, keep its exported names, props and signatures.
- `npx tsc --noEmit` passes; `npx eslint <the package's files>` is clean; the existing `tests/smoke.spec.ts` still passes.
- Every check script runs with `npm run check <file>` and exits 0; every Playwright spec runs against the package's own
  test-build server (16.3).
- "Visible" acceptance items are checked by hand (or by the named spec) at the stated URL on that server.

Package numbers `n` (for ports and database names, 16.3): foundation 0, notices 1, estimate-links 2, campaigns 3,
classes 4, appointments 5, register-bookings 6, shifts 7, partner-runs 8, e2e-docs 9.

### 15.1 `foundation` (depends: modules-foundation merged)

Owns (new unless marked "edit"):

- Schema: `prisma/schema.prisma` (edit: 2.1 + Appendix B), `prisma/migrations/20260926150000_scheduling_messaging/migration.sql`
  (Appendix A verbatim; folder rule at the top), `src/generated/prisma` (regenerated, git-ignored).
- Build and config: `package.json`, `package-lock.json` (edit: `"nodemailer": "^10.0.10"` in dependencies;
  `"overrides": { "nodemailer": "$nodemailer" }` because next-auth declares an optional peer `nodemailer ^7`; scripts
  `"check": "tsx --conditions=react-server"`, `"mail:sink": "node scripts/test-mail/smtp-sink.mjs"`, `"sms:mock": "node
  scripts/test-mail/twilio-mock.mjs"`), `.env.example` (edit: 16.1).
- Windows program: `desktop/backup.mjs` (edit: 2.3), `desktop/main.mjs` (edit: 2.3), `desktop/links-gate.mjs`.
- Server plumbing (edits): `src/instrumentation.ts` (4.3 timer), `src/proxy.ts` (14.2 lock), `src/auth.config.ts` (9.6),
  `src/auth.ts` (imports `clientAddress`), `src/lib/safe-fetch.ts` (`export` on `privateAddress`),
  `src/lib/constants.ts` (2.4).
- Libraries: `src/lib/zoned.ts`, `phone.ts`, `client-ip.ts`, `lease.ts`, `lock.ts`, `rate-limit.ts`, `ticket-status.ts`,
  `estimate-answer.ts`, `module-gate.ts`, `customer-input.ts`, `booking-types.ts`, `parse-table.ts`, `links-host.ts`,
  `src/lib/notices/context.ts`; `src/lib/messaging/types.ts`, `errors.ts`, `secrets.ts`, `settings.ts`, `presets.ts`,
  `templates.ts`, `quiet.ts`, `consent.ts`, `queue.ts`, `kick.ts`, `smtp.ts`, `twilio.ts`, `inbound.ts`,
  `service-due.ts`, `worker.ts`.
- Actions: `src/actions/messaging.ts`, `src/actions/consent.ts`; edits: `src/actions/records.ts` (`saveCustomer`
  notifyBy, 8.3), `src/actions/tickets.ts` (`setStatus` data action, `createTicket` status list and notifyBy, 7.2).
- Components: `src/components/module-off.tsx`, `notify-by-field.tsx`, `customer-picker.tsx`, `messages-tabs.tsx`,
  `messaging-tabs.tsx`, `calendar-tabs.tsx`, `sms-counter.tsx`, `customer-messages.tsx`, `messaging-settings-forms.tsx`
  (the client forms of `/settings/messages*`), `template-editor.tsx` (wording `<details>` with the live sample),
  `consent-sign.tsx` (the tablet form); edits: `src/components/nav.tsx` (6.2: three items, reply badge, pause pill),
  `src/components/ticket-controls.tsx` (7.2 #3), `src/components/customer-form.tsx` (`NotifyByField`),
  `src/components/intake-form.tsx` (`NotifyByField`), `src/components/import-items.tsx` (imports `parseTable`).
- Pages: `src/app/(app)/settings/messages/page.tsx`, `settings/messages/auto/page.tsx`, `settings/messages/rules/page.tsx`,
  `messages/page.tsx`, `messages/replies/page.tsx`, `messages/opt-outs/page.tsx`, `customers/consent-form/page.tsx`,
  `src/app/consent/[customerId]/page.tsx`; edits: `src/app/(app)/layout.tsx` (6.2 gates, badge and pill data),
  `settings/page.tsx` (Messages section), `customers/[id]/page.tsx` (`CustomerMessages` + 2 slots),
  `tickets/[id]/page.tsx` (2 slots), `tickets/new/page.tsx` and `repairs/new/page.tsx` (pass the Marketing gate and
  `needNotifyBy()` to the forms), `customers/page.tsx` (the gate for `CustomerForm`), `repairs/[id]/page.tsx` (3 slots),
  `repairs/page.tsx` (2 slots), `partners/[id]/page.tsx` (1 slot), `src/app/(app)/page.tsx` (4 slots),
  `src/app/api/export/[what]/route.ts` (8.4).
- Tests: `scripts/test-mail/smtp-sink.mjs`, `scripts/test-mail/twilio-mock.mjs` (16.2), `scripts/checks/lib.ts`,
  `scripts/checks/messaging-core.check.ts`, `scripts/checks/worker.check.ts`, `scripts/checks/links-gate.check.ts`,
  `scripts/checks/restore-optouts.check.ts`, `tests/helpers/messaging.ts`, `tests/helpers/modules.ts`,
  `tests/messaging.spec.ts`.

Shared edits (foundation goes first; the later package's edit is listed in its own section):

- `src/lib/partners.ts`: retail `case "job.update"` becomes the transaction of 7.2 #4 (approval reset on re-entering
  `WAITING_CUSTOMER_OK`, `backAt` reset when the job leaves the counter, `onJobStatus`); repair `case "job.pickedup"`
  also writes `pickupReadyAt: null`. Later: `partner-runs` (13.4).
- `src/actions/repair-jobs.ts`: `answerEstimate` body -> `answerRetailEstimate(tx, { ..., via: "counter" })` (7.2 #5);
  `takeInMachine` reads `notifyBy`. Later: `partner-runs` (`cancelJob` guard).
- `src/app/(app)/register/page.tsx`: insert `<TodaySlot user={user} place="register" />`, `<EstimatesTodoSlot
  user={user} />`, `<TodoLinesSlot user={user} />` directly after `<PartnerTodo ... />`. Later: `register-bookings`.
- Stubs it creates with the exact signatures of 7.1-7.3, then hands over: `src/lib/notices/hooks.ts`,
  `src/lib/notices/scheduler.ts` (-> notices); `src/lib/messaging/campaign-build.ts` (-> campaigns);
  `src/actions/class-register.ts` (-> classes); the 14 slot files of 7.3 (-> their owners); the placeholder pages
  `src/app/(app)/calendar/page.tsx` (-> appointments), `classes/page.tsx` (-> classes), `shifts/page.tsx` (-> shifts),
  `campaigns/page.tsx` and `customers/import/page.tsx` (-> campaigns).

Acceptance:

1. `npx prisma migrate deploy` applies the migration on the package database; `npx prisma migrate diff --from-schema
   <schema.prisma before foundation> --to-schema prisma/schema.prisma --script` equals the migration file without its
   last (hand-written backfill) statement, whitespace aside.
2. `npx tsc --noEmit` passes; `STITCH_TEST_BUILD=1 npm run build` passes.
3. `messaging-core.check.ts` (pure, no DB): `toE164` / `validEmail` tables (`"a,b@x.com"`, `"a@b.com\r\nBcc: x"` and
   quoted names rejected); `usMarketingNumber` (`+14165550100` false, `+12125550100` true); `recipientZones`
   (907, 808, other); `nextTextTime`: a notice at 19:59 / 20:00 shop time, a marketing text to a 415 number from a New
   York shop at 09:00 ET -> 12:00 ET, Sunday with `noSundayMarketing`, both DST change days; `zonedTime` across both DST
   changes; `allowed()` truth table (every row of 3.1, every skip reason, trade, not_us, a changed phone voids consent);
   `seal` / `unseal` round trip, other shop's AAD -> null, a 12-byte tag -> null, a value sealed with
   `SETTINGS_KEY_PREVIOUS` opens with `stale: true`; `render` is single-pass (a name `"{estimate_link}"` stays
   literal), `cleanText` removes CR/LF and links; subjects are cleaned after merge; `checkTemplate`; `smsParts`
   (GSM 160/153, UCS-2 70/67); `plainText`; `finalize` (shop prefix once, STOP line on marketing and `class_notice`
   texts, advertisement + postal footer, hosted vs Windows unsubscribe wording); `textToHtml` escapes `<script>`;
   `firstName` ("SMITH, MARY" -> "Mary", "Mrs. Jones" -> "Jones", "" -> "there"); `statusData` sets `pickupReadyAt` on
   entering and clears it on leaving `READY_FOR_PICKUP` and keeps the first `readyAt`; `consentCode` is stable.
4. `worker.check.ts` (DB; sink and mock started in-process on ephemeral ports; `MESSAGES` unset in the check process,
   no server on the package database, or its server started with `MESSAGES=off`):
   - with `MESSAGES=off`: `runMessages`, `messageRun`, `sendOneNow` return off and `kickMessages` does nothing;
   - a notice email and text reach the sink / mock; the same dedupe key twice -> one row; two `messageRun()` at once
     send each row once;
   - sink stopped -> the row stays `QUEUED` with `nextTryAt`, `retryTries` 0, `emailError` set; sent after restart;
   - sink answers `451` -> retry, the channel stops for the run; `550 5.4.5` -> channel paused until the next shop-day
     08:00, rows still `QUEUED`; `550 5.1.1` -> that row `FAILED`; three `5.1.1` in a row -> channel paused;
   - sink closes the socket after DATA (ambiguous): a marketing row -> `FAILED` "May have gone out; not sent again", a
     notice -> retried once then `FAILED`; the mock records a text and drops the connection -> `findSent` finds it ->
     `SENT` with that SID, the mock holds exactly one copy;
   - wrong Twilio token -> `smsPausedAt` set, rows still `QUEUED`; `21610` -> row `FAILED` + `Suppression(sms, all,
     carrier)` + ConsentEvent;
   - a notice text due at 21:30 shop time gets `sendAfter` 09:00 next day; a marketing text to a Pacific number from an
     Eastern shop at 09:30 ET waits until 12:00 ET; a second marketing text to the same number within 24 h waits; a
     fifth in 30 days -> `SKIPPED too_often`; an unhandled reply from the number -> `SKIPPED unread_reply`;
   - a company without Marketing: its rows stay `QUEUED` (held) and are listed as held; with Twilio set up and the
     module off for 45 days, a "please don't text me anymore" reply received on day 40 is read by `messageRun()` and the
     `Suppression` exists before any send (clock injected);
   - 3 incomplete reply reads -> `textHoldAt` set, marketing texts held, notices still sent; a complete read clears it;
   - marketing email daily cap 2 with 5 rows: 2 sent, 3 moved to the next shop-day at `quietStart`; a marketing row
     whose `sendAfter` is 49 h old is not sent until `releaseHeld`;
   - a `SENDING` row older than 2 min is recovered (notice -> `QUEUED` once, marketing -> `FAILED`, test -> `FAILED`);
     rows inserted with status `SENDING` (tests) are never picked up by the worker;
   - an estimate row (hand-made `EstimateLink` with a sealed token): the text reaching the mock contains `/e/<token>`,
     the stored body still has the masked link, `tokenSealed` is null after the run;
   - `clearStaleOwnLeases()` removes a lease held by `<hostname>:<other pid>`.
5. `links-gate.check.ts` (starts `startLinksGate` in front of a dummy HTTP server): `GET /e/x`, `GET /u/x`, `POST
   /api/u/x` pass through with `Host` rewritten to the public host and `x-forwarded-for` dropped; `GET /login`, `GET
   /customers`, `POST /e/x`, `POST /login`, `GET /api/library/file`, `GET /api/auth/session` and any request with a
   `next-action` header -> 404 without reaching the dummy server. The same table passes through
   `linksHostDecision()` (`src/lib/links-host.ts`, the function `src/proxy.ts` uses).
6. `restore-optouts.check.ts` (never against the working database: it creates `stitchbench_restorecheck_<run>`, runs
   `prisma migrate deploy` there, and drops it at the end): back up a company with `backup()`, then add a
   `Suppression`, a `marketing_no` ConsentEvent and a `notify_pref` "none", queue one marketing row and one notice row;
   `restore()` the backup: the suppression and events are there, the customer's `smsConsent*` are cleared,
   `notifyBy` is "none", the marketing row is `CANCELLED`, the notice is `QUEUED`, `marketingHoldAt` is set.
7. `tests/messaging.spec.ts` (Playwright, test build, sink and mock running): an admin saves SMTP (sink) and Twilio
   (mock) settings; the page HTML never contains the saved password or token; "Try it" reaches the sink and the mock
   only for the admin's own address / a confirmed test number (a typed-in other number is not offered); a TECH sees the
   settings read-only and a direct call of `saveEmailSettings` returns the admin error; the customer form saves "How
   should we tell them"; `/consent/{id}` shows no nav and no search box, signing records a `marketing_yes` event visible
   on Opt-outs and a confirmation text reaches the mock; recording an opt-out shows on the customer; a STOP posted to
   the mock's `/__inbound` shows under Replies and Opt-outs after "Send now"; with Marketing switched off
   (`setModule`) the Messages nav item shows the lock and saving settings shows the renew message; with Marketing on
   and email ready, `/tickets/new` requires "How should we tell them" for a new customer.
8. Visible: `/tickets/{id}` moved to "Ready - customer called" works as before (the hook stub returns null, the usual
   toast); `tests/smoke.spec.ts` passes; with `HUB_URL` set, `tests/partners.spec.ts` still passes (the `job.update`
   path).

### 15.2 `notices` (depends: foundation)

Owns: `src/lib/notices/hooks.ts` and `src/lib/notices/scheduler.ts` (the stubs), `src/lib/notices/vars.ts`,
`src/lib/notices/abandon.ts`, `src/actions/notices.ts`, `src/components/slots/ticket-notices.tsx`, `job-notices.tsx`,
`repairs-back.tsx`, `todo-lines.tsx` (stubs), `src/app/(app)/tickets/[id]/notice-letter/page.tsx`,
`src/app/(app)/repairs/[id]/notice-letter/page.tsx`, `src/app/u/[token]/page.tsx`, `src/app/api/u/[token]/route.ts`,
`scripts/checks/abandon.check.ts`, `scripts/checks/notices.check.ts`, `scripts/checks/seed-marketing.ts`,
`tests/notices.spec.ts`.

Shared edits: the stubs above (bodies replaced). In `scheduler.ts` the last statement of `runSchedulers` is `await
runBagsDue(now, shopIds);` (modules-design 12.4 #2; `vac-bags-due` then adds nothing there).

Acceptance:

1. tsc passes.
2. `abandon.check.ts` (pure): days [7, 30], abandon after 60, final 7 -> stages at day 7, 30, 53; [7, 58] with final 7
   -> the 58 stage dropped; `sendable` returns only the latest due stage, nothing more than 7 days after its due date,
   and nothing once the abandon date has passed; due times at `reminderHour` on DST days; `stageKey` differs for a new
   `pickupReadyAt`.
3. `notices.check.ts` (DB, clock injected, a company with Marketing and one without):
   - ready: a direct ticket to `READY_FOR_PICKUP` -> one `ready` row per allowed channel with `sendAfter` = +delay and a
     toast line naming the channel and time; back to `ON_BENCH` -> CANCELLED; `READY_FOR_PICKUP` again a week later ->
     a NEW row (a new `pickupReadyAt`, so a new key); a double call of `changeTicketStatus` with the same stale ticket
     -> one row; trade-account, partner and SITE tickets -> nothing; the company without Marketing -> nothing and no
     toast line;
   - retail: `onJobStatus` to `READY_FOR_PICKUP` -> nothing; `markBackAtCounter` -> one row, a second call -> "Already
     recorded."; `markManyBack` with 3 jobs -> 3 rows; a `job.update` moving a back job to `ON_BENCH` clears `backAt`;
   - reminders: a meeting tomorrow queues one per enrolled customer (not for a sign-up made less than 24 h before),
     a second scheduler run queues nothing, a class with `remind "first"` reminds only the first meeting; moving the
     meeting -> the old row CANCELLED by `stillWanted` ("The time changed") and a new one queued; nothing says
     "tomorrow";
   - uncollected: rows at day 7, 30 and 53 once each; a notice recorded by hand for the "second" stage stops the
     automatic second; switching `abandonNotices` on for a ticket ready 200 days ago queues nothing (past the window)
     and the slot says "decide by hand";
   - service due: a machine collected 13 months ago (after `serviceDueSince`) queues one `service_due`; a customer with
     two due machines gets one row naming both; a newer ticket for the machine cancels it at send time; a machine due
     before `serviceDueSince` - 60 days queues nothing; the daily cap counts only QUEUED / SENDING / SENT;
   - review: one per customer inside `reviewEveryDays`; SITE tickets never; `reviewAfterSales` off -> sales ignored;
   - `stillWanted` for every row of 9.4.
4. `tests/notices.spec.ts`: a direct ticket set to "Ready - customer called" -> the toast names the channel; after
   "Send now" the sink has "Your ... is ready" and the ticket's Messages section shows it Sent; "Record a notice given by
   hand" (certified mail + tracking number) shows as proof with "recorded ... by ..."; the notice letter prints; a
   marketing email seeded by `seed-marketing.ts` (prints the token): GET `/u/{token}` changes nothing, the button
   unsubscribes, the suppression appears under Opt-outs; the RFC 8058 POST with `List-Unsubscribe=One-Click` returns 200.
5. Visible: `/tickets/{id}` of a ready ticket shows the notice schedule with dates; with Marketing off each due stage
   says "send it by hand (Messages is off)"; `/repairs` shows "Marked ready by the repair shop. Are they here?".

### 15.3 `estimate-links` (depends: foundation)

Owns: `src/lib/estimate-links.ts`, `src/actions/estimate-links.ts`, `src/components/slots/ticket-estimate.tsx`,
`job-estimate.tsx`, `estimates-todo.tsx` (stubs), `src/components/auto-refresh.tsx`, `src/app/e/[token]/page.tsx`,
`src/app/api/e/[token]/route.ts`, `scripts/checks/estimate-links.check.ts`, `tests/estimate-links.spec.ts`.

Shared edits: the three slot stubs (bodies replaced).

Acceptance:

1. tsc passes.
2. `estimate-links.check.ts` (DB): the token is 43 characters; `EstimateLink` stores its sha256 and the sealed token
   only until the message is sent; after a worker run no `OutMessage` row, and no other column in the database dump of
   the check company, contains the raw token; a second link revokes the first; `answerByToken` twice -> the second
   "gone"; expired -> "gone"; an APPROVED ticket answer moves `WAITING_CUSTOMER_OK` -> `ON_BENCH` with `approvedCents`
   = the link's total and a notes line "... by link"; DECLINED keeps the status; a retail job answer writes `approval`
   and a `job.reply` PartnerOutbox row; the counter answering first -> the link answer is "gone"; another company's
   ticket id -> "Ticket not found."; a fourth `sendEstimate` for one ticket on one shop-day -> "You've sent this
   estimate 3 times today. Call them instead."
3. `tests/estimate-links.spec.ts` (`PUBLIC_URL` = the package server): a direct ticket "Waiting on customer OK" ->
   "Send the estimate" by email -> the sink email contains `/e/`; opened signed out it shows the lines and total and
   nothing else about the customer; the GET "Approve" step changes nothing; "Yes, approve" -> within 25 s, without a
   reload, the ticket page shows "Approved by link" and status "On bench"; the link then shows the answer and can't be
   answered again. Without `PUBLIC_URL` (second server run): the form says "(they call or reply)", the email has no
   link; a text reply posted to the mock shows on the ticket with "They approved" -> status "On bench".

### 15.4 `campaigns` (depends: foundation)

Owns: `src/lib/messaging/audiences.ts`, `src/lib/messaging/campaign-build.ts` (stub), `src/actions/campaigns.ts`,
`src/actions/customer-import.ts`, `src/app/(app)/campaigns/page.tsx` (placeholder), `campaigns/new/page.tsx`,
`campaigns/[id]/page.tsx`, `src/app/(app)/customers/import/page.tsx` (placeholder), `src/components/campaign-form.tsx`,
`src/components/customer-import.tsx`, `src/components/two-tap-button.tsx`, `scripts/checks/audiences.check.ts`,
`scripts/checks/campaigns.check.ts`, `tests/campaigns.spec.ts`.

Shared edits: the stub and the two placeholders (bodies replaced).

Acceptance:

1. tsc passes.
2. `audiences.check.ts` (DB): each audience returns the right customers of this shop only (never trade accounts or
   another company's); `service_due` matches `machinesDue` without `dueSince`; `classes` counts only attended classes.
3. `campaigns.check.ts` (DB): 1 200 members build in 3 runs of at most 500; two customers sharing an address get one
   row (`same_address` counted); the campaign turns SENT by the sweep when its last rows were SKIPPED; a campaign that
   would take 8 days at the cap is refused; the fourth campaign on one shop-day is refused; `cancelCampaign` cancels
   its queued rows; import: 3 rows (one matching an existing customer by phone, one with `unsubscribed = yes`) -> 1
   added, 1 matched, 1 suppression, no text consent anywhere.
4. `tests/campaigns.spec.ts`: an admin creates an email campaign to "everyone"; the page shows "2 people will get it.
   Not sending to: 1 unsubscribed"; "Send me a test" reaches the sink with "[Test]" and sample names only; the two-tap
   "Send now" queues it; after "Send now" on Messages the sink has 2 emails, each with the postal address, the
   advertisement line, `List-Unsubscribe` and `List-Unsubscribe-Post` headers; the campaign shows Sent 2 / skipped 1; a
   text campaign skips customers without written consent and the mock's texts end "Reply STOP to opt out."; without a
   postal address "Send now" shows the postal-address error; a TECH sees campaigns read-only.

### 15.5 `classes` (depends: foundation)

Owns: `src/lib/classes.ts`, `src/actions/classes.ts`, `src/actions/class-register.ts` (stub),
`src/app/(app)/classes/page.tsx` (placeholder), `classes/new/page.tsx`, `classes/[id]/page.tsx`,
`classes/[id]/roster/page.tsx`, `classes/print/page.tsx`, `src/components/class-form.tsx`,
`src/components/slots/customer-classes.tsx` (stub), `scripts/checks/classes.check.ts`, `tests/classes.spec.ts`.

Shared edits: the stubs and the placeholder (bodies replaced).

Acceptance:

1. tsc passes.
2. `classes.check.ts` (DB): 12 parallel `enrollIn` on a 10-seat class with a waiting list -> exactly 10 ENROLLED and 2
   WAITLIST; without a waiting list -> 10 and 2 "The class is full."; with someone waiting a new sign-up waits unless
   `skipWaitlist`; the same customer with two attendees -> two rows, the same attendee twice -> "already signed up";
   cancel then sign up again -> a new row with no payment fields; `moveUp` into a full class refused; lowering seats
   below the signed-up count refused; `meetingDays` weekly across a DST change keeps 18:00, `monthly_weekday` gives the
   3rd Saturday each month, `monthly_date` skips Feb 30; `deleteClass` with any enrollment refused; `messageClass`
   without "only about this class" refused; another company's class id -> not found; Scheduling off -> every action
   refuses with the renew message and `openClassSeats()` returns `[]`; `enrollAtRegister` returns a `BookingDue` with
   the snapshot fee.
3. `tests/classes.spec.ts` (retail company, both modules on): create a class with 4 weekly meetings and 2 seats; sign
   up 3 people (the third waits); cancel one, move the waiting person up (tell ticked -> a text in the mock); set a
   "Price for this person"; the roster prints 2 names and 4 attendance boxes; `/classes/print` lists the month; the
   customer page lists the class with "Ring up".

### 15.6 `appointments` (depends: foundation)

Owns: `src/lib/appointments.ts`, `src/lib/calendar.ts`, `src/actions/appointments.ts`, `src/app/(app)/calendar/page.tsx`
(placeholder), `calendar/new/page.tsx`, `calendar/appointments/[id]/page.tsx`, `calendar/types/page.tsx`,
`src/components/calendar-view.tsx`, `src/components/appointment-form.tsx`, `src/components/appt-type-form.tsx`,
`src/components/slots/customer-appointments.tsx`, `src/components/slots/today.tsx` (stubs),
`scripts/checks/appointments.check.ts`, `tests/calendar.spec.ts`.

Shared edits: the stubs and the placeholder (bodies replaced). `calendar.ts` ends with the `siteJobsBetween` line of
12.2 (modules-design 12.4 #3; `central-vac-installs` then adds nothing there).

Acceptance:

1. tsc passes.
2. `appointments.check.ts` (DB): `hoursFromForm` / `hoursText` round trip and the error text; `withinHours` at the
   edges; "Longarm rental" and "Longarm lesson" sharing resource "Longarm" with capacity 1: parallel bookings of both at
   10:00 -> one booked, one "Longarm is already booked then (1 of 1)"; a block holds the resource; the same staff member
   on two types refused; `rescheduleAppt` excludes itself; `freeWeek` lists 7 days and leaves out booked times; a 10:00
   booking on a DST change day is 10:00 shop time; `calendarItems` returns appointments, class meetings, runs and
   (with `shifts`) shifts in range; another company's type id -> not found.
3. `tests/calendar.spec.ts`: create "Longarm rental" (2 hours, $40, 1 at once, resource Longarm, Tue-Sat 10:00-17:00
   as day rows); book it from a free-time button; a second booking at the same time is refused with the message; the
   Day and Week views show it (Week at a phone-width viewport shows the per-day list); a class meeting and a shift that
   day also show; mark it Done; the register shows the one-line "Today" strip; a repair-only company with Scheduling
   on sees `/calendar` and the Dashboard "Today" card.

### 15.7 `register-bookings` (depends: foundation; uses the `classes` signatures of 7.1 only)

Owns (edits on top of modules-foundation's versions, 12.3): `src/actions/register.ts`, `src/components/register.tsx`,
`src/app/(app)/register/sales/page.tsx`; new `scripts/checks/register-bookings.check.ts`,
`tests/register-bookings.spec.ts`.

Shared edits: `src/app/(app)/register/page.tsx`: add `searchParams: Promise<{ booking?: string }>` to the page props,
validate `booking` against `/^(enrollment|appointment):[a-z0-9]{20,40}$/`, load that one unpaid booking scoped by
`shopId`, pass `preload={due}` to `<Register>`. Foundation's three slot lines stay as they are.

Acceptance:

1. tsc passes.
2. `register-bookings.check.ts` (DB, through `completeSale` / `voidSale` / `bookingsDue` as a check user): paying an
   enrollment sets `paidCents` = fee and `paidLineId`; paying it again -> "already paid"; a client-sent price is
   ignored; a cancelled class can't be paid; a refund (qty -1) sets `refundedCents`; an admin can lower a refund, a
   TECH can't; voiding the payment sale after a refund -> "void that refund first"; void the refund, then the payment
   -> both cleared; a taxable fee adds tax, a non-taxable doesn't; the whole-sale discount never reduces a booking
   line; a line with both an enrollment and a part is refused.
3. `tests/register-bookings.spec.ts`: from a roster "Ring up" opens the register with the class line and the URL goes
   back to `/register`; pay cash; the roster shows "Paid, sale #N" linking to the receipt; "Sign up for a class" in the
   register picker adds a new sign-up and its line; return mode lists it and refunds it; the sales report shows
   "Classes" and "Appointments" buckets.

### 15.8 `shifts` (depends: foundation)

Owns: `src/lib/shifts.ts`, `src/actions/shifts.ts`, `src/app/(app)/shifts/page.tsx` (placeholder),
`shifts/print/page.tsx`, `src/components/shift-form.tsx`, `scripts/checks/shifts.check.ts`, `tests/shifts.spec.ts`.

Shared edits: the placeholder (body replaced).

Acceptance:

1. tsc passes.
2. `shifts.check.ts` (DB): a shift for a user and one for a typed name without a login; overlap for the same user or
   the same name (case-insensitive) refused; `copyWeek` across the DST week keeps wall times; a non-empty target
   without `replace` refused; weekly totals group by name; another company's user id refused.
3. `tests/shifts.spec.ts`: add shifts for a user and for "Ann (Saturdays)"; weekly totals show; copy to next week;
   the print view lists them; the Calendar's "Staff" tab opens `/shifts`; a TECH sees the grid read-only.

### 15.9 `partner-runs` (depends: foundation)

Owns: `src/lib/partner-runs.ts`, `src/actions/partner-runs.ts`, `src/components/run-form.tsx`,
`src/app/(app)/partners/[id]/runs/new/page.tsx`, `src/app/(app)/partners/[id]/runs/[runId]/page.tsx`,
`src/components/partner-todo.tsx` (edit: the three run lines of 13.6), `src/components/slots/partner-runs.tsx`,
`job-run.tsx`, `repairs-runs.tsx`, `dashboard-runs.tsx` (stubs), `scripts/checks/partner-runs.check.ts`,
`tests/partner-runs.spec.ts`.

Shared edits:

- `src/lib/partners.ts` (after foundation's edit): the header comment lists the five types; `FROM` gains
  `"pickup.plan"`, `"pickup.ok"`, `"pickup.cancel"`, `"pickup.done"`, `"caps.update"` as `"either"`; `applyMessage`
  gains the cases of 13.4; new exported functions `applyRun`, `runPlan`, `sendRun`, `runEffects`, `pushFeatures`; one
  line `await pushFeatures();` directly after `await pushCatalogs();` in `doPartnerSync`.
- `src/actions/repair-jobs.ts` (after foundation's edit): `cancelJob` refuses a job in a run's `collected` list for
  its link (13.3).
- The four slot stubs (bodies replaced).

Acceptance:

1. tsc passes.
2. `partner-runs.check.ts`: pure part: `canDo` for every status x side x action; `planOutcome` (a plan from the
   non-owner ignored, an older rev ignored, a plan for a DONE run ignored). DB part: two companies on this install
   with a `PartnerLink` pair (same link id, sides repair / retail) created by the check; messages relayed by reading
   `PartnerOutbox` rows and calling `applyRun` on the other company: the retail shop (Scheduling on) schedules a run
   with its waiting machine; the repair shop (no Scheduling) sees it, OKs it and records what the driver took ->
   its ticket is `IN_TRUCK` and the retail job shows "Handed to the driver"; a run bringing a fixed machine back:
   retail records it delivered -> `backAt` set, one ready notice queued (Marketing on), the repair ticket goes
   `READY_FOR_PICKUP`; every message applied twice changes nothing; a `pickup.done` from a third company's link naming
   these job ids changes nothing; a `pickup.plan` from the non-owner side is ignored; a DONE whose `at` is 30 days old
   still applies; `pushFeatures()` sends `caps.update` once and not again while unchanged; `cancelJob` on a collected
   job is refused.
3. `tests/partner-runs.spec.ts` runs only with `HUB_URL` (a test StitchHub this install has joined; never the review's
   servers on 3100 / 3400 / 8080) and repeats the DB check's first two flows through the UI; without `HUB_URL` it is
   skipped, like `partners.spec.ts`.

### 15.10 `e2e-docs` (depends: all of the above)

Owns: `tests/scheduling-messaging.spec.ts`, `tests/two-servers.spec.ts`, `INSTALL.md` (edit: a "Messages" section:
SMTP providers and app passwords, Twilio and A2P 10DLC / toll-free registration, the Windows public address and links
port, "When the internet is down" lines, retention minimums of 14.2, the variables of 16.1, the Railway outgoing-SMTP
note), `README.md` (edit: the features and a Tests section: sink, mock, check scripts, per-package worktrees).

Shared edits: none.

Acceptance:

1. `tests/scheduling-messaging.spec.ts` passes on the merged branch: a company that is both repair and retail with both
   modules on signs someone up for a class (confirmation in the sink), books an appointment, sees reminders queued for
   tomorrow's items, sets a ticket ready (email in the sink), approves an estimate by link; then Scheduling and
   Marketing are switched off: nav items show locks, pages are read-only with the renew notice, "Sign someone up" is
   refused, a message queued just before the switch stays Waiting (held) and is not in the sink 15 s later (worker every
   5 s), the roster still prints, the `classes` CSV still downloads, the unsubscribe link still works, a partner run can
   still be OK'd; switched back on -> the held message goes out.
2. `tests/two-servers.spec.ts`: two servers on one database (ports 3500 and 3501, `MESSAGE_WORKER_SECONDS=2`): 30
   queued notices arrive in the sink exactly once each.
3. `INSTALL.md` / `README.md` describe every new variable, the Windows links port, the retention minimums and the test
   commands.

---

## 16. Testing

### 16.1 Environment variables (all optional; foundation adds them to `.env.example` with one comment each)

| Variable | Default | Meaning |
|---|---|---|
| `MESSAGES` | on | `off` stops every send path: timer, kick, "Send now", test sends (dev copies, checks that must not send) |
| `MESSAGE_WORKER_SECONDS` | 30 | how often the worker runs (tests: 2-5) |
| `MESSAGE_BATCH` | 20 | rows per shop, per channel, per run |
| `READY_NOTICE_DELAY_SECONDS` | 120 | wait before a ready notice goes (the undo window; tests: 1) |
| `PUBLIC_URL` | - | the public https address for customer links (estimate approval, one-click unsubscribe). Hosted: set by the operator. Windows program: set by `main.mjs` from `config.json` `publicUrl` |
| `PUBLIC_LINKS_ONLY` | - | `true`: requests whose Host is `PUBLIC_URL`'s host get only the public pages (14.2). Always `true` on the Windows program when `publicUrl` is set |
| `SETTINGS_KEY` | `AUTH_SECRET` | key material for sealing the mail password and Twilio secret; required on a hosted production build |
| `SETTINGS_KEY_PREVIOUS` | - | the previous `SETTINGS_KEY` during a rotation (read only; values are re-sealed with the new key) |
| `SMTP_ALLOW_HOSTS` | - | `host:port` list allowed as a private / plain mail server under hosted rules (tests: the sink's address) |
| `TWILIO_API_BASE` | `https://api.twilio.com` | tests only: the Twilio mock |
| `TRUST_PROXY` | - | existing: `true` behind Railway's proxy, so `clientAddress()` reads the last `X-Forwarded-For` hop |
| `STITCH_TEST_BUILD` | - | from modules-design: a test build (dev license keys; `SETTINGS_KEY` not required) |

### 16.2 Tools

- **SMTP sink** `scripts/test-mail/smtp-sink.mjs` (from `scratch/jobs-deploy-tests/sink/smtp-sink.mjs`, no dependency).
  Exports `startSmtpSink({ smtpPort = 0, httpPort = 0 }): Promise<{ smtpPort, httpPort, messages, clear(), close() }>`
  (0 = an ephemeral port); run directly it listens on `SMTP_SINK_PORT` (2525) and `SMTP_SINK_HTTP` (2580). HTTP: `GET
  /` lists messages (`from, to, user, raw, at`), `DELETE /` clears. AUTH PLAIN / LOGIN accepted. Scripted replies by
  recipient: `reject@...` -> `550 5.1.1`, `quota@...` -> `550 5.4.5 Daily sending quota exceeded`, `later@...` -> `451
  4.3.0`, `vanish@...` -> the DATA is read and the socket closed without a reply (ambiguous).
- **Twilio mock** `scripts/test-mail/twilio-mock.mjs` (from `scratch/jobs-deploy-tests/sink/twilio-mock.mjs`). Exports
  `startTwilioMock({ port = 0 })` (run directly: `TWILIO_MOCK_PORT`, 3401). `POST /2010-04-01/Accounts/{sid}/Messages.json`
  (Basic auth checked against `TWILIO_MOCK_USER` / `TWILIO_MOCK_SECRET`, default `ACtest...` / `secret`, also an `SK...`
  user): numbers ending `0000` -> 400 code 21610; invalid `To` -> 21211; wrong secret -> 401 code 20003; ending `0003`
  -> the message is recorded and the connection destroyed (ambiguous). `GET` the same path with `To=` lists inbound
  messages, with `From=` outbound ones (`DateSent` filters honoured; `next_page_uri` after 1000). `GET
  /2010-04-01/Accounts/{sid}/Messages/{SID}.json` -> status `delivered`, or `undelivered` with 30034 for numbers ending
  `0001`. `GET /2010-04-01/Accounts/{sid}.json` -> 200. `POST /__inbound {From, To, Body, at?}` adds a reply;
  `GET/DELETE /__sent`.
- **Check scripts** `scripts/checks/*.check.ts`, run with `npm run check <file>` (= `tsx --conditions=react-server`):
  `node:assert/strict`, exit code non-zero on failure. `scripts/checks/lib.ts` exports `checkShop({ retail?, repair?,
  modules?: ("scheduling" | "marketing" | "vac")[], tz? })` (creates a company named `Check {run}` with an OWNER user
  and switches modules on with `grantDevLicense(shopId, modules)` from modules-design's `scripts/license/dev.ts`; no
  bypass in `module-gate.ts`), `linkPair(repairShopId, retailShopId)` (a `PartnerLink` pair with one id), `withSink()`,
  `withMock()` (ephemeral ports; set `SMTP_ALLOW_HOSTS` and `TWILIO_API_BASE` in `process.env` for the check),
  `messagingFor(shopId, { email?, sms? })` (writes settings pointing at the sink / mock, sealed secrets,
  `tzConfirmedAt`), and `cleanup()` (deletes the check companies; cascade). Clock injection: every scheduler and worker
  entry point takes `now`.
- **Playwright** (`@playwright/test`, `-c pw.qa.config.ts` in this container): `tests/helpers/messaging.ts`
  (`sinkMessages()`, `clearSink()`, `mockSent()`, `mockInbound(from, body)`, `sendNow(page)` = the Messages page's
  "Send now"; ports from `SMTP_SINK_HTTP` / `TWILIO_MOCK_PORT`), `tests/helpers/modules.ts` (`setModule(page, company,
  key, on)` through the Companies screen as the platform admin, as modules-design 12.1 says). Each spec: `const run =
  Date.now().toString(36).toUpperCase()`; its own login helper; creates its own retail company through `/companies`
  when it needs StitchShop.

### 16.3 Running (and running packages in parallel)

Each feature package works in its own git worktree, database and ports, so builds, workers and test servers never
share anything:

```bash
# once per package n / key (from the feature worktree, after foundation is merged)
git -C /home/user/stitchbench-feat worktree add ../stitchbench-feat-<key> -b feat/sm-<key> <foundation commit>
cd /home/user/stitchbench-feat-<key> && npm ci
psql "<server url>/postgres" -c 'CREATE DATABASE "stitchbench_feat_<key>"'
# .env: DATABASE_URL=.../stitchbench_feat_<key>; then
npx prisma migrate deploy && npx prisma generate && npm run e2e:setup

# terminal 1: sink + mock on this package's ports
SMTP_SINK_PORT=$((2525+n)) SMTP_SINK_HTTP=$((2580+n)) npm run mail:sink &
TWILIO_MOCK_PORT=$((3401+n)) npm run sms:mock &
# terminal 2: the package's test-build server
STITCH_TEST_BUILD=1 npm run build
SMTP_ALLOW_HOSTS=127.0.0.1:$((2525+n)) TWILIO_API_BASE=http://127.0.0.1:$((3401+n)) MESSAGE_WORKER_SECONDS=5 \
READY_NOTICE_DELAY_SECONDS=1 PUBLIC_URL=http://localhost:$((3500+n)) npx next start -p $((3500+n))
# terminal 3
E2E_BASE_URL=http://localhost:$((3500+n)) SMTP_SINK_HTTP=$((2580+n)) TWILIO_MOCK_PORT=$((3401+n)) \
  npx playwright test -c pw.qa.config.ts tests/<spec>.spec.ts
# check scripts: stop the server first, or start it with MESSAGES=off (the checks run the worker themselves)
npm run check scripts/checks/<name>.check.ts
```

- `PUBLIC_URL=http://...` is accepted from the environment for tests (`publicBaseUrl()` allows http only for
  `localhost` / `127.0.0.1`).
- Merging: packages merge into `feat/scheduling-messaging` one at a time; after each merge, `npx tsc --noEmit` and that
  package's spec run once more on the merged branch (one server at a time, port 3500).
- `e2e-docs` runs alone on the merged branch in `/home/user/stitchbench-feat` (ports 3500 / 3501, database
  `stitchbench_feat`).
- Ports 3100, 3400, 6733, 7975 and 8080 and anything under `/home/user/stitchbench` or `/home/user/stitchhub` belong
  to the running review: never use, change or stop them.

---

## 17. Open questions (decided as stated unless the owner says otherwise)

1. Trade-account and partner tickets get no automatic customer messages from the bench (rule 1). Should a trade
   account (a dealer) optionally get "ready" emails for machines that came through it?
2. StitchBench sends "ready" only for `READY_FOR_PICKUP`, not `READY_IN_TRUCK` (rule 2); StitchShop only once the
   machine is recorded back at its counter (rule 3).
3. Review requests, service-due and bags-due reminders are treated as marketing (written consent for texts,
   unsubscribe and postal address in email). This is the cautious reading; most of them will go by email.
4. Partner runs: only starting or changing a run needs Scheduling (on the shop doing it); OK-ing, cancelling and
   recording the hand-off never do. The side that scheduled a run is the only one that changes its plan; the other side
   OKs it or cancels it with a note.
5. Paying for or refunding an existing class or appointment at the register stays allowed while Scheduling is off.
6. Marketing messages older than 48 h wait for a person ("Send them") rather than going out automatically.
7. Waitlist promotion is by staff only (with an optional message); no automatic "a seat opened" message.
8. Not in this build: online self-booking, a two-way texting inbox, Twilio webhooks, an HTML email designer, campaigns
   scheduled for later, hand-picked campaign audiences, emailing staff their shifts.
9. The Windows program shows estimate links and one-click unsubscribe only when the install has a public address
   (`config.json` `publicUrl`, a tunnel the shop set up, pointed at the links port); otherwise "call or reply", and
   unsubscribing is by email reply. A later build could add a "Public address" dialog to the program's tray menu, or
   host Windows shops' links on the StitchHub (a hub change).
10. Uncollected-machine notices for partner jobs use the partnership's agreed `abandonedAfterDays`; direct tickets the
    shop's own.
11. Marketing texts are held to 12:00-20:00 Eastern (the overlap of 9:00-20:00 in every mainland zone) rather than
    working out each number's zone from its area code (numbers move with their owners; this is the safe reading).
12. If the modules package ends up with different names or shapes than `getModules / hasModule / requireModule /
    shopsWithModule`, only `src/lib/module-gate.ts` changes.

---

## Appendix A. `prisma/migrations/20260926150000_scheduling_messaging/migration.sql` (verbatim)

The output of `prisma migrate diff --from-schema modules-schema.prisma --to-schema schema.prisma --script` (Prisma 7.10,
re-run for this revision: identical) plus the one hand-written backfill at the end. Also in `migration.sql`.

```sql
-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "lastReviewAskAt" TIMESTAMP(3),
ADD COLUMN     "notifyBy" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "smsConsentAt" TIMESTAMP(3),
ADD COLUMN     "smsConsentPhone" TEXT,
ADD COLUMN     "smsConsentSource" TEXT,
ADD COLUMN     "smsConsentText" TEXT;

-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "serviceNoticeFor" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "pickupReadyAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "appointmentId" TEXT,
ADD COLUMN     "enrollmentId" TEXT;

-- AlterTable
ALTER TABLE "PartnerLink" ADD COLUMN     "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "featuresHash" TEXT;

-- AlterTable
ALTER TABLE "RepairJob" ADD COLUMN     "backAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PartnerRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "ownerSide" TEXT NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "driver" TEXT NOT NULL DEFAULT 'repair',
    "collect" TEXT[],
    "deliver" TEXT[],
    "collected" TEXT[],
    "collectedAt" TIMESTAMP(3),
    "delivered" TEXT[],
    "deliveredAt" TIMESTAMP(3),
    "note" TEXT,
    "okRev" INTEGER,
    "okAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "events" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerRun_pkey" PRIMARY KEY ("shopId","id")
);

-- CreateTable
CREATE TABLE "MessagingSettings" (
    "shopId" TEXT NOT NULL,
    "emailOn" BOOLEAN NOT NULL DEFAULT false,
    "smtpPreset" TEXT,
    "smtpHost" TEXT,
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "smtpSecurity" TEXT NOT NULL DEFAULT 'starttls',
    "smtpUser" TEXT,
    "smtpPassSealed" TEXT,
    "smtpPassSavedAt" TIMESTAMP(3),
    "fromName" TEXT,
    "fromEmail" TEXT,
    "replyTo" TEXT,
    "replyWatchedAt" TIMESTAMP(3),
    "replyWatchedBy" TEXT,
    "emailDailyCap" INTEGER NOT NULL DEFAULT 300,
    "smsOn" BOOLEAN NOT NULL DEFAULT false,
    "twilioSid" TEXT,
    "twilioKeySid" TEXT,
    "twilioTokenSealed" TEXT,
    "twilioTokenSavedAt" TIMESTAMP(3),
    "twilioFrom" TEXT,
    "smsDailyCap" INTEGER NOT NULL DEFAULT 300,
    "smsPartMills" INTEGER NOT NULL DEFAULT 11,
    "testPhones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "testPhonePending" TEXT,
    "testCodeHash" TEXT,
    "testCodeUntil" TIMESTAMP(3),
    "inboundAt" TIMESTAMP(3),
    "inboundIncomplete" INTEGER NOT NULL DEFAULT 0,
    "emailOkAt" TIMESTAMP(3),
    "emailError" TEXT,
    "emailPausedAt" TIMESTAMP(3),
    "emailPausedUntil" TIMESTAMP(3),
    "emailCheckAt" TIMESTAMP(3),
    "smsOkAt" TIMESTAMP(3),
    "smsError" TEXT,
    "smsPausedAt" TIMESTAMP(3),
    "smsPausedUntil" TIMESTAMP(3),
    "smsCheckAt" TIMESTAMP(3),
    "marketingHoldAt" TIMESTAMP(3),
    "textHoldAt" TIMESTAMP(3),
    "textHoldWhy" TEXT,
    "postalAddress" TEXT,
    "tzConfirmedAt" TIMESTAMP(3),
    "tzConfirmedBy" TEXT,
    "quietStart" INTEGER NOT NULL DEFAULT 540,
    "quietEnd" INTEGER NOT NULL DEFAULT 1200,
    "noSundayMarketing" BOOLEAN NOT NULL DEFAULT true,
    "smsConsentText" TEXT,
    "consentTexts" JSONB NOT NULL DEFAULT '[]',
    "readyNotice" BOOLEAN NOT NULL DEFAULT true,
    "reminders" BOOLEAN NOT NULL DEFAULT true,
    "reminderHour" INTEGER NOT NULL DEFAULT 10,
    "abandonNotices" BOOLEAN NOT NULL DEFAULT false,
    "abandonDays" INTEGER[] DEFAULT ARRAY[7, 30]::INTEGER[],
    "finalNoticeDays" INTEGER NOT NULL DEFAULT 7,
    "serviceDue" BOOLEAN NOT NULL DEFAULT false,
    "serviceDueMonths" INTEGER NOT NULL DEFAULT 12,
    "serviceDueSince" TIMESTAMP(3),
    "serviceDueDay" TEXT,
    "reviewRequest" BOOLEAN NOT NULL DEFAULT false,
    "reviewUrl" TEXT,
    "reviewDelayHours" INTEGER NOT NULL DEFAULT 24,
    "reviewEveryDays" INTEGER NOT NULL DEFAULT 180,
    "reviewAfterSales" BOOLEAN NOT NULL DEFAULT false,
    "estimateLinkDays" INTEGER NOT NULL DEFAULT 7,
    "templates" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingSettings_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "OutMessage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "customerId" TEXT,
    "address" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "dedupeKey" TEXT,
    "sendAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notAfter" TIMESTAMP(3),
    "tries" INTEGER NOT NULL DEFAULT 0,
    "retryTries" INTEGER NOT NULL DEFAULT 0,
    "nextTryAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerId" TEXT,
    "deliveryStatus" TEXT,
    "deliveryError" TEXT,
    "error" TEXT,
    "optOutToken" TEXT,
    "ticketId" TEXT,
    "repairJobId" TEXT,
    "campaignId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "byUserId" TEXT,
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "shopId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("shopId","channel","address")
);

-- CreateTable
CREATE TABLE "ConsentEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT,
    "channel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "address" TEXT,
    "source" TEXT NOT NULL,
    "detail" TEXT,
    "byUserId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundText" (
    "shopId" TEXT NOT NULL,
    "sid" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT,
    "keyword" TEXT,
    "handledAt" TIMESTAMP(3),
    "handledBy" TEXT,

    CONSTRAINT "InboundText_pkey" PRIMARY KEY ("shopId","sid")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "audience" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "members" JSONB NOT NULL DEFAULT '[]',
    "built" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "skipped" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "queuedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateLink" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenSealed" TEXT,
    "maskedUrl" TEXT NOT NULL,
    "ticketId" TEXT,
    "repairJobId" TEXT,
    "customerId" TEXT,
    "totalCents" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "answer" TEXT,
    "answerNote" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answerFrom" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "ShopClass" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "teacher" TEXT,
    "location" TEXT,
    "supplies" TEXT,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "seats" INTEGER NOT NULL,
    "waitlist" BOOLEAN NOT NULL DEFAULT true,
    "remind" TEXT NOT NULL DEFAULT 'every',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "firstAt" TIMESTAMP(3),
    "lastAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassMeeting" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,

    CONSTRAINT "ClassMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "attendee" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ENROLLED',
    "feeCents" INTEGER NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "paidCents" INTEGER,
    "paidAt" TIMESTAMP(3),
    "paidLineId" TEXT,
    "refundedCents" INTEGER,
    "refundedAt" TIMESTAMP(3),
    "refundLineId" TEXT,
    "note" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentType" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 60,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "resource" TEXT,
    "hours" JSONB NOT NULL DEFAULT '[]',
    "location" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "typeId" TEXT,
    "resource" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BOOKED',
    "staffId" TEXT,
    "ticketId" TEXT,
    "repairJobId" TEXT,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "paidCents" INTEGER,
    "paidAt" TIMESTAMP(3),
    "paidLineId" TEXT,
    "refundedCents" INTEGER,
    "refundedAt" TIMESTAMP(3),
    "refundLineId" TEXT,
    "note" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "role" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartnerRun_shopId_linkId_startsAt_idx" ON "PartnerRun"("shopId", "linkId", "startsAt");

-- CreateIndex
CREATE INDEX "PartnerRun_shopId_startsAt_idx" ON "PartnerRun"("shopId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutMessage_optOutToken_key" ON "OutMessage"("optOutToken");

-- CreateIndex
CREATE INDEX "OutMessage_status_sendAfter_idx" ON "OutMessage"("status", "sendAfter");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_status_sendAfter_idx" ON "OutMessage"("shopId", "status", "sendAfter");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_createdAt_idx" ON "OutMessage"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_customerId_idx" ON "OutMessage"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_ticketId_idx" ON "OutMessage"("shopId", "ticketId");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_repairJobId_idx" ON "OutMessage"("shopId", "repairJobId");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_address_sentAt_idx" ON "OutMessage"("shopId", "address", "sentAt");

-- CreateIndex
CREATE INDEX "OutMessage_campaignId_status_idx" ON "OutMessage"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OutMessage_shopId_dedupeKey_key" ON "OutMessage"("shopId", "dedupeKey");

-- CreateIndex
CREATE INDEX "ConsentEvent_shopId_customerId_at_idx" ON "ConsentEvent"("shopId", "customerId", "at");

-- CreateIndex
CREATE INDEX "ConsentEvent_shopId_at_idx" ON "ConsentEvent"("shopId", "at");

-- CreateIndex
CREATE INDEX "InboundText_shopId_receivedAt_idx" ON "InboundText"("shopId", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundText_shopId_fromNumber_receivedAt_idx" ON "InboundText"("shopId", "fromNumber", "receivedAt");

-- CreateIndex
CREATE INDEX "Campaign_shopId_createdAt_idx" ON "Campaign"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EstimateLink_tokenHash_key" ON "EstimateLink"("tokenHash");

-- CreateIndex
CREATE INDEX "EstimateLink_shopId_ticketId_idx" ON "EstimateLink"("shopId", "ticketId");

-- CreateIndex
CREATE INDEX "EstimateLink_shopId_repairJobId_idx" ON "EstimateLink"("shopId", "repairJobId");

-- CreateIndex
CREATE INDEX "EstimateLink_shopId_answeredAt_idx" ON "EstimateLink"("shopId", "answeredAt");

-- CreateIndex
CREATE INDEX "ShopClass_shopId_firstAt_idx" ON "ShopClass"("shopId", "firstAt");

-- CreateIndex
CREATE INDEX "ClassMeeting_shopId_startsAt_idx" ON "ClassMeeting"("shopId", "startsAt");

-- CreateIndex
CREATE INDEX "ClassMeeting_classId_startsAt_idx" ON "ClassMeeting"("classId", "startsAt");

-- CreateIndex
CREATE INDEX "Enrollment_classId_customerId_idx" ON "Enrollment"("classId", "customerId");

-- CreateIndex
CREATE INDEX "Enrollment_shopId_customerId_idx" ON "Enrollment"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "Enrollment_classId_status_createdAt_idx" ON "Enrollment"("classId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AppointmentType_shopId_sortOrder_idx" ON "AppointmentType"("shopId", "sortOrder");

-- CreateIndex
CREATE INDEX "Appointment_shopId_startsAt_idx" ON "Appointment"("shopId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_shopId_customerId_idx" ON "Appointment"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "Appointment_typeId_startsAt_idx" ON "Appointment"("typeId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_shopId_resource_startsAt_idx" ON "Appointment"("shopId", "resource", "startsAt");

-- CreateIndex
CREATE INDEX "Shift_shopId_startsAt_idx" ON "Shift"("shopId", "startsAt");

-- CreateIndex
CREATE INDEX "Shift_userId_startsAt_idx" ON "Shift"("userId", "startsAt");

-- CreateIndex
CREATE INDEX "Ticket_shopId_machineId_intakeAt_idx" ON "Ticket"("shopId", "machineId", "intakeAt");

-- CreateIndex
CREATE INDEX "SaleLine_enrollmentId_idx" ON "SaleLine"("enrollmentId");

-- CreateIndex
CREATE INDEX "SaleLine_appointmentId_idx" ON "SaleLine"("appointmentId");

-- CreateIndex
CREATE INDEX "RepairJob_shopId_machineId_idx" ON "RepairJob"("shopId", "machineId");

-- AddForeignKey
ALTER TABLE "PartnerRun" ADD CONSTRAINT "PartnerRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagingSettings" ADD CONSTRAINT "MessagingSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutMessage" ADD CONSTRAINT "OutMessage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutMessage" ADD CONSTRAINT "OutMessage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutMessage" ADD CONSTRAINT "OutMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundText" ADD CONSTRAINT "InboundText_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateLink" ADD CONSTRAINT "EstimateLink_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopClass" ADD CONSTRAINT "ShopClass_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassMeeting" ADD CONSTRAINT "ClassMeeting_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassMeeting" ADD CONSTRAINT "ClassMeeting_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ShopClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ShopClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentType" ADD CONSTRAINT "AppointmentType_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "AppointmentType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill (hand-written): machines already on the pickup shelf count from when they became ready
UPDATE "Ticket" SET "pickupReadyAt" = "readyAt" WHERE "status" = 'READY_FOR_PICKUP' AND "pickupReadyAt" IS NULL;
```

## Appendix B. New models (append to the end of `prisma/schema.prisma`; also in `schema-additions.prisma`)

```prisma
// ============================================================
// Scheduling and messages (design.md). Times are instants; each shop shows them in its own Shop.timeZone.
// ============================================================

// A pickup / drop-off run between partner shops: machines going to the repair shop and fixed ones coming back. Same id
// on both sides. The side that scheduled it (ownerSide) changes the plan; the other side can OK it or cancel it. Each
// side records only what it received: the repair side `collected` (the driver took these), the retail side
// `delivered` (these reached our counter). src/lib/partner-runs.ts
model PartnerRun {
  id          String
  shopId      String
  shop        Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  linkId      String
  status      String    @default("SCHEDULED") // SCHEDULED | CANCELLED | DONE
  ownerSide   String // repair | retail: the side that scheduled it and changes the plan
  rev         Int       @default(1) // plan revision; only ownerSide raises it
  startsAt    DateTime
  endsAt      DateTime?
  driver      String    @default("repair") // which shop drives: repair | retail
  collect     String[] // planned: RepairJob ids going to the repair shop
  deliver     String[] // planned: RepairJob ids coming back
  collected   String[] // recorded by the repair side: what the driver took
  collectedAt DateTime?
  delivered   String[] // recorded by the retail side: what reached its counter
  deliveredAt DateTime?
  note        String?
  okRev       Int? // the plan revision the other side OK'd
  okAt        DateTime?
  cancelledAt DateTime?
  events      Json      @default("[]") // [{ at, side, what, name?, note? }]
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@id([shopId, id])
  @@index([shopId, linkId, startsAt])
  @@index([shopId, startsAt])
}

// A company's message settings (Settings -> Messages). The mail password and the Twilio token / API key secret are
// sealed with the server's key (src/lib/messaging/secrets.ts) and never sent to the browser.
model MessagingSettings {
  shopId             String    @id
  shop               Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  // Email: the shop's own mailbox (Gmail / Outlook app password) or a relay (SES, SendGrid, Mailgun, Brevo)
  emailOn            Boolean   @default(false)
  smtpPreset         String? // gmail | outlook | m365 | yahoo | sendgrid | mailgun | brevo | ses | other
  smtpHost           String?
  smtpPort           Int       @default(587)
  smtpSecurity       String    @default("starttls") // starttls | tls | none (a mail server on the shop's own network; Windows program only)
  smtpUser           String?
  smtpPassSealed     String?
  smtpPassSavedAt    DateTime?
  fromName           String?
  fromEmail          String?
  replyTo            String?
  replyWatchedAt     DateTime? // an admin said someone reads replyTo at least weekly (needed for marketing email)
  replyWatchedBy     String?
  emailDailyCap      Int       @default(300) // marketing emails a shop-day at most (a Gmail account allows about 500)
  // Texts: Twilio. The Account SID, and either the Auth Token or an API key (SK...) and its secret
  smsOn              Boolean   @default(false)
  twilioSid          String? // AC...
  twilioKeySid       String? // SK... when an API key is used (recommended); its secret is in twilioTokenSealed
  twilioTokenSealed  String?
  twilioTokenSavedAt DateTime?
  twilioFrom         String? // the shop's Twilio number, +15551234567
  smsDailyCap        Int       @default(300) // marketing texts a shop-day at most
  smsPartMills       Int       @default(11) // what Twilio charges per text part, in tenths of a cent (cost hints only)
  // Test texts go only to numbers an admin proved they hold (a code was texted to the number)
  testPhones         String[]  @default([])
  testPhonePending   String?
  testCodeHash       String?
  testCodeUntil      DateTime?
  // Text replies (STOP, START, HELP) are read up to here; a read that didn't finish starts again from here
  inboundAt          DateTime?
  inboundIncomplete  Int       @default(0)
  // How sending is going. A channel pauses on a wrong password or token, a daily quota, or a server refusing mail
  emailOkAt          DateTime?
  emailError         String?
  emailPausedAt      DateTime?
  emailPausedUntil   DateTime? // set: resumes by itself then (a quota); null: when saved again or the hourly check passes
  emailCheckAt       DateTime? // next automatic check of a paused channel
  smsOkAt            DateTime?
  smsError           String?
  smsPausedAt        DateTime?
  smsPausedUntil     DateTime?
  smsCheckAt         DateTime?
  // Marketing held until an admin has looked: every marketing message after a restore; marketing texts when replies
  // (STOP) couldn't all be read
  marketingHoldAt    DateTime?
  textHoldAt         DateTime?
  textHoldWhy        String?
  // The law's parts
  postalAddress      String?
  tzConfirmedAt      DateTime? // an admin confirmed Shop.timeZone (needed before any text goes out)
  tzConfirmedBy      String?
  quietStart         Int       @default(540) // 9:00, minutes after midnight, shop time
  quietEnd           Int       @default(1200) // 20:00
  noSundayMarketing  Boolean   @default(true)
  smsConsentText     String? // the words customers agree to for marketing texts (a default when empty)
  consentTexts       Json      @default("[]") // earlier wordings [{ code, text, from, to }] for signed paper forms
  // Automatic messages
  readyNotice        Boolean   @default(true)
  reminders          Boolean   @default(true)
  reminderHour       Int       @default(10) // reminders go out from this hour the day before, shop time
  abandonNotices     Boolean   @default(false)
  abandonDays        Int[]     @default([7, 30]) // days after ready; the final notice goes finalNoticeDays before the abandon date
  finalNoticeDays    Int       @default(7)
  serviceDue         Boolean   @default(false)
  serviceDueMonths   Int       @default(12)
  serviceDueSince    DateTime? // when it was switched on: machines due before then go through a campaign instead
  serviceDueDay      String? // the shop day ("2026-10-07") it last ran
  reviewRequest      Boolean   @default(false)
  reviewUrl          String?
  reviewDelayHours   Int       @default(24)
  reviewEveryDays    Int       @default(180)
  reviewAfterSales   Boolean   @default(false)
  estimateLinkDays   Int       @default(7)
  // Wording of the automatic messages, { "<key>.sms" | "<key>.email" | "<key>.subject": text }; missing = default
  templates          Json      @default("{}")
  updatedAt          DateTime  @updatedAt
}

// Every email and text: waiting, sent, or not sent and why. Also the proof a notice went out (date, channel, words).
model OutMessage {
  id             String    @id @default(cuid())
  shopId         String
  shop           Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  channel        String // email | sms (sent from here); letter | certified_mail | phone (a notice given by hand, recorded as proof: status SENT)
  purpose        String // notice | marketing
  kind           String // MESSAGE_KIND_LABEL in src/lib/constants.ts
  customerId     String?
  customer       Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)
  address        String // the email address or +1 number, fixed when queued ("by hand" for a letter without one)
  subject        String?
  body           String // what goes out; an estimate link is kept masked here and put in by the worker at send time
  status         String    @default("QUEUED") // QUEUED | SENDING | SENT | FAILED | SKIPPED | CANCELLED | EXPIRED
  dedupeKey      String? // the same key is queued once per shop
  sendAfter      DateTime  @default(now())
  notAfter       DateTime? // never sent after this (a reminder two hours before the class)
  tries          Int       @default(0) // times claimed for sending
  retryTries     Int       @default(0) // failures that count toward giving up ("offline" doesn't)
  nextTryAt      DateTime?
  claimedAt      DateTime?
  sentAt         DateTime? // when it went (given by hand: the date it was given)
  providerId     String? // Twilio SID, the email's Message-ID, or a certified-mail tracking number
  deliveryStatus String? // texts: Twilio's final word (delivered | undelivered | failed)
  deliveryError  String?
  error          String?
  optOutToken    String?   @unique // random token in a marketing email's unsubscribe link (it can only unsubscribe that address)
  // What it's about (plain ids)
  ticketId       String?
  repairJobId    String?
  campaignId     String?
  campaign       Campaign? @relation(fields: [campaignId], references: [id], onDelete: SetNull)
  refType        String? // meeting | appointment | enrollment | estimate | machine | stage | class
  refId          String?
  byUserId       String? // who sent or recorded it by hand; null = automatic
  cancelledById  String?
  createdAt      DateTime  @default(now())

  @@unique([shopId, dedupeKey])
  @@index([status, sendAfter])
  @@index([shopId, status, sendAfter])
  @@index([shopId, createdAt])
  @@index([shopId, customerId])
  @@index([shopId, ticketId])
  @@index([shopId, repairJobId])
  @@index([shopId, address, sentAt])
  @@index([campaignId, status])
}

// Addresses that get no messages: a text STOP (nothing at all, not even reminders) or an email unsubscribe (no
// marketing). Kept by address so it holds for a customer entered twice or with a changed record. Never purged.
model Suppression {
  shopId  String
  shop    Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  channel String // email | sms
  address String // lower-case email, or +1 number
  scope   String // marketing | all
  source  String // CONSENT_SOURCE_LABEL
  at      DateTime @default(now())

  @@id([shopId, channel, address])
}

// The consent record the law asks a shop to keep: every opt-in, opt-out and preference change, never edited or purged.
model ConsentEvent {
  id         String    @id @default(cuid())
  shopId     String
  shop       Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  customerId String?
  customer   Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)
  channel    String // email | sms; any for notify_pref
  event      String // CONSENT_EVENT_LABEL: marketing_yes | marketing_no | notify_pref | optout | optin | help
  address    String? // the email or number it applies to
  source     String // CONSENT_SOURCE_LABEL
  detail     String? // the words agreed to, the reply as sent, the new preference
  byUserId   String?
  at         DateTime  @default(now())

  @@index([shopId, customerId, at])
  @@index([shopId, at])
}

// Texts customers sent to the shop's Twilio number, read every few minutes. STOP / START / HELP are acted on; the
// rest wait for someone to read them (and hold marketing texts to that number until they have).
model InboundText {
  shopId     String
  shop       Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  sid        String // Twilio's message SID
  fromNumber String
  body       String
  receivedAt DateTime
  customerId String? // plain id: a customer with this number, when there is one
  keyword    String? // STOP | START | HELP | STOPLIKE (a stop in other words)
  handledAt  DateTime?
  handledBy  String?

  @@id([shopId, sid])
  @@index([shopId, receivedAt])
  @@index([shopId, fromNumber, receivedAt])
}

// A marketing message to a group of customers (sent now; the worker turns members into messages in batches).
model Campaign {
  id          String       @id @default(cuid())
  shopId      String
  shop        Shop         @relation(fields: [shopId], references: [id], onDelete: Cascade)
  name        String
  channel     String // email | sms
  subject     String?
  body        String
  audience    Json // Audience in src/lib/messaging/audiences.ts
  status      String       @default("DRAFT") // DRAFT | QUEUING | SENDING | SENT | CANCELLED
  members     Json         @default("[]") // customer ids picked when it was sent
  built       Int          @default(0) // how many members have been turned into messages
  queuedAt    DateTime?
  finishedAt  DateTime?
  recipients  Int          @default(0) // messages queued
  skipped     Json         @default("{}") // { reason: count }
  createdById String?
  queuedById  String?
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  messages    OutMessage[]

  @@index([shopId, createdAt])
  @@index([status])
}

// A link a customer opens to see an estimate and approve or decline it. Only the token's hash is kept for lookups; the
// token itself stays sealed only until the messages carrying it have gone out.
model EstimateLink {
  id          String    @id @default(cuid())
  shopId      String
  shop        Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  tokenHash   String    @unique
  tokenSealed String?
  maskedUrl   String // how the link appears in stored message bodies, e.g. https://.../e/•••Xk3q
  ticketId    String? // a StitchBench ticket (plain id, always checked with shopId)
  repairJobId String? // or a partner repair job, the sewing shop's side
  customerId  String?
  totalCents  Int // the estimate as shown; a changed bill needs a new link
  lines       Json // [{ description, amountCents }] as shown
  note        String? // what the shop wrote with it
  expiresAt   DateTime
  answer      String? // APPROVED | DECLINED
  answerNote  String?
  answeredAt  DateTime?
  answerFrom  String? // the client address when a trusted proxy reports it, and the browser
  revokedAt   DateTime?
  createdById String?
  createdAt   DateTime  @default(now())

  @@index([shopId, ticketId])
  @@index([shopId, repairJobId])
  @@index([shopId, answeredAt])
}

// One copy of a background job at a time across every server process on this install (src/lib/lease.ts).
model JobLease {
  name   String   @id
  holder String // hostname:pid
  until  DateTime
}

// A class, workshop or club: one or more meetings, a seat limit, a fee rung up at the register.
model ShopClass {
  id          String         @id @default(cuid())
  shopId      String
  shop        Shop           @relation(fields: [shopId], references: [id], onDelete: Cascade)
  title       String
  description String?
  teacher     String?
  location    String?
  supplies    String? // supply list: on the roster, the sign-up message and the reminder
  feeCents    Int            @default(0)
  taxable     Boolean        @default(false)
  seats       Int
  waitlist    Boolean        @default(true)
  remind      String         @default("every") // day-before reminders: every | first (meeting only) | never
  status      String         @default("OPEN") // OPEN | CLOSED (no more sign-ups) | CANCELLED
  firstAt     DateTime? // first and last meeting, kept in step by the actions (for lists)
  lastAt      DateTime?
  createdById String?
  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt
  meetings    ClassMeeting[]
  enrollments Enrollment[]

  @@index([shopId, firstAt])
}

model ClassMeeting {
  id        String    @id @default(cuid())
  shopId    String
  shop      Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  classId   String
  shopClass ShopClass @relation(fields: [classId], references: [id], onDelete: Cascade)
  startsAt  DateTime
  endsAt    DateTime
  cancelled Boolean   @default(false)
  note      String?

  @@index([shopId, startsAt])
  @@index([classId, startsAt])
}

// Someone signed up for a class (or waiting for a seat). One row per sign-up: signing up again after a cancel makes a
// new row. Paid and refunded at the register.
model Enrollment {
  id            String    @id @default(cuid())
  shopId        String
  shop          Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  classId       String
  shopClass     ShopClass @relation(fields: [classId], references: [id], onDelete: Cascade)
  customerId    String?
  customer      Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)
  name          String // the customer's name when they signed up (the roster keeps it)
  attendee      String? // who's coming when it isn't the customer (a child, a friend)
  status        String    @default("ENROLLED") // ENROLLED | WAITLIST | CANCELLED
  feeCents      Int // the price for this person
  taxable       Boolean   @default(false)
  paidCents     Int?
  paidAt        DateTime?
  paidLineId    String? // the register sale line that paid it
  refundedCents Int?
  refundedAt    DateTime?
  refundLineId  String?
  note          String?
  cancelledAt   DateTime?
  createdById   String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@index([classId, customerId])
  @@index([shopId, customerId])
  @@index([classId, status, createdAt])
}

// Something customers book a time for: a lesson, longarm rental, a machine drop-off or pickup.
model AppointmentType {
  id           String        @id @default(cuid())
  shopId       String
  shop         Shop          @relation(fields: [shopId], references: [id], onDelete: Cascade)
  name         String
  minutes      Int           @default(60)
  feeCents     Int           @default(0)
  taxable      Boolean       @default(false)
  capacity     Int           @default(1) // bookings at the same time (two longarms: 2); shared by types with the same resource
  resource     String? // what it uses up, e.g. "Longarm": types naming the same resource share its capacity
  // When it can be booked: [{ day: 0-6 (Sunday 0), from: "10:00", to: "17:00" }]; empty = any time
  hours        Json          @default("[]")
  location     String?
  active       Boolean       @default(true)
  sortOrder    Int           @default(0)
  createdAt    DateTime      @default(now())
  appointments Appointment[]

  @@index([shopId, sortOrder])
}

model Appointment {
  id            String           @id @default(cuid())
  shopId        String
  shop          Shop             @relation(fields: [shopId], references: [id], onDelete: Cascade)
  typeId        String?
  type          AppointmentType? @relation(fields: [typeId], references: [id], onDelete: SetNull)
  resource      String? // the type's resource when booked (capacity is counted per resource)
  blocked       Boolean          @default(false) // "Block this time": no customer, holds the resource
  customerId    String?
  customer      Customer?        @relation(fields: [customerId], references: [id], onDelete: SetNull)
  name          String // who it's for, as booked ("" when blocked)
  title         String // the type's name when booked, or the reason for a block
  startsAt      DateTime
  endsAt        DateTime
  status        String           @default("BOOKED") // BOOKED | DONE | NO_SHOW | CANCELLED
  staffId       String?
  staff         User?            @relation(fields: [staffId], references: [id], onDelete: SetNull)
  ticketId      String? // a machine drop-off or pickup: the StitchBench ticket (plain id)
  repairJobId   String? // or the partner repair job, the sewing shop's side (plain id)
  feeCents      Int              @default(0)
  taxable       Boolean          @default(false)
  paidCents     Int?
  paidAt        DateTime?
  paidLineId    String?
  refundedCents Int?
  refundedAt    DateTime?
  refundLineId  String?
  note          String?
  cancelledAt   DateTime?
  createdById   String?
  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt

  @@index([shopId, startsAt])
  @@index([shopId, customerId])
  @@index([typeId, startsAt])
  @@index([shopId, resource, startsAt])
}

// Who works the counter when. The person may have no login: name is always set (a snapshot for users).
model Shift {
  id          String   @id @default(cuid())
  shopId      String
  shop        Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  userId      String?
  user        User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  name        String
  startsAt    DateTime
  endsAt      DateTime
  role        String? // Counter, Classroom, Longarm... (free text)
  note        String?
  createdById String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([shopId, startsAt])
  @@index([userId, startsAt])
}
```

---

## Review log (revision 2)

Three reviews of revision 1: security-compliance (S), correctness-ops (O), product-ux (U). Each point is listed with
what happened. "Accepted" = done as the reviewer asked, in the section named. "Accepted, changed" = the problem is
fixed a different way (why in one line). "Rejected" = not done (why in one line). Claims were checked against
`/home/user/stitchbench-feat` at `9ba25a4` where they depended on the code. The owner's decisions are unchanged.

### Security-compliance

| # | Point | Outcome |
|---|---|---|
| S1 | Windows public address exposes the whole app; unsubscribe breaks when the PC is off | Accepted, changed: the per-shop `publicUrl` column is gone; the address is install-level (`PUBLIC_URL`; on Windows `config.json` `publicUrl`), locked to the public paths by `src/proxy.ts` AND, on Windows, by a links gate on its own `127.0.0.1` port (2.3, 14.2) so a tunnel that rewrites Host can't fail open; server actions (`next-action`) are refused on that address, which the review missed (Next forwards them to the login form's worker). Windows unsubscribing is by reply (`mailto:` first, no one-click header). Kept as an option rather than cut because the owner's addendum asks for estimate links where a public address is configured |
| S2 | Reading STOP replies is module-gated and can skip replies | Accepted (4.3 step 3, `inbound.ts`): read for every shop with Twilio set up; no 30-day cap; the watermark moves one fully read day at a time; incomplete reads set `textHoldAt`; the 45-day check is in `worker.check.ts` |
| S3a | Quiet hours must use the recipient's zone | Accepted, changed: marketing texts must fit the window in every mainland zone (plus Alaska / Hawaii for 907 / 808) instead of an area-code table: stricter, and numbers move with their owners (`quiet.ts`) |
| S3b | Per-recipient caps; `smsDailyCap`; US numbers only | Accepted: marketing texts 1 per number per 24 h and 4 per 30 days, `smsDailyCap`, `not_us` (3.2, 3.3, 4.3) |
| S3c | All texts at most 3 per 24 h, notices included | Rejected: the state 3-per-24-h rules cover solicitations (marketing is already capped at 1 a day); delaying a reminder or ready notice would make it late; staff-triggered notices are capped at 3 a day |
| S4 | Estimate token stored in the message body | Accepted: bodies hold `maskedUrl`; the token is sealed in `EstimateLink.tokenSealed` until sent, then cleared; checked (10.1, 4.3 step 8.7, 15.3) |
| S5 | First `X-Forwarded-For` hop; unbounded rate-limit map | Accepted: `src/lib/client-ip.ts` (the existing last-hop, `TRUST_PROXY` logic), an `anon` bucket and a global public-POST cap, 50 000-key eviction (4.1) |
| S6 | Test sends bypass consent and quiet hours | Accepted: own addresses and code-confirmed test numbers only, sample values only, quiet hours apply (8.1, 11.2) |
| S7 | Hosted SMTP: direct-to-MX, DNS rebinding, port probing | Accepted: ports 465 / 587 / 2525, login required, every connection checked and pinned to the checked address, `verify` rate-limited, fixed error words (4.1 `smtp.ts`, 14.2) |
| S8 | Uncollected-machine notices count from the first `readyAt` | Accepted: `Ticket.pickupReadyAt` (set on every entry to `READY_FOR_PICKUP`, cleared on leaving); retail jobs count from `backAt` only (the machine at our counter, per U21, not `backAt ?? readyAt`); backdating limits, `certified_mail` channel, the state-law line (9.3, 9.5) |
| S9 | A restore drops opt-outs | Accepted, changed: `restore()` reads the live `Suppression` and newer `ConsentEvent` rows before the TRUNCATE and puts them back, re-applies withdrawn consent and "no messages", and holds marketing until an admin resumes (2.3). No separate journal file: the live database already holds every opt-out at restore time, and a lost database usually means a lost `%APPDATA%` too |
| S10a | `SETTINGS_KEY` rotation | Accepted: required on hosted production builds, `kid` in the sealed format, `SETTINGS_KEY_PREVIOUS`, re-seal on use (4.1 `secrets.ts`) |
| S10b | Passwords typed over plain-http LAN | Accepted: secrets only from the PC itself (`isLocalRequest`, also refusing proxied requests) (4.2) |
| S10c | Twilio Auth Token is the master key | Accepted: API key SID + secret supported and recommended (4.1 `twilio.ts`, 8.1) |
| S10d | nodemailer logging, GCM tag length, hint columns | Accepted: `logger: false, debug: false`, `authTagLength: 16`, no `*Hint` columns (4.1, 2.1) |
| S11 | Consent wording, confirmation text, tablet page, paper form code | Accepted: new default wording and checks, `consent_confirm` text, `/consent/[customerId]` outside `(app)`, wording code on the paper form (3.3, 8.2, 8.3) |
| S12 | HELP, START / YES, long replies | Accepted: shop-named HELP reply once a day; only START / UNSTOP lift any suppression, YES only a reply / carrier one (what Twilio itself lifts); every reply scanned; unhandled replies hold marketing texts and show a badge (4.1 `inbound.ts`, 6.2) |
| S13 | Email-reply unsubscribes have no process | Accepted where the reply is the mechanism (no public address): watched reply-to required, `unsubscribe {token}` subject, the Opt-outs form resolves it, weekly banner (3.3, 8.2) |
| S14 | Header and content injection | Accepted: strict `validEmail`, address objects, subjects cleaned after merge, single-pass `render`, `cleanText` strips links from untrusted values, preview before sending an estimate, no `dangerouslySetInnerHTML` (4.1, 5, 10.5) |
| S15 | Partner run effects not scoped to the link | Accepted: every effect looks jobs up by `{ shopId, linkId, side, id: { in } }`; checked (13.2, 15.9) |
| S16 | Staff-triggered notices can carry marketing | Accepted: 3 per address per 24 h, the "only about this class" tick, STOP line on class / booking texts, 3 estimate sends per ticket per day (3.3, 12.1, 10.1) |
| S17 | `MESSAGES=off` doesn't stop every path | Accepted (4.3, checked in `worker.check.ts`) |
| S18 | Role and classification gaps | Accepted: `sendNoticeNow` abandon admin-only, `cancelMessage` of an abandon notice admin-only with `cancelledById`, `trade` skip reason, re-reads with `{ id, shopId }` (8.1, 9.4, 9.5, 3.2) |
| S19a | Retention minimums | Accepted (14.2; INSTALL.md in 15.10) |
| S19b | Serve public links from a separate domain | Accepted, changed: supported and recommended (`PUBLIC_URL` on a links domain + `PUBLIC_LINKS_ONLY`), not required: one Railway service with one domain must keep working |
| S-cut | Per-shop public address | Accepted (removed); the install-level address stays (see S1) |
| S-cut | Free-typed test recipients; `*Hint` columns | Accepted (removed) |
| S-cut | YES as an opt-in keyword | Rejected as a full cut: YES lifts only a reply / carrier STOP, matching Twilio's own opt-in keywords, so the app never stays stricter than the carrier's block list in a confusing way nor looser than it |
| S-cut | Review and service-due by email only | Rejected: S3 and S11 are built in this same foundation and checked by its acceptance, which was the stated condition |

### Correctness-ops

| # | Point | Outcome |
|---|---|---|
| O1 | Ready clock from the first `readyAt`; dedupe keys collide; retail start moves | Accepted: `pickupReadyAt` (tickets) and `backAt` (retail jobs) drive keys and stages; a new ready spell gets a new key; backfill statement in the migration (acceptance item 1 relaxed) and in `FIXUPS` (2.2, 2.3, 9.2) |
| O2 | Status races; double answers; `createTicket` status | Accepted: guarded `updateMany` in `changeTicketStatus`, guarded `answerRetailEstimate`, `createTicket` status list (4.1, 7.2) |
| O3 | Send-error mapping | Accepted: enhanced status codes, `quota` pauses to the next shop-day, 4xx retries and stops the channel for the run, 4xx `EAUTH` retries, the Twilio codes as listed, a 3-failure breaker, `retryTries` separate from `tries`, hourly re-check of paused channels, Dashboard / sidebar notices (4.1, 4.3, 9.5) |
| O4 | Ambiguous sends duplicated | Accepted: `SMTPConnection` driven directly so the stage is known; Twilio `findSent` before a retry (4.1, 4.3) |
| O5 | "SENT" isn't delivery | Accepted: `deliveryStatus` / `deliveryError`, `pollDelivery`, undelivered treated as not given on the notice schedule, pause after 5 carrier blocks (4.1, 9.5) |
| O6 | Daily cap vs the 48 h hold | Accepted, changed: capped rows move to the next shop-day; campaigns refused over 7 days at the cap (not 3: a 300-a-day Gmail shop could otherwise not reach 1 000 people; U10 asked for 14) |
| O7 | Campaign rows built in the request | Accepted: built by the worker 500 at a time, dedupe by address, 5 000-character bodies, SENT by a sweep (11.1) |
| O8 | Restore wipes opt-outs; the fix-up cancels notices | Accepted (2.3) |
| O9 | Reminders say "tomorrow" on the day | Accepted, changed: no "tomorrow" in any wording (`{when}` carries the date), `notAfter` = start - 2 h, reminders skipped for bookings made less than 24 h before; `stillWanted` compares the start in the key (U7 asked for the late-but-before-start window) |
| O10 | `Shop.timeZone` defaults to New York | Accepted: texts need `tzConfirmedAt`; the Windows program offers the PC's zone in that confirmation (8.1, 8.3) |
| O11 | Reply polling can miss replies after a big campaign | Accepted: no page cap within the time budget, per-day watermark, every minute during and 24 h after a text campaign, every shop with Twilio (4.3 step 3) |
| O12 | Capacity per type double-books one longarm | Accepted: `AppointmentType.resource`, capacity per resource, lock key per resource (12.2) |
| O13 | Waitlist order; re-enrol reuses rows; cancelled classes payable | Accepted: no unique key, new row per sign-up, waiting list first unless an admin skips it, seat and status changes under the class lock, pay refused for a cancelled class (12.1, 12.3) |
| O14 | Run DONE last-writer-wins | Accepted: per-side received lists, a single writer for the plan, limits checked against the message's own time (13) |
| O15 | Gates block custody records | Accepted: OK / cancel / record need no module (6.3, 13.5) |
| O16 | Hand-recorded notices don't stop automatic ones; late floods | Accepted: stage lookup by `refType "stage"` + `refId`; `sendable()` never sends a stage more than 7 days late or after the abandon date (9.1, 9.3) |
| O17 | Service-due backlog, duplicates, cap, cost | Accepted: `serviceDueSince` / 60-day floor, one message per customer, cap counts QUEUED / SENDING / SENT, once per shop-day, two new indexes (4.1, 9.3) |
| O18 | Worker throughput, SMTP connections, IPv6 | Accepted: rotating start shop, 20 s per shop, one SMTP session per shop per run, IPv4 first and every checked address tried, pinning under hosted rules, 24 h offline -> settings on hosted, Railway note (4.1, 4.3, 14.1) |
| O19 | Test sends race the worker | Accepted: test rows inserted as `SENDING`, recovered as FAILED (4.1, 4.3) |
| O20a | Parallel packages share `.next`, ports, database, worker | Accepted: one worktree, database and port set per package, checks on ephemeral ports with no competing worker, e2e one at a time after each merge (16.3) |
| O20b | Unspecified modules test helper | Accepted: `checkShop({ modules })` uses modules-design's `grantDevLicense`; `setModule()` for Playwright (16.2) |
| O20c | Split foundation into core + messaging-ui | Rejected: the build brief puts the messaging settings UI and consent fields in foundation, alone and first |
| O21 | Hooks open a second connection inside a transaction | Accepted: `hookContext()` computed before every transaction (1, 4.1, 7.1) |
| O22 | A second estimate on a partner job can't be sent | Accepted: `job.update` resets `approval` on re-entering `WAITING_CUSTOMER_OK` (7.2 #4) |
| O23 | "The shop sees it immediately" not met | Accepted: `AutoRefresh` on ticket and job pages while a link is open (10.5) |
| O24 | Lease after restart; SKIPPED keys; worker index; run reset by `cancelJob`; link scanners | Accepted: `hostname:pid` holders cleaned at start; `:{channel}:skipped`; `OutMessage(shopId, status, sendAfter)`; runs aren't rewritten by `cancelJob`; approval needs a separate confirm step with a POST (changed from a checkbox: a scanner that follows links never POSTs) |
| O-cut | Scheduled campaigns; `emailWeek`; `staff_alert`; hand-picked audience; two-sided run editing | Accepted (removed) |
| O-cut | Review requests after register sales | Rejected: the owner's addendum says "after a repair is picked up (or a register sale)"; it stays an off-by-default switch |
| O-cut | The `classes` audience | Rejected: it is the core of a quilt-shop newsletter (U29) and is one query |
| O-cut | `DashboardEstimatesSlot` | Rejected: it became `EstimatesTodoSlot`, how the counter sees link answers and unanswered estimates (owner: "the shop sees it immediately"; U23) |
| O-cut | One of `RepairsRunsSlot` / `DashboardRunsSlot` | Rejected: they are for different products (StitchShop `/repairs`, StitchBench Dashboard) |
| O-cut | Service-due for retail partner jobs | Rejected: a sewing shop's services are its partner repair jobs; without them StitchShop gets no service-due reminders at all |
| O-cut | Replies "Handled" workflow | Rejected: unhandled replies hold marketing texts to that number (FCC revocation by any reasonable means, S12), so staff need a way to release them |

### Product-ux

| # | Point | Outcome |
|---|---|---|
| U1 | Runs need Scheduling on both shops | Accepted: only proposing / changing needs it on the acting shop; `pushFeatures` advertises by code version (6.3, 13.4, 13.5) |
| U2 | Text replies go unseen | Accepted: replies on the ticket / job estimate slots with answer buttons, nav badge, Dashboard / register line, new copy (6.2, 9.5, 10.5) |
| U3 | No hint what setting Ready sends | Accepted: `setStatus` returns a note for the toast; "Don't send" on a queued ready notice (7.2, 9.2, 9.5) |
| U4 | Ready notices skipped for most customers | Accepted: required "how should we tell them" when Marketing is on and a channel is ready; one-tap "They said: ..." (4.1 `NotifyByField`, 8.3, 9.5) |
| U5 | Can't sign up for a class at the register | Accepted: "Sign up for a class" in the register picker, `enrollAtRegister`, `router.replace` after a preload (12.1, 12.3) |
| U6 | No sign-up / booking confirmation | Accepted: `class_signup.*` / `booking.*` templates, `tell` ticked by default (5, 12) |
| U7 | Reminders wrong or missed | Accepted: window up to 2 h before, no "tomorrow", per-class reminder setting (9.3) |
| U8 | Late "final notice"; no letter; no to-do | Accepted: `sendable()` window, "Print as a letter" with "Mailed today", "notices to send by hand" on the Dashboard / register (9.1, 9.5) |
| U9 | Service-due floods the backlog | Accepted: only machines due after the switch-on (or the last 60 days); `{months}` is the real count (9.3) |
| U10 | Big campaigns stall at the cap | Accepted, changed: the worker carries the rest to the next shop-day; the page shows "Goes out over N days"; limit 7 days (see O6) |
| U11 | "How to tell them" editable twice | Accepted: edited only in `CustomerForm`; `CustomerMessages` shows it read-only (8.3) |
| U12 | Tablet page shows the whole app | Accepted: `/consent/[customerId]` outside `(app)` (8.3) |
| U13 | Shifts only for people with a login | Accepted: `Shift.userId` optional, `name` always (12.4) |
| U14 | One customer can't sign up two people | Accepted: `Enrollment.attendee`, no unique key (12.1) |
| U15 | No monthly repeats | Accepted: weekly, every 2 weeks, monthly by weekday, monthly by date (12.1) |
| U16 | Scheduling hidden from repair-only companies | Accepted: `/calendar` and `/shifts` need only the module; Dashboard "Today" card; `install` calendar items (6.2, 12.2) |
| U17 | Booking by guessing dates | Accepted: next 7 days' free times, one "+" per empty hour, "Block this time" (12.2) |
| U18 | Week view on tablets | Accepted: 7 columns only at `xl`, one-line items, Day view default (12.2) |
| U19 | Can't bring in the email list | Accepted: `/customers/import` with an unsubscribed column, never text consent (11.2, 11.3) |
| U20 | Campaign cost, checking, sending | Accepted: part price and cost line, plain-character conversion, emoji warning, check on every load, two-tap send, real start time (11.3, 5) |
| U21 | StitchShop ready texts before the machine is back | Accepted: notices only once `backAt` is recorded; bulk "These are back"; the "Is it here?" line is in `TodoLinesSlot` rather than an edit to `PartnerTodo` (one owner per file) (9.2, 9.5) |
| U22 | Sending problems go unnoticed | Accepted, changed: sidebar pill, Dashboard / register lines, `staff_alert` removed; link answers show in `EstimatesTodoSlot` on the Dashboard and register instead of a pill in the Dashboard's table (that table stays foundation's file) |
| U23 | Accidental approval, stale to-do, late channel errors | Accepted: confirm step, "no answer in 2 days: call" in `EstimatesTodoSlot` (not a `PartnerTodo` edit), channels pre-ticked and disabled with reasons (10.4, 10.5) |
| U24 | Wording and settings page | Accepted: `{amount_line}`, `firstName` rules, wording next to each switch with a live sample, three tabs, provider presets, the Microsoft note (to re-check before shipping), "Registering your number" (4.1, 5, 8.3) |
| U25 | Menu grows by 5 | Accepted: Calendar, Classes, Messages only; Campaigns is a Messages tab, Staff a Calendar tab (6.2) |
| U26 | Customer messages and register strip too big | Accepted: one summary line with `<details>`; one-line "Today" strip; "Ring up" on the customer's classes (8.3, 12.1, 12.2) |
| U27 | No per-person class price | Accepted: `setEnrollmentFee` (12.1) |
| U28 | Hours typed as text | Accepted: 7 day rows stored as JSON (12.2) |
| U29 | Newsletter content | Accepted: `/classes/print?month=` and `{upcoming_classes}` (5, 12.1) |
| U-cut | Campaigns menu item; hand-picked audience; `emailWeek`; `staff_alert`; `/messages/[id]` page; "Send now" for everyone | Accepted (removed or admin-only under Troubleshooting) |
| U-cut | The PROPOSED -> CONFIRMED handshake | Accepted, changed: runs are SCHEDULED when created and an OK is optional; but only the scheduling side changes the plan (O14's single writer), because letting either side edit brings back crossing edits |

### Architect's own changes in this revision

- Links gate on the Windows program and the `next-action` refusal (S1 above).
- `pollReplies` reads one UTC day at a time so a long backlog makes progress (S2 / O11).
- `EXPLICIT_KINDS`: confirmation, HELP and test messages are checked against suppression only, even with a customer id
  stored for the record.
- A restore also re-applies "how to tell them" changes made after the backup (`notify_pref` events).
- `ConsentEvent.channel` `any` for `notify_pref`; hand-sent email / text notices are recorded as `SENT` rows the worker
  never touches.
- `bags_due` and `install` hooks from `modules-design.md` 12.4 are placed with their owners (`notices`,
  `appointments`), so the vac packages need no shared edits here.
