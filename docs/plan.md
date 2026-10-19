# StitchBench and StitchShop: the Foundry Account plan

**Status:** 2026-10-19. Survey done. FA-1 and FA-2 done (cloud client and mock; hosted sign-in with a Foundry Account behind the `FOUNDRY_SIGNIN` switch, which is off). The Assistant is not wired yet. Owner: Bruce Wattendorf (SiteSentrix).

## Goal
One login, the **Foundry Account** (cloud.stitchfoundry.app), and one credit balance ("Foundry credits"), for all
SiteSentrix software. Copy MakerFoundry's approach ("Accounts (MF-1)" in github.com/SiteSentrix/makerfoundry
`docs/plan.md`): the server signs in through the cloud service, keeps the cloud token server-side, and keeps its own data
keyed by the account's `id`.

## Today (surveyed 2026-10-19)
- StitchShop is this same code base (`APP_NAME=StitchShop`, `DEFAULT_SHOP_KIND=retail`); two Railway projects.
- **Login:** `User` per company (`prisma/schema.prisma`), bcrypt cost 10, Auth.js v5 credentials with JWT sessions
  (`src/auth.ts`), re-checked in the database each request (`src/lib/session.ts`, `sessionVersion`). Throttling in
  `src/lib/sign-in.ts`. Sign-up only with `ALLOW_SIGNUP=true`. Hosted reset at `/reset`. `POST /api/platform/companies`
  (bearer `PLATFORM_API_TOKEN`) lets the hub start hosted companies.
- **Hub link:** `src/lib/hub.ts`, `hub-account.ts`: a company's StitchHub account, started from Settings → Account.
- **AI:** `src/lib/assistant/client.ts` posts to the hub's `/v1/assistant`; about 27 features in
  `src/lib/assistant/features.ts` (repair drafts, likely causes, plate/label/thread/packing-slip reading from photos,
  ask the manuals, parts helpers, "Ask your shop", marketing drafts, quilt picks, customer questions on the booking page).
  Switches in Settings → Assistant; `ASSISTANT=off` stops all.
- **Variables (names only):** `APP_NAME`, `AUTH_SECRET`, `AUTH_TRUST_HOST`, `DATABASE_URL`, `DEFAULT_SHOP_KIND`,
  `PLATFORM_ADMIN_EMAILS`, `SEED_OWNER_EMAIL`, `SEED_OWNER_NAME`, `SEED_OWNER_PASSWORD`, `SEED_SHOP_NAME`, `TRUST_PROXY`;
  optional `PUBLIC_URL`, `SETTINGS_KEY`, `PLATFORM_API_TOKEN`, `LICENSE_HOSTED_KEY`, `PLATFORM_SMTP_URL`.
- **Users:** none yet; development phase (owner, 2026-10-19). **No migration flow**: demo accounts are reset.

## Decided (owner, 2026-10-19)
- **Hosted editions (Railway):** the owner signs in with a Foundry Account only. `User` gains `foundryId`; the Auth.js
  JWT holds a session reference, not the cloud token (kept server-side, sealed). Staff logins stay local to the company.
- **Desktop installs:** local logins stay. A Foundry link is optional. Without it: no hub sharing (community, partner
  shops, marketplace) and no credit-paid AI; the program and the shop's own AI key still work. With it: both work, and
  when the PC is offline the hub and AI show a message saying they return when it is online.
- **AI:** SiteSentrix pays Anthropic; credits are how it earns. Default is Foundry credits through `/v1/messages`, called
  server-side with the company owner's token (one balance per shop). Option: the shop's own Anthropic key (Settings →
  Assistant), sealed with `SETTINGS_KEY` like the mail password. The hub's `/v1/assistant` proxy is retired.

## Design notes
- Link local users to accounts by the cloud's `id`, never by email alone: sign-up on the cloud doesn't verify email yet,
  so an attacker could pre-register someone's address.
- A feature with no person behind it (the booking-page customer question) charges the owner's balance and turns itself
  off when it is empty.
- Keep `PROGRAM_FREE` and the license-key rules as they are until the owner says otherwise.

## Tasks
| Id | What | Done when |
|---|---|---|
| FA-0 | These docs; asks sent to the StitchFoundry chat (list in StitchHub's `docs/plan.md`) | merged |
| FA-1 | Cloud client module (sign-in, account, `/v1/messages`) with a mock server for tests | **Done 2026-10-19**: `src/lib/foundry/cloud.ts` (`signUp`, `signIn`, `signOut`, `getAccount`, `forgotPassword`, `sendMessages`; errors are `FoundryError` with a `kind`: offline, signed-out, no-credits, wait, refused, not-open, broken), `scripts/test-mail/foundry-mock.mjs`, `src/lib/foundry/cloud.test.ts` (12 tests). Address: `FOUNDRY_CLOUD_URL`, default https://cloud.stitchfoundry.app. Unused until FA-2 |
| FA-2 | Hosted sign-in with a Foundry Account; `User.foundryId`; reset demo accounts | **Done 2026-10-19, behind `FOUNDRY_SIGNIN` (off).** See "FA-2 notes". Demo accounts need no reset: a login is linked by proving its old password |
| FA-3 | Desktop: optional link; offline messages for hub and AI | link, unlink and offline checked |
| FA-4 | AI through `/v1/messages` or the shop's own key; drop the hub proxy call | features work both ways |
| FA-5 | Remove local owner passwords on hosted; drop `SEED_OWNER_PASSWORD` | none left |


## Open: "We host it for you" (owner, 2026-10-19; not built, no price decided)
A third way to use StitchBench or StitchShop: SiteSentrix hosts the shop or bench on its own server, for a cost. The owner wants it
shown, with the cost, on the StitchFoundry page for the apps. **Nothing is written or published yet.** Needed from the owner first
(money and public wording are the owner's call):
1. **The price**, and what it covers (one company? storage? backups? support? the Foundry credits are separate).
2. **Which page**: the StitchFoundry website's apps page (stitchfoundry.app, in the sitesentrix-web repo), or `/foundry/` on this
   site, or both.
3. **How it is paid**: a subscription through the hub's Stripe (which exists: $25 a month or $250 a year per shop in the hub's code,
   switched off while `PROGRAM_FREE` is on), or through the Foundry Account service's Stripe, or by invoice.
4. **How it differs from today's free hosted service**: the public pages now say hosted use is free ("nothing to pay"), and
   `docs/plans/pricing-review-2026-10.md` in StitchBench lists a "dedicated hosted copy" at cost (about $10 on top of a plan). The
   wording on `/`, `/stitchbench/`, `/signup/` and `/features/` would have to change with it.
Hosted copies sign in with a Foundry Account (FA-2), so this option rides on the work already done. Task id: FA-7.
## Open decisions (the owner's)
Prices and plans (`PROGRAM_FREE`), legal wording, and the wording users see on the first-run link prompt.

## FA-1 notes
- The mock follows the real service as read from `apps/stitchfoundry-cloud` on 2026-10-19, including that **only
  `claude-opus-5-5` is offered** and that sign-up doesn't verify email. If the StitchFoundry chat changes either, change
  `foundry-mock.mjs` and its tests with it.
- The client never logs, stores or puts the token in an error. Callers (FA-2 onward) keep it in the database, sealed with
  `SETTINGS_KEY`, and give the browser only a session reference.
- `OFFLINE_NOTICE` is the one wording for "the hub and AI need the internet and your Foundry Account"; FA-3 shows it.

## FA-2 notes
**The switch** (`src/lib/foundry/mode.ts`, hosted only; the desktop program is always off): `FOUNDRY_SIGNIN` unset or `off` = the
sign-in page and every session behave exactly as before. `on` = the page offers the Foundry Account first and the old email and
password beside it; both work. `only` = the old password no longer signs anyone in (it still proves a login when linking), and a
session without a live Foundry sign-in for its login's account ends, so turning it on signs everyone in again. Setting it is the
owner's call, in Railway's variables (the name is already in `.railway/railway.ts`).

**How it works**
- A login is linked to a Foundry Account at `/login/link` by proving both: its old email and password (with the usual limits), and
  the account's password (or "make me one", which signs up). `User.foundryId` then holds the account's **id**, never its email; the
  service doesn't verify email yet, and a test shows an account made with an owner's email gets nothing.
- `/login` signs in through the service; the logins linked to that id are the ones that fit (several companies: the existing
  "Choose a company" step). `/login/forgot` asks the service to email a reset link.
- The service's token is kept sealed in `FoundrySession` (only the hash of the browser's random cookie is stored); the browser holds
  only that cookie. Sign out and `/api/session-end` delete the row and the cookie and end the session at the service.
- Roles, companies and everything shop-specific still come from this database. A Foundry sign-in changes who may log in, nothing else.
- Migration `20261030000000_foundry_account`; `scripts/checks/foundry-signin.check.ts` (9 steps, needs the dev database).

**Checked 2026-10-19:** tsc, lint, unit tests (100), `signin.check.ts` (unchanged behaviour with the switch off), the new check, and a
real browser run of the built app against the stand-in service in `on` and `only` (link, wrong old password, unlinked account,
sign out, sign in again, old password in `on`, old session and a missing Foundry cookie ending in `only`; no token in any cookie).
**Not checked:** a deploy on Railway, the real service at cloud.stitchfoundry.app, the real reset email (needs its Resend key), and a
phone-width look at the new pages.

**Not done yet (small follow-ups)**
- Link from Settings when the same email and password fit a login in several companies (the link page says so).
- Sign-up for a brand-new company with a Foundry Account (`/signup` still makes a local password); the hub's
  `POST /api/platform/companies` still hands an owner a link to set a local password.
- Removing local owner passwords and `SEED_OWNER_PASSWORD` once the owner has switched to `only` (FA-5).
- Ask the StitchFoundry chat for verified email (an `emailVerified` flag) so a link could also offer "same email" as a hint.
