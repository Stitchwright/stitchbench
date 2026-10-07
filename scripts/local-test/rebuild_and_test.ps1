# Rebuild StitchBench, restart the :3300 test server, run the given Playwright specs one at a time. Output: .run\rebuild_and_test.log
param([string]$Spec = "partners")
$sp = $PSScriptRoot
$run = "$sp\.run"
New-Item -ItemType Directory -Force $run | Out-Null
$log = "$run\rebuild_and_test.log"
"start $(Get-Date)" | Out-File $log -Encoding utf8
Get-NetTCPConnection -LocalPort 3300 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }
Set-Location C:\Users\bwatt\stitchbench
$env:NODE_OPTIONS = "--max-old-space-size=2048"
# A test build: development license keys count against this machine's database (docs/TESTING.md), so the specs can switch modules on.
$env:STITCH_TEST_BUILD = "1"
$b = npx next build 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { $b | Out-File $log -Append -Encoding utf8; "BUILD FAILED" | Out-File $log -Append -Encoding utf8; exit 1 }
"build ok $(Get-Date)" | Out-File $log -Append -Encoding utf8
$env:NODE_OPTIONS = ""
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "$sp\start_hubtest.bat" -WindowStyle Hidden
for ($i = 0; $i -lt 60; $i++) { Start-Sleep 2; try { if ((Invoke-WebRequest -UseBasicParsing http://localhost:3300/login -TimeoutSec 5).StatusCode -eq 200) { break } } catch {} }
$env:E2E_BASE_URL = "http://localhost:3300"; $env:HUB_URL = "http://localhost:3200"; $env:PW_CHANNEL = "chrome"
$env:HUB_JOIN_KEY = "join-local-test"; $env:HUB_ADMIN_TOKEN = "local-test-admin-token-123"
$env:PDF_URL = "http://localhost:3400/test-manual.pdf"; $env:TESTLIB = "$run\testlib"
$env:E2E_EMAIL = "e2e@stitchbench.test"; $env:E2E_PASSWORD = "e2e-password-1"; $env:MANUAL_DIR = "$sp\fixtures\manualdir"
foreach ($s in ($Spec -split " ")) {
  "== $s $(Get-Date)" | Out-File $log -Append -Encoding utf8
  npx playwright test $s --workers=1 --reporter=line 2>&1 | Out-File $log -Append -Encoding utf8
  "exit $s $LASTEXITCODE" | Out-File $log -Append -Encoding utf8
}
"done $(Get-Date)" | Out-File $log -Append -Encoding utf8
