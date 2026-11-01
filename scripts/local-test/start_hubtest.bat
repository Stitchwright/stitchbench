@echo off
rem Test run: StitchBench on :3300 (dev database, test library folder) and a plain file server on :3400 with a PDF.
set S=%~dp0
if not exist "%S%.run" mkdir "%S%.run"
start "" /b cmd /c "cd /d %S%fixtures\pdfsrv && python -m http.server 3400 > %S%.run\pdfsrv.log 2>&1"
cd /d "%S%..\.."
if not exist "%S%.run\testlib\_inbox" mkdir "%S%.run\testlib\_inbox"
set LIBRARY_DIR=%S%.run\testlib
set PORT=3300
rem The administrator's pages: put your own login's email in place of you@example.com.
set PLATFORM_ADMIN_EMAILS=you@example.com,e2e@stitchbench.test
set PARTNER_SYNC_SECONDS=20
set FETCH_ALLOW_HOSTS=localhost:3400
rem tests/help.spec.ts: /api/help/test-error throws a test error (404 without this)
set HELP_TEST_ERRORS=1
rem the key rules (lapsed = read-only, add-ons off without a key) are tested with the free program switched off (src/lib/free-program.ts)
set PROGRAM_FREE=off
call npx next start -p 3300 > "%S%.run\app3300.log" 2>&1
