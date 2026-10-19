# Start here: Foundry Account work (new session)

Written 2026-10-19. This sits beside `AGENTS.md` and `CONTRIBUTING.md`; read those too. Then [`plan.md`](plan.md).

## The owner
**Bruce Wattendorf**, doing business as **SiteSentrix**. Plain, step-by-step instructions work best for anything he
has to click through. Commits are authored by him (see `CLAUDE.md`).

## What this repo is
StitchBench (repair shops) **and** StitchShop (sewing and quilt shops) are this one code base. `APP_NAME=StitchShop` and
`DEFAULT_SHOP_KIND=retail` make a StitchShop. Hosted on Railway as two projects (`stitchbench`, `stitchshop`); the same
program also ships as a Windows/Mac/Linux desktop app (`desktop/`) and a Docker image. Related: StitchHub
(github.com/Stitchwright/stitchhub, the shared server), stitchsite (the marketing site), and the Foundry Account service
(github.com/Stitchwright/StitchFoundry, `apps/stitchfoundry-cloud`, `docs/cloud.md`).

## Where login and AI are today
- Login: `src/auth.ts` (Auth.js credentials, JWT), `src/lib/sign-in.ts` (throttling), bcrypt cost 10, `User` in
  `prisma/schema.prisma`, `src/lib/session.ts` (`requireUser`).
- Hub link: `src/lib/hub.ts`, `src/lib/hub-account.ts` (a company's StitchHub account).
- AI: `src/lib/assistant/client.ts` sends everything to the hub's `POST /v1/assistant`; about 27 features are listed in
  `src/lib/assistant/features.ts`. The program never held a key.

## Decided (owner, 2026-10-19)
- **One login: the Foundry Account**, one credit balance ("Foundry credits") across SiteSentrix software.
- **AI is how SiteSentrix earns.** Default: Foundry credits via the cloud service's `/v1/messages`, called server-side
  with the owner's token. Option: a shop's **own Anthropic key**, sealed like the mail password (`SETTINGS_KEY`).
- **Desktop installs** keep local logins with an optional Foundry link. Without the link: no hub sharing, no
  credit-paid AI; own key still works. **Hosted editions** sign in with a Foundry Account only. Staff logins stay local
  to each company.
- Shop data stays in this database, keyed by the Foundry account's `id`.

## The owner decides (ask, don't assume)
Money, payments, legal wording, and anything that changes what real users see (including moving existing users to a
Foundry Account, and the `PROGRAM_FREE` rules).

## Rules for this repo
- `npm run lint`, `npm run test:unit` and the affected `scripts/checks/*` before every push; never push to main with
  failing checks; never force-push.
- Next.js here is not the one you know: read `node_modules/next/dist/docs/` first (`AGENTS.md`).
- Secrets live in Railway variables. Never in code, docs or chat.
