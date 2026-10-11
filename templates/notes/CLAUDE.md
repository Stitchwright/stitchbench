# Start here (the owner's notes, for a new Claude Code session)

1. Read `stitchbench/HANDOFF.md` first: what is done, what is half done, the owner's decisions (don't re-ask them) and
   the order to work in. Plans are in `stitchbench/plans/`; the security review is in `stitchbench/round3/` (private:
   never copy findings into the public repositories, issues or pull requests).
2. Repositories: the code is public at github.com/{{ORG}}/StitchBench (StitchBench and StitchShop, one codebase;
   StitchShop is a build flavor), github.com/{{ORG}}/StitchHub (the community hub) and github.com/{{ORG}}/StitchSite
   (the website). This repository and `{{ORG}}/stitchbench-data` (the manufacturers' reference data) are private.
   `main` in each code repository is what's deployed: a push to main is a deploy.
3. Where things run: hub https://hub.stitchbench.app (also https://stitchhub-production.up.railway.app; Railway project
   `stitchhub`); hosted StitchShop https://stitchshop-production.up.railway.app (project `stitchshop`); hosted
   StitchBench https://stitchbench-production-e554.up.railway.app (project `stitchbench`). All three Railway services
   deploy from GitHub `main`. The `railway` CLI won't run on the owner's PC (Windows blocks it silently), so variables
   and redeploys go through the Railway website, or `scripts/railway-docker.ps1` in the stitchbench repository.
   StitchBench is installed on the PC (`%LOCALAPPDATA%\Programs\StitchBench`, port 3100), updated in place with
   `scripts/local-test/update_installed.ps1 -Version <v>` after `npm run prepare-app` in `desktop/` (back up first:
   `node desktop/backup-now.mjs`). Deploys and merges are run by the owner; when giving `!` commands, use
   forward-slash paths joined with `&&` (Bash strips backslashes).
4. Local end-to-end testing: `scripts/local-test/README.md` in the stitchbench repository (test hub on :3200, test app
   on :3300; run specs one at a time, running them in parallel crashes Chrome on the PC).
5. Secrets never go in a repository or in chat: admin passwords are in `Documents\StitchHub admin.txt`,
   `Documents\StitchShop hosted admin.txt` and `Documents\StitchBench hosted admin.txt`; the dev DB is
   `postgresql://stitchbench:stitchbench@localhost:5433/stitchbench` (test-only).
6. Bash heredocs on the PC halve backslashes: write scripts that contain `\` with the Write tool, not a heredoc.
7. Reference data: tension specs come from the owner's manual library
   (`C:\Manuals\_business-notes\Thread_Tension_Specs.xlsx`). In a stitchbench checkout (where `prisma/seed-data`'s
   reference files are git-ignored) regenerate `tension_specs.json` from that sheet and run
   `python scripts/library/fill_model_keys.py` (fills model keys for names without digits; lookups only match on keys),
   then commit the changed files to `{{ORG}}/stitchbench-data`. Official builds fetch them with `STITCH_DATA_TOKEN`
   (stitchbench INSTALL.md, "Reference data").
8. The manual repository on StitchHub: the owner decided on 3 Oct 2026 to host one, filled by techs' uploads with
   notice-and-takedown (HANDOFF section 3 item 18). Build it only through `stitchbench/plans/manual-repository-design.md`.
