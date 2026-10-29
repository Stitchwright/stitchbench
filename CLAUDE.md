@AGENTS.md

See CONTRIBUTING.md for setup, checks and conventions, and docs/plans/ for the design documents.

## Commit authorship

Commits in this repository are authored by **Bruce Wattendorf**, so the work shows on his GitHub profile. AI assistance is credited with a trailer, not as the author.

- Before the first commit in a session, set the identity: `git config user.name "Bruce Wattendorf"` and `git config user.email "bwattendorf@gmail.com"`. If you can't change the config, pass `--author="Bruce Wattendorf <bwattendorf@gmail.com>"` on every `git commit`.
- Never author or commit as `Claude <noreply@anthropic.com>`.
- End every commit message with this trailer as its last line:
  `Co-Authored-By: Claude <noreply@anthropic.com>`

## What this is

StitchBench and StitchShop: one Next.js code base for sewing-machine repair shops (tickets, machines, parts, factory specs) and sewing/quilt/vacuum shop counters (register, classes, booking, online shop, decorating). Open source (MIT OR Apache-2.0). Runs hosted on Railway, as a Windows/Mac/Linux program (Electron, `desktop/`) or self-hosted with Docker.

## Layout

- `src/app/` pages and API routes; `src/actions/` server actions; `src/lib/` business logic (pure maths in `*-math.ts`); `src/components/`
- `prisma/` schema, migrations and seed data; `scripts/checks/` the database checks; `tests/` Playwright
- `desktop/` the Electron program and its database tooling; `docs/plans/` design documents

## Build and test

```
npm ci && npx prisma generate
npx tsc --noEmit && npm run lint && npm run test:unit      # what CI runs on every PR
npm run build                                             # prisma generate + next build
npm run check scripts/checks/<name>.check.ts              # one database check (needs DATABASE_URL; some need SETTINGS_KEY)
cd desktop && npm test                                    # needs TEST_DATABASE_URL
```

Node version: `.nvmrc`. Setup details: `CONTRIBUTING.md`.

## Conventions

The rules in `AGENTS.md` and `CONTRIBUTING.md` apply (shop-scoped queries, `safe()` actions, money in cents). Keep a change focused and add a check or test.

## Product family

StitchFoundry is the umbrella brand (SiteSentrix, Rhode Island). One free **Foundry Account** (cloud.stitchfoundry.app) and one credit balance work across the apps.

| Product | What it is | How it relates to this repo |
|---|---|---|
| StitchFoundry | Embroidery digitizing (stitchfoundry.app), the flagship | Sends a finished design to a shop's StitchShop through StitchHub's inbox ("Send to StitchShop"); shares the Foundry Account |
| LaserFoundry | Laser cutting and engraving (laserfoundry.app) | Sibling; shares the Foundry Account only |
| MakerFoundry | Share, buy and sell embroidery and laser designs (makerfoundry.app) | Sibling; shares the Foundry Account only |
| PatternFoundry | Sewing patterns (coming soon) | Sibling; shares the Foundry Account only |
| StitchBench | Repair-shop ticketing: machines, tickets, parts, factory specs | This repo. A repair shop (a tech) joins StitchHub from Settings, Account, is the supply side of partner jobs and the parts marketplace |
| StitchShop | The counter for sewing, quilt and vacuum shops (same code base as StitchBench, `APP_NAME=StitchShop`) | This repo, run as a retail shop. Sends machines to a partner repair shop through StitchHub and receives StitchFoundry designs in its inbox |
| StitchHub | The community hub and parts marketplace (hub.stitchbench.app) | The server this program syncs with (install key, partner links, listings, orders, manuals). Bench calls its `/v1/...` routes (`src/lib/hub.ts`) |

## Standing rule for every session

At START read `CLAUDE.md` and `PROGRESS.md`. Do ONE task. At END update `PROGRESS.md` and open a pull request (never merge it, never push to main, never force-push).

Where this conflicts with a repo-specific rule above (for example commit authorship), the repo-specific rule wins.
