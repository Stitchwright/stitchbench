@echo off
rem Local StitchHub for testing (dev Postgres, test secrets). Link checker off so tests don't hit real sites.
cd /d C:\Users\bwatt\stitchhub
set DATABASE_URL=postgresql://stitchbench:stitchbench@localhost:5433/stitchhub_test
set ADMIN_TOKEN=local-test-admin-token-123
set JOIN_KEY=join-local-test
set HUB_NAME=StitchHub (local test)
set PORT=3200
set LINK_CHECKER=off
set HUB_ALLOW_PRIVATE_LINKS=true
if not exist "%~dp0.run" mkdir "%~dp0.run"
node src/server.mjs > "%~dp0.run\hub.log" 2>&1
