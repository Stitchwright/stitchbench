# Update the StitchBench installed on this PC in place (Smart App Control blocks unsigned installers):
# server files from desktop\server, the program files from desktop\, and the version number. Then start it again.
param([string]$Version = "1.5.0")
$repo = "C:\Users\bwatt\stitchbench"
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
foreach ($f in "main.mjs", "migrate.mjs", "backup.mjs", "reference.mjs", "icon.png") { Copy-Item "$repo\desktop\$f" "$inst\resources\app\$f" -Force }

# Version, written without a byte-order mark (Electron reads it as JSON).
$pkgPath = "$inst\resources\app\package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.version = $Version
[IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))

Start-Process "$inst\StitchBench.exe"
"updated to $Version and started"
