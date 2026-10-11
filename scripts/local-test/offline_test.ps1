# The shop with no internet: run tests/offline.spec.ts in phases while the test hub on :3200 is running (prepare),
# killed (down: connection refused), replaced by a black hole (hang: connects, never answers), and back.
# Output: .run\offline_test.log.   -NoBuild reuses the last build.   -Phases "hang,back" runs only those (state file kept).
param([switch]$NoBuild, [string]$Phases = "prepare,down,hang,back")
$sp = $PSScriptRoot
$run = "$sp\.run"
New-Item -ItemType Directory -Force $run | Out-Null
$log = "$run\offline_test.log"
$state = "$run\offline_state.json"
$want = $Phases -split ","
"start $(Get-Date) phases=$Phases" | Out-File $log -Encoding utf8
if ($want -contains "prepare") { Remove-Item $state -ErrorAction SilentlyContinue }

function Stop-Port($port) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false -ErrorAction SilentlyContinue }
  Start-Sleep 1
}
function Wait-Url($url, $tries = 60) {
  for ($i = 0; $i -lt $tries; $i++) { Start-Sleep 2; try { if ((Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 5).StatusCode -eq 200) { return $true } } catch {} }
  return $false
}
function Start-App {
  Stop-Port 3300
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "$sp\start_hubtest.bat" -WindowStyle Hidden
  if (-not (Wait-Url "http://localhost:3300/login")) { "APP DID NOT START" | Out-File $log -Append -Encoding utf8; exit 1 }
}
function Start-Hub {
  Stop-Port 3200
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$sp\start_hub.bat`"" -WindowStyle Hidden
  if (-not (Wait-Url "http://localhost:3200/health")) { "HUB DID NOT START" | Out-File $log -Append -Encoding utf8; exit 1 }
}
function Start-BlackHole {
  Stop-Port 3200
  Start-Process -FilePath "node" -ArgumentList "`"$sp\blackhole.mjs`"", "3200" -WindowStyle Hidden
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep 1; if (Get-NetTCPConnection -LocalPort 3200 -State Listen -ErrorAction SilentlyContinue) { return } }
  "BLACK HOLE DID NOT START" | Out-File $log -Append -Encoding utf8; exit 1
}
function Run-Phase($phase) {
  "== phase $phase $(Get-Date)" | Out-File $log -Append -Encoding utf8
  $env:OFFLINE_PHASE = $phase
  npx playwright test offline --workers=1 --reporter=line --trace on 2>&1 | Out-File $log -Append -Encoding utf8
  "exit $phase $LASTEXITCODE" | Out-File $log -Append -Encoding utf8
  if ($LASTEXITCODE -ne 0) { return $false }
  return $true
}

Set-Location (Resolve-Path "$PSScriptRoot\..\..")
if (-not $NoBuild) {
  $env:NODE_OPTIONS = "--max-old-space-size=2048"
  $b = npx next build 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { $b | Out-File $log -Append -Encoding utf8; "BUILD FAILED" | Out-File $log -Append -Encoding utf8; exit 1 }
  "build ok $(Get-Date)" | Out-File $log -Append -Encoding utf8
  $env:NODE_OPTIONS = ""
}

$env:E2E_BASE_URL = "http://localhost:3300"; $env:HUB_URL = "http://localhost:3200"; $env:PW_CHANNEL = "chrome"
$env:HUB_JOIN_KEY = "join-local-test"; $env:HUB_ADMIN_TOKEN = "local-test-admin-token-123"
$env:E2E_EMAIL = "e2e@stitchbench.test"; $env:E2E_PASSWORD = "e2e-password-1"; $env:MANUAL_DIR = "$sp\fixtures\manualdir"
$env:OFFLINE_STATE = $state

$ok = $true
if ($want -contains "prepare") {
  Start-Hub
  Start-App
  $ok = Run-Phase "prepare"
}
if ($ok -and $want -contains "down") {
  "-- hub killed (connection refused) $(Get-Date)" | Out-File $log -Append -Encoding utf8
  Stop-Port 3200
  if (-not (Get-NetTCPConnection -LocalPort 3300 -State Listen -ErrorAction SilentlyContinue)) { Start-App }
  $ok = Run-Phase "down"
}
if ($ok -and $want -contains "hang") {
  "-- black hole on :3200 (connects, never answers), then the app restarted $(Get-Date)" | Out-File $log -Append -Encoding utf8
  Start-BlackHole
  Start-App
  $ok = Run-Phase "hang"
}
if ($want -contains "back") {
  "-- hub back $(Get-Date)" | Out-File $log -Append -Encoding utf8
  Start-Hub
  if (-not (Get-NetTCPConnection -LocalPort 3300 -State Listen -ErrorAction SilentlyContinue)) { Start-App }
  if ($ok) { $ok = Run-Phase "back" }
} else {
  Start-Hub
}
"done ok=$ok $(Get-Date)" | Out-File $log -Append -Encoding utf8
