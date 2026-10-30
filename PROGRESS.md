# PROGRESS: StitchBench and StitchShop

Updated 2026-10-29. Read after `CLAUDE.md`. Keep this under one page.

## Current state
- `main` is `a5c5a4a` or newer. CI (typecheck, lint, 125 unit tests, build) is green; the installer pipeline is green end to end (Windows signed, macOS signed and notarized, Linux; release job publishes). Last full run: test tag `v0.0.1-rc.9`.
- The Decorating module (embroidery and screen-print orders, DST reading, proof by link, StitchFoundry inbox) is merged and free.
- **Production is not updated:** the Railway services still run the 10 Oct code and point at the old `bwattendorf/...` repo names.
- Licence MIT OR Apache-2.0. No beta signup form, analytics or landing page work here (the site is handled in the StitchFoundry chat).

## Recently done
- Integration contract copy (v1.0.0, `contracts/`) and `tests/unit/contract.test.ts` checking Bench's real `job.update`, sender rules and readers; `docs/integration.md`.
- Decorating module, inbox preview picture, DST stitch-count fix (#32).
- Installer fixes: retry on Apple's staple network drops (#33, #34); checksums with spaces in file names (#35).
- Cleanup: `.nvmrc` (24), exact-version saves; no history bloat found (7c853b9, on the work branch).

## Next 3 steps
1. Owner: reconnect Railway to `Stitchwright/stitchbench`, back up the database, deploy (hub first, then this).
2. Owner: delete test releases `v0.0.1-rc.6` to `rc.9`; choose the first public version number.
3. Name the Windows installers without spaces (GitHub turns spaces into dots, so `SHA256SUMS.txt` names stop matching downloads).

## Blockers
- Railway source repo is the old name (see 1).
- Hosted price ($25 a month or $250 a year a shop) is decided but billing is off while `PROGRAM_FREE` is on; the site wording needs updating before it starts.
- StitchFoundry's "Send to StitchShop" sender is not built, so the inbox is untested end to end.
