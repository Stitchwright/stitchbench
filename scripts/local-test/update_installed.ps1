# Update the StitchBench installed on this PC in place (Smart App Control blocks unsigned installers):
# server files from desktop\server, the program files from desktop\, and the version number. Then start it again.
param([string]$Version = "1.5.0")
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$inst = "$env:LOCALAPPDATA\Programs\StitchBench"
if (-not (Test-Path "$inst\StitchBench.exe")) { throw "StitchBench isn't installed at $inst" }
if (-not (Test-Path "$repo\desktop\server\server.js")) { throw "Run prepare-app first (desktop\server is missing)" }

# Quit the running program (its own quit stops Postgres cleanly; a plain kill leaves Postgres to be adopted next start).
Get-Process StitchBench -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
Start-Sleep 2
Get-Process StitchBench -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

robocopy "$repo\desktop\server" "$inst\resources\server" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
# Every program file the installer ships (desktop\package.json build.files), so a new file such as app-role.mjs isn't
# left out: 1.6.1 failed to start when this list was written by hand.
$pkg = Get-Content "$repo\desktop\package.json" -Raw | ConvertFrom-Json
$files = @($pkg.build.files | Where-Object { $_ -notmatch '[\\/*]' -and $_ -ne "package.json" -and (Test-Path "$repo\desktop\$_" -PathType Leaf) })
if ($files.Count -lt 5) { throw "desktop\package.json build.files lists too few program files ($($files -join ', '))" }
foreach ($f in $files) { Copy-Item "$repo\desktop\$f" "$inst\resources\app\$f" -Force }

# Version, written without a byte-order mark (Electron reads it as JSON).
$pkgPath = "$inst\resources\app\package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.version = $Version
[IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))

Start-Process "$inst\StitchBench.exe"
"updated to $Version and started"
