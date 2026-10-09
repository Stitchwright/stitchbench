# Runs the Railway CLI inside Docker, because Smart App Control on this PC blocks railway.exe (unsigned).
# The token comes from Documents\Railway token.txt (one line: RAILWAY_API_TOKEN=...) straight into the container;
# it is never printed. Example:
#   powershell -File scripts/railway-docker.ps1 ssh -p <project id> -e production -s stitchbench -- node scripts/hosted/count-unassigned-market.mjs
$ErrorActionPreference = "Continue"  # "Stop" turns docker's stderr into a failure in Windows PowerShell
$tokenFile = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Railway token.txt"
if (-not (Test-Path $tokenFile)) { Write-Host "No token file: $tokenFile (one line: RAILWAY_API_TOKEN=...)"; exit 1 }

$image = "stitchbench-railway-cli:2"
docker image inspect $image *> $null
if ($LASTEXITCODE -ne 0) {
  "FROM node:22-alpine`nRUN apk add --no-cache openssh-client && npm i -g @railway/cli@5.64.1`nENTRYPOINT [`"railway`"]" | docker build -t $image -
  if ($LASTEXITCODE -ne 0) { Write-Host "Couldn't build the $image image"; exit 1 }
}
# `railway ssh` needs an SSH key; the container's own key lives in this volume (made on first use; register it
# once with `ssh keys add -k /root/.ssh/id_ed25519.pub -n "PC docker"`). Railway's host key is trusted on first use.
$keyVolume = "stitchbench-railway-ssh"
docker run --rm -v "${keyVolume}:/root/.ssh" --entrypoint sh $image -c "test -f /root/.ssh/id_ed25519 || ssh-keygen -q -t ed25519 -N '' -C stitchbench-docker -f /root/.ssh/id_ed25519; test -f /root/.ssh/config || printf 'Host *\n  StrictHostKeyChecking accept-new\n' > /root/.ssh/config"
docker run --rm -v "${keyVolume}:/root/.ssh" --env-file $tokenFile $image @args
exit $LASTEXITCODE
