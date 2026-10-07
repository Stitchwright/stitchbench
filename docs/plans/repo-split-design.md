# Splitting StitchBench and StitchShop: design (2 Oct 2026, for the owner)

**Owner decision, 3 Oct 2026: not now.** One codebase stays; this plan is kept for if a reason to split appears (HANDOFF section 3 item 7).

HANDOFF.md section 3 item 7 (the owner was given shape (b): one repository laid out as npm workspaces, `packages/core`
plus `apps/stitchbench` and `apps/stitchshop`) and item 10 (a shop can move between hosted, Windows and self-hosted,
which the split must not make harder). Nothing here is built. Where this document says "decided", the owner may still
say otherwise; section 9 lists the open questions with a recommended answer each. The dry run
`node scripts/repo-split/plan.mjs` prints every file the move touches and the `git mv` commands; it moves nothing.

Files relied on: `package.json`, `desktop/package.json`, `desktop/main.mjs`, `desktop/prepare-app.mjs`,
`desktop/test/desktop.test.mjs`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `playwright.config.ts`,
`prisma.config.ts`, `prisma/schema.prisma`, `.github/workflows/checks.yml`, `installers.yml`, `railway.json`,
`.railway/railway.ts`, `scripts/local-test/update_installed.ps1`, `rebuild_and_test.ps1`, `start_hubtest.bat`,
`scripts/checks/lib.ts`, `tests/helpers.ts`, `scripts/e2e-setup.ts`, `src/lib/shops.ts`, `src/app/layout.tsx`,
`src/app/globals.css`, `INSTALL.md`, Next 16.2's `output.md`, `turbopack.md`, `transpilePackages.md`.

## 0. What the split is, in one page

- **The two programs share every source file.** The flavor is two environment variables, read in three places:
  `APP_NAME` (`src/app/layout.tsx` for the tab title, `src/lib/shops.ts` `appName()`) and `DEFAULT_SHOP_KIND`
  (`shops.ts` `defaultShopKind()`, `prisma/seed.ts` for the seeded company). The Windows program sets both from
  `flavor` in its `package.json` (`desktop/main.mjs` line 391); the hosted services set them as Railway variables.
  Everything else is decided per company at run time from `Shop.doesRepair` and `Shop.sellsRetail` (about 25 files,
  `nav.tsx`, `(app)/layout.tsx`, the settings, parts, classes, register and vac pages), because a StitchShop counter
  may do repairs and a bench may sell. So no page, action, component or library is StitchShop-only or StitchBench-only,
  and nothing that exists today moves into `apps/`.
- **Decided: shape (b), honestly sized.** `packages/core` holds the whole Next.js app as it is today (`src/` with the
  routes, `prisma/` with the one schema and migration history, `public/`, `tests/`, `scripts/`, the configs).
  `apps/stitchbench` and `apps/stitchshop` are thin Next.js projects: a `package.json` with the product's name and
  version, a `next.config.ts`, a `tsconfig.json`, a generated `src/app/` whose files only re-export core's routes, the
  installer configuration, the Railway configuration and the icon. `packages/desktop` is today's `desktop/` folder,
  the one Electron shell both installers are built from.
- **Core stays runnable on its own** (`next dev` / `next build` in `packages/core` is the unbranded instance, as the
  root is today). The Playwright specs, the check scripts and the local test server (`:3300`) keep running against it,
  unchanged except for the folder they run in. The apps are what gets released: two installers, two Railway services.
- **The flavor mechanism does not change.** The apps carry their defaults (`stitch.flavor`, `APP_NAME`,
  `DEFAULT_SHOP_KIND`) in `package.json` and the installer/Railway configuration; `main.mjs` and the Railway variables
  keep setting the two variables exactly as now. Zero changes to `src/` beyond one `@source` line in `globals.css`.
- **One schema, one migration history, no migration in this change.** `packages/core/prisma` is the only Prisma
  project; both apps run `prisma migrate deploy` from it at start, and the Windows program ships its `migrations/`
  folder as today. That also keeps item 10 true: a company's export/import, the backups and `import-from-dev.mjs` see
  one database layout whichever program made it.
- **`packages/desktop` stays outside the npm workspaces** (own `package-lock.json`, own `npm ci`, as today), so
  Electron, `embedded-postgres` and electron-builder's `node_modules/**` packaging are untouched by hoisting.
- Dry run (2 Oct 2026, 617 files: 609 tracked plus the day's uncommitted work, which the script counts so a folder
  move never sweeps along a file it has not shown): **558 to `packages/core`, 20 to `packages/desktop`, 39 stay at the
  root, 0 unclassified; 23 `git mv` commands.** Estimate: 3 working days plus one day of the owner's deploys and
  checks (section 10).

## 1. Target layout

```
stitchbench/                       the GitHub repository keeps its name (Railway and the owner's links point at it)
  package.json                     workspace root: "workspaces": ["packages/core", "apps/*"], forwarding scripts
  package-lock.json                one lock file for core and the apps (regenerated once)
  .gitignore, docker-compose.yml, README.md, INSTALL.md, CLAUDE.md, AGENTS.md, docs/, .github/, .railway/
  packages/core/                   @stitch/core (private). Today's root, moved:
    src/  prisma/  prisma.config.ts  public/  tests/  scripts/{checks,e2e-setup.ts,hub,library,license,local-test,test-mail,copy-pdf-worker.mjs}
    next.config.ts  tsconfig.json  eslint.config.mjs  postcss.config.mjs  playwright.config.ts  .env.example  (.env, untracked)
    package.json                   today's root package.json: same dependencies and scripts, name @stitch/core
  packages/desktop/                today's desktop/, moved whole; not a workspace member. prepare-app.mjs gains --app.
  apps/stitchbench/                @stitch/stitchbench, version 1.7.0 (the next release number after 1.6.1)
    package.json                   "stitch": { "flavor": "stitchbench", "appName": "StitchBench", "defaultShopKind": "repair" }
    next.config.ts                 spreads core's config, adds outputFileTracingRoot (section 2)
    tsconfig.json                  extends ../../packages/core/tsconfig.json, paths "@/*": ["../../packages/core/src/*"]
    postcss.config.mjs             the same three lines (Next reads it from the project folder)
    src/app/**, src/proxy.ts, src/instrumentation.ts, public/   GENERATED by sync-app.mjs at build, git-ignored
    electron-builder.yml           appId, productName, shortcut, extraMetadata (flavor, version), icon, output folder
    railway.json                   today's healthcheck and restart policy plus this app's build and start commands
    brand/icon.png                 a copy of desktop/icon.png for now
  apps/stitchshop/                 the same nine files with the StitchShop name, com.timingandtension.stitchshop, "retail"
  scripts/repo-split/plan.mjs      the dry run (this document); sync-app.mjs, the shim generator (new)
```

Root `package.json` scripts forward to the packages so the handoff's commands stay short: `dev`, `build`, `lint`,
`test:unit`, `e2e`, `check`, `db:*` run `npm run <x> -w @stitch/core`; `build:stitchbench` / `build:stitchshop` run
the app builds; `installers` is documented in INSTALL.md rather than scripted (it needs `packages/desktop`'s own
install).

## 2. How one Next.js app directory serves two apps

Next 16 looks for `app/` (or `src/app/`) in the project folder that holds `next.config.ts`, and only there; it cannot
be pointed at another package. Symlinks are out (Windows, git). The honest options:

(a) **Build core twice** with different environment: the apps are only installer and Railway configuration. Simplest,
but an app could never have a route of its own, and `apps/` would be three config files, not what the owner was shown.

(b) **Each app has its own `src/app/` of re-export shims** (decided). For every route file in
`packages/core/src/app/**` (today 104 `page.tsx`, 23 `route.ts`, 2 `layout.tsx`, `error.tsx`, `global-error.tsx`) the
app has a file at the same path:

```ts
// apps/stitchshop/src/app/(app)/tickets/page.tsx   (generated; do not edit)
export { default } from "@/app/(app)/tickets/page";
export * from "@/app/(app)/tickets/page";   // metadata, dynamic, revalidate, generateMetadata, generateStaticParams
```

`route.ts` shims are the `export *` line only (handlers are named exports). `src/proxy.ts` re-exports
`{ default, config }`, `src/instrumentation.ts` re-exports `{ register }`. `favicon.ico` is copied. `globals.css`,
`api/library/range.ts`, `history.tsx` and the `.test.ts` are not routes: core's own files import them relatively and
they stay in core. `public/` is copied from core into the app at build (Next serves `public/` from the project folder
only); later brand-specific files would come from `apps/<x>/brand/public/` copied over it.

The shims are written by `scripts/repo-split/sync-app.mjs <app>` and git-ignored; each app's `prebuild` and `predev`
run it, so the tree can never be stale and nothing is forgotten when a route is added (decision; alternative in 9.1).
A hand-written route that only one app should have goes in `apps/<x>/src/app-own/` and is copied over the generated
tree last; today that folder is empty in both apps, and the generator refuses a collision.

Why this works in Next 16.2: Turbopack resolves any file under the workspace root (it finds the root by the lock
file; `turbopack.root` is the fallback), compiles core's `.ts/.tsx` as source (they are not a built package, so no
`transpilePackages` is needed; it is the fallback if an import is treated as external), honours the app's
`tsconfig.json` `paths`, so `@/…` inside core's files resolves to `packages/core/src` because both tsconfigs say the
same thing. `"use client"` and `"use server"` directives live in core's files and survive re-export. Three things each
app's `next.config.ts` must carry, by spreading a `nextConfigBase` exported from `packages/core/next.config.ts`:
`experimental.serverActions.bodySizeLimit` / `proxyClientMaxBodySize` (they must match `proxy.ts`), the baked
`env.STITCH_TEST_BUILD`, and `output: "standalone"` under `STANDALONE=1`; plus `outputFileTracingRoot:
path.join(import.meta.dirname, "../..")` so a standalone build traces core's files and the hoisted `node_modules`.

Tailwind 4 scans for class names from the folder the build runs in, which becomes `apps/<x>`: core's components
would lose their utility classes. One line in `packages/core/src/app/globals.css`, `@source "..";` (relative to the
stylesheet: `packages/core/src`), fixes it and is harmless for core's own build. Gate: a built app page carries the
`bg-navy`-style classes (section 8, step 4).

## 3. Prisma: one schema, one history, one generated client

Nothing changes but the folder. `packages/core/prisma/schema.prisma` keeps `output = "../src/generated/prisma"`, so
the client stays at `packages/core/src/generated/prisma`, reached from core's code and from the apps' builds through
`@/generated/prisma/client`. `prisma.config.ts` moves with it, so `npx prisma …` runs in `packages/core` (the root
`db:*` scripts forward there). The apps never import Prisma directly. `release` (`prisma migrate deploy` then the
seed) is core's script, called by each app's `start`: `npm run -w @stitch/core release && next start`. The Windows
program copies `packages/core/prisma/migrations` and the three `seed-data` files as today. `.gitignore` gets
`/packages/core/src/generated`. The drift check in HANDOFF section 3 item 2 runs in `packages/core` with the same
command. Rule for the split PR: it carries no migration, so a rollback never touches a database.

## 4. The Windows program and the installers

`packages/desktop` is `desktop/` moved whole, with its own `package.json`, lock file and `node_modules`, outside the
workspaces. Changes inside it:
- `prepare-app.mjs --app stitchbench|stitchshop`: runs `STANDALONE=1 npm run build -w apps/<x>` from the repo root,
  then fills `packages/desktop/server/` from `apps/<x>/.next/standalone`. In a workspace that folder is laid out as
  `standalone/apps/<x>/server.js` + `.next`, with the hoisted `node_modules` (and traced core files) at its top, traced
  from `outputFileTracingRoot`. Decision: copy it as it is and let `main.mjs` spawn `server/apps/<x>/server.js` (the
  path in a `server/entry.json` prepare-app writes) rather than flatten it, which would mean rewriting the relative
  paths `server.js` was generated with. `.next/static` and `public/` go beside that `server.js`; `migrations/` and
  `seed-data/` stay at `server/` where `main.mjs` reads them; the `_node_modules` renaming and `.env` scrubbing stay.
- `main.mjs`: `APP_DIR` entry path from `entry.json`; `FLAVOR` still from `PKG.flavor`, which electron-builder's
  `extraMetadata.flavor` writes into the packaged `package.json` as today.
- `test/desktop.test.mjs`: `MIGRATIONS` becomes `../core/prisma/migrations` (today `../prisma/migrations`).
- `package.json`: the `installer:stitchshop` flags move out into the apps' `electron-builder.yml` files; the base
  `build` block (`asar: false`, `files`, `extraResources`, `nsis`) becomes `electron-builder.base.yml` that both app
  files `extends`. Build from `packages/desktop`: `npx electron-builder --win nsis --publish never --config
  ../../apps/stitchshop/electron-builder.yml`. The app's file sets `appId`, `productName`, `nsis.shortcutName`,
  `win.icon: ../../apps/stitchshop/brand/icon.png`, `directories.output: ../../apps/stitchshop/dist`, and
  `extraMetadata: { flavor, productName, version }` with the version read from `apps/stitchshop/package.json` by a
  tiny wrapper (`packages/desktop/build-installer.mjs <app>`), so the app's `package.json` is the single place a
  release number lives (today it is `desktop/package.json`). `app.getVersion()` in backups and the tray follows.
- `installers.yml`: a matrix over `app: [stitchbench, stitchshop]`; each job runs root `npm ci`, `npm ci` in
  `packages/desktop`, `node prepare-app.mjs --app <app>`, `node build-installer.mjs <app>`, and uploads
  `apps/<app>/dist/*.exe` as `installers-<app>`. Triggers: `workflow_dispatch` (both) and tags `stitchbench-v*` /
  `stitchshop-v*` (the prefix selects one app). Today's single `prepare-app` run serving both installers only worked
  because the two builds were identical; after the split each app is built on its own.
- `scripts/local-test/update_installed.ps1 -Version <v> -App stitchbench|stitchshop`: copies
  `packages/desktop/server` (the last prepared app; the script checks `server/entry.json` names the same app) over
  `%LOCALAPPDATA%\Programs\<StitchBench|StitchShop>\resources\server`, program files from
  `packages/desktop/package.json` `build.files` as today, and writes the version. The handoff's update line becomes
  `cd packages/desktop && node prepare-app.mjs --app stitchbench` then the script.

## 5. Railway: two services, one repository

Both services keep deploying from the repository root (`railway up` uploads the linked folder; Railpack sees the
root `package.json` and runs `npm ci`, which installs core and the apps). What differs per service is the build and
start command, and Railway holds those per service: decided, each app gets its own `railway.json` (today's
healthcheck and restart policy plus `build.buildCommand: "npm run build -w @stitch/stitchshop"` and
`deploy.startCommand: "npm run start -w @stitch/stitchshop"`), and each service's **Config-as-code file path** is set
once in the dashboard to `apps/<x>/railway.json`; the root `railway.json` is deleted. `.railway/railway.ts` (the
Infrastructure-as-Code file for item 14, due before 2026-12-01) gets the same two commands keyed by `ctx.projectName`
so the Dec switch carries them; `keptVariables` is unchanged (`APP_NAME` and `DEFAULT_SHOP_KIND` stay Railway
variables). `npm run build -w @stitch/stitchshop` is `prisma generate` in core, `sync-app.mjs`, `next build`;
`start` is core's `release` then `next start`. The healthcheck `/api/health` is a core route and exists in both apps.
The Railway CLI respects `.gitignore`, so `packages/desktop/node_modules` and `apps/*/dist` are not uploaded.
INSTALL.md's self-hosted steps gain one line each (the config path), nothing else.

## 6. Tests, checks and the local test server

- `tests/`, `playwright.config.ts`, `scripts/checks/`, `scripts/e2e-setup.ts`, `scripts/license/`,
  `scripts/test-mail/` move to `packages/core` unchanged. Their imports are `@/…` (tsconfig paths, same file) or
  `../src/…` (same relative depth). `npm run e2e`, `npm run check <file>`, `npm run e2e:setup`, `npm run test:unit`
  run in `packages/core` (or through the root forwarders). `.env` (untracked) moves to `packages/core` by hand:
  dotenv reads the working folder.
- The local test server stays core's unbranded build: `rebuild_and_test.ps1`, `start_hubtest.bat` and
  `offline_test.ps1` change their `Set-Location` / `cd /d` to `C:\Users\bwatt\stitchbench\packages\core`; the hub side
  (`start_hub.bat`, `:3200`) is untouched. `scripts/local-test/README.md` gets the new paths.
- `checks.yml`: root `npm ci`, then in `packages/core` `prisma generate`, `tsc --noEmit`, `lint`, `test:unit`, and two
  new steps, `npm run build -w @stitch/stitchbench` and `-w @stitch/stitchshop` (about 4 minutes each on
  `ubuntu-latest`; they are the only thing that proves the shims and the Tailwind source line). The `desktop` job runs
  in `packages/desktop` exactly as now. Cache keys: `package-lock.json` and `packages/desktop/package-lock.json`.
- `eslint.config.mjs` ignores gain `../../apps/*/src/app/**` equivalents; simpler: each app has a two-line ESLint
  config that ignores its generated tree, and `npm run lint` at the root runs core's only.
- `desktop/test/desktop.test.mjs` path change (section 4). No spec, check or unit test changes its contents.

## 7. The move itself

Commit A is the 23 commands below and nothing else (`git mv` keeps history; `git log --follow` and GitHub's rename
detection work because the files are unchanged in that commit). From the repository root, in Git Bash:

```
mkdir -p packages/core packages/core/scripts
git mv .env.example packages/core/.env.example
git mv eslint.config.mjs packages/core/eslint.config.mjs
git mv next.config.ts packages/core/next.config.ts
git mv playwright.config.ts packages/core/playwright.config.ts
git mv postcss.config.mjs packages/core/postcss.config.mjs
git mv prisma.config.ts packages/core/prisma.config.ts
git mv prisma packages/core/prisma
git mv public packages/core/public
git mv scripts/checks packages/core/scripts/checks
git mv scripts/copy-pdf-worker.mjs packages/core/scripts/copy-pdf-worker.mjs
git mv scripts/e2e-setup.ts packages/core/scripts/e2e-setup.ts
git mv scripts/hub packages/core/scripts/hub
git mv scripts/library packages/core/scripts/library
git mv scripts/license packages/core/scripts/license
git mv scripts/local-test packages/core/scripts/local-test
git mv scripts/test-mail packages/core/scripts/test-mail
git mv src packages/core/src
git mv tests packages/core/tests
git mv tsconfig.json packages/core/tsconfig.json
mkdir -p packages && git mv desktop packages/desktop
git commit -m "Repo split 1/5: move the app to packages/core and the Windows program to packages/desktop (moves only)"
```

`scripts/repo-split/` stays at the root, which is why `scripts/` moves folder by folder. `package.json` and
`package-lock.json` stay at the root and are rewritten in commit B (a `git mv` of `package.json` to core followed by a
new root file would read as a rename to git and muddle `blame`; the content is what matters there, not the history).
`plan.mjs` regenerates this list (`node scripts/repo-split/plan.mjs`); re-run it on the day, since files are added daily.

## 8. Build order, with a gate after each step

Prerequisite: `main` quiet for the day (no other branch merges between commit A and the merge; a rebase across the
move is painful). Record the baseline on `main` first: `npx tsc --noEmit`, `npm run lint`, `npm run test:unit`,
`npx playwright test smoke` against `:3300`, `npx next build`; all green, timings noted. Work on branch `repo-split`.

1. **Commit A, moves only** (section 7). Gate: `git status` shows renames only (`git diff --stat -M HEAD~1` all
   `=>`); `git log --follow packages/core/src/lib/shops.ts` shows the old history.
2. **Commit B, workspace plumbing.** Root `package.json` rewritten (workspaces, forwarders, `engines`); core's
   `package.json` is today's root one renamed `@stitch/core` with `postinstall` kept (npm runs workspace lifecycle
   scripts on install, so `copy-pdf-worker` still fills `packages/core/public`); `rm -rf node_modules && npm install`
   regenerates the lock; `.gitignore` paths (`/packages/core/src/generated`, `/packages/core/.next`,
   `/packages/core/test-results`, `/packages/core/public/pdf.worker.min.mjs`, `/packages/core/public/pdfjs`,
   `/packages/desktop/{node_modules,server,dist}`, `/apps/*/{.next,dist,src/app,src/proxy.ts,src/instrumentation.ts,public}`);
   `.env` moved by hand; the `desktop.test.mjs` path. Gate, in `packages/core`: `npm ci` at the root succeeds;
   `npx prisma generate`, `npx tsc --noEmit`, `npm run lint`, `npm run test:unit` all green; `npx next build` green;
   `start_hubtest.bat` from the new folder and `npx playwright test smoke` green; `cd packages/desktop && npm ci &&
   npm test` green.
3. **Commit C, the apps.** `sync-app.mjs`; `apps/stitchbench` and `apps/stitchshop` (package.json, next.config.ts
   spreading `nextConfigBase`, tsconfig.json, postcss.config.mjs, eslint ignore, brand/icon.png); `@source "..";` in
   `globals.css`; `nextConfigBase` exported from core's `next.config.ts`. Gate: `npm run build -w @stitch/stitchbench`
   and `-w @stitch/stitchshop` green; `npm ls react next` shows one copy of each (deduped); `APP_NAME=StitchShop
   DEFAULT_SHOP_KIND=retail PORT=3301 npm run start -w @stitch/stitchshop` against the dev database answers
   `/api/health`, the login page's title is "StitchShop" and is styled (the Tailwind gate), and `E2E_BASE_URL=
   http://localhost:3301 npx playwright test smoke` passes from `packages/core`; `npx tsc --noEmit -p apps/stitchshop`
   green (it type-checks core through the shims; slow, run once).
4. **Commit D, the Windows program.** `prepare-app.mjs --app`, `entry.json`, the one-line `main.mjs` change,
   `electron-builder.base.yml` + the two app files, `build-installer.mjs`, `update_installed.ps1 -App`. Gate:
   `node prepare-app.mjs --app stitchbench` then `node desktop/backup-now.mjs`-style backup of the installed 1.6.1,
   then `update_installed.ps1 -Version 1.7.0 -App stitchbench`: the tray starts, no migration runs (none in this
   change), a page loads on `:3100`, **Back up now** works, the tray says 1.7.0. `npm test` in `packages/desktop` green.
5. **Commit E, workflows, Railway files, documents.** `checks.yml`, `installers.yml` (matrix), per-app `railway.json`
   and the root one deleted, `railway.ts` commands, `scripts/local-test/*` paths and README, INSTALL.md (section 11),
   README.md, CLAUDE.md item 3 commands, AGENTS.md paths, HANDOFF item 7 (done, the day, the branch) and 0b, the
   memory note. Gate: push the branch; the Checks workflow is green including both app builds; `gh workflow run
   installers.yml --ref repo-split` yields two `.exe` artifacts.
6. **Owner's deploys** (the owner runs these; the gate is the owner's). In the Railway dashboard set each service's
   config-as-code path (`apps/stitchshop/railway.json`, `apps/stitchbench/railway.json`). `railway up --service
   stitchshop --ci` from the root: `/api/health` answers, a sign-in works, the title says StitchShop. Then
   `railway link --project stitchbench`, `railway up --service stitchbench --ci`, same checks, link back. Then merge
   `repo-split` into `main` (one PR, five commits, no squash so the move commit stays pure), tag `stitchbench-v1.7.0`
   and `stitchshop-v1.7.0`, and let the installers workflow build from the tags.

## 9. Open questions, each with a recommended answer

9.1 **Generated shims: git-ignored and built on demand, or committed?** Recommended: git-ignored (decided above). A
committed tree would show the routes an app has in the repository, but it drifts the first time someone adds a page
and forgets `sync-app`; a `--check` step in CI would catch it, and that is one more thing. Revisit if an app ever has
more than a handful of own routes.
9.2 **Should core stay a buildable Next project?** Recommended: yes, for now. It is the unbranded test and dev
instance everything in `docs/TESTING.md` and `scripts/local-test` assumes; dropping it would mean picking one app as
"the test app" and changing every script. Remove it only if the apps diverge enough that testing core alone misleads.
9.3 **Release tags.** Recommended: `stitchbench-v1.7.0` / `stitchshop-v1.7.0`, both at 1.7.0 for the split release,
then independent. The `v*` tags of 1.4–1.6 stay as they are.
9.4 **Is `packages/desktop` a workspace member?** Recommended: no. Electron and `embedded-postgres` must not hoist
(electron-builder packages `node_modules/**` from the app folder, and the Checks `desktop` job installs with
`--ignore-scripts` in that folder). Cost: two `npm ci` runs, as today.
9.5 **Package names.** Recommended: `@stitch/core`, `@stitch/stitchbench`, `@stitch/stitchshop`, all private; the
GitHub repository and the Railway projects keep their names.
9.6 **StitchShop icon.** Recommended: the same icon for now (`brand/icon.png` is a copy in each app); a brand decision,
not part of the move.
9.7 **Per-app `railway.json`, or `railway.ts` only?** Recommended: both (section 5): `railway.json` works today with
one dashboard setting per service; `railway.ts` carries the same for the December switch.
9.8 **`scripts/local-test`** goes to `packages/core/scripts/local-test` (it builds and runs core); the hub-side scripts
in it point at the other repository. **A `stitch-protocol` package** for the hub is not in this move (item 7's note).

## 10. Estimate

Day 1: baseline, commits A and B, gates 1–2 (the lock-file regeneration and the first green core build are where
surprises surface). Day 2: commit C, gate 3 (the shim generator, the Tailwind and standalone-tracing questions, a
`tsc -p apps/…` run). Day 3: commits D and E, gates 4–5 (the installed program updated in place, the two workflows
green, documents). Day 4, the owner: Railway config paths and both deploys, the merge, the tags, the installer run.
Three working days of build plus one owner day; add a day if the standalone layout needs the flattening fallback.

## 11. Risks and what answers each

- **`@/` alias across packages.** Core's files are compiled by the app's build with the app's tsconfig `paths`; both
  map `@/*` to `packages/core/src/*`, so they agree. If Turbopack treats a core file as external, `transpilePackages:
  ["@stitch/core"]` in the app config is the switch; if it refuses to resolve outside the project, `turbopack.root`
  set to the repository root. Gate 3 shows which, if any.
- **Two copies of React or Next.** `next`, `react`, `react-dom` are declared only in `@stitch/core`; the apps list
  `next` at the identical pinned version so `npm run build -w` finds the binary, and npm dedupes to one copy. Gate:
  `npm ls react next` after every lock change.
- **Generated Prisma client path.** Unchanged relative to the schema; the only thing to get right is the `.gitignore`
  line and that `prisma generate` runs in core before any app build (the app `build` script does it).
- **Tailwind 4 source scanning** runs from the working folder: `@source "..";` in `globals.css`. Visible at once in
  gate 3 (an unstyled login page).
- **Standalone output layout in a workspace** (`standalone/apps/<x>/server.js`, hoisted `node_modules` at the top,
  traced core files beside them). `outputFileTracingRoot` at the repository root makes it complete; `entry.json` tells
  `main.mjs` where `server.js` is. Fallback: flatten by rewriting the one relative path in `server.js`.
- **Electron packaging of a workspace.** Avoided: `packages/desktop` is not a workspace member (9.4).
- **Hard-coded paths** in the local-test scripts, CLAUDE.md and HANDOFF (`desktop/`, `node desktop/backup-now.mjs`):
  step 5; grep for `desktop/` and `stitchbench\\` before merging.
- **Railway's first deploy after the move** fails if the config path is not set (the root no longer has a `build`).
  Set the paths first; the previous deployment stays live until the new one passes the healthcheck.
- **A frozen `main` for a day.** A branch open across the move needs `git rebase -X find-renames`; its new files must
  be placed by hand.

## 12. Rollback

Before the merge: delete the branch, nothing else changed (no migration, no Railway setting touched until step 6).
After step 6 and before the merge: Railway → the service's previous deployment → **Redeploy** (one click, the database
is unchanged); the Windows program back to 1.6.1 by running `update_installed.ps1 -Version 1.6.1` from a `main`
checkout (`git worktree add ../sb-main main`, `npm ci`, `cd desktop && npm ci && node prepare-app.mjs`), or by
restoring the pre-update backup from the tray. After the merge: `git revert -m 1 <merge commit>` on `main` restores
the old tree in one commit (the moves reverse cleanly because commit A changed no content), then the same Railway
redeploy and the same in-place update. The dev database, the shops' data and the hub are never touched by the split.

## 13. What INSTALL.md and the handoff say afterwards

INSTALL.md: the two Railway sections gain the config-path line (the build and start commands come from
`apps/<x>/railway.json`, nothing for a shop to type); "Building the installers on GitHub" names the two artifacts and
the tag prefixes; "Building the Windows installer" becomes `cd packages/desktop && npm ci && node prepare-app.mjs --app
stitchbench && node build-installer.mjs stitchbench` (and `stitchshop`); "Updating an installed program", "Tools in
`desktop/`" and "Test builds" read `packages/desktop` and `npm run build -w @stitch/stitchbench`; the check-script line
runs in `packages/core`. HANDOFF: item 7 marked done with the date and this file; section 0b and CLAUDE.md item 3 get
the new `prepare-app` and `update_installed.ps1 -App` commands; the memory note says the app lives in `packages/core`.
The hub repository and INSTALL.md's hub, messages and modules sections do not change.
