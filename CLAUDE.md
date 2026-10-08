@AGENTS.md

# Start here (for a new session in this folder)

1. Read `docs/HANDOFF.md` first: what is done, what is half done, the bug list (`docs/round3/ROUND3_FINDINGS.md`,
   fix packages in `docs/round3/fix-packages/`), the owner's decisions (pricing, hosting, sharing, repo split) and the
   order to work in. Don't re-ask decisions listed there.
2. Two repos: this one (StitchBench + StitchShop, one codebase, StitchShop is a build flavor) and
   `C:\Users\bwatt\stitchhub` (the community hub). `main` in each holds all the work and is what's deployed
   (merged and deployed 8 Oct 2026). Older branches are merged.
3. Where things run: hub https://hub.stitchbench.app (also https://stitchhub-production.up.railway.app; Railway project
   `stitchhub`); hosted StitchShop https://stitchshop-production.up.railway.app (project `stitchshop`); hosted
   StitchBench https://stitchbench-production-e554.up.railway.app (project `stitchbench`). Since 8 Oct all three
   Railway services deploy from GitHub `main` (each repo connected, branch main): a push to main is a deploy. The
   `railway` CLI won't run on this PC (Windows blocks it silently), so changes to variables and redeploys go through
   the Railway website. StitchBench 1.6.1 installed on this PC
   (`%LOCALAPPDATA%\Programs\StitchBench`, port 3100), updated in place with
   `scripts/local-test/update_installed.ps1 -Version <v>` after `npm run prepare-app` in `desktop/` (back up first:
   `node desktop/backup-now.mjs`). Deploys and merges must be run by the owner; when giving `!` commands, use
   forward-slash paths joined with `&&` (Bash strips backslashes).
4. Local end-to-end testing: `scripts/local-test/README.md` (test hub on :3200, test app on :3300, run specs one at
   a time; running them in parallel crashes Chrome on this PC).
5. Secrets never go in the repo or in chat: admin passwords are in `Documents\StitchHub admin.txt`,
   `Documents\StitchShop hosted admin.txt` and `Documents\StitchBench hosted admin.txt`; the dev DB is
   `postgresql://stitchbench:stitchbench@localhost:5433/stitchbench` (test-only).
6. Bash heredocs on this PC halve backslashes: write scripts that contain `\` with the Write tool, not a heredoc.

