# Local end-to-end testing (Windows, this PC)

Scripts used during the 2026-09 review to build StitchBench, run a test StitchHub, and run the Playwright specs
one at a time (running them in parallel crashed Chrome on this PC). Everything writes to `.run\` here (ignored).

## Pieces
| Script | What it does |
|---|---|
| `start_hub.bat` | A StitchHub on **:3200** against the dev Postgres database `stitchhub_test`, link checker off, `HUB_ALLOW_PRIVATE_LINKS=true` (the specs' links point at localhost). Test admin token and join key are inside; they are test values only. |
| `start_hubtest.bat` | StitchBench on **:3300** (`npx next start`) with a test manual library in `.run\testlib`, plus a plain file server on **:3400** serving `fixtures\pdfsrv`. Sets `FETCH_ALLOW_HOSTS=localhost:3400` so "Download to library" may fetch from it. |
| `rebuild_and_test.ps1 -Spec "smoke inventory hub market figure partners register"` | `next build`, restart :3300, run the named specs serially. Log: `.run\rebuild_and_test.log`. |
| `offline_test.ps1 [-NoBuild] [-Phases "prepare,down,hang,back"]` | The no-internet test: runs `tests/offline.spec.ts` in phases while the hub is running, killed, replaced by `blackhole.mjs` (accepts connections, never answers), and back. |
| `update_installed.ps1 -Version 1.x.y` | After `npm run prepare-app` in `desktop\`: update the StitchBench installed on this PC in place (unsigned installers are blocked by Smart App Control). |
| `read_trace.py` | Prints the slow requests from Playwright traces (`--trace on`). |

## One-time setup
1. Dev Postgres on localhost:5433 (`docker compose up -d` in the repo root). Create the hub's test database once:
   `CREATE DATABASE stitchhub_test`.
2. The StitchBench dev database needs the e2e user: `npm run e2e:setup` (email `e2e@stitchbench.test`, password
   `e2e-password-1`), and must be joined to the test hub (Settings -> Community hub -> Join with the invite made
   from `start_hub.bat`'s join key), with `PLATFORM_ADMIN_EMAILS` including the e2e email (start_hubtest.bat sets it).
3. Fixtures (not committed: they are OEM manuals from the library):
   - `fixtures\manualdir\Janome_MC6700P_ServiceManual_2017.pdf` — copy from the manual library
     (`C:\Manuals\Sewing\Janome\...`); the figure spec reads page 4 of it.
   - `fixtures\pdfsrv\test-manual.pdf` — any PDF (the hub spec downloads it and checks it starts with `%PDF-`).

## Running
```
scripts\local-test\start_hub.bat            (leave running)
powershell -File scripts\local-test\rebuild_and_test.ps1 -Spec "smoke inventory hub market figure partners register"
powershell -File scripts\local-test\offline_test.ps1
```
Hub smoke test: `HUB_URL=http://localhost:3200 ADMIN_TOKEN=local-test-admin-token-123 JOIN_KEY=join-local-test npm test`
in the stitchhub repo.
