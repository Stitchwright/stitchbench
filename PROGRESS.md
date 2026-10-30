# PROGRESS: StitchBench and StitchShop

Updated 2026-10-29. Read after `CLAUDE.md`. Keep this under one page.

## Current state
- `main` is `a5c5a4a` or newer. CI (typecheck, lint, 125 unit tests, build) is green; the installer pipeline is green end to end (Windows signed, macOS signed and notarized, Linux; release job publishes). Last full run: test tag `v0.0.1-rc.9`.
- The Decorating module (embroidery and screen-print orders, DST reading, proof by link, StitchFoundry inbox) is merged and free.
- **Production is not updated:** the Railway services still run the 10 Oct code and point at the old `bwattendorf/...` repo names.
- Licence MIT OR Apache-2.0. No beta signup form, analytics or landing page work here (the site is handled in the StitchFoundry chat).

## Recently done
- Work queue set up: `docs/claude-queue.md`, a disabled-by-default `claude-nightly.yml`, labels, issues #40 to #45 (4 queued, 2 proposed).
- Integration contract copy (v1.0.0, `contracts/`) and `tests/unit/contract.test.ts` checking Bench's real `job.update`, sender rules and readers; `docs/integration.md`.
- Decorating module, inbox preview picture, DST stitch-count fix (#32).
- Installer fixes: retry on Apple's staple network drops (#33, #34); checksums with spaces in file names (#35).
- Cleanup: `.nvmrc` (24), exact-version saves; no history bloat found (7c853b9, on the work branch).

## Next 3 steps
1. Owner: tag `v1.7.2` at `a5c5a4a`, wait for the installers, check 21 files; then reconnect Railway and deploy.
2. Queue: #40 (review before the repo goes public), #41 (database checks in CI), #42 (Windows installer names without spaces).
3. Owner: paste the two routines from `docs/claude-queue.md` into Claude Code Routines.

## Blockers
- Railway source repo is the old name (see 1).
- Hosted price ($25 a month or $250 a year a shop) is decided but billing is off while `PROGRAM_FREE` is on; the site wording needs updating before it starts.
- StitchFoundry's "Send to StitchShop" sender is not built, so the inbox is untested end to end.
