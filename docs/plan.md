# StitchBench and StitchShop: the Foundry Account plan

**Status:** 2026-10-19. Survey done, nothing built yet. Owner: Bruce Wattendorf (SiteSentrix).

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
| FA-1 | Cloud client module (sign-in, account, `/v1/messages`) with a mock server for tests | unit tests pass |
| FA-2 | Hosted sign-in with a Foundry Account; `User.foundryId`; reset demo accounts | owner signs in on a hosted demo |
| FA-3 | Desktop: optional link; offline messages for hub and AI | link, unlink and offline checked |
| FA-4 | AI through `/v1/messages` or the shop's own key; drop the hub proxy call | features work both ways |
| FA-5 | Remove local owner passwords on hosted; drop `SEED_OWNER_PASSWORD` | none left |

## Open decisions (the owner's)
Prices and plans (`PROGRAM_FREE`), legal wording, and the wording users see on the first-run link prompt.
