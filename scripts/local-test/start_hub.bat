@echo off
rem Local StitchHub for testing (dev Postgres, test secrets). Link checker off so tests don't hit real sites.
rem The stitchhub folder beside this repository's folder; set HUB_DIR to use another.
if not defined HUB_DIR set HUB_DIR=%~dp0..\..\..\stitchhub
cd /d "%HUB_DIR%"
set DATABASE_URL=postgresql://stitchbench:stitchbench@localhost:5433/stitchhub_test
set ADMIN_TOKEN=local-test-admin-token-123
set JOIN_KEY=join-local-test
set HUB_NAME=StitchHub (local test)
set PORT=3200
set LINK_CHECKER=off
rem The community most-used list shows a part once this many shops report it (3 on a real hub; the test hub has one).
set USAGE_MIN_SHOPS=1
set HUB_ALLOW_PRIVATE_LINKS=true
rem No mailbox on this PC: account emails (the set-password link) are printed to .run\hub.log, where tests/account.spec.ts reads them.
set MAIL_DEV_LOG=true
if not exist "%~dp0.run" mkdir "%~dp0.run"
node src/server.mjs > "%~dp0.run\hub.log" 2>&1
