# StitchHub accounts and billing: design (2 Oct 2026, first draft for the owner)

HANDOFF.md section 3 step 5 and section 4 ("Pricing", 26 Sep 2026). Two repos: this one (StitchBench and StitchShop,
one codebase) and `C:\Users\bwatt\stitchhub` (the hub: Hono + pg, plain `.mjs`, SQL migrations in `migrations/`, the
admin page `public/admin.html`). Nothing here is built. Where this document says "decided", the owner may still say
otherwise; section 9 lists the questions with a recommended answer each.

Files relied on: `src/lib/license.ts`, `license-keys.ts`, `license-signing.ts`, `licenses.ts`, `modules.ts`,
`module-info.ts`, `module-gate.ts`, `modules-admin.ts`, `shops.ts`, `session.ts`, `hub.ts`, `hub-writes.ts`,
`src/lib/shop/stripe.ts`, `src/lib/messaging/secrets.ts`, `src/lib/messaging/smtp.ts`, `src/actions/hub.ts`,
`src/actions/companies.ts`, `src/app/signup/page.tsx`, `src/app/(app)/companies/page.tsx`, `src/app/(app)/layout.tsx`,
`src/app/api/shop/stripe/[who]/route.ts`, `prisma/schema.prisma` (Shop, User, HubState, PartnerLink, License,
ModuleGrant), `desktop/main.mjs`, `INSTALL.md`; hub `src/server.mjs`, `src/partners.mjs`, `src/db.mjs`, `src/env.mjs`,
`migrations/001_init.sql`, `005_partners.sql`, `008_round3_partners.sql`, `009_round3_hub-market-parts.sql`,
`README.md`, `test/smoke.mjs`; `docs/plans/modules-design.md` sections 3, 5, 6.4, 14; `online-and-parts-design.md`
section 3 "As built".

## 0. Scope in one page

- A **shop** (one `Shop` row: a company on the hosted instance, or the one company of a Windows install) gets an
  **account on StitchHub**: email and password, verified by email, password reset by email. The account owns one or
  more shops. Nothing changes for staff logins inside the program.
- **One price for all three products**: $25 a month or $250 a year per shop, through Stripe Billing on the hub
  (Checkout to start, Customer Portal to change card, plan or cancel, webhooks to learn what happened). A shop is
  **free while partnered**: a retail-side shop with an ACTIVE partner link to a repair shop in good standing pays
  nothing (section 3.2). The owner can comp any shop. New shops get a 30-day trial.
- The program learns its standing from a **hub-issued license key** for a new module id `base`, fetched at every sync
  and stored like a pasted key. The existing machinery (`windows`, `statusAt`, grace, "renew", "lapsed",
  `canWrite`) does the rest. **Lapsed = read-only**, exactly the module table in modules-design 6.4: look, print,
  export, finish and close what is open, take payments; no new tickets, sales, parts or edits. Data is never removed.
- The hub signs with its own key (`hub1`), compiled into both programs as a public half; the owner's `k1` keys and
  the hosted Companies switch (`h1`) keep working as second and third issuers, so a shop that can't reach the hub can
  still be sold a key by email.
- A **terms and privacy page** lives on the hub (`/terms`, `/privacy`); both programs link to it and the account
  records which version was accepted.
- Not charging until the owner's four conditions hold (signed installer, a month of real use, the terms page, Stripe
  live); until then every shop is on a comp. The hub stays free to everyone (section 8 notes the contradiction).

## 1. What exists today, and what changes

**Joining the hub is per install, not per shop.** `HubState` has one row (`id = 1`) per database with `installId` and
`installKey`; `joinHub` (`src/lib/hub.ts`) posts `/v1/register` with the hub's join key, or `/v1/partners/join` with a
partner code (scope `partner`, partner routes only), or `/v1/upgrade`. The hub's `installs` table holds the key's
sha256, `scope`, `blocked`, `invited_by`. Companies inside an install are only a `shop_ref` (`Shop.id`) on partner
links, listings, orders, posts and revisions (hub migrations 005, 009, 011). `requireInstallAdmin` (`session.ts`) lets
the one company's owner, or the platform admin on a shared instance, change the connection. Members are limited per
install and per `X-Shop-Ref` (hub `writeLimit`). `Shop.hubWritesOff` is the platform admin's per-company mute
(`hub-writes.ts`, the Companies page). `PLATFORM_ADMIN_EMAILS` names whoever runs the install.

**Code and handoff disagree in one place.** `claimShop` in `src/lib/hub.ts` posts `/v1/shops/claim { shopRef }` on
every sync for a one-company install and swallows the 404; the hub has no such route and no `shops` table. This design
makes the route real (section 5.1) and sends it for every company, which is also the "per-company hub identity" of
HANDOFF 3.8.

**Licensing today** (`modules-foundation`, 2f): `License` rows hold pasted `SB1.` keys for `vac | appliance |
scheduling | marketing`; `verifyFor` checks the compiled public keys (`LICENSE_PUBLIC_KEYS`: `dev1`, and `k1`/`h1`
to come); `ModuleGrant` is the hosted Companies switch signed with the hosting key; `statusAt` gives
`off | on | renew | grace | lapsed`; unknown module names in `m` are accepted and shown as "needs a newer version",
so a key carrying `base` is harmless to a program from before this design. HANDOFF 3.4.1 asked `modules-foundation` to
absorb "base program licensed, hub as a second key issuer, auto key refresh"; 2f shows it did not. This design does.

**Passwords today.** Owners and admins reset a staff password in Settings (`resetUserPassword`); nobody can reset the
owner's except the owner (`settings.ts:168`). There is no reset by email anywhere and no platform mail: SMTP is per
shop, for customer messages (`messaging/smtp.ts`). The tray menu (`desktop/main.mjs`) has no "Reset a password" item
yet, though HANDOFF 4 lists one as decided. Hosted sign-up is `/signup` behind `ALLOW_SIGNUP=true`; otherwise the
platform admin adds companies on the Companies page (`createShopWithOwner` with `allowReserved`).

**Stripe today.** `src/lib/shop/stripe.ts` is a plain-fetch client (form bodies, `stripe-version` pinned, 20 s
timeout, `verifyWebhook` with the `t=`/`v1=` HMAC and a tolerance window, `signWebhook` for the mock); the webhook
route reads at most 256 KB and checks the signature before reading anything; secrets at rest are sealed with
AES-256-GCM bound to shop and field (`messaging/secrets.ts`). The hub keeps none of that: billing lives on the hub, so
the Stripe secret lives only in the hub's Railway variables and nothing is sealed in a shop's database.

## 2. Accounts on StitchHub

### 2.1 Model

An **account** is an email address with a password, owned by a person (the shop owner). A **hub shop** is
`(install_id, shop_ref)` with a name and kind; it belongs to at most one account. One account may own several shops
(a repair shop that hosts its quilt shops' StitchShop companies). The install key stays the credential the program
uses; the account is the credential a person uses on the hub's own pages.

### 2.2 Getting an account: three doors, one table

1. **From the program** (the usual way). New page Settings → Account (`/settings/account`, owners only; on a shared
   hosted instance also the platform admin for any company). "Create your StitchHub account": email, tick the terms.
   The program posts `POST /v1/accounts/start { shopRef, shopName, kind, email, termsVersion }` with its install key;
   the hub makes the account unverified, ties the shop to it, and emails a link `https://hub/account/set-password?t=…`
   (token hashed at rest like partner codes, 24 h, one use). The owner sets a password on the hub; the account is
   verified. The program's page shows "Account: name@…, verified / waiting for the email (Send it again)".
2. **Link an existing account.** Same page, "I already have an account": the program shows a 10-character link code
   (`POST /v1/accounts/link-code` → `{ code }`, 15 minutes); the owner signs in on the hub and types it under
   "Connect a shop". The hub pairs the shop with the account. The program learns it at the next sync.
3. **On the hub first** (a shop with no program yet, buying hosted StitchBench). `/account/signup` on the hub: email,
   password, terms. Verify by email. Then "Start a hosted shop" (section 4.4) or "Connect a shop" with a code.

An install that is not on any hub (never joined) joins in door 1 as a side effect: the hub's address is compiled in
as the default (`HUB_DEFAULT_URL`, today the Railway address) and the account start replaces the join key for the
community (`installs.scope = 'member'` for an account-backed install). The join key stays for self-hosted hubs and
for hubs that choose to keep it. **Grandfathering**: every install already on the hub keeps working with no account;
the account is needed only to pay or to be comped, and the trial clock for an existing shop starts when it first
claims itself (section 3.4), not retroactively.

### 2.3 Sign in, sessions, reset

- Pages on the hub, plain HTML + fetch like `admin.html`: `/account` (sign in / sign up), `/account/verify`,
  `/account/forgot`, `/account/set-password`, `/account/shops` (the account's shops: standing, Subscribe, Manage
  billing, Connect a shop, Download invoices), `/account/settings` (email, password, sign out everywhere).
- Passwords: Node `crypto.scrypt` (the hub has no bcrypt and should not grow one), 8+ characters, the 20
  most-common-password list refused. Sessions: a random 32-byte id, sha256 at rest in `sessions`, HttpOnly, Secure,
  SameSite=Lax cookie, 30 days, revoked by "sign out everywhere". `SESSION_SECRET` is not needed because the cookie
  carries an opaque id; `ADMIN_TOKEN` is never reused.
- Reset by email: `/account/forgot` always answers "If that address has an account, the email is on its way";
  tokens 1 h, one use, every older token for the account cancelled; a reset signs out every session.
- Rate limits through the hub's existing `allow()` buckets: 10 sign-ups and 20 sign-in failures an hour per address,
  5 resets an hour per account, the global wrong-password bucket like `WRONG_JOIN_KEYS`.
- Mail: the hub gains `nodemailer` (the same major as this repo) and two variables, `SMTP_URL`
  (`smtps://user:pass@host:465`) and `MAIL_FROM`. One mailbox the owner controls; the hub refuses to start accounts
  until both are set (the rest of the hub runs as today).

### 2.4 Tying the install to the account, and what the install learns

`doSync` (`hub.ts`) already calls `/v1/me` at the top of every run. Two additions: `POST /v1/shops/claim` for every
company on the install (name, kind, program and version), and `GET /v1/shops/{shopRef}/standing` for each, which
answers `{ account: { email, verified } | null, standing: "trial" | "active" | "past_due" | "waived" | "comped" |
"lapsed" | "none", lastDay, message, key: "SB1.…" | null, revokeKeyIds: [] }`. The program stores the key (section
3.5), shows `message` on Settings → Account, and deletes `License` rows whose `keyId` is in `revokeKeyIds` and whose
`source` is `hub`. Partner-only installs may call `/v1/shops/*` and `/v1/accounts/*` (the member middleware's regex
gains them), since a StitchShop that joined with a partner code alone still has an account to keep.

## 3. Billing

### 3.1 The rule

$25 a month or $250 a year **per shop**, for StitchBench on Windows, StitchShop on Windows and every company on a
hosted instance. Modules (Vac Shop, Appliance, Scheduling, Marketing) are priced separately and stay on the owner's
emailed keys for now; a later package puts them on the same subscription (section 7, `hub-modules`).

### 3.2 "Partnered" means this

A hub shop is **waived** at time T when the hub holds a `partner_links` row with `status = 'ACTIVE'` in which this
shop is the **retail side** (`retail_install_id, retail_shop_ref`) and the **repair side's** shop has standing
`trial`, `active`, `past_due` (inside grace) or `comped`. A repair-side shop is never waived by a partnership: it is
the payer. A shop with both kinds (`doesRepair && sellsRetail`) is treated as repair. When the partnership ends
(`ended_at` set) or the repair shop lapses, the waiver ends and the retail shop gets 30 days of standing `trial`-like
notice ("Your free use through <repair shop> ended on …; subscribe by …"), then lapses. Waived keys are issued for 35
days at a time and re-issued at every sync while the waiver holds, so an offline Windows install keeps working about a
month past the end of its partnership and no longer. This is the code's `PartnerLink` (`side = retail`, `status =
ACTIVE`) mirrored on the hub; the hub's row is the authority because both shops report to it.

### 3.3 Stripe Billing on the hub

- Variables on the hub: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`,
  `STRIPE_API_BASE` (the mock). `src/stripe.mjs` is a port of `src/lib/shop/stripe.ts`'s `formBody`, `call` and
  `verifyWebhook` (about 80 lines, no SDK), plus `createSubscriptionCheckout`, `createPortalSession`,
  `retrieveSubscription`.
- **Subscribe**: `/account/shops` → Subscribe (monthly | yearly) → `POST /account/shops/{id}/checkout` → a Checkout
  Session, `mode = subscription`, one Stripe customer per account (`accounts.stripe_customer_id`, made on first
  use), `client_reference_id` and `metadata.hub_shop_id` = the hub shop, `subscription_data.metadata` the same,
  automatic tax **off** (SaaS; the owner decides later), promotion codes allowed (comps are not codes, see 3.4),
  `success_url` back to `/account/shops?done=1`, trial handled by the hub (not Stripe trials), so Checkout always
  takes a card. Switching monthly to yearly, changing the card, cancelling: `POST /account/shops/{id}/portal` → a
  Customer Portal session (configuration: cancel at period end, proration on plan switch, invoice history).
- **Webhooks** `POST /stripe/webhook`: raw body at most 256 KB, signature first, event id stored in `stripe_events`
  (primary key; a replay is a 200 and a no-op). Handled: `checkout.session.completed` (write
  `subscriptions.stripe_subscription_id`), `customer.subscription.created | updated | deleted` (status,
  `current_period_end`, `cancel_at_period_end`, price → plan), `invoice.paid` (period end advances),
  `invoice.payment_failed` (status `past_due`; mail the account). The hub trusts the webhook's object only after
  re-reading the subscription from Stripe (`retrieveSubscription`), as the online shop re-reads its session.
- **Standing from the subscription**: `active` or `trialing` → `active`, `lastDay` = `current_period_end` in the
  shop's zone; `past_due` → `past_due` with `lastDay` unchanged (the key already carries 14 days of grace past the
  period end, and Stripe's retries run inside that); `canceled` with `cancel_at_period_end` → `active` until the
  end, then `lapsed`; `unpaid` or `canceled` past the end → `lapsed`. Grace is 14 days (`g: 14`), the module default.
- **Dunning mail** from the hub: payment failed (with the Portal link), 7 days into grace, the day it lapses; renewal
  reminder 30 days before a yearly period ends (Stripe emails the monthly receipts). Each is sent once per period
  (`subscriptions.mailed` jsonb).

### 3.4 Trials and comps

- **Trial**: 30 days from a shop's first claim (`shops.created_at`), standing `trial`, a key with plan `t` and
  explicit `f`/`u` (the hub sets the dates; `TRIAL_DAYS = 14` in `license.ts` is the CLI's and is left alone).
  One trial per shop ever; a shop deleted and re-made on the same install is the same `(install_id, shop_ref)` only
  if the `Shop.id` is the same, so a fresh company is a fresh trial (open question 6).
- **Comp** (the owner's grandfathering and goodwill): on the hub admin page, "Free until <date> / forever" with a
  note → standing `comped`, plan `c`, `u` = the date (or `2099-12-31`). Used for every current shop until the owner
  starts charging. `RENEW_NOTICE_DAYS` gains `c: 30` and `w: 0` (waived keys never show "renew").

### 3.5 How the programs learn it: the `base` module

- `MODULE_IDS` gains `"base"` (`license.ts`, `module-info.ts`: label "StitchBench" or "StitchShop" by `appName()`,
  blurb "The program itself", href `/settings/account`). `LICENSE_PUBLIC_KEYS` gains `hub1: { x, scope: "hub" }`;
  `acceptScope` treats `hub` like `any` for pasted or fetched keys and never for the Companies switch. The private
  half is `HUB_LICENSE_KEY` on the hub's Railway, made with this repo's `npm run license:keygen -- --kid hub1 --hub`
  (a new flag that prints the hub's variable and the `license-keys.ts` line). Rotation and leaks follow
  modules-design 3.3 (`hub2`, retire `hub1` with `lastDay` and `allow` from the hub's `license_issues` log).
- A hub key's payload is the existing one: `m: ["base"]`, `p: "m" | "y" | "t" | "c" | "w"`, `s = Shop.id`, `g: 14`.
  The hub signs a fresh key whenever standing changes and at least every 30 days; the program keeps one hub row per
  shop (`License.source = "hub"`, replace on fetch). An emailed `k1` key with `m: ["base"]` from `npm run license`
  works the same way (a shop whose hub is unreachable, or that the owner prefers to invoice), and so does the
  Companies switch (`ModuleGrant.module = "base"`, plan `a`) on the hosted instance.
- **Status to behaviour.** `loadModules` already returns `base` like any module once the id exists. New
  `src/lib/base-gate.ts`: `baseState(shopId)` and `baseWritable(shopId)` (= `canWrite(status)`). Where it bites:
  - `safe()` in `src/lib/action.ts` refuses a mutating action with "`<Program>` for this company is read-only since
    <date>. You can look at and export everything, finish open work and take payments. Subscribe in Settings →
    Account." unless the action is registered as `whileLapsed` (sign in/out, passwords, Settings → Account, closing
    statuses, payments, returns and voids, exports, hub sync, backups). The list lives in one file
    (`src/lib/lapse-allow.ts`) and `scripts/checks/base-license.check.ts` asserts every allowed name exists.
  - Route handlers that write (`/api/photos`, `/api/book/*`, `/api/shop/*`, `/api/e`, `/api/u`) return 403 or close
    the public pages ("This shop's online booking is paused") when the shop is lapsed; message workers skip the shop
    (as modules-design 6.4 already does for scheduling and marketing).
  - Layout: `GraceBanner` and `ModulePills` (`layout.tsx`, `module-banner.tsx`) carry `base` with no change; a
    lapsed `base` adds a top bar on every page for every role, and the nav keeps every item (read-only pages).
  - A shop that never had any key (standing `none`: an install that never joined any hub) is `off`, and `off` for
    `base` means **fully working**, not hidden: until the owner starts charging, nothing must change for a shop that
    never connects. The hub turns `none` into `trial` on first claim. (Open question 2 asks whether, after launch,
    an install that never connects should run for ever; the recommendation is yes, with a nag after 60 days, because
    the Windows program must keep working offline and the key is a deterrent, not DRM, modules-design 3.5.)
- **Offline Windows**: the key's `u + g` is the limit; a monthly payer whose PC is offline keeps working about 44
  days (`effectiveNow`'s clock floor applies). The hosted instance's install is itself a hub member, so companies on
  it get keys the same way; the owner's Companies switch is the fallback there.

### 3.6 Cancellation, refunds, chargebacks

- Cancel in the Portal: at period end (default) or now (Portal setting off by default; the owner can allow it). The
  key runs to its `u`; the shop is read-only after grace; nothing is deleted; Settings → Your data exports stay.
- Refunds are by hand in the Stripe dashboard by the owner; the terms state the policy (recommended: full refund
  within 14 days of a first charge, otherwise none, yearly cancellations refunded pro rata at the owner's
  discretion). When the owner refunds, the hub sees `charge.refunded` → marks the period unpaid → standing `lapsed`
  at once with `revokeKeyIds` = the keys of that period; an online install drops them at the next sync; the hosted
  Companies switch "off" covers the rest. An offline Windows install keeps working to `u + g` (accepted, 3.5).
- A chargeback (`charge.dispute.created`) does the same and flags the account on the admin page.

## 4. Hub pages, admin, provisioning, resets

### 4.1 The owner's admin page

`admin.html` gains Accounts (email, verified, shops, standing, last sign-in; "Comp…", "Lapse now", "Resend
verification", "Open in Stripe") and the shops table gains standing and the account. `GET /v1/admin/accounts`,
`POST /v1/admin/shops/:id/comp`, `POST /v1/admin/shops/:id/lapse`, all behind `ADMIN_TOKEN` as today.

### 4.2 Terms and privacy

`public/terms.html` and `public/privacy.html` on the hub, served at `/terms` and `/privacy`, each with a version
date in its first line and in `settings` (`terms_version`). The account stores `terms_version` and `terms_at` at
sign-up and again at each Checkout; a newer version shows a "we updated our terms" line at the next hub sign-in and
in Settings → Account. Both programs link the two pages from Settings → Account, the hosted `/signup`, the Windows
first-run sign-up and the login page footer. The owner writes the text (a lawyer or a template service, not this
document); the facts to state are in section 6.

### 4.3 Password resets, four kinds (HANDOFF 3.5)

1. Hub account: section 2.3.
2. Hosted app, by email: `/login` gains "Forgot your password?" → `/reset` → a token row (`PasswordReset`: userId,
   tokenHash, expiresAt, usedAt) and mail through a new platform SMTP (`PLATFORM_SMTP_URL`, `PLATFORM_MAIL_FROM`,
   sent with `messaging/smtp.ts`'s `openSmtp`); the owner's address included. Off on the Windows program and where
   the variables are unset (the link is not shown).
3. Windows tray "Reset a password…": a dialog on the PC listing the company's logins; picks one, generates a 12-character
   password, sets it (bcrypt, `sessionVersion + 1`) and shows it once on the PC's own screen. Needs the PC, nothing
   else (`desktop/main.mjs`, next to "Restore a backup…").
4. From the hub account to a Windows install, **opt-in**: Settings → Account, "Allow a password reset from my
   StitchHub account" (`Shop.hubResetOptIn`, off by default, owners only, Windows only). On the hub,
   `/account/shops` → "Reset the owner password on the shop PC" → the hub signs a grant (Ed25519 with `hub1`:
   `{ shopRef, email, nonce, exp: +1 h }`) into `reset_grants`; the install's sync fetches
   `/v1/shops/{shopRef}/resets`, verifies the signature and the opt-in, generates the new password, bumps
   `sessionVersion`, and shows it **only in the program's own Electron window** (a modal; never on other devices,
   never emailed), then acknowledges the grant (one use). Owner login only (role OWNER, the account's email).

### 4.4 Hosted shop created from the hub

`/account/shops` → "Start a hosted StitchBench / StitchShop" → the hub calls the hosted service
`POST /api/platform/companies { shopName, kind, ownerName, ownerEmail, timeZone, hubShopId }` with
`Authorization: Bearer PLATFORM_API_TOKEN` (a new variable on both sides; the route exists only when it is set). The
service runs `createShopWithOwner` with `allowReserved`, a random password, and answers `{ shopId }`; the hub ties the
shop to the account and the service mails a set-password link (4.3.2). The hosted install's next sync claims the
shop and fetches its trial key. One request per account per 10 minutes.

## 5. Data model and API

### 5.1 Hub, migration `012_accounts_billing.sql`

```
accounts        (id, email unique (lower), password_hash, verified_at, terms_version, terms_at, stripe_customer_id,
                 created_at, last_sign_in_at, disabled)
account_tokens  (token_hash pk, account_id, kind verify|reset|link, expires_at, used_at)
sessions        (id_hash pk, account_id, created_at, last_seen_at, expires_at)
shops           (id, install_id -> installs, shop_ref, name, kind repair|retail|both, program, version, account_id
                 null -> accounts, comp_until, comp_note, created_at, last_seen_at, unique (install_id, shop_ref))
subscriptions   (shop_id pk, stripe_subscription_id unique, plan m|y, status, current_period_end,
                 cancel_at_period_end, unpaid_since, mailed jsonb, updated_at)
stripe_events   (id pk, type, received_at)
license_issues  (key_id pk, shop_id, plan, modules text[], first_day, last_day, issued_at, revoked_at)
reset_grants    (id, shop_id, email, nonce, expires_at, used_at)
settings        + terms_version
```

Routes (install key): `POST /v1/shops/claim`, `GET /v1/shops/:ref/standing`, `POST /v1/accounts/start`,
`POST /v1/accounts/link-code`, `GET /v1/shops/:ref/resets`, `POST /v1/shops/:ref/resets/:id/done`. Routes (session
cookie): everything under `/account/*`. Public: `/terms`, `/privacy`, `POST /stripe/webhook`. Admin: 4.1. Every new
route gets the hub's body limits and `allow()` buckets. The export/import (`transfer.mjs`) carries every new table.

### 5.2 StitchBench, migration `20261003120000_hub_accounts` (named after the newest folder; rename if later)

- `License.source String @default("pasted")` (`pasted | hub`), index `(shopId, source)`.
- `Shop.hubAccountEmail String?`, `Shop.hubStanding String?`, `Shop.hubStandingAt DateTime?`,
  `Shop.hubStandingNote String?`, `Shop.hubResetOptIn Boolean @default(false)`, `Shop.termsVersion String?`.
- `PasswordReset` (id, userId, tokenHash unique, expiresAt, usedAt, createdAt; `@@index([userId])`).
- `MODULE_IDS` + `"base"`; `ModuleGrant.module` comment gains `base`. No change to `HubState`.
- Windows: `desktop/backup.mjs` restore keeps `License` rows with `source = hub` (they are re-fetched anyway).

## 6. Security notes

- Secrets: `HUB_LICENSE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SMTP_URL`, `PLATFORM_API_TOKEN` are
  Railway variables on the hub; `PLATFORM_API_TOKEN` and `PLATFORM_SMTP_URL` on the hosted services. Nothing new
  is stored in a shop's database except its own key text (public once issued) and hashed reset tokens. No card data
  anywhere: Checkout and the Portal are Stripe's pages.
- Public halves only in code (`license-keys.ts`), as modules-design 3.3 insists; the hub's standing answer is
  trusted only through the key's signature (a hostile hub can lapse a shop by refusing a key, never extend one it
  did not sign; and an install on a hub that is not the owner's accepts no `hub1` key unless that hub holds the
  private half).
- Webhooks: signature before parsing, event id deduped, object re-read from Stripe. Install routes: the install key
  (`key_hash`) as today; a shop may claim and read only its own `shop_ref`s. Link codes and tokens: hashed, short,
  one use. Password hashing: scrypt, N=2^15. Cookies HttpOnly/Secure/SameSite=Lax; state-changing account routes
  check the `Origin` header equals the hub's.
- Privacy facts for the terms page: the hub stores what README.md lists plus account email, password hash, hub shop
  names and standing, Stripe customer and subscription ids (no card numbers); the hosted service stores the shop's
  business data on the shop's behalf; the Windows program stores everything on the shop's PC; emails are used for
  account, billing and reset mail only; export in Settings → Your data; deletion on request (an account and its
  hub shops can be deleted by the owner on the admin page; partner messages are kept a year as today).
- Reset grants (4.3.4) are opt-in, signed, one-use, one hour, owner only, shown on the PC only; the opt-in is stored
  on the PC so a forged hub cannot switch it on.

## 7. Packages, in build order, with gates

Each package has its own worktree and database, a check script run with `npm run check <file>` (tenant section
included where there are shop rows), a Playwright spec on a test build, and touches only its files. Order:

1. **`hub-accounts`** (hub repo). Migration 012 (tables of 5.1 except `subscriptions`, `stripe_events`), nodemailer,
   `src/accounts.mjs` (sign up, verify, sign in, sessions, forgot, set-password, link codes, `/v1/shops/claim`,
   `/v1/shops/:ref/standing` answering `none`/`trial`/`comped` only), the `/account/*` pages, admin accounts and
   comp, `/terms` and `/privacy` placeholders with a version. Check: `test/accounts.mjs` (an in-process SMTP sink;
   sign-up → verify → sign in → forgot → reset → link code → claim; wrong-token and rate-limit cases; export carries
   the tables). Gate: `npm run check`, `npm test` (smoke) and `npm run test:db` pass against a test hub; deploy the
   hub (old programs are unaffected: the routes are new).
2. **`base-license`** (this repo). `base` in `MODULE_IDS`/`MODULES`, `hub` scope and `hub1` line, `--hub` in keygen,
   `base` in `npm run license` and the Companies switch, migration 5.2, `base-gate.ts`, `lapse-allow.ts`, the
   `safe()` rule, route-handler and worker checks, the layout bar, Settings → Account (doors 1 and 2, standing, the
   terms links, the reset opt-in), `doSync` claim + standing + key store + revoke, the Windows tray reset (4.3.3),
   INSTALL.md "Your account". Checks: `scripts/checks/base-license.check.ts` (a lapsed `base` refuses `createTicket`
   and `completeSaleAs`, allows `setStatus` to a closing status, a payment, a void and `/api/export`; the allow-list
   names exist; a `hub1` key is accepted as pasted and refused as a grant; `revokeKeyIds` deletes only `source =
   hub`; tenant section). Spec: `tests/account.spec.ts` against the local test hub (:3200): create account → verify
   via the sink → standing "trial" on Settings → Account; `dev.ts --grant base` ended → read-only bar, new ticket
   refused, export works. Gate: tsc, eslint, unit tests, every existing check, `modules-lapse`, `modules-basics`,
   `smoke`, `hub`, `partners` specs pass; no shop without a key changes behaviour (`off` = working).
3. **`hub-billing`** (hub repo). `src/stripe.mjs`, `subscriptions`, `stripe_events`, Checkout, Portal, webhook,
   standing from the subscription, the waiver rule from `partner_links`, trials, dunning mail, `license_issues`,
   key signing with `HUB_LICENSE_KEY`, admin "Lapse now". Check: `test/billing.mjs` with a subscription-aware copy of
   this repo's `scripts/test-mail/stripe-mock.mjs` (`checkout.session.completed`, `invoice.paid`,
   `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`): trial → active → past_due → lapsed
   → active again; a retail partner waived, the repair shop lapses, the waiver ends; a replayed event is a no-op; a
   bad signature is 400; the key verifies with `hub1` and `s` is the right shop. Gate: 1's gate again, then the
   two-repo run: the local test hub with the mock and this repo's `tests/account.spec.ts` extended with "Subscribe"
   through the mock's payment page → standing "active" in the program within one sync.
4. **`hosted-provisioning`** (both repos). `PLATFORM_API_TOKEN`, `POST /api/platform/companies`, hosted reset by
   email (4.3.2, `PasswordReset`, `PLATFORM_SMTP_URL`), hub "Start a hosted shop", reset grants (4.3.4) on both
   sides. Checks: `scripts/checks/platform-api.check.ts` (token required; a company made; a second call refused for
   10 minutes) and `test/provision.mjs` on the hub. Spec: `tests/account.spec.ts` grows "Forgot your password" on
   the hosted build with the sink. The Windows grant path is checked by `cd desktop && npm test` (a signed grant
   verified, an unsigned one and an opted-out shop refused) since Electron does not run in CI.
5. **`terms-launch`** (both repos). The owner's terms and privacy text, acceptance recording at sign-up and Checkout,
   the "updated terms" line, the login footer links, HANDOFF and INSTALL sections, the rollout checklist (`hub1`
   keygen and lines in both repos, Railway variables, Stripe prices and Portal configuration, webhook endpoint,
   mail domain SPF/DKIM, comps for every current shop). Gate: the owner's four conditions; until then
   `STRIPE_SECRET_KEY` stays unset and the Subscribe button says "Coming soon; free while we're in the partnership
   period".
6. Later: **`hub-modules`** (modules on the subscription: Stripe prices per module, `m` grows on the hub key, the
   emailed `k1` keys stay for self-hosted shops), **`hub-email-identity`** (one email per company, HANDOFF 2c L7/L31,
   when the account email and the owner's login email should be allowed to differ per company).

## 8. Where the code or the handoff contradicts itself

- **Hub membership paid or free.** HANDOFF 3.5 sells "hub membership" through Stripe and grandfathers members; the
  owner's later pricing decision (section 4, 26 Sep: "the hub free to everyone", "Community first") and README.md's
  "one-time contribution toward server costs" say otherwise. This design follows the 26 Sep decision: the hub is
  free; an account replaces the join key for the owner's hub; nothing is billed for hub access.
- `/v1/shops/claim` is sent by the program and unknown to the hub (section 1). Made real here.
- The tray "Reset a password" is listed as decided (HANDOFF 4 and 3.5) but not built. Package 2.
- `modules-foundation` was to absorb the hub-issuer work (HANDOFF 3.4.1); it did not (2f). Package 2 does.
- `TRIAL_DAYS = 14` (`license.ts`) versus the owner's "a month of real use": the hub sets its own 30-day dates;
  the CLI's 14-day trial stays for modules.
- Pricing says "free while partnered (a repair shop or bench tech pays; a sewing shop pays only if it isn't sending
  anyone repairs)" but also "a shop may license directly and the fee is waived once it connects to a repair shop".
  Section 3.2 reads both as: the waiver is for the retail side only and follows the ACTIVE link; a direct subscriber
  that becomes partnered is told to cancel in the Portal (the hub does not cancel for them; open question 4).

## 9. Decisions (2 Oct 2026: the owner took the recommended answer on every question below)

Each item keeps its alternative for the record; the recommended answer is the decision. In short: lapsed = read-only
as modules-design 6.4; never-connected shops work for ever with a nag after 60 days; 14 days' grace; a partnered
direct subscriber is told, not cancelled; "both" shops pay; the trial is per shop; 14-day full refund on a first
charge; no sales tax on the subscription; account mail from one mailbox on the owner's domain; hub-started hosted
companies land on the shared instance; the account email is the owner's login email for now; account deletion by
the owner on request.

1. **Lapsed behaviour for the base program.** Recommended: read-only as in modules-design 6.4, with payments,
   closing statuses, returns, voids, exports, backups and sync still allowed; public booking and the online shop
   paused. Alternative: refuse only new tickets and sales (softer). The allow-list is one file either way.
2. **A shop that never connects to any hub.** Recommended: it works for ever (`off` = working), with a nag line in
   Settings → Account after 60 days and the "Ask StitchBench" mailto, because offline Windows installs must not
   break and the key is a deterrent. Alternative: a 30-day local trial from install, then read-only until a key is
   pasted (the owner emails `k1` keys to such shops).
3. **Grace**: 14 days after the period end (Stripe's retries run inside it). Alternative: 7.
4. **Direct subscriber that becomes partnered.** Recommended: the program tells them "You're partnered with <repair
   shop>: you can cancel in Manage billing and stay free"; no automatic cancellation or refund. Alternative: the hub
   cancels at period end for them.
5. **Who pays for a "both" shop** (`doesRepair && sellsRetail`): recommended, as a repair shop (pays).
6. **Trial per shop** by `Shop.id`: a deleted and re-made company gets a new trial. Recommended: accept (the owner
   sees it on the admin page); the alternative is a trial per account.
7. **Refund policy text**: 14 days full refund on a first charge, otherwise none, yearly pro rata at the owner's
   discretion. Recommended as written; the owner may prefer "no refunds, cancel any time".
8. **Sales tax on the subscription**: off (no Stripe Tax on SaaS) until the owner's accountant says otherwise.
9. **Mail domain**: account and reset mail from one address the owner controls (recommended: a `hub@` or `billing@`
   mailbox on the owner's domain with SPF and DKIM), used by the hub (`SMTP_URL`) and the hosted services
   (`PLATFORM_SMTP_URL`). Twilio is not involved.
10. **Hosted shop names and slugs**: a hub-started hosted company is made on the shared instance (HANDOFF 3.8); a
    dedicated instance stays a by-hand step. Recommended: yes.
11. **Account email = owner login email?** Recommended for now (one person, one address); package 6
    `hub-email-identity` relaxes it with L7/L31.
12. **Deleting an account**: the owner does it on the admin page on request; the shop's hub shops are detached, the
    subscription cancelled, listings and notes stay under the install as today. Recommended; a self-service delete
    can come later.
